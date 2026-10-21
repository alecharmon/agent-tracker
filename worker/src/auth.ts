import { authorizationErrorRedirect, OAuthAuthorizationServer, OAuthResourceServer } from "@cloudflare/workers-oauth-provider";

// Auth for the tracker (docs/auth.md). The Worker is an OAuth 2.1 authorization server for the CLI and MCP
// clients; sign-in goes upstream to Cloudflare Access (Access for SaaS, OIDC), or to a local stub sign-in
// page with DEV_LOGIN=1. The web dashboard uses a signed session cookie from the same upstream sign-in.

export interface AuthEnv {
  OAUTH_KV: KVNamespace;
  /** Canonical origin of this tracker, e.g. https://agents.example.com (http on loopback for dev). */
  TRACKER_URL: string;
  /** JSON {"emails": [...], "email_domains": [...]}: who may sign in. Empty means nobody. */
  TRACKER_ALLOW?: string;
  /** HMAC key for web session cookies (and dev sign-in codes). */
  SESSION_SECRET?: string;
  /** "1": local stub sign-in instead of Cloudflare Access. */
  DEV_LOGIN?: string;
  ACCESS_CLIENT_ID?: string;
  ACCESS_CLIENT_SECRET?: string;
  ACCESS_AUTHORIZATION_URL?: string;
  ACCESS_TOKEN_URL?: string;
  ACCESS_JWKS_URL?: string;
}

export interface User {
  email: string;
  name?: string;
}

const enc = new TextEncoder();
const b64url = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const html = (body: string, status = 200, headers: HeadersInit = {}) =>
  new Response(
    `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Agent tracker</title>
<style>:root{color-scheme:light dark}body{font:15px/1.5 system-ui,sans-serif;max-width:26rem;margin:12vh auto;padding:0 16px}
button,input{font:inherit;padding:.5rem .8rem;border-radius:.5rem;border:1px solid #8886}button{cursor:pointer}
.primary{background:#2563eb;color:#fff;border-color:#2563eb}code{font-size:1.4rem;letter-spacing:.05em;user-select:all;word-break:break-all}</style>${body}`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "x-frame-options": "DENY", "content-security-policy": "frame-ancestors 'none'", ...headers } },
  );
/** Copy library headers (several Set-Cookie included) onto a response. */
function withHeaders(res: Response, h: Headers) {
  for (const c of (h as Headers & { getSetCookie(): string[] }).getSetCookie()) res.headers.append("set-cookie", c);
  h.forEach((v, k) => k.toLowerCase() !== "set-cookie" && res.headers.set(k, v));
  return res;
}
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// ---- who may sign in -------------------------------------------------------------------------

export function allowed(env: AuthEnv, email: string) {
  let allow: { emails?: string[]; email_domains?: string[] } = {};
  try {
    allow = JSON.parse(env.TRACKER_ALLOW ?? "{}");
  } catch {}
  const e = email.trim().toLowerCase();
  return (
    (allow.emails ?? []).some((x) => x.toLowerCase() === e) ||
    (allow.email_domains ?? []).some((d) => e.endsWith(`@${d.toLowerCase().replace(/^@/, "")}`))
  );
}

// ---- signed values (session cookie, dev sign-in code) ---------------------------------------

