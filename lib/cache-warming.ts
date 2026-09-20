import { createHash } from "node:crypto";
import * as ai from "@earendil-works/pi-ai";
import type { AssistantMessage, AssistantMessageEventStream, Context, Model, ModelsSimpleStreamOptions, Api, Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const WARMING_POLICY = Object.freeze({
	intervalMs: 25 * 60_000,
	maxIdleMs: 150 * 60_000,
	maxRefreshes: 4,
	maxEstimatedUsd: 1,
	maxMissCostFraction: 0.5,
	minCacheHitRatio: 0.9,
	maxOutputTokens: 128,
	timeoutMs: 45_000,
});
const CONFIG = "bg-task-warming-config";
const RECORD = "bg-task-cache-warm";
const OBSERVATION = "bg-task-cache-observation";
const INSTRUCTION = "Background-job cache maintenance only. Do not continue the task, analyze prior content, or call any tools. Reply exactly OK and nothing else.";

type Payload = Record<string, unknown> & { input: unknown[]; model: string };
type Clock = {
	now(): number;
	set(fn: () => void, ms: number): unknown;
	clear(handle: unknown): void;
};
const realClock: Clock = {
	now: Date.now,
	set: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref(); return timer; },
	clear: handle => clearTimeout(handle as NodeJS.Timeout),
};
type Jobs = {
	runningIds(): string[];
	blocked(): boolean;
	reconcile(ctx: ExtensionContext): Promise<void>;
};
type Sample = {
	payload: Payload;
	model: Model<Api>;
	sessionId: string;
	requestedAt: number;
	anchor?: string;
	usage?: Usage;
	assistant?: AssistantMessage;
	count: number;
	spent: number;
	lastWarmAt?: number;
};

