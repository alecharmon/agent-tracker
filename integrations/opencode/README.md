# OpenCode integration: not built yet

**Blocked:** this machine can't run an OpenCode model. The OpenCode Go key has expired, and the Cloudflare AI Gateway route returns an authentication error. That leaves nothing to test against.

**Plan,** using OpenCode's v2 plugin API (`Plugin.define({ id, setup(ctx) })`):
- **Liveness:** on the `session.status` event, `{ type: "idle" }` → `POST /api/agent-sessions/opencode/<sessionID>/idle`, and `busy` → `/active`.
- **Wake on answer:** when the session goes idle while its task is waiting, watch `/api/tasks/<id>/answers?peek=1`. When the answer lands, call `client.session.prompt({ sessionID, text: <answer> })`.
- **Session id for the model:** `ctx.session.hook("context", e => e.system.push({ type: "text", text: "…session id…" }))`.

Until then, OpenCode uses the MCP server and the skill, with no wake-on-answer.
