#!/usr/bin/env node
// Apply tracker.config.json to Cloudflare Access with the `cf` CLI: an Access for SaaS (OIDC) app for this
// tracker, gated by an allow policy built from config.access.allow, signing in with config.access.login_methods.
// Idempotent: reruns update the same app and policy.
//
//   npm run setup:access [-- --dry-run] [-- --write-secrets]
//
// Auth: the `cf` CLI's login (`cf auth create <name>`, optionally `cf auth activate <name> <repo dir>`).
// The account comes from config.account_id. --write-secrets pipes ACCESS_*, TRACKER_ALLOW and SESSION_SECRET into
// `wrangler secret put` (the Worker's pinned account_id decides where); secret values are never printed.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeDeployConfig } from "./wrangler-config.mjs";

const args = new Set(process.argv.slice(2));
const dry = args.has("--dry-run");
const cfg = JSON.parse(readFileSync(process.env.TRACKER_CONFIG ?? "tracker.config.json", "utf8"));
const url = cfg.url.replace(/\/$/, "");
const allow = cfg.access?.allow ?? {};
if (!/^https:\/\//.test(url)) throw new Error("config.url must be the tracker's https origin");
if (!cfg.account_id || /</.test(cfg.account_id)) throw new Error("config.account_id is not set");
if (![...(allow.emails ?? []), ...(allow.email_domains ?? []), ...(allow.github_orgs ?? [])].length)
  throw new Error("config.access.allow is empty: nobody could sign in");

const env = { ...process.env, CLOUDFLARE_ACCOUNT_ID: cfg.account_id };
/** Run `cf …`; reads always run, writes print instead under --dry-run. */
function cf(cmd, { body, write = false } = {}) {
  if (dry && write) {
    console.log(`[dry-run] cf ${cmd.join(" ")}${body ? ` --body ${JSON.stringify(body)}` : ""}`);
    return {};
  }
  const r = spawnSync("cf", [...cmd, ...(body ? ["--body", JSON.stringify(body)] : [])], { env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`cf ${cmd.slice(0, 4).join(" ")} failed: ${(r.stderr || r.stdout).trim().slice(0, 500)}`);
  const out = JSON.parse(r.stdout || "null");
  return out && typeof out === "object" && "result" in out ? out.result : out;
}

const name = `agent-tracker (${new URL(url).host})`;

// Login methods: identity providers by type; create the one-time PIN provider if it's missing.
const idps = cf(["zero-trust", "identity-providers", "list"]) ?? [];
const wanted = cfg.access?.login_methods ?? ["onetimepin"];
const idpIds = [];
for (const type of wanted) {
  let idp = idps.find((i) => i.type === type);
  if (!idp && type === "onetimepin") idp = cf(["zero-trust", "identity-providers", "create"], { body: { type, name: "One-time PIN", config: {} }, write: true });
  if (!idp && !dry) throw new Error(`no "${type}" login method in Zero Trust: add it in the dashboard (Settings › Authentication) first`);
  if (idp?.id) idpIds.push(idp.id);
}
const github = idps.find((i) => i.type === "github");

// Allow policy (reusable), from config.
const include = [
  ...(allow.emails ?? []).map((email) => ({ email: { email } })),
  ...(allow.email_domains ?? []).map((domain) => ({ email_domain: { domain } })),
  ...(allow.github_orgs ?? []).map((org) => ({ github_organization: { name: org, identity_provider_id: github?.id } })),
];
const policyBody = { name: `${name} allow`, decision: "allow", include };
const existingPolicy = (cf(["zero-trust", "access", "policies", "list"]) ?? []).find((p) => p.name === policyBody.name);
const policy = existingPolicy
  ? cf(["zero-trust", "access", "policies", "update", existingPolicy.id], { body: policyBody, write: true })
  : cf(["zero-trust", "access", "policies", "create"], { body: policyBody, write: true });

// The OIDC SaaS app the tracker signs in through.
const appBody = {
  name, type: "saas", allowed_idps: idpIds, auto_redirect_to_identity: idpIds.length === 1,
  policies: [policy.id ?? existingPolicy?.id].filter(Boolean),
  saas_app: {
    auth_type: "oidc",
    redirect_uris: [`${url}/oauth/callback`, `${url}/login/callback`],
    grant_type: ["authorization_code", "refresh_tokens"],
    scopes: ["openid", "email", "profile"],
    refresh_token_options: { lifetime: "90d" },
  },
};
const existingApp = (cf(["zero-trust", "access", "applications", "list"]) ?? []).find((a) => a.name === name);
const app = existingApp
  ? cf(["zero-trust", "access", "applications", "update", existingApp.id], { body: appBody, write: true })
  : cf(["zero-trust", "access", "applications", "create"], { body: appBody, write: true });

const org = cf(["zero-trust", "organization", "get"]);
const clientId = app.saas_app?.client_id ?? existingApp?.saas_app?.client_id ?? "<client_id>";
const oidc = `https://${org.auth_domain}/cdn-cgi/access/sso/oidc/${clientId}`;
const secrets = {
  ACCESS_CLIENT_ID: clientId,
  ACCESS_CLIENT_SECRET: app.saas_app?.client_secret, // only returned when the app is created
  ACCESS_AUTHORIZATION_URL: `${oidc}/authorization`,
  ACCESS_TOKEN_URL: `${oidc}/token`,
  ACCESS_JWKS_URL: `${oidc}/jwks`,
  TRACKER_ALLOW: JSON.stringify({ emails: allow.emails ?? [], email_domains: allow.email_domains ?? [] }),
};

console.log(`Access app: ${name} (${existingApp ? "update" : "create"}); policy: ${policyBody.name} (${existingPolicy ? "update" : "create"}); team: ${org.auth_domain}; login: ${wanted.join(", ")}`);
if (dry) process.exit(0);
if (!args.has("--write-secrets")) {
  console.log("Rerun with --write-secrets to store the Worker secrets (values aren't printed):", Object.keys(secrets).join(", "), "SESSION_SECRET");
  if (!existingApp) console.log("Note: the client secret is only returned now, at creation. Without --write-secrets you'll need to rotate it later.");
  process.exit(0);
}
const deployConfig = writeDeployConfig();
const put = (key, value) => {
  const r = spawnSync("npx", ["wrangler", "secret", "put", key, "--config", deployConfig], { cwd: "worker", input: value, stdio: ["pipe", "ignore", "inherit"] });
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
