#!/usr/bin/env -S node --no-warnings
import { parseArgs, styleText } from "node:util";
import { type Item, stubPayloads } from "@agent-tracker/core";
import { accessToken, login, logout, signedInAs } from "./auth.ts";
import { CONFIG_KEYS, type ConfigKey, configPath, defaultMachine, machineName, readConfig, writeConfig } from "./config.ts";
import { hook } from "./hook.ts";
import { task, TASK_USAGE } from "./task.ts";

const USAGE = `agnt-trkr — track agent work

  agnt-trkr ls [--state s] [--agent a] [--source s] [--home h] [--repo r] [-q text] [--all]
  agnt-trkr show <id>          item detail, events and PRs (full id or native id)
  agnt-trkr decisions          what needs me
  agnt-trkr prs                PRs seen in status lines
  agnt-trkr timeline [--minutes 30]
  agnt-trkr summary
  agnt-trkr login [--remote]   sign in (Cloudflare Access via the tracker); --remote prints a URL + code prompt
  agnt-trkr logout | whoami    forget the stored sign-in / show who you are
  agnt-trkr token              print a fresh access token (for plugins and scripts)
  agnt-trkr config [get <key> | set <key> <value> | unset <key>]   per-machine settings: url, machine
                            (machine: how this machine shows on tasks; default whoami@hostname)
  agnt-trkr inbox [--source s] [--home h] [--wait <secs>|forever] [--peek]
                            answers and messages waiting for a source that seeds items (e.g. firstmate);
                            claims them (delivered once) and prints JSON. Exit 0 = something delivered, 3 = nothing.
  agnt-trkr rm <id>…           delete items/tasks and their history (stray test tasks)
  agnt-trkr seed               load the stub fleet into the backend (local dev)
  agnt-trkr task …             for agents: start | update | ask | answers | done | fail (agnt-trkr task help)
  agnt-trkr hook <claude-code|codex|devin> <session-start|prompt|stop|session-end>   harness hook handler (stdin: hook JSON)

  --json    raw JSON output
  env: AGENTS_URL (default http://localhost:8787), AGENTS_TOKEN
  config: ~/.config/agent-tracker/config.json  {"url": "...", "token": "..."}`;

function config() {
  const file = readConfig();
  const url = (process.env.AGENTS_URL ?? file.url ?? "http://localhost:8787").replace(/\/$/, "");
  return { url, token: process.env.AGENTS_TOKEN ?? file.token };
}

/** The stored OAuth sign-in for this tracker, an explicit AGENTS_TOKEN, or (local dev with auth off) none. */
async function bearer(url: string, force = false) {
  return (await accessToken(url, force).catch(() => null)) ?? config().token ?? null;
}

