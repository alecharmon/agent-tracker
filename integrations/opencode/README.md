# OpenCode integration

`agent-tracker.ts` is an OpenCode v2 plugin (`Plugin.define`).

- **Session id for the model:** the `context` hook tells the model its session id, so `task_start` links the task to the session. It also tells the model to end its turn after asking.
- **Liveness:** each turn is bracketed by `session.execution.started` (busy) and `session.execution.succeeded`, `failed` or `cancelled` (idle). Busy marks the task active. Idle marks it idle, unless the task waits on the captain.
- **Wake on answer:** an idle session whose task is waiting gets watched. When the answer lands, `ctx.session.prompt({ sessionID, text })` starts the next turn with it.

## Install

Copy it to the project's `.opencode/plugins/agent-tracker.ts`, or to `~/.config/opencode/plugins/` for every project.

Run with `opencode --standalone`, or restart the background service (`opencode service`) after installing. The shared background service doesn't pick up a project's plugin, or its environment, until it restarts.

Settings: `AGENTS_URL` (default `http://127.0.0.1:8787`), `AGENTS_TOKEN`, `AGENTS_HOOK_WAIT_HOURS` (default 1). `AGENTS_DEBUG_LOG=<file>` logs the events it sees.

Live-tested on v2.0.20 with Muse Spark 1.3.
