/** The launch-time Pi state needed by a background command. */
export interface BackgroundEnvironmentContext {
	readonly sessionManager: {
		getSessionId(): string | undefined;
		getSessionFile(): string | undefined;
	};
	readonly model?: {
		readonly provider: string;
		readonly id: string;
	};
	readonly thinkingLevel?: string;
}

/**
 * Copy an inherited environment and replace Pi's session-scoped values with
 * the current launch context. Missing current values remove stale inherited
 * metadata while unrelated variables remain untouched.
 */
export function buildBackgroundEnvironment(
	inherited: Readonly<NodeJS.ProcessEnv>,
	ctx: BackgroundEnvironmentContext,
): NodeJS.ProcessEnv {
	const env = { ...inherited };
	const model = ctx.model;
	const current = {
		PI_SESSION_ID: ctx.sessionManager.getSessionId(),
		PI_SESSION_FILE: ctx.sessionManager.getSessionFile(),
		PI_PROVIDER: model?.provider,
		PI_MODEL: model?.id,
		PI_REASONING_LEVEL: ctx.thinkingLevel,
	};

	for (const [key, value] of Object.entries(current)) {
		if (value) env[key] = value;
		else delete env[key];
	}

	return env;
}
