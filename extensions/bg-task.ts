/**
 * bg-task: event-driven background shell tasks for pi.
 *
 * Tools:
 *   bg_run  - start a detached command, returns immediately with a task id
 *   bg_list - list tasks for this session
 *   bg_log  - read bounded tail of a task's log
 *   bg_kill - kill a running task (process-group SIGTERM)
 *
 * When a task's process exits, a completion message is injected into the
 * session with { deliverAs: "followUp", triggerTurn: true } so the agent
 * automatically continues. Completion is reported exactly once (a "reported"
 * marker file written with the exclusive flag guards against watcher races
 * and survives restarts).
 *
 * On-disk layout: /tmp/pi-bg-task/<session>/<id>/
 *   meta.json command.sh runner.sh output.log exit-code done [cancelled] [reported]
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, type FSWatcher, watch as fsWatch } from "node:fs";
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
};

type TaskMeta = Omit<Task, "watcher" | "reporting">;

type TaskStatus = "running" | "finished" | "cancelled";

const shellQuote = (v: string): string => `'${v.replaceAll("'", "'\"'\"'")}'`;

const sessionRoot = (sessionId: string): string =>
	join(ROOT_DIR, Buffer.from(sessionId).toString("base64url"));

const logPath = (task: Task): string => join(task.dir, "output.log");

function taskStatus(task: Task): TaskStatus {
	if (existsSync(join(task.dir, "cancelled"))) return "cancelled";
	return existsSync(join(task.dir, "done")) ? "finished" : "running";
}

async function ensureDir(path: string): Promise<void> {
	await mkdir(path, { recursive: true, mode: 0o700 });
	await chmod(path, 0o700);
}

async function writeRunner(dir: string, command: string): Promise<void> {
	const q = (name: string) => shellQuote(join(dir, name));
	await writeFile(join(dir, "command.sh"), command, { mode: 0o700 });
	// The runner writes exit-code then the "done" marker (both via atomic
	// rename) so watchers only ever observe complete files.
	await writeFile(
		join(dir, "runner.sh"),
		`#!/usr/bin/env bash
set +e
/bin/bash -l ${q("command.sh")} >${q("output.log")} 2>&1
status=$?
printf '%s\\n' "$status" >${q("exit-code.tmp")}
mv ${q("exit-code.tmp")} ${q("exit-code")}
: >${q("done.tmp")}
mv ${q("done.tmp")} ${q("done")}
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
			: exitCode === 0
				? `Background task finished: ${label(task)}`
				: `Background task FAILED: ${label(task)}`;
	const lines = [
		`${title} (exit ${exitCode})`,
		`Command: ${task.command}`,
		`Full log: ${logPath(task)}`,
	];
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

export default function bgTaskExtension(pi: ExtensionAPI) {
	const tasks = new Map<string, Task>();
	let uiCtx: ExtensionContext | undefined;

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

	async function completeTask(task: Task): Promise<void> {
		const status = taskStatus(task);
		if (task.reporting || status === "running") return;
		task.reporting = true;
		stopWatching(task);
		try {
			const exitCode = Number.parseInt(
				await readFile(join(task.dir, "exit-code"), "utf8"),
				10,
			);
			if (!Number.isInteger(exitCode)) throw new Error("invalid exit code");
			const output = await readFile(logPath(task), "utf8").catch(() => "");

			// Exactly-once guard: exclusive-create marker. If it already exists
			// (EEXIST), another watcher/run already reported this task.
			await writeFile(join(task.dir, "reported"), "", {
				flag: "wx",
				mode: 0o600,
			});
			pi.sendMessage(
				{
					customType: "bg-task-completion",
					content: completionText(task, status, exitCode, output),
					details: { taskId: task.id, name: task.name, exitCode, status },
					display: true,
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
				// Not yet reportable (e.g. exit-code mid-write); allow retry.
				task.reporting = false;
				return;
			}
		} finally {
			updateStatus();
		}
	}

	function watchTask(task: Task): void {
		if (task.watcher || taskStatus(task) !== "running") return;
		task.watcher = fsWatch(task.dir, () => void completeTask(task));
		// Re-check in case the task finished between the status check and watch.
		void completeTask(task);
	}

	async function recoverTasks(ctx: ExtensionContext): Promise<void> {
		const root = sessionRoot(ctx.sessionManager.getSessionId());
		if (!existsSync(root)) return;
		for (const entry of await readdir(root, { withFileTypes: true })) {
			if (!entry.isDirectory() || tasks.has(entry.name)) continue;
			const meta = await readMeta(join(root, entry.name));
			if (!meta) continue;
			const task: Task = { ...meta };
			tasks.set(task.id, task);
			if (existsSync(join(task.dir, "reported"))) continue;
			if (taskStatus(task) === "running") watchTask(task);
			else void completeTask(task); // finished while pi was closed
		}
		updateStatus();
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

			const cwd = params.cwd ?? ctx.cwd;
			const child = spawn(join(dir, "runner.sh"), [], {
				cwd,
				detached: true,
				stdio: "ignore",
			});
			if (!child.pid) throw new Error("Background process did not start.");
			child.unref();

			const task: Task = {
				id,
				pid: child.pid,
				command: params.command,
				cwd,
				name: params.name,
				notify: params.notify,
				startedAt: Date.now(),
				dir,
			};
			await writeFile(
				join(dir, "meta.json"),
				JSON.stringify({ ...task }, null, 2),
				{ mode: 0o600 },
			);
			tasks.set(id, task);
			watchTask(task);
			updateStatus();

			return {
				content: [
					{
						type: "text" as const,
						text:
							`Started background task ${label(task)} (pid ${task.pid}).\n` +
							`Log: ${logPath(task)}\n` +
							`Status: running. Completion will be reported automatically with exit code and log tail — do not poll.`,
					},
				],
				details: { taskId: id, pid: task.pid, logPath: logPath(task) },
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
			const raw = await readFile(logPath(task), "utf8").catch(() => "");
			const tail = truncateTail(raw, {
				maxBytes: Math.min(params.maxBytes ?? MAX_TAIL_BYTES, MAX_TAIL_BYTES),
				maxLines: Math.min(params.maxLines ?? MAX_TAIL_LINES, MAX_TAIL_LINES),
			});
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
			"Kill a running background task (SIGTERM to its process group) and mark it cancelled.",
		parameters: Type.Object({
			taskId: Type.String({ description: "Task id from bg_run/bg_list" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			await recoverTasks(ctx);
			const task = getTask(params.taskId);
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

			stopWatching(task);
			// Mark cancelled + reported first so the runner's "done" write does
			// not race us into sending a completion follow-up for our own kill.
			await writeFile(join(task.dir, "cancelled"), "", {
				flag: "wx",
				mode: 0o600,
			}).catch(() => {});
			await writeFile(join(task.dir, "reported"), "", {
				flag: "wx",
				mode: 0o600,
			}).catch(() => {});
			try {
				process.kill(-task.pid, "SIGTERM"); // process group
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ESRCH") {
					try {
						process.kill(task.pid, "SIGTERM");
					} catch {
						// already gone
					}
				} else {
					throw error;
				}
			}
			updateStatus();
			return {
				content: [
					{
						type: "text" as const,
						text: `Sent SIGTERM to task ${label(task)} (pid group ${task.pid}). Marked cancelled. Log: ${logPath(task)}`,
					},
				],
				details: { taskId: task.id, status: "cancelled" },
			};
		},
	});
}
