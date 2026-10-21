// Deploy-time Worker config: worker/wrangler.jsonc (committed, generic) + tracker.config.json (yours, gitignored)
// -> worker/.wrangler.deploy.json (gitignored). Keeps account ids and URLs out of the repo.
import { readFileSync, writeFileSync } from "node:fs";

export const DEPLOY_CONFIG = ".wrangler.deploy.json"; // relative to worker/

export function writeDeployConfig(trackerConfigPath = process.env.TRACKER_CONFIG ?? "tracker.config.json") {
  const cfg = JSON.parse(readFileSync(trackerConfigPath, "utf8"));
  for (const k of ["url", "account_id", "kv_namespace_id"])
    if (!cfg[k] || /</.test(cfg[k])) throw new Error(`tracker.config.json: set "${k}"`);
  // wrangler.jsonc only has whole-line comments (URLs inside strings contain "//", so strip lines, not substrings)
  const base = JSON.parse(readFileSync("worker/wrangler.jsonc", "utf8").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n"));
  const out = {
    ...base,
    account_id: cfg.account_id,
    kv_namespaces: base.kv_namespaces.map((n) => (n.binding === "OAUTH_KV" ? { ...n, id: cfg.kv_namespace_id } : n)),
    vars: { ...base.vars, TRACKER_URL: cfg.url.replace(/\/$/, "") },
  };
  writeFileSync(`worker/${DEPLOY_CONFIG}`, JSON.stringify(out, null, 2) + "\n");
  return DEPLOY_CONFIG;
}
