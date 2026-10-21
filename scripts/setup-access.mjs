#!/usr/bin/env node
// Apply tracker.config.json to Cloudflare Access: an Access for SaaS (OIDC) app for this tracker, gated by an
// allow policy built from config.access.allow, signing in with config.access.login_methods. Idempotent.
//
//   CLOUDFLARE_API_TOKEN=… node scripts/setup-access.mjs [--dry-run] [--write-secrets]
//
// The token needs Account › Access: Apps and Policies › Edit, and Access: Organizations, Identity Providers › Read.
// --write-secrets pipes ACCESS_*, TRACKER_ALLOW and SESSION_SECRET into `wrangler secret put` (personal account
// wrangler config); secret values are never printed.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = new Set(process.argv.slice(2));
const dry = args.has("--dry-run");
const cfg = JSON.parse(readFileSync(process.env.TRACKER_CONFIG ?? "tracker.config.json", "utf8"));
const url = cfg.url.replace(/\/$/, "");
const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? cfg.account_id;
const token = process.env.CLOUDFLARE_API_TOKEN;
const allow = cfg.access?.allow ?? {};
if (!/^https:\/\//.test(url)) throw new Error("config.url must be the tracker's https origin");
if (![...(allow.emails ?? []), ...(allow.email_domains ?? []), ...(allow.github_orgs ?? [])].length) throw new Error("config.access.allow is empty: nobody could sign in");
if (!dry && (!token || !account)) throw new Error("set CLOUDFLARE_API_TOKEN (and account_id in config or CLOUDFLARE_ACCOUNT_ID)");

async function cf(method, path, body) {
  if (dry && method !== "GET") {
    console.log(`[dry-run] ${method} ${path}${body ? " " + JSON.stringify(body) : ""}`);
    return {};
  }
  if (dry) return [];
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, {
    method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body && JSON.stringify(body),
  });
  const out = await res.json();
  if (!out.success) throw new Error(`${method} ${path}: ${JSON.stringify(out.errors)}`);
  return out.result;
}

const name = `agent-tracker (${new URL(url).host})`;

// Login methods: identity providers by type; create the one-time PIN provider if it's missing.
const idps = dry ? [] : await cf("GET", "/access/identity_providers");
const wanted = cfg.access?.login_methods ?? ["onetimepin"];
const idpIds = [];
for (const type of wanted) {
  let idp = idps.find((i) => i.type === type);
  if (!idp && type === "onetimepin") idp = await cf("POST", "/access/identity_providers", { type, name: "One-time PIN", config: {} });
  if (!idp && !dry) throw new Error(`no "${type}" identity provider in Zero Trust: add it in the dashboard first (Settings › Authentication)`);
  if (idp?.id) idpIds.push(idp.id);
}
const github = idps.find((i) => i.type === "github");

// Allow policy (reusable), from config.
const include = [
  ...(allow.emails ?? []).map((email) => ({ email: { email } })),
  ...(allow.email_domains ?? []).map((domain) => ({ email_domain: { domain } })),
  ...(allow.github_orgs ?? []).map((org) => ({ github_organization: { name: org, identity_provider_id: github?.id } })),
];
const policies = dry ? [] : await cf("GET", "/access/policies");
const policyBody = { name: `${name} allow`, decision: "allow", include };
const existingPolicy = policies.find((p) => p.name === policyBody.name);
const policy = existingPolicy ? await cf("PUT", `/access/policies/${existingPolicy.id}`, policyBody) : await cf("POST", "/access/policies", policyBody);

// The OIDC SaaS app the tracker signs in through.
const apps = dry ? [] : await cf("GET", "/access/apps");
const appBody = {
  name, type: "saas", allowed_idps: idpIds, auto_redirect_to_identity: idpIds.length === 1,
  policies: policy.id ? [policy.id] : [],
  saas_app: {
    auth_type: "oidc",
    redirect_uris: [`${url}/oauth/callback`, `${url}/login/callback`],
    grant_type: ["authorization_code", "refresh_tokens"],
    scopes: ["openid", "email", "profile"],
    refresh_token_options: { lifetime: "90d" },
  },
};
const existingApp = apps.find((a) => a.name === name);
const app = existingApp ? await cf("PUT", `/access/apps/${existingApp.id}`, appBody) : await cf("POST", "/access/apps", appBody);

const org = dry ? { auth_domain: "<team>.cloudflareaccess.com" } : await cf("GET", "/access/organizations");
const clientId = app.saas_app?.client_id ?? "<client_id>";
const oidc = `https://${org.auth_domain}/cdn-cgi/access/sso/oidc/${clientId}`;
const secrets = {
  ACCESS_CLIENT_ID: clientId,
  ACCESS_CLIENT_SECRET: app.saas_app?.client_secret, // only returned on create
  ACCESS_AUTHORIZATION_URL: `${oidc}/authorization`,
  ACCESS_TOKEN_URL: `${oidc}/token`,
  ACCESS_JWKS_URL: `${oidc}/jwks`,
  TRACKER_ALLOW: JSON.stringify({ emails: allow.emails ?? [], email_domains: allow.email_domains ?? [] }),
};

console.log(`Access app: ${name} (${existingApp ? "updated" : "created"}); policy: ${policyBody.name}; login: ${wanted.join(", ")}`);
if (!args.has("--write-secrets")) {
  console.log("Rerun with --write-secrets to store these Worker secrets (values aren't printed):", Object.keys(secrets).join(", "), "SESSION_SECRET");
  process.exit(0);
}
if (dry) process.exit(0);
const env = { ...process.env, XDG_CONFIG_HOME: join(homedir(), ".config/wrangler-personal") };
const put = (key, value) => {
  const r = spawnSync("npx", ["wrangler", "secret", "put", key], { cwd: "worker", input: value, env, stdio: ["pipe", "ignore", "inherit"] });
  if (r.status !== 0) throw new Error(`wrangler secret put ${key} failed`);
  console.log(`stored ${key}`);
};
for (const [k, v] of Object.entries(secrets)) {
  if (!v) {
    console.log(`skipped ${k}: Cloudflare only returns it when the app is created; rotate it in the dashboard if you need it again`);
    continue;
  }
  put(k, v);
}
if (!existingApp) put("SESSION_SECRET", randomBytes(32).toString("base64url"));
console.log(`Set "vars": { "TRACKER_URL": "${url}" } in worker/wrangler.jsonc before deploying.`);
