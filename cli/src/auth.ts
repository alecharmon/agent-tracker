import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";

// `agnt-trkr login`: OAuth 2.1 (authorization code + PKCE) against the tracker, which signs you in through
// Cloudflare Access. Local machines use a loopback redirect; remote ones (ssh, --remote) show a code to paste.

interface Cred {
  client_id: string;
  redirect_uri: string;
  access_token: string;
  refresh_token?: string;
  expires_at: number; // ms
  email?: string;
}
const credPath = join(homedir(), ".config/agent-tracker/credentials.json");
const b64url = (b: Buffer) => b.toString("base64url");

function readCreds(): Record<string, Cred> {
  try {
    return JSON.parse(readFileSync(credPath, "utf8"));
  } catch {
    return {};
  }
}
function writeCreds(all: Record<string, Cred>) {
  mkdirSync(dirname(credPath), { recursive: true });
  writeFileSync(credPath, JSON.stringify(all, null, 2), { mode: 0o600 });
  chmodSync(credPath, 0o600);
}

async function discover(url: string) {
  const res = await fetch(`${url}/.well-known/oauth-authorization-server`);
  if (!res.ok) throw new Error(`${url} doesn't offer sign-in (${res.status}). Is auth enabled there?`);
  return (await res.json()) as { authorization_endpoint: string; token_endpoint: string; registration_endpoint?: string };
}

async function tokenRequest(endpoint: string, body: Record<string, string>) {
  const res = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });
  const out: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`token request failed: ${out.error_description ?? out.error ?? res.status}`);
  return out as { access_token: string; refresh_token?: string; expires_in?: number };
}

const isRemote = () => !!process.env.SSH_CONNECTION || !!process.env.SSH_TTY || (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY);

export async function login(url: string, opts: { remote?: boolean } = {}) {
  const meta = await discover(url);
  if (!meta.registration_endpoint) throw new Error("the tracker doesn't allow client registration");
  const remote = opts.remote ?? isRemote();
  const verifier = b64url(randomBytes(32));
  const state = b64url(randomBytes(16));

  // Remote: the tracker's /oauth/cli page shows the code. Local: a one-shot loopback server receives it.
  let redirect = `${url}/oauth/cli`;
  let received: Promise<string> | null = null;
  let server: ReturnType<typeof createServer> | null = null;
  if (!remote) {
    server = createServer();
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    redirect = `http://127.0.0.1:${port}/callback`;
    received = new Promise((resolve, reject) => {
      server!.on("request", (req, res) => {
        const q = new URL(req.url ?? "/", redirect).searchParams;
        const ok = q.get("state") === state && q.get("code");
        res.writeHead(ok ? 200 : 400, { "content-type": "text/html" });
        res.end(ok ? "<p style='font:16px system-ui'>Signed in. You can close this tab.</p>" : "<p>Sign-in failed. Check the terminal.</p>");
        ok ? resolve(q.get("code")!) : reject(new Error(q.get("error_description") ?? q.get("error") ?? "state mismatch"));
      });
    });
  }

  const reg = await fetch(meta.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: `agents CLI (${hostname().split(".")[0]})`,
      redirect_uris: [redirect],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  if (!reg.ok) throw new Error(`client registration failed (${reg.status})`);
  const { client_id } = (await reg.json()) as { client_id: string };

  const auth = new URL(meta.authorization_endpoint);
  auth.search = new URLSearchParams({
    response_type: "code", client_id, redirect_uri: redirect, state, resource: `${url}/api`,
    code_challenge: b64url(createHash("sha256").update(verifier).digest()), code_challenge_method: "S256",
  }).toString();

  let code: string;
  if (remote) {
    console.error(`Open this on any device and sign in:\n\n  ${auth}\n`);
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    code = (await rl.question("Paste the code shown after signing in: ")).trim();
    rl.close();
  } else {
    console.error(`Opening your browser to sign in…\nIf it doesn't open, visit:\n  ${auth}`);
    execFile(process.platform === "darwin" ? "open" : "xdg-open", [auth.toString()], () => {});
    const timeout = setTimeout(() => server?.close(), 10 * 60_000);
    try {
      code = await received!;
    } finally {
      clearTimeout(timeout);
      server?.close();
    }
  }

  const t = await tokenRequest(meta.token_endpoint, {
    grant_type: "authorization_code", code, redirect_uri: redirect, client_id, code_verifier: verifier, resource: `${url}/api`,
  });
  const cred: Cred = {
    client_id, redirect_uri: redirect, access_token: t.access_token, refresh_token: t.refresh_token,
    expires_at: Date.now() + (t.expires_in ?? 3600) * 1000,
  };
  const me = await fetch(`${url}/api/me`, { headers: { authorization: `Bearer ${cred.access_token}` } }).then((r) => r.json()).catch(() => ({}));
  cred.email = (me as any).email;
  writeCreds({ ...readCreds(), [url]: cred });
  return cred;
}

export function logout(url: string) {
  const all = readCreds();
  const had = !!all[url];
  delete all[url];
  writeCreds(all);
  return had;
}

/** A valid access token for `url`, refreshed when close to expiry; null when not signed in. */
export async function accessToken(url: string, force = false): Promise<string | null> {
  const all = readCreds();
  const c = all[url];
  if (!c) return null;
  if (!force && c.expires_at - Date.now() > 60_000) return c.access_token;
  if (!c.refresh_token) return null;
  const meta = await discover(url);
  const t = await tokenRequest(meta.token_endpoint, {
    grant_type: "refresh_token", refresh_token: c.refresh_token, client_id: c.client_id, resource: `${url}/api`,
  });
  const next = { ...c, access_token: t.access_token, refresh_token: t.refresh_token ?? c.refresh_token, expires_at: Date.now() + (t.expires_in ?? 3600) * 1000 };
  writeCreds({ ...readCreds(), [url]: next });
  return next.access_token;
}

export const signedInAs = (url: string) => readCreds()[url]?.email ?? null;
