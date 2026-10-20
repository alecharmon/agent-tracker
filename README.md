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
