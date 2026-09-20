import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";
import { capturePayload, eligibleModel, refreshPayload, registerCacheWarming, streamRefresh, warmingEconomics, WARMING_POLICY as P } from "../lib/cache-warming.ts";

const model = { id: "gpt-6-astra", provider: "openai-codex", api: "openai-codex-responses", name: "test", reasoning: true, input: ["text"], contextWindow: 500000, maxTokens: 10000, cost: {input: 10, cacheRead: 1, cacheWrite: 0, output: 50} } as Model<Api>;
const payload = () => ({model: model.id, store: false, stream: true, instructions: "unchanged system", input: [{role: "user", content: [{type: "input_text", text: "private fixture"}]}], prompt_cache_key: "test-session", reasoning: {effort: "medium"}, tools: [{type: "function", name: "dangerous", parameters: {type:"object"}}], tool_choice: "auto"});
const usage = (input = 1000, cacheRead = 99000, output = 5) => ({input, cacheRead, output, cacheWrite: 0, reasoning: 0, totalTokens: input + cacheRead + output, cost: { input: input * 1e-5, cacheRead: cacheRead * 1e-6, output: output * 5e-5, cacheWrite: 0, total: input * 1e-5 + cacheRead * 1e-6 + output * 5e-5 }});
const result = (u = usage(), text = "OK", stopReason = "stop") => ({role: "assistant", provider: model.provider, model: model.id, api: model.api, content: [{type: "text", text}], usage: u, stopReason, timestamp: 1});
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

function harness(saved: any[] = []) {
	let now = 1_000_000;
	let seq = 0;
	const timers = new Map<number, {fn: () => void; at: number}>();
	const clock = {now: () => now, set: (fn: () => void, ms: number) => {const id = ++seq; timers.set(id, {fn, at: now + ms}); return id;}, clear: (id: unknown) => {timers.delete(id as number);}};
	const handlers = new Map<string, Function[]>();
	const commands = new Map<string, any>();
	const entries = structuredClone(saved);
	const calls: any[] = [];
	const notices: string[] = [];
	const state = {jobs: ["job1"], blocked: false, idle: true, pending: false, model: structuredClone(model), response: result(), slow: false, reconciles: 0};
	const pi = {on(name: string, fn: Function) {handlers.set(name, [...handlers.get(name) ?? [], fn]);}, registerCommand(name: string, definition: any) {commands.set(name, definition);}, appendEntry(customType: string, data: any) {entries.push({type:"custom", id: `e${entries.length}`, customType, data});}};
	const ctx: any = {hasUI: true, get model() {return state.model;}, isIdle: () => state.idle, hasPendingMessages: () => state.pending,
		sessionManager: {getSessionId: () => "test-session", getBranch: () => entries, getEntries: () => entries},
		ui: {setStatus() {}, notify(text: string) {notices.push(text);}},
		modelRegistry: { getProvider() { return {}; }, streamSimple(_model: any, _context: any, options: any) {
			const sent = options.onPayload({input: [{role:"assistant",content:[{type:"output_text",text:"READY"}]}]});
			calls.push({model: _model, context: _context, options, sent});
			let response = state.response;
			return {async *[Symbol.asyncIterator]() {
				if (state.slow) {
					await new Promise<void>(resolve => options.signal.addEventListener("abort", () => resolve(), {once: true}));
					response = result(usage(0,0,0), "", "aborted");
				} else yield {type: "text_delta", delta: response.content[0].text};
			}, result: async () => response};
		}}};
	const warm = registerCacheWarming(pi as unknown as ExtensionAPI, {runningIds: () => state.jobs, blocked: () => state.blocked, reconcile: async () => {state.reconciles++;}}, clock);
	async function emit(name: string, event: any = {}) {let value; for (const fn of handlers.get(name) ?? []) value = await fn(event, ctx); return value;}
	async function command(action: string) {await commands.get("bg-warm").handler(action, ctx);}
	async function ready() {
		await emit("before_provider_request", {payload: payload()});
		entries.push({type:"message", id:`a${entries.length}`, message: result()});
		await emit("message_end", {message: result()});
		await emit("agent_settled");
	}
	async function advance(ms = P.intervalMs) {
		now += ms;
		for (const [id,t] of [...timers]) if (t.at <= now) {timers.delete(id); t.fn();}
		await flush();
	}
	return {warm, state, calls, entries, timers, notices, emit, command, ready, advance};
}

