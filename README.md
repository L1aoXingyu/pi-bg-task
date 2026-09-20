# pi-bg-task

Event-driven **background shell tasks** for [pi](https://pi.dev) — Claude Code-style.

Start a long-running command, get a task id back immediately, and when the process exits a completion message is injected into the session with `triggerTurn: true` so the agent automatically continues. **No sleep-polling.**

## Install

```bash
pi install git:github.com/L1aoXingyu/pi-bg-task
```

Restart pi (or `/reload`) so the extension loads. Version 0.2.0 targets Pi 0.85.1 or newer; background jobs survive reload.

## Tools

| Tool | Purpose |
|------|---------|
| `bg_run` | Start a detached background command (`command`, optional `cwd`, `name`, `notify`) |
| `bg_list` | List tasks for this session |
| `bg_log` | Bounded log tail |
| `bg_kill` | Verify runner identity, then SIGTERM the process group; stale/unverified tasks become `lost` |

Built-in `bash` is **not** overridden. Use `bg_run` only for long jobs.

## How it works

1. `bg_run` writes `command.sh` + `runner.sh`, spawns detached (`detached: true` + `unref()`)
2. Runner captures stdout/stderr to `output.log`, then atomically writes `exit-code` and `done`
3. Extension `fs.watch`es the task dir; on completion sends `bg-task-completion` via  
   `pi.sendMessage(..., { deliverAs: "followUp", triggerTurn: true })`
4. If Pi is compacting, delivery remains paused until the compacted checkpoint is installed; the Codex compaction extension also announces this state through Pi's inter-extension event bus regardless of extension load order
5. The exclusive `reported` marker is written only after Pi emits the structured callback and a successful assistant response; interrupted turns remain retryable, and the stable task id supports at-least-once deduplication
6. `session_start` recovers unfinished tasks; finished-while-away tasks are reported when the session resumes

## Pi 0.82 session environment

Each `bg_run` launch receives the same current session metadata exposed by Pi 0.82's built-in bash tool:

- `PI_SESSION_ID`
- `PI_SESSION_FILE` (unset for ephemeral sessions)
- `PI_PROVIDER` and `PI_MODEL` (unset when no model is selected)
- `PI_REASONING_LEVEL` (unset when unavailable)

These values are resolved from the tool context when the detached process starts, so session, model, and reasoning changes apply to the next launch. Stale inherited values are removed when current metadata is unavailable. `PI_CODING_AGENT` and unrelated environment variables remain inherited.

## Background-job cache warming (opt-in)

For **`openai-codex/gpt-6-astra` only**, enable best-effort refreshes while this session has running background jobs:

```text
/bg-warm on
/bg-warm status
/bg-warm off
```

The choice is persisted in the current session, not globally. New sessions default to off. After enabling or reloading, warming waits for the **next successful real model request**; it never reconstructs or immediately replays an old session. Other providers (including xAI and Cursor) are intentionally not enabled yet.

### Policy and safeguards

- Pi must be idle, without queued messages, and at least one tracked job must still be running. Runner identities are reconciled before sending.
- Refresh every **25 minutes**, at most **4 times** per real-request/idle period; 150-minute absolute horizon. This is an experimental cadence, **not a provider TTL guarantee**. Four refreshes happen at approximately 25/50/75/100 minutes if all checks pass.
- Before each refresh, estimated cumulative spend must fit both **$1** and **50% of the estimated extra cost of one cache miss**. Small contexts (<4k tokens), unavailable pricing, or uneconomic refreshes are skipped.
- A refresh preserves the captured request prefix, tool schemas, reasoning settings and cache key; appends the serialized last assistant response plus a short maintenance request; expects `OK`. Codex's normal `auto` transport retains session affinity. The next foreground call may need a full-context transmission instead of a WebSocket delta; refresh text is never put into its history. **No returned tool is executed.**
- Maintenance instructions and responses are never appended to the conversation. Payloads stay in memory only and are released when invalidated or exhausted.
- A new agent run, completion callback, model/thinking change, compaction, branch navigation, no running jobs, or shutdown cancels warming. Reload preserves jobs/opt-in but requires a fresh real request before warming again.
- Each refresh has a 45-second client timeout, no configured retries, and streaming guards (256 visible characters / 2048 visible reasoning characters). More than 128 reported output or reasoning tokens, unexpected replies, errors, missing usage, or a cache-hit ratio below 90% pause the feature until `/bg-warm on`.

**These are spending cutoffs, not guaranteed server-side billing limits.** Codex does not enforce Pi's `maxTokens` setting; a cache miss or hidden reasoning can cost more than estimated. Client cancellation may leave unknown usage. Subscription dollar values are estimates, not account charges. Prompt-prefix preservation is best-effort if later-loaded extensions rewrite provider payloads or headers. A successful short-gap probe does not establish multi-hour retention or savings.

### Verify during real use

The footer has a separate `warm:` status. `/bg-warm status` shows the next scheduled time (Unix milliseconds), attempt counts, estimated spend, and unknown-usage count. When a safeguard pauses warming, a UI notice explains why.

Session JSONL contains non-context `custom` entries:

- `bg-task-warming-config`: session opt-in/pause state.
- `bg-task-cache-observation`: normal request usage, request gap and payload hash while jobs are active.
- `bg-task-cache-warm`: refresh usage, cache read/input/output/reasoning, job IDs, attempt, interruption and usage-completeness flags.

These entries contain **no prompt text, response text, API keys or headers**. They do not change model history. Refresh usage is tracked separately and is **not included in Pi's native `/session` totals**, because the public extension API does not expose standalone usage accounting. Include `bg-task-cache-warm` records when comparing total usage before/after rollout. Unknown usage must not be counted as zero.

Native Pi cache warming is suppressed for this supported route while the extension mode is enabled, preventing duplicate refreshes. No Pi core, model catalog, global cache TTL, or authentication settings are patched.

## Example prompts

Smoke test:

```text
Use bg_run to run: sleep 5 && echo DOWNLOAD_OK
name: smoke-test
notify: On success, reply with "background continuation works" and summarize the log tail. Do not poll.
```

Model download:

```text
Download the model in the background with bg_run:
  huggingface-cli download Qwen/Qwen2.5-72B-Instruct --local-dir ./models/qwen
name: download-qwen
notify: After success, continue with quantization setup and run the smoke test.
Then keep working on other tasks while it downloads. Do not sleep or poll.
```

## On-disk layout

```
/tmp/pi-bg-task/<base64url session id>/<task id>/
  meta.json command.sh runner.sh output.log
  exit-code done [cancelled] [lost] [reported]
```

Task dirs use mode `0700`. Footer status shows `bg:N running` while tasks are active.

## Notes

- Prefer built-in `bash` for short commands; `bg_run` for downloads/builds/long jobs
- Completion log tail is capped (200 lines / 32 KB); full path is always included
- Logs live under the OS temp dir (cleared on reboot)
- macOS / Linux focused; process-group kill assumes Unix semantics
- The submitted workload should remain in the foreground; daemonized/backgrounded descendants may outlive the runner

## License

MIT

## Changelog

### 0.2.0
- Add opt-in job-aware Codex Astra cache warming via `/bg-warm on|off|status`.
- Preserve request prefix and assistant-message boundary; isolate refreshes from normal conversation/tool execution and normal history.
- Add bounded scheduling, estimate-based economics, cancellation/lifecycle guards, cache-hit checks and non-context usage diagnostics.
- Support Pi 0.85.1 provider streaming and Pi 0.86+ registry streaming without upgrading running sessions.
- Add deterministic mocked-timer, lifecycle, accounting, payload and compatibility tests.

### 0.1.2
- Add Pi 0.82-compatible launch-time propagation for session, model, and reasoning environment variables
- Defer durable completion callbacks while Pi compaction is replacing session state, including load-order-independent coordination with `pi-openai-server-compaction`
- Acknowledge callbacks only after structured delivery plus a successful assistant turn; generation-fence reload/shutdown and retry interrupted attempts up to three times per runtime
- Remove stale inherited session metadata when current values are unavailable while preserving `PI_CODING_AGENT` and unrelated variables
- Add focused unit smoke coverage for dynamic environment replacement and stale-value removal

### 0.1.1
- Fix fast-finish race: already-terminal tasks are completed (watchTask + child exit)
- Fix invalid cwd: preflight + spawn error handling (no unhandled ChildProcess crash)
- Fix stale PID kill: verify runner identity before SIGTERM; refuse/mark lost otherwise
- Drop login shell (`-l`); bounded log tail I/O; send completion before `reported` marker
- Serialize recoverTasks; heal in-map unfinished terminal tasks
