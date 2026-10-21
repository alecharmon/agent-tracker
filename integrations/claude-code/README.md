# Claude Code integration

These hooks keep the tracker accurate without relying on the model, and wake Claude when the captain answers.

| Hook | What it does |
|---|---|
| `SessionStart` | Tells the model its session id, so `task_start` links the task to this session. Writes `AGENTS_HARNESS` / `AGENTS_SESSION` into `$CLAUDE_ENV_FILE` for the CLI. |
| `UserPromptSubmit` | An idle task goes back to running. |
| `Stop` (`asyncRewake`) | **If the task is waiting on the captain:** waits in the background, for up to `AGENTS_HOOK_WAIT_HOURS`, default 1. When the answer lands it exits 2, which wakes the idle session with the answer.<br>**Otherwise:** marks the task idle.<br>If the model reads the answer itself first, the waiter exits quietly. Only one waiter runs per session. |
| `SessionEnd` | Ends the session on the task. |

Hooks only track. A tracker failure never blocks Claude.

## Install

Requires the `agnt-trkr` CLI on `PATH`, and the agent-tracker MCP server or skill.

Merge `settings.json` into the project's `.claude/settings.json`, or into `~/.claude/settings.json` to cover every project. Claude Code runs hooks only in trusted workspaces.