test("payload replay appends only maintenance and preserves system/tools/reasoning/key", () => {
	const p = payload(); const copy = structuredClone(p); const boundary = [{role:"assistant",content:[{type:"output_text",text:"READY"}]}]; const warm = refreshPayload(p, boundary);
	assert.deepEqual(p, copy); assert.deepEqual(warm.input.slice(0,-2), p.input);
	const {input: a,...before} = p, {input: b,...after} = warm;
	assert.deepEqual(before, after); assert.match(JSON.stringify(b.at(-1)), /Reply exactly OK/);
});
test("reject unsupported routes, delta/background/store payloads and missing cache keys", () => {
	assert.equal(eligibleModel(model), true);
	assert.equal(eligibleModel({...model, provider: "xai"}), false);
	for (const p of [{...payload(), previous_response_id:"id"}, {...payload(), store:true}, {...payload(), background:true}, {...payload(), prompt_cache_key:undefined}, {...payload(), input:"bad"}, {...payload(), model:"other"}]) assert.equal(capturePayload(p,model), undefined);
});
test("economics includes cached context, uncached suffix and output, rejects unknown pricing", () => {
	const e = warmingEconomics(model,usage())!;
	assert.ok(e.estimate > .1); assert.equal(e.budget,.855);
	assert.equal(warmingEconomics({...model,cost:{...model.cost,cacheRead:0}},usage()),undefined);
	assert.equal(warmingEconomics(model,usage(100,0)),undefined);
});
test("default off; opt-in waits for a fresh request; 25 minute schedule", async () => {
	const h=harness(); await h.emit("session_start"); await h.ready(); assert.equal(h.timers.size,0);
	await h.command("on"); assert.equal(h.timers.size,0); await h.ready();
	await h.advance(P.intervalMs-1); assert.equal(h.calls.length,0); await h.advance(1);
	assert.equal(h.calls.length,1); assert.equal(h.calls[0].options.transport,"auto");
	assert.equal(h.calls[0].options.maxRetries,0); assert.equal(h.state.reconciles,1);
	assert.deepEqual(h.calls[0].sent.input.slice(0,-2),payload().input);
	const logs=h.entries.filter(e=>e.customType==="bg-task-cache-warm"); assert.equal(logs.length,1);
	assert.equal(logs[0].data.usageComplete,true); assert.ok(!JSON.stringify(logs).includes("private fixture"));
	assert.equal(h.entries.filter(e=>e.type==="message").length,2); // only the two real requests
});
test("eight refresh limit survives status commands and does not repeat indefinitely", async () => {
	const h=harness(); await h.emit("session_start"); await h.command("on"); await h.ready();
	h.state.response=result(usage(154,99846));
	for(let i=0;i<9;i++){await h.advance(); await h.command("status");}
	assert.equal(h.calls.length,8); assert.equal(h.timers.size,0); assert.equal(h.warm.status().state,"refresh limit");
});
test("estimated budget exhaustion stops subsequent refreshes", async () => {
	const h=harness(); await h.emit("session_start"); await h.command("on"); await h.ready();
	h.state.response.usage.cost.total=.85; await h.advance(); await h.advance();
	assert.equal(h.calls.length,1); assert.equal(h.warm.status().state,"budget reached");
});
for (const event of ["agent_start","model_select","thinking_level_select","session_before_compact","session_compact","session_before_tree","session_tree"]) {
	test(`${event} invalidates pending replay`,async()=>{const h=harness();await h.emit("session_start");await h.command("on");await h.ready();await h.emit(event);await h.advance();assert.equal(h.calls.length,0);});
}
for(const reason of ["no-jobs","blocked","busy","pending","branch-changed","late-timer"]) {
	test(`pre-send guard: ${reason}`,async()=>{
		const h=harness();await h.emit("session_start");await h.command("on");await h.ready();
		if(reason==="no-jobs") h.state.jobs=[];
		if(reason==="blocked") h.state.blocked=true;
		if(reason==="busy") h.state.idle=false;
		if(reason==="pending") h.state.pending=true;
		if(reason==="branch-changed") h.entries.push({type:"message",id:"new-user"});
		await h.advance(P.intervalMs+(reason==="late-timer"?61000:0));assert.equal(h.calls.length,0);
	});
}
for(const variant of ["cache-miss","too-much-output","wrong-response","error"]) {
	test(`pause until explicitly enabled: ${variant}`,async()=>{
		const h=harness();await h.emit("session_start");await h.command("on");await h.ready();
		if(variant==="cache-miss") h.state.response=result(usage(100000,0));
		if(variant==="too-much-output") h.state.response=result(usage(1000,99000,129));
		if(variant==="wrong-response") h.state.response=result(usage(),"I will do work");
		if(variant==="error") h.state.response=result(usage(0,0,0),"","error");
		await h.advance();assert.equal(h.warm.status().enabled,false);await h.ready();await h.advance();assert.equal(h.calls.length,1);
	});
}
test("foreground request aborts in-flight refresh, accounts unknown usage, does not disable future warming",async()=>{
	const h=harness();await h.emit("session_start");await h.command("on");await h.ready();h.state.slow=true;
	await h.advance();assert.equal(h.calls.length,1);await h.emit("agent_start");await flush();
	assert.equal(h.warm.status().enabled,true);assert.equal(h.warm.status().unknownUsage,1);assert.equal(h.timers.size,0);
});
test("timeout aborts and pauses; shutdown drains request and releases timers",async()=>{
	for(const shutdown of [false,true]) {
		const h=harness();await h.emit("session_start");await h.command("on");await h.ready();h.state.slow=true;await h.advance();
		if(shutdown)await h.emit("session_shutdown");else await h.advance(P.timeoutMs);
		assert.equal(h.timers.size,0);assert.equal(h.warm.status().unknownUsage,1);
	}
});
test("reload restores opt-in/accounting but never replays an old request",async()=>{
	const a=harness();await a.emit("session_start");await a.command("on");await a.ready();await a.advance();await a.emit("session_shutdown");
	const b=harness(a.entries);await b.emit("session_start");assert.equal(b.warm.status().enabled,true);assert.equal(b.warm.status().totalRefreshes,1);
	await b.advance();assert.equal(b.calls.length,0);
});
test("off cancels scheduled refresh and persists opt-out",async()=>{
	const h=harness();await h.emit("session_start");await h.command("on");await h.ready();await h.command("off");await h.advance();assert.equal(h.calls.length,0);
	const b=harness(h.entries);await b.emit("session_start");assert.equal(b.warm.status().enabled,false);
});
test("native warming is suppressed only for opted-in supported model",async()=>{
	const h=harness();await h.emit("session_start");await h.command("on");
	assert.deepEqual(await h.emit("cache_warming_decision"), {action:"stop"});
	await h.command("off");assert.equal(await h.emit("cache_warming_decision"),undefined);
	assert.equal(h.entries.some(e=>e.type==="settings"),false);
});