async function hmacKey(env: AuthEnv) {
  if (!env.SESSION_SECRET && env.DEV_LOGIN !== "1") throw new Error("SESSION_SECRET is not set");
  return crypto.subtle.importKey("raw", enc.encode(env.SESSION_SECRET ?? "dev-only-session-secret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
async function sign(env: AuthEnv, value: object) {
  const body = b64url(enc.encode(JSON.stringify(value)));
  return `${body}.${b64url(await crypto.subtle.sign("HMAC", await hmacKey(env), enc.encode(body)))}`;
}
async function unsign<T>(env: AuthEnv, token: string | null | undefined): Promise<T | null> {
  const [body, mac] = (token ?? "").split(".");
  if (!body || !mac) return null;
  try {
    if (!(await crypto.subtle.verify("HMAC", await hmacKey(env), unb64url(mac), enc.encode(body)))) return null;
    const v = JSON.parse(new TextDecoder().decode(unb64url(body)));
    return v.exp && v.exp < Date.now() / 1000 ? null : v;
  } catch {
    return null;
  }
}

const SESSION = "tracker_session";
export async function sessionUser(env: AuthEnv, req: Request): Promise<User | null> {
  const cookie = req.headers.get("cookie")?.split(/;\s*/).find((c) => c.startsWith(`${SESSION}=`))?.slice(SESSION.length + 1);
  const s = await unsign<User & { exp: number }>(env, cookie);
  return s && allowed(env, s.email) ? { email: s.email, name: s.name } : null;
}

// ---- the OAuth server ------------------------------------------------------------------------

const servers = new Map<string, { as: OAuthAuthorizationServer<AuthEnv>; mcp: OAuthResourceServer<AuthEnv, User> }>();
export function oauth(env: AuthEnv) {
  const issuer = env.TRACKER_URL.replace(/\/$/, "");
  let s = servers.get(issuer);
  if (!s) {
    const as = new OAuthAuthorizationServer<AuthEnv>({
      issuer,
      resources: [`${issuer}/mcp`, `${issuer}/api`],
      defaultResource: `${issuer}/api`,
      clientRegistrationEndpoint: "/register",
      clientIdMetadataDocumentEnabled: true,
      // A grant lives while it's used; 90 idle days and the client signs in again.
      refreshTokenTTL: 365 * 86400,
      refreshTokenIdleTTL: 90 * 86400,
    } as any);
    const mcp = new OAuthResourceServer<AuthEnv, User>({
      resourceMetadata: { resource: `${issuer}/mcp`, authorization_servers: [issuer] },
      validateToken: (e: AuthEnv) => (resource: string, token: string) => as.validateToken(resource, token, e),
      handler: { fetch: () => new Response("unreachable", { status: 500 }) }, // replaced per request in mcpGuard
    } as any);
    s = { as, mcp };
    servers.set(issuer, s);
  }
  return s;
}

/** Bearer token for /api, or the web session cookie. */
export async function apiUser(env: AuthEnv, req: Request): Promise<User | null> {
  const bearer = req.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
  if (bearer) {
    const issuer = env.TRACKER_URL.replace(/\/$/, "");
    const t = await oauth(env).as.validateToken<User>(`${issuer}/api`, bearer, env).catch(() => null);
    return t && allowed(env, t.props.email) ? t.props : null;
  }
  return sessionUser(env, req);
}

/** /mcp behind the resource server: discovery challenge for MCP clients, then `next` with the user. */
export function mcpGuard(env: AuthEnv, req: Request, ctx: ExecutionContext, next: (user: User) => Promise<Response>) {
  const issuer = env.TRACKER_URL.replace(/\/$/, "");
  const guard = new OAuthResourceServer<AuthEnv, User>({
    resourceMetadata: { resource: `${issuer}/mcp`, authorization_servers: [issuer] },
    validateToken: (e: AuthEnv) => (resource: string, token: string) => oauth(e).as.validateToken(resource, token, e),
    handler: {
      fetch: (_r: Request, e: AuthEnv, c: any) =>
        allowed(e, c.props.email) ? next(c.props) : Response.json({ error: "not allowed" }, { status: 403 }),
    },
  } as any);
  return guard.fetch(req, env, ctx);
}

// ---- upstream sign-in: Cloudflare Access (OIDC), or the dev stub ----------------------------

async function upstreamUrl(env: AuthEnv, state: string, verifier: string, callback: string) {
  if (env.DEV_LOGIN === "1") return `${env.TRACKER_URL.replace(/\/$/, "")}/oauth/dev-login?state=${encodeURIComponent(state)}&cb=${encodeURIComponent(callback)}`;
  if (!env.ACCESS_AUTHORIZATION_URL || !env.ACCESS_CLIENT_ID) throw new Error("Cloudflare Access is not configured (ACCESS_* secrets)");
  const u = new URL(env.ACCESS_AUTHORIZATION_URL);
  u.search = new URLSearchParams({
    client_id: env.ACCESS_CLIENT_ID, response_type: "code", scope: "openid email profile", state,
    redirect_uri: callback, code_challenge: b64url(await crypto.subtle.digest("SHA-256", enc.encode(verifier))),
    code_challenge_method: "S256",
  }).toString();
  return u.toString();
}

/** The returned code -> the signed-in user (verified id_token from Access, or the dev stub's signed code). */
async function upstreamUser(env: AuthEnv, code: string, verifier: string, callback: string): Promise<User> {
  if (env.DEV_LOGIN === "1") {
    const v = await unsign<User>(env, code);
    if (!v) throw new Error("bad dev sign-in code");
    return v;
  }
  const res = await fetch(env.ACCESS_TOKEN_URL!, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code", code, redirect_uri: callback, code_verifier: verifier,
      client_id: env.ACCESS_CLIENT_ID!, client_secret: env.ACCESS_CLIENT_SECRET!,
    }),
  });
  if (!res.ok) throw new Error(`Access token exchange failed (${res.status})`);
  const { id_token } = (await res.json()) as { id_token?: string };
  const claims = await verifyIdToken(env, id_token ?? "");
  return { email: String(claims.email), name: claims.name ? String(claims.name) : undefined };
}

