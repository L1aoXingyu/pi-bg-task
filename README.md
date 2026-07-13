# pi-bg-task

Event-driven **background shell tasks** for [pi](https://pi.dev) — Claude Code-style.

Start a long-running command, get a task id back immediately, and when the process exits a completion message is injected into the session with `triggerTurn: true` so the agent automatically continues. **No sleep-polling.**

## Install

```bash
pi install git:github.com/L1aoXingyu/pi-bg-task
```

Restart pi (or start a new session) so the extension loads.

## Tools

| Tool | Purpose |
|------|---------|
| `bg_run` | Start a detached background command (`command`, optional `cwd`, `name`, `notify`) |
| `bg_list` | List tasks for this session |
| `bg_log` | Bounded log tail |
| `bg_kill` | SIGTERM the process group and mark cancelled |

Built-in `bash` is **not** overridden. Use `bg_run` only for long jobs.

## How it works

1. `bg_run` writes `command.sh` + `runner.sh`, spawns detached (`detached: true` + `unref()`)
2. Runner captures stdout/stderr to `output.log`, then atomically writes `exit-code` and `done`
3. Extension `fs.watch`es the task dir; on completion sends `bg-task-completion` via  
   `pi.sendMessage(..., { deliverAs: "followUp", triggerTurn: true })`
4. Exactly-once via exclusive `reported` marker (`wx`)
5. `session_start` recovers unfinished tasks; finished-while-away tasks are reported once

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
  exit-code done [cancelled] [reported]
```

Task dirs use mode `0700`. Footer status shows `bg:N running` while tasks are active.

## Notes

- Prefer built-in `bash` for short commands; `bg_run` for downloads/builds/long jobs
- Completion log tail is capped (200 lines / 32 KB); full path is always included
- Logs live under the OS temp dir (cleared on reboot)
- macOS / Linux focused; process-group kill assumes Unix semantics

## License

MIT
