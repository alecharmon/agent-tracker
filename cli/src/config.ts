import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { dirname, join } from "node:path";

// Per-machine settings: ~/.config/agent-tracker/config.json
//   url      the tracker (default http://localhost:8787; AGENTS_URL overrides)
//   machine  how this machine appears on tasks (default `whoami`@hostname; AGENTS_MACHINE overrides)
//   token    an explicit bearer token (rarely needed; `agnt-trkr login` is the normal path)

export const configPath = join(homedir(), ".config/agent-tracker/config.json");
export const CONFIG_KEYS = ["url", "machine", "token"] as const;
export type ConfigKey = (typeof CONFIG_KEYS)[number];

export function readConfig(): Partial<Record<ConfigKey, string>> {
  try {
    return JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return {};
  }
}

export function writeConfig(key: ConfigKey, value: string | null) {
  const c = readConfig();
  if (value === null) delete c[key];
  else c[key] = value;
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
  chmodSync(configPath, 0o600);
}

export const defaultMachine = () => `${userInfo().username}@${hostname().split(".")[0]}`;

/** This machine's name on tasks. */
export const machineName = () => process.env.AGENTS_MACHINE?.trim() || readConfig().machine?.trim() || defaultMachine();
