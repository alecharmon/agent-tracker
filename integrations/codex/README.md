# Codex integration

Codex hooks use the same events as Claude Code's, but Codex has no background rewake. So the **Stop** hook holds the turn while the task waits on the captain. The TUI shows "Waiting for the captain's answer on the agent tracker". When the answer lands, the hook returns `{"decision":"block","reason":<answer>}` and Codex continues the turn with it. Esc interrupts the wait as usual.

| Hook | What it does |
|---|---|
| `SessionStart` | Tells the model its session id and that it can end its turn after asking. |
| `UserPromptSubmit` | An idle task goes back to running, and any waiter stops. |
| `Stop` | Holds the turn until the answer arrives, for up to `AGENTS_HOOK_WAIT_HOURS` (default 1). Otherwise it marks the task idle. |
| `SessionEnd` | Ends the session on the task. |

## Install

Copy `hooks.json` to the project's `.codex/hooks.json`, or merge it into `~/.codex/hooks.json`. The project must be trusted for its hooks to load. Requires the `agents` CLI on `PATH`.
