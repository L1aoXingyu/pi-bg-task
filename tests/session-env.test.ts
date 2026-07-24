import assert from "node:assert/strict";
import test from "node:test";
import {
	buildBackgroundEnvironment,
	type BackgroundEnvironmentContext,
} from "../lib/session-env.ts";

test("removes unavailable stale Pi values and preserves unrelated environment", () => {
	const inherited = {
		PATH: "/usr/bin",
		PI_CODING_AGENT: "true",
		UNRELATED: "keep-me",
		PI_SESSION_ID: "stale-session",
		PI_SESSION_FILE: "/tmp/stale.jsonl",
		PI_PROVIDER: "stale-provider",
		PI_MODEL: "stale-model",
		PI_REASONING_LEVEL: "stale-level",
	};
	const ctx: BackgroundEnvironmentContext = {
		sessionManager: {
			getSessionId: () => undefined,
			getSessionFile: () => undefined,
		},
	};

	const env = buildBackgroundEnvironment(inherited, ctx);

	for (const key of [
		"PI_SESSION_ID",
		"PI_SESSION_FILE",
		"PI_PROVIDER",
		"PI_MODEL",
		"PI_REASONING_LEVEL",
	]) {
		assert.equal(key in env, false, `${key} should be removed`);
	}
	assert.equal(env.PI_CODING_AGENT, "true");
	assert.equal(env.UNRELATED, "keep-me");
	assert.equal(env.PATH, "/usr/bin");
	assert.equal(inherited.PI_SESSION_ID, "stale-session");
});

test("resolves dynamic Pi values each time an environment is built", () => {
	const state = {
		sessionId: "session-a",
		sessionFile: "/tmp/session-a.jsonl",
		model: { provider: "anthropic", id: "claude-a" },
		thinkingLevel: "high",
	};
	const ctx: BackgroundEnvironmentContext = {
		sessionManager: {
			getSessionId: () => state.sessionId,
			getSessionFile: () => state.sessionFile,
		},
		get model() {
			return state.model;
		},
		get thinkingLevel() {
			return state.thinkingLevel;
		},
	};

	const first = buildBackgroundEnvironment({}, ctx);
	state.sessionId = "session-b";
	state.sessionFile = "/tmp/session-b.jsonl";
	state.model = { provider: "openai", id: "gpt-b" };
	state.thinkingLevel = "xhigh";
	const second = buildBackgroundEnvironment({}, ctx);

	assert.deepEqual(first, {
		PI_SESSION_ID: "session-a",
		PI_SESSION_FILE: "/tmp/session-a.jsonl",
		PI_PROVIDER: "anthropic",
		PI_MODEL: "claude-a",
		PI_REASONING_LEVEL: "high",
	});
	assert.deepEqual(second, {
		PI_SESSION_ID: "session-b",
		PI_SESSION_FILE: "/tmp/session-b.jsonl",
		PI_PROVIDER: "openai",
		PI_MODEL: "gpt-b",
		PI_REASONING_LEVEL: "xhigh",
	});
});
