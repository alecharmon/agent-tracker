# Auth: OAuth, gated by Cloudflare's own login

**Goal:** everyone signs in through Cloudflare Access, the same way in the browser, the CLI, harness hooks, MCP clients and remote machines. There are no long-lived API keys. Access to a tracker is shared by adding people in config.

## Shape

```
          browser  ─┐                                   ┌─ Cloudflare Access login
 agnt-trkr login (CLI) ─┼─► Tracker Worker (OAuth 2.1 AS) ─┤   (one-time email code, GitHub, Google…)
 MCP clients        ─┘   /authorize /token /register    └─ Access for SaaS (OIDC) checks the policy
                          │
                          └─ resource server: /api/*, /mcp accept the Worker's access tokens
```

- **The Worker is the OAuth 2.1 authorization server,** built on `@cloudflare/workers-oauth-provider` v1. That supports MCP's 2026-07-28 auth spec: protected-resource metadata, Client ID Metadata Documents, and Dynamic Client Registration for older clients.
- **`/authorize` sends the user upstream to Cloudflare Access for SaaS (OIDC).** Access shows Cloudflare's login page with the identity providers enabled in Zero Trust (the email one-time PIN needs no setup) and enforces the **Access policy**. The Worker verifies the returned ID token against Access's JWKS and issues its own tokens. Those carry `{ email, name }` and are refreshable for 90 days.
- **`/api/*` and `/mcp` require a valid access token.** Every response and message records **who** sent it (`by: email`). `AUTH_DISABLED=1` remains for local development only.

## Clients

| Client | Flow | Where tokens live |
|---|---|---|
| Web dashboard | `/login` → Access → back to the dashboard. An HttpOnly, SameSite=Lax session cookie holds the token. | cookie |
| `agnt-trkr login` (Mac) | authorization code + PKCE, with a loopback redirect (`http://127.0.0.1:<port>/callback`) | `~/.config/agent-tracker/credentials.json` (0600), auto-refresh |
| `agnt-trkr login` on a **remote machine** (ssh, no browser) | the same flow, but the redirect is the tracker's `/oauth/cli` page, which shows a one-time code. Open the printed URL on any device, sign in, and paste the code back into the terminal (like `gh auth login`). `--remote` forces it; it's chosen automatically when `$SSH_CONNECTION` is set or there's no display. | same file |
| Harness hooks, Pi/OpenCode plugins | `agnt-trkr token` prints a fresh access token from the stored credentials (refreshing if needed) | (via the CLI) |
| MCP clients (Claude Code, Codex, OpenCode, Pi, Devin) | standard MCP OAuth: the client discovers `/.well-known/oauth-protected-resource`, registers, and opens the browser: `claude` `/mcp` → authenticate, `codex mcp login`, `opencode mcp auth`, `pi mcp login`, `devin mcp login` | the client's own store |

**Remote MCP clients** run their callback on the remote machine's localhost. They either print a URL to finish in a local browser, which needs port forwarding, or fall back to the CLI path: `agnt-trkr login --remote`, after which the hooks and CLI carry the agent. The skill already treats the CLI as a full alternative to MCP.

## Config: who's allowed

`tracker.config.json` (one per deployment; `tracker.config.example.json` is committed):

```json
{
  "url": "https://agents.example.com",
  "account_id": "<cloudflare account id>",
  "access": {
    "allow": { "emails": ["you@example.com"], "email_domains": [], "github_orgs": [] },
    "login_methods": ["onetimepin", "github"]
  }
}
```

Each person runs their own tracker from the same code, with their own config. `allow` is usually just you, plus anyone you invite.

`npm run setup:access` applies this config with the `cf` CLI (Cloudflare's own login: `cf auth create <name>`; no API token). The script:
- creates or updates the Access for SaaS (OIDC) app, with the tracker's `/oauth/callback` as redirect URI and 90-day refresh tokens;
- creates or updates its allow policy;
- prints the `wrangler secret put` commands for `ACCESS_CLIENT_ID` / `ACCESS_CLIENT_SECRET`.

**Sharing:** add an email (or a domain, or a GitHub org) to `allow`, then rerun the script. The Worker also checks the same allowlist as defence in depth, so a policy edit made by hand can't silently widen access.

## Deploy checklist

1. Log in to wrangler with your personal account: `npx wrangler login`.
2. Create the KV namespace with `npx wrangler kv namespace create OAUTH_KV`, and put its id in `worker/wrangler.jsonc`.
3. Set `vars.TRACKER_URL` in `worker/wrangler.jsonc` to the deployed origin.
4. Copy `tracker.config.example.json` → `tracker.config.json` (gitignored) and fill it in.
5. `npm run setup:access -- --dry-run`, then `npm run setup:access -- --write-secrets` (signed in with `cf auth create`)
6. `npm run build && npm run deploy -w @agent-tracker/worker`
7. On each machine: `AGENTS_URL=https://… agnt-trkr login` (or `--remote` over ssh). For MCP clients, add the server URL and sign in from the client.

## Local development

- `AUTH_DISABLED=1`: today's behaviour, no auth.
- `DEV_LOGIN=1`: runs the **real OAuth flow** against a built-in stub sign-in page that asks for an email from the allowlist, instead of Cloudflare Access. This tests the CLI login, remote code paste, MCP discovery and token refresh end to end, with no Cloudflare account.

Run an auth-enabled dev server next to the normal one:

```sh
cd worker && npx wrangler dev --port 8789 --env-file .dev.vars.auth --persist-to .wrangler/state-auth
```

Here `.dev.vars.auth` holds `DEV_LOGIN=1`, `TRACKER_URL=http://127.0.0.1:8789`, `TRACKER_ALLOW={"emails":["you@example.com"]}` and `SESSION_SECRET=…`.

**Tested this way:**
- the remote CLI login (URL, then consent, then sign-in, then the pasted code), token refresh, and `agnt-trkr whoami`;
- web sign-in, with a non-allowlisted email refused; session cookie HttpOnly and SameSite=Lax; logout;
- MCP OAuth (challenge, discovery, DCR, PKCE, then `tools/list`);
- tokens are audience-bound: an `/api` token is refused at `/mcp` and vice versa;
- a client-supplied `x-tracker-user` header is ignored;
- answers and messages record who sent them.

Not yet exercised against real Cloudflare Access: that needs the personal account login and a deploy.

## Cost

- **Cloudflare Zero Trust:** free for up to 50 users.
- **Workers KV** (OAuth grants and tokens): within the free tier.
- No other services.
