/**
 * bg-task: event-driven background shell tasks for pi.
 *
 * Tools:
 *   bg_run  - start a detached command, returns immediately with a task id
 *   bg_list - list tasks for this session
 *   bg_log  - read bounded tail of a task's log
 *   bg_kill - kill a running task (process-group SIGTERM) after identity check
 *
 * When a task's process exits, a completion message is injected into the
 * session with { deliverAs: "followUp", triggerTurn: true } so the agent
 * automatically continues.
 *
 * On-disk layout: /tmp/pi-bg-task/<session>/<id>/
 *   meta.json command.sh runner.sh output.log exit-code done
 *   [cancelled] [lost] [reported]
 */

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	existsSync,
	type FSWatcher,
	openSync,
	readSync,
	statSync,
	closeSync,
	watch as fsWatch,
} from "node:fs";
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateTail } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const ROOT_DIR = join(tmpdir(), "pi-bg-task");
const MAX_TAIL_BYTES = 32 * 1024;
const MAX_TAIL_LINES = 200;

type Task = {
	id: string;
	pid: number;
	command: string;
	cwd: string;
	name?: string;
	notify?: string;
	startedAt: number;
	dir: string;
	watcher?: FSWatcher;
	reporting?: boolean;
	/** True if this process launched the task in the current extension instance. */
	owned?: boolean;
};

type TaskMeta = Omit<Task, "watcher" | "reporting" | "owned">;

type TaskStatus = "running" | "finished" | "cancelled" | "lost";

const shellQuote = (v: string): string => `'${v.replaceAll("'", "'\"'\"'")}'`;

const sessionRoot = (sessionId: string): string =>
	join(ROOT_DIR, Buffer.from(sessionId).toString("base64url"));

const logPath = (task: Task): string => join(task.dir, "output.log");
const runnerPath = (task: Task): string => join(task.dir, "runner.sh");