export function eligibleModel(model: Model<Api> | undefined): boolean {
	// Exact, tested subscription route only. Do not invent TTLs for other providers.
	return model?.provider === "openai-codex" && model.id === "gpt-6-astra" && model.api === "openai-codex-responses";
}
export function capturePayload(value: unknown, model: Model<Api>): Payload | undefined {
	if (!value || typeof value !== "object") return;
	const p = value as Record<string, unknown>;
	if (p.model !== model.id || !Array.isArray(p.input) || p.previous_response_id || p.background || p.store !== false) return;
	if (typeof p.prompt_cache_key !== "string" || !p.prompt_cache_key) return;
	// Avoid retaining unbounded multimodal payloads in the extension.
	const json = JSON.stringify(p);
	if (Buffer.byteLength(json) > 8 * 1024 * 1024) return;
	return JSON.parse(json) as Payload;
}
export function refreshPayload(payload: Payload, assistantInput: unknown[]): Payload {
	if (!assistantInput.length) throw new Error("Missing assistant boundary for cache refresh");
	const body = structuredClone(payload);
	body.input.push(...structuredClone(assistantInput), { role: "user", content: [{ type: "input_text", text: INSTRUCTION }] });
	return body;
}
function usableUsage(usage: Usage): boolean {
	return [usage.input, usage.cacheRead, usage.cacheWrite, usage.output, usage.reasoning ?? 0, usage.totalTokens,
		usage.cost.input, usage.cost.cacheRead, usage.cost.cacheWrite, usage.cost.output, usage.cost.total]
		.every(n => Number.isFinite(n) && n >= 0) && usage.totalTokens > 0;
}
export function warmingEconomics(model: Model<Api>, usage: Usage): { estimate: number; budget: number } | undefined {
	if (!usableUsage(usage)) return;
	const n = usage.input + usage.cacheRead + usage.cacheWrite;
	const { input, cacheRead, output } = model.cost;
	if (n < 4096 || ![input, cacheRead, output].every(x => Number.isFinite(x) && x > 0) || cacheRead >= input) return;
	// Preserve any higher effective rates reported on the real call (e.g. service tier).
	const rate = (catalog: number, tokens: number, dollars: number) => Math.max(catalog, tokens > 0 ? dollars * 1e6 / tokens : 0);
	const i = rate(input, usage.input, usage.cost.input);
	const c = rate(cacheRead, usage.cacheRead, usage.cost.cacheRead);
	const o = rate(output, usage.output, usage.cost.output);
	return {
		estimate: (n * c + (usage.output + 256) * i + WARMING_POLICY.maxOutputTokens * o) / 1e6,
		budget: Math.min(WARMING_POLICY.maxEstimatedUsd, n * Math.max(0, i - c) / 1e6 * WARMING_POLICY.maxMissCostFraction),
	};
}
function anchor(ctx: ExtensionContext): string | undefined {
	return ctx.sessionManager.getBranch().filter(e => ["message", "custom_message", "compaction", "branch_summary", "model_change", "thinking_level_change"].includes(e.type)).at(-1)?.id;
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Pi 0.85 exposes provider streams but not ModelRegistry.streamSimple yet. */
export async function streamRefresh(ctx: ExtensionContext, model: Model<Api>, options: ModelsSimpleStreamOptions, context: Context = { messages: [] }): Promise<AssistantMessageEventStream> {
	if (typeof ctx.modelRegistry.streamSimple === "function") return ctx.modelRegistry.streamSimple(model, context, options);
	const signal = options.signal;
	signal?.throwIfAborted();
	const auth = await new Promise<Awaited<ReturnType<typeof ctx.modelRegistry.getApiKeyAndHeaders>>>((resolve, reject) => {
		const abort = () => reject(new Error("Warming authentication cancelled"));
		signal?.addEventListener("abort", abort, { once: true });
		ctx.modelRegistry.getApiKeyAndHeaders(model).then(resolve, reject).finally(() => signal?.removeEventListener("abort", abort));
	});
	signal?.throwIfAborted();
	if (!auth.ok) throw new Error("Warming authentication unavailable");
	const provider = ctx.modelRegistry.getProvider(model.provider);
	if (!provider) throw new Error("Warming provider unavailable");
	return provider.streamSimple({ ...model, baseUrl: auth.baseUrl ?? model.baseUrl }, typeof ai.normalizeContext === "function" ? ai.normalizeContext(context) : context as ReturnType<typeof ai.normalizeContext>, {
		...options, apiKey: auth.apiKey, headers: auth.headers, env: auth.env,
	});
}

/** Independent, opt-in Codex fallback; never changes Pi settings or executes model tools. */
export function registerCacheWarming(pi: ExtensionAPI, jobs: Jobs, clock: Clock = realClock) {
	let ctx: ExtensionContext | undefined;
	let active = false;
	let closing = false;
	let enabled = false;
	let sample: Sample | undefined;
	let timer: unknown;
	let nextAt: number | undefined;
	let controller: AbortController | undefined;
	let inflight: Promise<void> | undefined;
	let state = "off";
	let totalCount = 0;
	let totalCost = 0;
	let unknownUsage = 0;
	let previousRequestAt: number | undefined;
	let episodeAttempts = 0;

	function status() {
		return { enabled, state, nextAt, attempts: sample?.count ?? episodeAttempts, totalRefreshes: totalCount,
			estimatedUsd: totalCost, unknownUsage, policy: WARMING_POLICY,
			note: "Estimates, not subscription charges. Recorded separately from Pi /session totals." };
	}
	function display() {
		if (ctx?.hasUI) ctx.ui.setStatus("bg-warm", enabled ? `warm:${state} ${totalCount} ~$${totalCost.toFixed(3)}${unknownUsage ? " +?" : ""}` : undefined);
	}
	function cancel(reason: string) {
		if (timer !== undefined) clock.clear(timer);
		timer = undefined;
		nextAt = undefined;
		controller?.abort();
		sample = undefined;
		state = reason;
		display();
	}
	function pause(reason: string) {
		enabled = false;
		cancel(reason);
		pi.appendEntry(CONFIG, { enabled: false, reason });
		if (ctx?.hasUI) ctx.ui.notify(`Background cache warming paused: ${reason}. /bg-warm on to re-enable.`, "warning");
	}
	function valid(s: Sample): boolean {
		return active && !closing && enabled && sample === s && !!ctx && !jobs.blocked() && ctx.isIdle() && !ctx.hasPendingMessages()
			&& ctx.sessionManager.getSessionId() === s.sessionId && eligibleModel(ctx.model)
			&& ctx.model?.id === s.model.id && anchor(ctx) === s.anchor && jobs.runningIds().length > 0;
	}
	function schedule() {
		if (timer !== undefined || inflight || !sample || !sample.usage || !sample.assistant || !valid(sample)) return;
		const s = sample;
		if (s.count >= WARMING_POLICY.maxRefreshes) { cancel("refresh limit"); return; }
		const economics = warmingEconomics(s.model, s.usage!);
		if (!economics || s.spent + economics.estimate > economics.budget) { cancel("budget reached"); return; }
		const due = (s.lastWarmAt ?? s.requestedAt) + WARMING_POLICY.intervalMs;
		// Never try to resurrect an old cache immediately after reload, suspension or a busy turn.
		if (clock.now() - due > 60_000 || due > s.requestedAt + WARMING_POLICY.maxIdleMs) { cancel("window expired"); return; }
		nextAt = due;
		state = "scheduled";
		display();
		timer = clock.set(() => {
			timer = undefined;
			nextAt = undefined;
			inflight = refresh(s).catch(() => {
				if (active && !closing && sample === s) pause("refresh or accounting failure");
			}).finally(() => { inflight = undefined; if (active && !closing) schedule(); });
		}, Math.max(0, due - clock.now()));
	}
	async function refresh(s: Sample) {
		if (!valid(s) || !ctx || !s.usage || !s.assistant) { cancel("inactive"); return; }
		await jobs.reconcile(ctx);
		if (!valid(s) || clock.now() - (s.lastWarmAt ?? s.requestedAt) > WARMING_POLICY.intervalMs + 60_000) { cancel("inactive"); return; }
		const callCtx = ctx;
		const abort = new AbortController();
		controller = abort;
		const timeout = clock.set(() => abort.abort(), WARMING_POLICY.timeoutMs);
		const startedAt = clock.now();
		const taskIds = jobs.runningIds();
		s.count++;
		episodeAttempts = s.count;
		state = "refreshing";
		display();
		let result: AssistantMessage | undefined;
		let chars = 0;
		let thinkingChars = 0;
		try {
			const stream = await streamRefresh(callCtx, s.model, {
				sessionId: s.sessionId, transport: "auto", maxTokens: 32, maxRetries: 0,
				timeoutMs: WARMING_POLICY.timeoutMs, signal: abort.signal,
				// Keep the captured prefix, tools and reasoning settings byte-for-byte at the payload level.
				// Keep Codex's normal session-affine transport; next real turn may require a full-context replay.
				onPayload: (generated) => {
					if (!valid(s) || abort.signal.aborted) throw new Error("Warming invalidated before send");
					const input = (generated as { input?: unknown }).input;
					if (!Array.isArray(input)) throw new Error("Unsupported assistant serialization");
					return refreshPayload(s.payload, input);
				},
			}, { messages: [s.assistant] });
			for await (const event of stream) {
				if (event.type === "text_delta") chars += event.delta.length;
				if (event.type === "thinking_delta") thinkingChars += event.delta.length;
				if (chars > 256 || thinkingChars > 2048 || event.type === "toolcall_start") abort.abort();
			}
			result = await stream.result();
		} finally {
			clock.clear(timeout);
			if (controller === abort) controller = undefined;
			const usage = result?.usage;
			const complete = !!result && result.stopReason === "stop" && !!usage && usableUsage(usage);
			const reportedCost = usage?.cost.total;
			const cost = reportedCost !== undefined && Number.isFinite(reportedCost) && reportedCost >= 0 ? reportedCost : 0;
			totalCount++;
			totalCost += cost;
			s.spent += cost;
			if (!complete) unknownUsage++;
			// No prompt, response, headers or credentials are persisted. Custom entries never enter context.
			if (active) pi.appendEntry(RECORD, { at: new Date(startedAt).toISOString(), durationMs: clock.now() - startedAt,
				provider: s.model.provider, model: s.model.id, payloadHash: digest(s.payload), taskIds,
				idleMs: startedAt - s.requestedAt, attempt: s.count, usage, usageComplete: complete,
				stopReason: result?.stopReason ?? "exception", interrupted: sample !== s || closing, transport: "auto" });
		}
		if (sample !== s || closing) return;
		if (!result || result.stopReason !== "stop" || !usableUsage(result.usage)) { pause("error/timeout or unknown usage"); return; }
		const u = result.usage;
		const text = result.content.filter(c => c.type === "text").map(c => c.text).join("").trim();
		if (text !== "OK" || u.output > WARMING_POLICY.maxOutputTokens || (u.reasoning ?? 0) > WARMING_POLICY.maxOutputTokens) { pause("unexpected output"); return; }
		const prompt = u.input + u.cacheRead + u.cacheWrite;
		if (!prompt || u.cacheRead / prompt < WARMING_POLICY.minCacheHitRatio) { pause("cache hit below 90%"); return; }
		s.lastWarmAt = startedAt;
		state = "refreshed";
		display();
	}

	pi.registerCommand("bg-warm", {
		description: "Background-job cache warming: on | off | status (Codex Astra only, opt-in)",
		handler: async (args, commandCtx) => {
			ctx = commandCtx;
			const action = args.trim() || "status";
			if (action === "on" || action === "off") {
				if (action === "on" && (!eligibleModel(ctx.model) || typeof ctx.modelRegistry.getProvider !== "function")) {
					ctx.ui.notify("Requires Pi 0.85+ and openai-codex/gpt-6-astra. Other providers are not enabled.", "warning"); return;
				}
				enabled = action === "on";
				cancel(enabled ? "waiting for next real request" : "off");
				pi.appendEntry(CONFIG, { enabled });
			} else if (action !== "status") { ctx.ui.notify("Usage: /bg-warm on|off|status", "warning"); return; }
			ctx.ui.notify(JSON.stringify(status(), null, 2), "info");
		},
	});
	pi.on("session_start", (_event, context) => {
		ctx = context; active = true; closing = false;
		for (const e of ctx.sessionManager.getBranch()) {
			if (e.type === "custom" && e.customType === CONFIG) enabled = (e.data as { enabled?: boolean })?.enabled === true;
		}
		for (const e of ctx.sessionManager.getEntries()) {
			if (e.type === "custom" && e.customType === RECORD) {
				const d = e.data as { usage?: Usage; usageComplete?: boolean };
				totalCount++; totalCost += d?.usage?.cost.total ?? 0; if (!d?.usageComplete) unknownUsage++;
			}
		}
		cancel(enabled ? "waiting for next real request" : "off");
	});
	pi.on("agent_start", () => cancel("agent active"));
	pi.on("before_provider_request", (event, context) => {
		ctx = context;
		cancel("waiting for response");
		if (!enabled || !eligibleModel(ctx.model) || jobs.blocked() || !jobs.runningIds().length) return;
		const payload = capturePayload(event.payload, ctx.model!);
		if (!payload) { state = "unsupported payload"; display(); return; }
		episodeAttempts = 0;
		sample = { payload, model: structuredClone(ctx.model!), sessionId: ctx.sessionManager.getSessionId(), requestedAt: clock.now(), count: 0, spent: 0 };
	});
	pi.on("message_end", (event, context) => {
		ctx = context;
		const m = event.message;
		if (!enabled || !sample || m.role !== "assistant") return;
		if (m.provider !== sample.model.provider || m.model !== sample.model.id || !["stop", "toolUse"].includes(m.stopReason)) { cancel("unsuccessful response"); return; }
		sample.usage = structuredClone(m.usage);
		if (m.stopReason === "stop" && !m.content.some(c => c.type === "toolCall")) sample.assistant = structuredClone(m);
		sample.anchor = anchor(ctx);
		pi.appendEntry(OBSERVATION, { at: new Date(clock.now()).toISOString(), provider: m.provider, model: m.model,
			requestGapMs: previousRequestAt === undefined ? null : sample.requestedAt - previousRequestAt,
			payloadHash: digest(sample.payload), usage: m.usage });
		previousRequestAt = sample.requestedAt;
	});
	pi.on("agent_settled", (_event, context) => { ctx = context; if (sample) sample.anchor = anchor(ctx); schedule(); });
	const contextChanged = () => cancel("context changed");
	pi.on("model_select", contextChanged);
	pi.on("thinking_level_select", contextChanged);
	pi.on("session_before_compact", contextChanged);
	pi.on("session_compact", contextChanged);
	pi.on("session_before_tree", contextChanged);
	pi.on("session_tree", contextChanged);
	// Prevent native warming from duplicating this fallback or doing uncapped Codex replays.
	pi.on("cache_warming_decision", (_event, context) => {
		if (enabled && eligibleModel(context.model)) return { action: "stop" as const };
	});
	pi.on("session_shutdown", async () => {
		closing = true; cancel("shutdown");
		await inflight;
		active = false;
	});
	return {
		invalidate: (reason: string) => cancel(reason),
		tasksChanged() { if (!jobs.runningIds().length) cancel("no running jobs"); },
		status,
	};
}