test("Pi 0.85 fallback uses configured provider and resolved auth without exposing credentials", async()=>{
 let called:any;
 const fakeStream={} as any;
 const ctx={modelRegistry:{getApiKeyAndHeaders:async()=>({ok:true,apiKey:"test-secret",headers:{"x-test":"header"},env:{TEST:"1"},baseUrl:"https://example.invalid"}),getProvider:()=>({streamSimple:(...args:any[])=>{called=args;return fakeStream;}})}} as unknown as ExtensionContext;
 assert.equal(await streamRefresh(ctx,model,{transport:"sse"}),fakeStream);
 assert.equal(called[0].baseUrl,"https://example.invalid");assert.equal(called[2].apiKey,"test-secret");
 assert.equal(called[2].transport,"sse");assert.deepEqual(called[1],{messages:[]});
});
test("Pi 0.85 auth wait is abortable and never sends after cancellation",async()=>{
 let resolve:any, sent=false;
 const ctx={modelRegistry:{getApiKeyAndHeaders:()=>new Promise(r=>{resolve=r;}),getProvider:()=>({streamSimple:()=>{sent=true;}})}} as unknown as ExtensionContext;
 const c=new AbortController();const pending=streamRefresh(ctx,model,{signal:c.signal});c.abort();
 await assert.rejects(pending,/cancelled/);resolve({ok:true,apiKey:"fake"});await flush();assert.equal(sent,false);
});

test("enabled without jobs does not retain or log a foreground payload",async()=>{
 const h=harness();await h.emit("session_start");await h.command("on");h.state.jobs=[];await h.ready();
 assert.equal(h.entries.some(e=>e.customType==="bg-task-cache-observation"),false);assert.equal(h.timers.size,0);
});
test("no-job notification cancels an in-flight refresh without executing anything",async()=>{
 const h=harness();await h.emit("session_start");await h.command("on");await h.ready();h.state.slow=true;await h.advance();
 h.state.jobs=[];h.warm.tasksChanged();await flush();assert.equal(h.calls.length,1);assert.equal(h.timers.size,0);assert.equal(h.warm.status().unknownUsage,1);
});
test("refuse to replay without an assistant message boundary",()=>{
 assert.throws(()=>refreshPayload(payload(),[]),/Missing assistant boundary/);
});

test("non-finite usage/pricing cannot bypass budget checks",()=>{
 const u=usage();u.cost.cacheRead=NaN;assert.equal(warmingEconomics(model,u),undefined);
 const v=usage();v.input=Infinity;assert.equal(warmingEconomics(model,v),undefined);
});
