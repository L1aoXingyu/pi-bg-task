# pi-bg-task

Event-driven **background shell tasks** for [pi](https://pi.dev) — Claude Code-style.

Start a long-running command, get a task id back immediately, and when the process exits a completion message is injected into the session with `triggerTurn: true` so the agent automatically continues. **No sleep-polling.**

## Install

```bash
pi install git:github.com/L1aoXingyu/pi-bg-task
```

Restart pi (or start a new session) so the extension loads. Version 0.1.2 targets Pi 0.82 or newer.

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