function taskStatus(task: Task): TaskStatus {
	if (existsSync(join(task.dir, "cancelled"))) return "cancelled";
	if (existsSync(join(task.dir, "lost"))) return "lost";
	return existsSync(join(task.dir, "done")) ? "finished" : "running";
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Verify that `pid` still looks like this task's detached runner group leader.
 * Used before kill/reconcile so recovered bare PIDs cannot signal unrelated processes.
 */
function isOurRunner(pid: number, runner: string): boolean {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	if (!pidAlive(pid)) return false;
	try {
		const out = execFileSync(
			"ps",
			["-p", String(pid), "-o", "pgid=", "-o", "command="],
			{ encoding: "utf8" },
		).trim();
		if (!out) return false;
		const match = out.match(/^(\d+)\s+(.*)$/s);
		if (!match) return false;
		const pgid = Number(match[1]);
		const command = match[2].trim();
		// Detached spawn makes the child its own session/group leader.
		if (pgid !== pid) return false;
		// Require the complete argv shape, not a substring: an unrelated group
		// could otherwise include the known runner path as a harmless extra arg.
		const runnerArg = shellQuote(runner);
		return (
			command === `bash ${runner}` ||
			command === `/bin/bash ${runner}` ||
			command === `/usr/bin/bash ${runner}` ||
			command === `/usr/bin/env bash ${runner}` ||
			command === `env bash ${runner}` ||
			command === `bash ${runnerArg}` ||
			command === `/bin/bash ${runnerArg}` ||
			command === `/usr/bin/bash ${runnerArg}` ||
			command === `/usr/bin/env bash ${runnerArg}` ||
			command === `env bash ${runnerArg}`
		);
	} catch {
		return false;
	}
}

/** Read only the last maxBytes of a file (does not load the whole log). */
function readFileTail(path: string, maxBytes: number): string {
	try {
		const st = statSync(path);
		if (st.size <= 0) return "";
		const fd = openSync(path, "r");
		try {
			const start = Math.max(0, st.size - maxBytes);
			const len = st.size - start;
			const buf = Buffer.alloc(len);
			readSync(fd, buf, 0, len, start);
			return buf.toString("utf8");
		} finally {
			closeSync(fd);
		}
	} catch {
		return "";
	}
}

async function ensureDir(path: string): Promise<void> {
	await mkdir(path, { recursive: true, mode: 0o700 });
	await chmod(path, 0o700);
}

async function writeRunner(dir: string, command: string): Promise<void> {
	const q = (name: string) => shellQuote(join(dir, name));
	await writeFile(join(dir, "command.sh"), command, { mode: 0o700 });
	// Non-login bash to match pi's built-in bash semantics.
	// exit-code then done, both via atomic rename.
	await writeFile(
		join(dir, "runner.sh"),
		`#!/usr/bin/env bash
set +e
/bin/bash ${q("command.sh")} >${q("output.log")} 2>&1
status=$?
printf '%s\\n' "$status" >${q("exit-code.tmp")}
/bin/mv ${q("exit-code.tmp")} ${q("exit-code")}
: >${q("done.tmp")}
/bin/mv ${q("done.tmp")} ${q("done")}
exit "$status"
`,
		{ mode: 0o700 },
	);
}

async function readMeta(dir: string): Promise<TaskMeta | undefined> {
	try {
		const meta = JSON.parse(
			await readFile(join(dir, "meta.json"), "utf8"),
		) as TaskMeta;
		if (
			typeof meta.id !== "string" ||
			typeof meta.command !== "string" ||
			typeof meta.cwd !== "string" ||
			typeof meta.startedAt !== "number" ||
			!Number.isSafeInteger(meta.pid) ||
			meta.pid <= 0 ||
			meta.dir !== dir
		) {
			return undefined;
		}
		return meta;
	} catch {
		return undefined;
	}
}

function label(task: Task): string {
	return task.name ? `${task.name} (${task.id})` : task.id;
}

function completionText(
	task: Task,
	status: TaskStatus,
	exitCode: number,
	output: string,
): string {
	const title =
		status === "cancelled"
			? `Background task cancelled: ${label(task)}`
			: status === "lost"
				? `Background task LOST: ${label(task)}`
				: exitCode === 0
					? `Background task finished: ${label(task)}`
					: `Background task FAILED: ${label(task)}`;
	const lines = [
		`${title} (exit ${exitCode})`,
		`Command: ${task.command}`,
		`Cwd: ${task.cwd}`,
		`Full log: ${logPath(task)}`,
	];
	if (status === "lost") {
		lines.push(
			"Reason: process is gone or no longer matches this task's runner (stale/reused PID or unclean death).",
		);
	}
	const tail = truncateTail(output, {
		maxBytes: MAX_TAIL_BYTES,
		maxLines: MAX_TAIL_LINES,
	});
	if (tail.content) {
		lines.push("", "Log tail:", "```", tail.content, "```");
		if (tail.truncated) {
			lines.push(`[Log tail truncated. Full log: ${logPath(task)}]`);
		}
	}
	if (task.notify) {
		lines.push("", `Follow-up intent: ${task.notify}`);
	}
	return lines.join("\n");
}

async function spawnDetached(
	runner: string,
	cwd: string,
): Promise<ChildProcess> {
	if (!isDirectory(cwd)) {
		throw new Error(`cwd does not exist or is not a directory: ${cwd}`);
	}
	const child = spawn(runner, [], {
		cwd,
		detached: true,
		stdio: "ignore",
	});

	// Consume errors for the child lifetime so Node never treats them as unhandled.
	child.on("error", () => {});

	await new Promise<void>((resolvePromise, reject) => {
		const onError = (err: Error) => {
			cleanup();
			reject(err);
		};
		const onSpawn = () => {
			cleanup();
			resolvePromise();
		};
		const cleanup = () => {
			child.off("error", onError);
			child.off("spawn", onSpawn);
		};
		// If spawn already completed synchronously (rare), still wait a tick via listeners.
		child.once("error", onError);
		child.once("spawn", onSpawn);
	});

	if (!child.pid) {
		throw new Error("Background process did not start (no pid).");
	}
	return child;
}

export default function bgTaskExtension(pi: ExtensionAPI) {
	const tasks = new Map<string, Task>();
	let uiCtx: ExtensionContext | undefined;
	let recoverInflight: Promise<void> | undefined;

	function updateStatus(): void {
		if (!uiCtx?.hasUI) return;
		const running = [...tasks.values()].filter(
			(t) => taskStatus(t) === "running",
		).length;
		uiCtx.ui.setStatus(
			"bg-task",
			running > 0 ? `bg:${running} running` : undefined,
		);
	}

	function stopWatching(task: Task): void {
		task.watcher?.close();
		task.watcher = undefined;
	}

	async function markLost(task: Task, reason: string): Promise<void> {
		if (taskStatus(task) !== "running") return;
		await writeFile(join(task.dir, "lost"), `${reason}\n`, {
			flag: "wx",
			mode: 0o600,
		}).catch(() => {});
		// Synthetic exit-code so completeTask can always read one.
		if (!existsSync(join(task.dir, "exit-code"))) {
			await writeFile(join(task.dir, "exit-code"), "-1\n", {
				flag: "wx",
				mode: 0o600,
			}).catch(() => {});
		}
	}

	/**
	 * If markers say "running" but the process is not our runner, mark lost.
	 * Never signals PIDs here — only classification.
	 */
	async function reconcileIdentity(task: Task): Promise<void> {
		if (taskStatus(task) !== "running") return;
		// Owned tasks that just started may not show in ps yet; only force-lost
		// when the process is clearly gone or identity mismatches after launch.
		if (isOurRunner(task.pid, runnerPath(task))) return;
		if (task.owned && pidAlive(task.pid)) {
			// Still alive but command line doesn't match yet / ps lag — don't mark lost.
			// If it's alive with wrong identity after recovery, owned is false.
			return;
		}
		if (task.owned && Date.now() - task.startedAt < 2000) {
			// Grace period right after spawn.
			return;
		}
		await markLost(
			task,
			isOurRunner(task.pid, runnerPath(task))
				? "unknown"
				: pidAlive(task.pid)
					? "pid_alive_but_not_our_runner"
					: "process_gone_without_done_marker",
		);
	}

	async function completeTask(task: Task): Promise<void> {
		await reconcileIdentity(task);
		const status = taskStatus(task);
		if (task.reporting || status === "running") return;
		if (existsSync(join(task.dir, "reported"))) {
			stopWatching(task);
			updateStatus();
			return;
		}
		task.reporting = true;
		try {
			const exitRaw = await readFile(join(task.dir, "exit-code"), "utf8").catch(
				() => (status === "lost" ? "-1" : ""),
			);
			const exitCode = Number.parseInt(exitRaw.trim(), 10);
			if (!Number.isInteger(exitCode)) {
				// Marker race: done/lost without readable exit-code yet — retry later.
				task.reporting = false;
				return;
			}
			const output = readFileTail(logPath(task), MAX_TAIL_BYTES * 2);

			// Deliver first, then durable ack. Prefer at-least-once over lost callbacks.
			pi.sendMessage(
				{
					customType: "bg-task-completion",
					content: completionText(task, status, exitCode, output),
					details: { taskId: task.id, name: task.name, exitCode, status },
					display: true,
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);

			await writeFile(join(task.dir, "reported"), "", {
				flag: "wx",
				mode: 0o600,
			});
			stopWatching(task);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") {
				// Another path already reported.
				stopWatching(task);
			} else {
				// Keep watcher / allow retry.
				task.reporting = false;
				return;
			}
		} finally {
			updateStatus();
		}
	}

	function watchTask(task: Task): void {
		if (existsSync(join(task.dir, "reported"))) {
			stopWatching(task);
			return;
		}
		// C1: already-terminal tasks must still complete (fast-finish race).
		if (taskStatus(task) !== "running") {
			void completeTask(task);
			return;
		}
		if (!task.watcher) {
			task.watcher = fsWatch(task.dir, () => void completeTask(task));
			task.watcher.on("error", () => {
				// Watch is advisory; fall back to a one-shot reconcile.
				void completeTask(task);
			});
		}
		// Re-check after attaching watcher.
		void completeTask(task);
	}

	async function recoverTasks(ctx: ExtensionContext): Promise<void> {
		if (recoverInflight) {
			await recoverInflight;
			return;
		}
		recoverInflight = (async () => {
			const root = sessionRoot(ctx.sessionManager.getSessionId());
			if (!existsSync(root)) return;
			for (const entry of await readdir(root, { withFileTypes: true })) {
				if (!entry.isDirectory()) continue;
				const existing = tasks.get(entry.name);
				if (existing) {
					// Heal in-map terminal tasks that never reported (C1 residual).
					if (
						!existsSync(join(existing.dir, "reported")) &&
						taskStatus(existing) !== "running"
					) {
						void completeTask(existing);
					} else if (taskStatus(existing) === "running") {
						await reconcileIdentity(existing);
						watchTask(existing);
					}
					continue;
				}
				const meta = await readMeta(join(root, entry.name));
				if (!meta) continue;
				// Reject id/dir mismatch.
				if (meta.id !== entry.name) continue;
				const task: Task = { ...meta, owned: false };
				tasks.set(task.id, task);
				if (existsSync(join(task.dir, "reported"))) continue;
				await reconcileIdentity(task);
				if (taskStatus(task) === "running") watchTask(task);
				else void completeTask(task);
			}
			updateStatus();
		})();
		try {
			await recoverInflight;
		} finally {
			recoverInflight = undefined;
		}
	}

	function getTask(taskId: string): Task {
		const task = tasks.get(taskId);
		if (!task) {
			throw new Error(
				`Unknown background task: ${taskId}. Use bg_list to see tasks.`,
			);
		}
		return task;
	}

	pi.on("session_start", async (_event, ctx) => {
		uiCtx = ctx;
		await recoverTasks(ctx);
	});

	pi.on("session_shutdown", () => {
		for (const task of tasks.values()) stopWatching(task);
		tasks.clear();
	});

	pi.registerTool({
		name: "bg_run",
		label: "bg_run",
		description:
			"Start a long-running shell command as a detached background task. Returns immediately with a task id. " +
			"When the process exits, a completion message (exit code + log tail) is automatically injected into the " +
			"conversation and a new turn is triggered — do NOT sleep or poll for completion. " +
			"Use the notify parameter to record what should happen after completion.",
		promptSnippet:
			"Run long shell commands (downloads, builds, training) in the background",
		promptGuidelines: [
			"Use bg_run for commands expected to take more than ~1 minute (downloads, builds, test suites). Keep the built-in bash for short commands.",
			"Never sleep-poll or repeatedly check on a background task; its completion message arrives automatically and triggers your next turn.",
			"Put follow-up instructions in bg_run's notify parameter so they are replayed to you in the completion message.",
			"After starting a background task, continue with other work or end your turn; wait for the completion callback.",
		],
		parameters: Type.Object({
			command: Type.String({ description: "Shell command to run (bash)" }),
			cwd: Type.Optional(
				Type.String({
					description: "Working directory (defaults to session cwd)",
				}),
			),
			name: Type.Optional(
				Type.String({
					description: "Short human label, e.g. 'download-qwen'",
				}),
			),
			notify: Type.Optional(
				Type.String({
					description:
						"Follow-up intent included in the completion message, e.g. 'After success, continue quantization setup.'",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			await recoverTasks(ctx);
			const sessionId = ctx.sessionManager.getSessionId();
			const id = randomBytes(6).toString("hex");
			const dir = join(sessionRoot(sessionId), id);
			await ensureDir(dir);
			await writeRunner(dir, params.command);

			const cwd = resolve(ctx.cwd, params.cwd ?? ".");
			let child: ChildProcess;
			try {
				child = await spawnDetached(join(dir, "runner.sh"), cwd);
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				throw new Error(`Failed to start background task: ${msg}`);
			}

			const pid = child.pid!;
			const task: Task = {
				id,
				pid,
				command: params.command,
				cwd,
				name: params.name,
				notify: params.notify,
				startedAt: Date.now(),
				dir,
				owned: true,
			};

			try {
				await writeFile(
					join(dir, "meta.json"),
					JSON.stringify(
						{
							id: task.id,
							pid: task.pid,
							command: task.command,
							cwd: task.cwd,
							name: task.name,
							notify: task.notify,
							startedAt: task.startedAt,
							dir: task.dir,
						},
						null,
						2,
					),
					{ mode: 0o600 },
				);
			} catch (error) {
				// Launch cleanup: do not leave an untracked detached process.
				try {
					process.kill(-pid, "SIGTERM");
				} catch {
					/* ignore */
				}
				throw error;
			}

			tasks.set(id, task);

			// C1: exit event as durable wake-up in addition to fs.watch.
			child.once("exit", () => {
				// Give runner a moment to write exit-code/done markers.
				setTimeout(() => void completeTask(task), 50);
			});
			child.unref();

			watchTask(task);
			updateStatus();

			const statusNow = taskStatus(task);
			return {
				content: [
					{
						type: "text" as const,
						text:
							`Started background task ${label(task)} (pid ${task.pid}).\n` +
							`Log: ${logPath(task)}\n` +
							(statusNow === "running"
								? "Status: running. Completion will be reported automatically with exit code and log tail — do not poll."
								: `Status: ${statusNow} (completion may already be queued). Do not poll.`),
					},
				],
				details: {
					taskId: id,
					pid: task.pid,
					logPath: logPath(task),
					status: statusNow,
				},
			};
		},
	});

	pi.registerTool({
		name: "bg_list",
		label: "bg_list",
		description:
			"List background tasks for this session (running and recently finished).",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			await recoverTasks(ctx);
			// Opportunistic reconcile for listed running tasks.
			for (const task of tasks.values()) {
				if (taskStatus(task) === "running") {
					await reconcileIdentity(task);
					if (taskStatus(task) !== "running") void completeTask(task);
				}
			}
			const rows = [...tasks.values()]
				.sort((a, b) => a.startedAt - b.startedAt)
				.map((task) => {
					const status = taskStatus(task);
					const seconds = Math.floor((Date.now() - task.startedAt) / 1000);
					const cmd =
						task.command.length > 80
							? `${task.command.slice(0, 80)}…`
							: task.command;
					return `${task.id}  ${status.padEnd(9)}  ${String(seconds).padStart(5)}s  pid=${task.pid}  ${task.name ?? "-"}  ${cmd}`;
				});
			return {
				content: [
					{
						type: "text" as const,
						text: rows.length
							? `id            status       age     pid   name  command\n${rows.join("\n")}`
							: "No background tasks in this session.",
					},
				],
				details: { count: rows.length },
			};
		},
	});

	pi.registerTool({
		name: "bg_log",
		label: "bg_log",
		description:
			"Read a bounded tail of a background task's log. For progress spot-checks only — completion is reported automatically, so do not poll in a loop.",
		parameters: Type.Object({
			taskId: Type.String({ description: "Task id from bg_run/bg_list" }),
			maxLines: Type.Optional(
				Type.Number({ description: `Max lines (default ${MAX_TAIL_LINES})` }),
			),
			maxBytes: Type.Optional(
				Type.Number({ description: `Max bytes (default ${MAX_TAIL_BYTES})` }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			await recoverTasks(ctx);
			const task = getTask(params.taskId);
			const maxBytes = Math.min(
				Math.max(1, params.maxBytes ?? MAX_TAIL_BYTES),
				MAX_TAIL_BYTES,
			);
			const maxLines = Math.min(
				Math.max(1, params.maxLines ?? MAX_TAIL_LINES),
				MAX_TAIL_LINES,
			);
			const raw = readFileTail(logPath(task), maxBytes);
			const tail = truncateTail(raw, { maxBytes, maxLines });
			const header = `Task ${label(task)} — status: ${taskStatus(task)} — full log: ${logPath(task)}`;
			return {
				content: [
					{
						type: "text" as const,
						text: tail.content
							? `${header}\n\n${tail.content}${tail.truncated ? "\n\n[truncated]" : ""}`
							: `${header}\n\n(log is empty so far)`,
					},
				],
				details: { taskId: task.id, status: taskStatus(task) },
			};
		},
	});

	pi.registerTool({
		name: "bg_kill",
		label: "bg_kill",
		description:
			"Kill a running background task (SIGTERM to its process group) after verifying process identity. Refuses to signal stale/reused PIDs.",
		parameters: Type.Object({
			taskId: Type.String({ description: "Task id from bg_run/bg_list" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			await recoverTasks(ctx);
			const task = getTask(params.taskId);
			await reconcileIdentity(task);
			const status = taskStatus(task);
			if (status !== "running") {
				return {
					content: [
						{
							type: "text" as const,
							text: `Task ${label(task)} is already ${status}.`,
						},
					],
					details: { taskId: task.id, status },
				};
			}

			const runner = runnerPath(task);
			if (!isOurRunner(task.pid, runner)) {
				// C3: never signal an unverified PID.
				await markLost(task, "kill_refused_unverified_pid");
				void completeTask(task);
				return {
					content: [
						{
							type: "text" as const,
							text:
								`Refused to signal task ${label(task)}: pid ${task.pid} is not a verified runner for this task ` +
								`(gone or reused). Marked lost without killing. Log: ${logPath(task)}`,
						},
					],
					details: { taskId: task.id, status: "lost", signaled: false },
				};
			}

			stopWatching(task);
			// Mark cancelled + reported first so runner "done" does not inject a completion for our kill.
			await writeFile(join(task.dir, "cancelled"), "", {
				flag: "wx",
				mode: 0o600,
			}).catch(() => {});
			await writeFile(join(task.dir, "reported"), "", {
				flag: "wx",
				mode: 0o600,
			}).catch(() => {});

			try {
				// Only process-group signal. No positive-PID fallback (unsafe after reuse).
				process.kill(-task.pid, "SIGTERM");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
					throw error;
				}
				// Group already gone — markers already suppress completion.
			}

			updateStatus();
			return {
				content: [
					{
						type: "text" as const,
						text: `Sent SIGTERM to task ${label(task)} (pid group ${task.pid}). Marked cancelled. Log: ${logPath(task)}`,
					},
				],
				details: { taskId: task.id, status: "cancelled", signaled: true },
			};
		},
	});
}
