# Devin CLI integration

This works the same way as the Codex integration ([../codex/README.md](../codex/README.md)). Devin's Stop hook can return `{"decision":"block","reason":…}`, so the hook holds the turn while the task waits on the captain, then continues it with the answer.

## Install

Copy `hooks.v1.json` to the project's `.devin/hooks.v1.json`. Requires the `agnt-trkr` CLI on `PATH`.

Devin also reads Claude Code-format hooks from `.claude/settings.json`. Don't install both integrations in one project: Devin would run the Claude Code hooks too, and those use background rewake, which Devin doesn't support.
