# agent-tracker

Personal tracker for agent work: a CLI, a web dashboard and a Raycast extension over one Cloudflare Worker + Durable Object (SQLite) backend. The first source is the Firstmate fleet.

See [docs/design.md](docs/design.md).

## Local dev (stub data)

```sh
npm install
npm run build            # web → web/dist, served by the Worker
npm run dev              # wrangler dev on http://localhost:8787 (local DO, token dev-token)
npm run seed             # load the stub fleet
node cli/src/main.ts ls  # or: decisions, show <id>, prs, timeline, summary
```

The web app opens on the Inbox. Lanes is at `/#lanes`. Needs-you items open a panel where you answer the agent's questions.

## Agent integrations

Agents report through the MCP server (`/mcp`) or the `agnt-trkr task` CLI, following `skills/agent-tracker`. Harness hooks add liveness and **wake on answer**: when the captain answers, a waiting agent resumes on its own.

| Harness | Install | Wake on answer |
|---|---|---|
| Claude Code | `integrations/claude-code/settings.json` → `.claude/settings.json` | background `asyncRewake` hook wakes the idle session |
| Codex | `integrations/codex/hooks.json` → `.codex/hooks.json` | Stop hook holds the turn, then continues it with the answer |
| Devin CLI | `integrations/devin/hooks.v1.json` → `.devin/hooks.v1.json` | same as Codex |
| Pi | `integrations/pi/agent-tracker.ts` → `.pi/extensions/` | extension starts a new turn (`triggerTurn`) |
| OpenCode | `integrations/opencode/agent-tracker.ts` → `.opencode/plugins/` (run `--standalone` or restart the service) | plugin prompts the idle session with the answer |

## Auth

The tracker is an OAuth server gated by Cloudflare Access login, with no API keys. The web app, `agnt-trkr login` (also over ssh with `--remote`) and MCP clients all sign in the same way. Who's allowed lives in `tracker.config.json`, and `npm run setup:access` applies it. See [docs/auth.md](docs/auth.md).

Local dev keeps `AUTH_DISABLED=1`. `DEV_LOGIN=1` runs the full flow against a stub sign-in page.