async function call(path: string, init: RequestInit = {}, retried = false): Promise<any> {
  const { url } = config();
  const token = await bearer(url, retried);
  const res = await fetch(url + path, {
    ...init,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json", ...init.headers },
  }).catch((e) => {
    if (e?.name === "TimeoutError" || e?.name === "AbortError") throw e;
    throw new Error(`cannot reach ${url} (${e.cause?.code ?? e.message}). Is \`npm run dev -w @agent-tracker/worker\` running?`);
  });
  if (res.status === 401 && !retried && signedInAs(url)) return call(path, init, true); // refresh once
  if (res.status === 401) throw new Error(`not signed in to ${url}: run \`agnt-trkr login\`${process.env.SSH_CONNECTION ? " (or agnt-trkr login --remote)" : ""}`);
  const body: any = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${body.error ?? ""}${body.matches ? ": " + body.matches.join(", ") : ""}`);
  return body;
}

const COLOR: Record<string, Parameters<typeof styleText>[0]> = {
  needs_me: "yellow", answered: "magenta", failed: "red", underway: "cyan", gated: "magenta", landed: "green", idle: "gray", unknown: "gray",
};
const LABEL: Record<string, string> = { needs_me: "needs me", underway: "running", landed: "done" };
const tty = process.stdout.isTTY;
const paint = (c: Parameters<typeof styleText>[0], s: string) => (tty ? styleText(c, s) : s);
const state = (s: string) => paint(COLOR[s] ?? "gray", (LABEL[s] ?? s).padEnd(8));

export function ago(iso: string | null, now = Date.now()) {
  if (!iso) return "";
  const m = Math.round((now - Date.parse(iso)) / 60_000);
  return m < 60 ? `${m}m` : m < 2880 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
}
const cut = (s: string | null, n: number) => (!s ? "" : s.length > n ? s.slice(0, n - 1) + "…" : s);

function table(items: Item[]) {
  if (!items.length) return console.log(paint("gray", "nothing here"));
  const w = Math.min(Math.max(...items.map((i) => i.native_id.length)), 32);
  for (const i of items)
    console.log([
      state(i.state),
      cut(i.native_id, w).padEnd(w),
      paint("gray", cut(i.agent ?? i.owner ?? i.source, 12).padEnd(12)),
      ago(i.updated_at ?? i.last_seen).padStart(4),
      cut(i.title, 70),
    ].join("  "));
}

async function main(argv: string[]) {
  const { values: o, positionals: [cmd = "ls", ...rest] } = parseArgs({
    args: argv, allowPositionals: true,
    options: {
      json: { type: "boolean" }, all: { type: "boolean" }, help: { type: "boolean", short: "h" },
      state: { type: "string" }, agent: { type: "string" }, source: { type: "string" }, home: { type: "string" },
      repo: { type: "string" }, q: { type: "string", short: "q" }, minutes: { type: "string" },
      // agnt-trkr task
      detail: { type: "string" }, model: { type: "string" }, key: { type: "string" }, parent: { type: "string" }, url: { type: "string" }, task: { type: "string" },
      wait: { type: "string" }, harness: { type: "string" }, session: { type: "string" }, "ask-json": { type: "string" },
      question: { type: "string", multiple: true }, option: { type: "string", short: "o", multiple: true },
      "no-other": { type: "boolean" }, dispatch: { type: "boolean" }, status: { type: "string" }, note: { type: "string" },
      remote: { type: "boolean" }, machine: { type: "string" }, peek: { type: "boolean" },
    },
  });
  if (o.help || cmd === "help") return console.log(USAGE);
  const out = (data: unknown, pretty: () => void) => (o.json ? console.log(JSON.stringify(data, null, 2)) : pretty());

  switch (cmd) {
    case "ls": {
      const qs = new URLSearchParams();
      for (const k of ["state", "agent", "source", "home", "repo", "q"] as const) if (o[k]) qs.set(k, o[k]!);
      if (o.all) qs.set("all", "1");
      const items = await call(`/api/items?${qs}`);
      return out(items, () => table(items));
    }
    case "decisions": {
      const items = await call("/api/decisions");
      return out(items, () => table(items));
    }
    case "show": {
      if (!rest[0]) throw new Error("usage: agnt-trkr show <id>");
      const r = await call(`/api/items/${encodeURIComponent(rest[0])}`);
      return out(r, () => {
        const i: Item = r.item;
        console.log(`${state(i.state)} ${paint("bold", i.title)}`);
        console.log(paint("gray", `${i.id}  kind=${i.kind}${i.agent ? "  agent=" + i.agent : ""}${i.model ? "  model=" + i.model : ""}${i.repo ? "  repo=" + i.repo : ""}`));
        if (i.detail) console.log(i.detail);
        if (i.url) console.log(i.url);
        for (const p of r.prs) console.log(`${paint("green", "PR")} ${p.url}${p.verb ? "  " + p.verb : ""}`);
        for (const e of r.events) console.log(`  ${paint("gray", ago(e.ts).padStart(4))}  ${paint("bold", e.verb)} ${e.text}`);
      });
    }
    case "prs": {
      const prs = await call("/api/prs");
      return out(prs, () => prs.forEach((p: any) => console.log(`${ago(p.seen_at).padStart(4)}  ${(p.verb ?? "").padEnd(12)}  ${p.url}  ${paint("gray", p.title)}`)));
    }
    case "timeline": {
      const t = await call(`/api/timeline?minutes=${o.minutes ?? 30}`);
      return out(t, () => {
        const lanes = Map.groupBy(t.items as Item[], (i) => i.agent ?? i.owner ?? i.source);
        for (const [lane, items] of lanes) {
          console.log(paint("bold", lane) + paint("gray", items[0].model ? `  ${items[0].model}` : ""));
          for (const i of items) console.log(`  ${state(i.state)}  ${ago(i.started_at ?? i.first_seen).padStart(4)} → ${ago(i.updated_at).padEnd(4)}  ${i.title}`);
        }
      });
    }
    case "summary": {
      const s = await call("/api/summary");
      return out(s, () => {
        console.log(Object.entries(s.counts).map(([k, n]) => `${state(k).trim()} ${n}`).join("   "));
        for (const l of s.last_ingest) console.log(paint("gray", `synced ${l.source}/${l.home} ${ago(l.at)} ago`));
      });
    }
    case "seed": {
      const r = await call("/api/ingest", { method: "POST", body: JSON.stringify(stubPayloads()) });
      return out(r, () => r.results.forEach((x: any) => console.log(`seeded ${x.source}/${x.home}: ${x.items} items, ${x.events} events`)));
    }
    case "login": {
      const { url } = config();
      const c = await login(url, { remote: o.remote });
      return console.log(`Signed in to ${url}${c.email ? ` as ${c.email}` : ""}.`);
    }
    case "logout":
      return console.log(logout(config().url) ? "Signed out." : "Not signed in.");
    case "whoami": {
      const me = await call("/api/me");
      return out(me, () => console.log(`${me.email}${me.auth === "disabled" ? " (auth disabled: local dev)" : ""} @ ${config().url}`));
    }
    case "token": {
      const t = await bearer(config().url);
      if (!t) throw new Error("not signed in: run `agnt-trkr login`");
      return console.log(t);
    }
    case "rm": {
      if (!rest.length) throw new Error("usage: agnt-trkr rm <id>…");
      for (const id of rest) console.log(JSON.stringify(await call(`/api/items/${encodeURIComponent(id)}`, { method: "DELETE" })));
      return;
    }
    case "inbox": {
      // For external systems that seed items (fleet snapshots, the collector): a watcher runs this and wakes
      // whatever should act. Long-polls in <=50s slices; --wait forever keeps going (and rides out restarts).
      const qs = new URLSearchParams();
      if (o.source) qs.set("source", o.source);
      if (o.home) qs.set("home", o.home);
      const forever = o.wait === "forever";
      const until = Date.now() + (forever ? Infinity : Math.max(Number(o.wait ?? 0), 0) * 1000);
      for (;;) {
        const left = Math.min(50, Math.max(0, Math.floor((until - Date.now()) / 1000)));
        qs.set("wait", String(left));
        let p: any;
        try {
          p = await call(`/api/inbox?${qs}`, { signal: AbortSignal.timeout((left + 10) * 1000) });
        } catch (e) {
          if (!forever) throw e;
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
        if (p.pending > 0) {
          const entries = o.peek ? p.entries : await call(`/api/inbox?${qs}`, { method: "POST" });
          console.log(JSON.stringify({ pending: entries.length, claimed: !o.peek, entries }));
          return;
        }
        if (Date.now() >= until) {
          if (o.json) console.log(JSON.stringify({ pending: 0, entries: [] }));
          process.exitCode = 3;
          return;
        }
      }
    }
    case "config": {
      const [sub, key, ...val] = rest;
      if (!sub) {
        const c = readConfig();
        return out({ ...c, token: c.token ? "<set>" : undefined, path: configPath }, () => {
          console.log(`url      ${config().url}${c.url ? "" : "  (default)"}`);
          console.log(`machine  ${machineName()}${c.machine ? "" : `  (default: ${defaultMachine()})`}`);
          console.log(`file     ${configPath}`);
        });
      }
      if (!CONFIG_KEYS.includes(key as ConfigKey)) throw new Error(`key must be one of ${CONFIG_KEYS.join(", ")}`);
      if (sub === "get") return console.log(key === "machine" ? machineName() : key === "url" ? config().url : readConfig()[key as ConfigKey] ?? "");
      if (sub === "set") {
        if (!val.length) throw new Error(`usage: agnt-trkr config set ${key} <value>`);
        writeConfig(key as ConfigKey, val.join(" "));
        return console.log(`${key} = ${key === "token" ? "<set>" : val.join(" ")}`);
      }
      if (sub === "unset") return (writeConfig(key as ConfigKey, null), console.log(`${key} unset`));
      throw new Error("usage: agnt-trkr config [get <key> | set <key> <value> | unset <key>]");
    }
    case "hook":
      return hook(call, rest[0], rest[1]);
    case "task":
      if (!rest.length || rest[0] === "help") return console.log(TASK_USAGE);
      // Agents read JSON best; -q/-o order matters, so the raw argv is passed through.
      return task(call, rest, o, argv, (r) => console.log(JSON.stringify(r)));
    default:
      throw new Error(`unknown command ${cmd}\n\n${USAGE}`);
  }
}

if (import.meta.main ?? process.argv[1]?.endsWith("main.ts")) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(paint("red", "error: ") + e.message);
    process.exit(1);
  });
}