let jwks: { at: number; keys: any[] } | undefined;
async function verifyIdToken(env: AuthEnv, token: string): Promise<Record<string, unknown>> {
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) throw new Error("malformed id_token");
  const header = JSON.parse(new TextDecoder().decode(unb64url(h)));
  if (header.alg !== "RS256") throw new Error("unexpected id_token alg");
  if (!jwks || Date.now() - jwks.at > 300_000 || !jwks.keys.some((k) => k.kid === header.kid))
    jwks = { at: Date.now(), keys: ((await (await fetch(env.ACCESS_JWKS_URL!)).json()) as { keys: any[] }).keys };
  const jwk = jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("unknown id_token key");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, unb64url(s), enc.encode(`${h}.${p}`)))) throw new Error("bad id_token signature");
  const c = JSON.parse(new TextDecoder().decode(unb64url(p)));
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(env.ACCESS_CLIENT_ID) || (c.exp && c.exp < Date.now() / 1000) || !c.email) throw new Error("id_token rejected");
  return c;
}

// ---- routes ----------------------------------------------------------------------------------

/** Auth routes; null when the path isn't one. */
export async function authRoutes(req: Request, env: AuthEnv, ctx: ExecutionContext): Promise<Response | null> {
  const url = new URL(req.url);
  const issuer = env.TRACKER_URL.replace(/\/$/, "");
  const path = url.pathname;
  const { as } = oauth(env);
  const api = as.getOAuthApi(env);

  // Protocol endpoints: discovery, token, registration.
  if (path.startsWith("/.well-known/oauth-authorization-server") || path === "/oauth/token" || path === "/register")
    return as.fetch(req, env, ctx);
  if (path.startsWith("/.well-known/oauth-protected-resource")) return oauth(env).mcp.fetch(req, env, ctx as any);

  // OAuth authorize: consent for this client, then upstream sign-in.
  if (path === "/authorize" && req.method === "GET") {
    let request;
    try {
      request = await api.parseAuthRequest(req);
    } catch (e) {
      return html(`<h1>Can't sign in</h1><p>${esc(e instanceof Error ? e.message : String(e))}</p>`, 400);
    }
    const client = await api.lookupClient(request.clientId);
    const consent = await api.beginConsent(request);
    const name = esc(client?.clientName || request.clientId);
    return withHeaders(html(
      `<h1>Allow access?</h1><p><b>${name}</b> wants to read and update your agent tracker as you.</p>
<form method=post action="/authorize"><input type=hidden name=handle value="${esc(consent.handle)}">
<button class=primary name=decision value=allow>Allow and sign in</button> <button name=decision value=deny>Deny</button></form>`,
    ), consent.headers);
  }
  if (path === "/authorize" && req.method === "POST") {
    const form = await req.formData();
    const handle = String(form.get("handle"));
    if (form.get("decision") !== "allow") {
      const denied = await api.denyConsent(req, handle);
      denied.headers.set("Location", denied.redirectTo);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const approved = await api.approveConsent(req, handle);
    const verifier = crypto.randomUUID() + crypto.randomUUID();
    const { state, headers } = await api.beginUpstream(approved.request, { data: { verifier }, headers: approved.headers });
    headers.set("Location", await upstreamUrl(env, state, verifier, `${issuer}/oauth/callback`));
    return new Response(null, { status: 302, headers });
  }
  if (path === "/oauth/callback") {
    const { request: original, data, headers } = await api.finishUpstream<{ verifier: string }>(req);
    const code = url.searchParams.get("code");
    let user: User | null = null;
    if (code) user = await upstreamUser(env, code, data.verifier, `${issuer}/oauth/callback`).catch(() => null);
    if (!user || !allowed(env, user.email)) {
      headers.set("Location", authorizationErrorRedirect(original, "access_denied"));
      return new Response(null, { status: 302, headers });
    }
    const { redirectTo } = await api.completeAuthorization({
      request: original, userId: user.email, metadata: { label: user.email }, scope: original.scope, props: user,
    });
    headers.set("Location", redirectTo);
    return new Response(null, { status: 302, headers });
  }

  // Remote CLI sign-in lands here: show the code to paste back into the terminal.
  if (path === "/oauth/cli") {
    const code = url.searchParams.get("code");
    if (!code) return html(`<h1>Sign-in didn't finish</h1><p>${esc(url.searchParams.get("error") ?? "No code returned.")}</p>`, 400);
    return html(`<h1>Signed in</h1><p>Paste this code into the terminal where you ran <b>agnt-trkr login</b>:</p><p><code>${esc(code)}</code></p>`);
  }

  // Web dashboard: same upstream sign-in, ending in a session cookie.
  if (path === "/login") {
    const next = url.searchParams.get("next")?.startsWith("/") ? url.searchParams.get("next")! : "/";
    const state = await sign(env, { next, nonce: crypto.randomUUID(), exp: Math.floor(Date.now() / 1000) + 600 });
    const verifier = crypto.randomUUID() + crypto.randomUUID();
    return new Response(null, {
      status: 302,
      headers: {
        location: await upstreamUrl(env, state, verifier, `${issuer}/login/callback`),
        "set-cookie": `tracker_login=${await sign(env, { verifier, state, exp: Math.floor(Date.now() / 1000) + 600 })}; Path=/login; HttpOnly; SameSite=Lax; Max-Age=600${issuer.startsWith("https:") ? "; Secure" : ""}`,
      },
    });
  }
  if (path === "/login/callback") {
    const cookie = req.headers.get("cookie")?.split(/;\s*/).find((c) => c.startsWith("tracker_login="))?.slice("tracker_login=".length);
    const pending = await unsign<{ verifier: string; state: string }>(env, cookie);
    const st = await unsign<{ next: string }>(env, url.searchParams.get("state"));
    const code = url.searchParams.get("code");
    // The state must be the one this browser started (cookie-bound), not just any signed state.
    if (!pending || !st || pending.state !== url.searchParams.get("state") || !code) return html(`<h1>Sign-in expired</h1><p><a href="/login">Try again</a></p>`, 400);
    const user = await upstreamUser(env, code, pending.verifier, `${issuer}/login/callback`).catch(() => null);
    if (!user || !allowed(env, user.email)) return html(`<h1>Not allowed</h1><p>${esc(user?.email ?? "That account")} can't use this tracker.</p>`, 403);
    const session = await sign(env, { ...user, exp: Math.floor(Date.now() / 1000) + 30 * 86400 });
    const secure = issuer.startsWith("https:") ? "; Secure" : "";
    const headers = new Headers({ location: st.next });
    headers.append("set-cookie", `${SESSION}=${session}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}${secure}`);
    headers.append("set-cookie", `tracker_login=; Path=/login; Max-Age=0`);
    return new Response(null, { status: 302, headers });
  }
  if (path === "/logout") return new Response(null, { status: 302, headers: { location: "/", "set-cookie": `${SESSION}=; Path=/; Max-Age=0` } });

  // Dev-only stub for the upstream provider: pick an allowed email.
  if (path === "/oauth/dev-login") {
    if (env.DEV_LOGIN !== "1") return new Response("not found", { status: 404 });
    const state = url.searchParams.get("state") ?? "";
    const cb = url.searchParams.get("cb") ?? `${issuer}/oauth/callback`;
    if (!cb.startsWith(issuer)) return new Response("bad callback", { status: 400 });
    if (req.method === "POST") {
      const email = String((await req.formData()).get("email") ?? "");
      const code = await sign(env, { email, name: email.split("@")[0], exp: Math.floor(Date.now() / 1000) + 120 });
      return new Response(null, { status: 302, headers: { location: `${cb}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}` } });
    }
    return html(`<h1>Dev sign-in</h1><p>Stands in for Cloudflare Access locally.</p>
<form method=post><input name=email type=email placeholder="you@example.com" required autofocus> <button class=primary>Sign in</button></form>`);
  }
  return null;
}
