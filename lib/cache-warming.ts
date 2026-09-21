import { createHash } from "node:crypto";
import * as ai from "@earendil-works/pi-ai";
import type { AssistantMessage, AssistantMessageEventStream, Context, Model, ModelsSimpleStreamOptions, Api, Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const WARMING_POLICY = Object.freeze({
	intervalMs: 25 * 60_000,
	maxIdleMs: 225 * 60_000,
	maxRefreshes: 8,
	maxEstimatedUsd: 1,
	maxMissCostFraction: 0.95,
	minCacheHitRatio: 0.9,
	maxOutputTokens: 128,
	timeoutMs: 45_000,
});
const CONFIG = "bg-task-warming-config";
const RECORD = "bg-task-cache-warm";
const OBSERVATION = "bg-task-cache-observation";
const INSTRUCTION = "Background-job cache maintenance only. Do not continue the task, analyze prior content, or call any tools. Reply exactly OK and nothing else.";

type Payload = Record<string, unknown> & { model: string; input?: unknown[]; messages?: unknown[] };
type ConversationKey = "input" | "messages";
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
	return !!model?.id && !!model.provider;
}
export function replaySafe(model: Model<Api> | undefined, thinkingLevel?: string): boolean {
	if (!eligibleModel(model)) return false;
	if (model!.api !== "anthropic-messages") return true;
	if (!thinkingLevel || thinkingLevel === "off") return true;
	return (model!.compat as { forceAdaptiveThinking?: boolean } | undefined)?.forceAdaptiveThinking === true;
}
export function conversationKey(payload: Payload): ConversationKey | undefined {
	if (Array.isArray(payload.input)) return "input";
	if (Array.isArray(payload.messages)) return "messages";
}
export function refreshIntervalMs(model: Model<Api>): number {
	const seconds = (model as Model<Api> & { promptCache?: { short?: number } }).promptCache?.short;
	if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 20) {
		const ttlMs = seconds * 1000;
		return Math.max(10_000, Math.min(Math.floor(ttlMs * 0.9), ttlMs - 10_000));
	}
	return WARMING_POLICY.intervalMs;
}
export function refreshLimit(model: Model<Api>): number {
	const interval = refreshIntervalMs(model);
	if (interval >= WARMING_POLICY.intervalMs) return WARMING_POLICY.maxRefreshes;
	return Math.max(WARMING_POLICY.maxRefreshes, Math.floor(WARMING_POLICY.maxIdleMs / interval));
}
function maintenanceUser(payload: Payload): unknown {
	if (conversationKey(payload) === "input") {
		return { role: "user", content: [{ type: "input_text", text: INSTRUCTION }] };
	}
	const msgs = Array.isArray(payload.messages) ? payload.messages : [];
	const user = msgs.find(item => item && typeof item === "object" && (item as { role?: string }).role === "user") as
		{ content?: unknown } | undefined;
	const content = user?.content;
	if (Array.isArray(content)) {
		const first = content[0];
		const type = first && typeof first === "object" ? (first as { type?: string }).type : undefined;
		if (type === "input_text") return { role: "user", content: [{ type: "input_text", text: INSTRUCTION }] };
		return { role: "user", content: [{ type: "text", text: INSTRUCTION }] };
	}
	return { role: "user", content: INSTRUCTION };
}
function assistantBoundary(generated: unknown, payload: Payload): unknown[] | undefined {
	if (!generated || typeof generated !== "object") return;
	const g = generated as Record<string, unknown>;
	const key = conversationKey(payload);
	if (key && Array.isArray(g[key])) return g[key] as unknown[];
	if (Array.isArray(g.input)) return g.input as unknown[];
	if (Array.isArray(g.messages)) return g.messages as unknown[];
}
function capRefreshOutput(body: Payload): void {
	// Codex ChatGPT rejects max_output_tokens. Leave Responses/input bodies
	// unchanged unless the captured request already had a cap (xAI/OpenAI Responses).
	if (conversationKey(body) === "input") {
		if (typeof body.max_output_tokens === "number") body.max_output_tokens = Math.min(body.max_output_tokens, 32);
		return;
	}
	if (typeof body.max_tokens === "number") body.max_tokens = Math.min(body.max_tokens, 32);
	else body.max_tokens = 32;
	if (typeof body.max_completion_tokens === "number") {
		body.max_completion_tokens = Math.min(body.max_completion_tokens, 32);
	}
}
/** OpenAI reports reasoning inside output_tokens. Visible tokens are the remainder. */
export function visibleOutputTokens(usage: Usage): number {
	const reasoning = usage.reasoning ?? 0;
	if (!Number.isFinite(reasoning) || reasoning <= 0) return usage.output;
	return Math.max(0, usage.output - Math.min(reasoning, usage.output));
}
export function maintenanceTextAccepted(text: string): boolean {
	const t = text.trim();
	return t.length === 0 || /^ok[.!]?\s*$/i.test(t);
}
export function refreshOutputAccepted(result: Pick<AssistantMessage, "content" | "usage">): boolean {
	if (result.content.some(c => c.type === "toolCall")) return false;
	const text = result.content.filter(c => c.type === "text").map(c => c.text).join("");
	return maintenanceTextAccepted(text) && visibleOutputTokens(result.usage) <= WARMING_POLICY.maxOutputTokens;
}
export function capturePayload(value: unknown, model: Model<Api>): Payload | undefined {
	if (!value || typeof value !== "object") return;
	const p = value as Record<string, unknown>;
	if (p.model !== model.id || p.previous_response_id || p.background || p.store === true) return;
	if (!conversationKey(p as Payload)) return;
	// Avoid retaining unbounded multimodal payloads in the extension.
	const json = JSON.stringify(p);
	if (Buffer.byteLength(json) > 8 * 1024 * 1024) return;
	return JSON.parse(json) as Payload;
}
export function refreshPayload(payload: Payload, assistantInput: unknown[]): Payload {
	if (!assistantInput.length) throw new Error("Missing assistant boundary for cache refresh");
	const body = structuredClone(payload);
	const key = conversationKey(body);
	if (!key) throw new Error("Unsupported assistant serialization");
	(body[key] as unknown[]).push(...structuredClone(assistantInput), maintenanceUser(body));
	capRefreshOutput(body);
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
function configEnabled(entries: readonly { type?: string; customType?: string; data?: unknown }[]): boolean {
	let enabled = true;
	for (const e of entries) {
		if (e.type === "custom" && e.customType === CONFIG) enabled = (e.data as { enabled?: boolean } | undefined)?.enabled === true;
	}
	return enabled;
}

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

/** Independent job-aware cache warming; never changes Pi settings or executes model tools. */
export function registerCacheWarming(pi: ExtensionAPI, jobs: Jobs, clock: Clock = realClock) {
	let ctx: ExtensionContext | undefined;
	let active = false;
	let closing = false;
	let enabled = true;
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
			&& ctx.sessionManager.getSessionId() === s.sessionId && eligibleModel(ctx.model) && replaySafe(ctx.model, ctx.thinkingLevel)
			&& ctx.model?.id === s.model.id && ctx.model?.provider === s.model.provider && anchor(ctx) === s.anchor && jobs.runningIds().length > 0;
	}
	function schedule() {
		if (timer !== undefined || inflight || !sample || !sample.usage || !sample.assistant || !valid(sample)) return;
		const s = sample;
		const interval = refreshIntervalMs(s.model);
		if (s.count >= refreshLimit(s.model)) { cancel("refresh limit"); return; }
		const economics = warmingEconomics(s.model, s.usage!);
		if (!economics || s.spent + economics.estimate > economics.budget) { cancel("budget reached"); return; }
		const due = (s.lastWarmAt ?? s.requestedAt) + interval;
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
		const interval = refreshIntervalMs(s.model);
		if (!valid(s) || clock.now() - (s.lastWarmAt ?? s.requestedAt) > interval + 60_000) { cancel("inactive"); return; }
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
					const extra = assistantBoundary(generated, s.payload);
					if (!extra) throw new Error("Unsupported assistant serialization");
					return refreshPayload(s.payload, extra);
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
		if (!refreshOutputAccepted(result)) { pause("unexpected output"); return; }
		const prompt = u.input + u.cacheRead + u.cacheWrite;
		if (!prompt || u.cacheRead / prompt < WARMING_POLICY.minCacheHitRatio) { pause("cache hit below 90%"); return; }
		s.lastWarmAt = startedAt;
		state = "refreshed";
		display();
	}

	pi.registerCommand("bg-warm", {
		description: "Background-job cache warming: on | off | status (default on)",
		handler: async (args, commandCtx) => {
			ctx = commandCtx;
			const action = args.trim() || "status";
			if (action === "on" || action === "off") {
				if (action === "on" && typeof ctx.modelRegistry.getProvider !== "function") {
					ctx.ui.notify("Requires Pi 0.85+.", "warning"); return;
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
		enabled = configEnabled(ctx.sessionManager.getBranch());
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
		if (!enabled || !eligibleModel(ctx.model) || !replaySafe(ctx.model, ctx.thinkingLevel) || jobs.blocked() || !jobs.runningIds().length) return;
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
	// Prevent native warming from duplicating this fallback while a job-aware snapshot is live.
	pi.on("cache_warming_decision", (_event, context) => {
		if (enabled && sample && jobs.runningIds().length > 0 && context.model?.provider === sample.model.provider && context.model?.id === sample.model.id) {
			return { action: "stop" as const };
		}
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
