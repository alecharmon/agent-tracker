# Devin CLI integration

This works the same way as the Codex integration ([../codex/README.md](../codex/README.md)). Devin's Stop hook can return `{"decision":"block","reason":…}`, so the hook holds the turn while the task waits on the captain, then continues it with the answer.

## Install

Copy `hooks.v1.json` to the project's `.devin/hooks.v1.json`. Requires the `agnt-trkr` CLI on `PATH`.

Devin also reads Claude Code-format hooks, both from a project's `.claude/settings.json` and from your user-level `~/.claude/settings.json`. Don't install both integrations in one project. And if the Claude Code hooks are in your user-level settings, Devin runs them in every project: they report the session as Claude Code and wait with background rewake, which Devin doesn't support. In that case, keep the Claude Code hooks in each project's `.claude/settings.json` instead of `~/.claude/settings.json`.
