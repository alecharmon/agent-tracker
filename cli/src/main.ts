#!/usr/bin/env -S node --no-warnings
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs, styleText } from "node:util";
import { type Item, stubPayloads } from "@agent-tracker/core";

const USAGE = `agents — track agent work

  agents ls [--state s] [--agent a] [--source s] [--home h] [--repo r] [-q text] [--all]
  agents show <id>          item detail, events and PRs (full id or native id)
  agents decisions          what needs me
  agents prs                PRs seen in status lines
  agents timeline [--minutes 30]
  agents summary
  agents seed               load the stub fleet into the backend (local dev)

  --json    raw JSON output
  env: AGENTS_URL (default http://localhost:8787), AGENTS_TOKEN
  config: ~/.config/agent-tracker/config.json  {"url": "...", "token": "..."}`;

function config() {
  let file: { url?: string; token?: string } = {};
  try {
    file = JSON.parse(readFileSync(join(homedir(), ".config/agent-tracker/config.json"), "utf8"));
  } catch {}
  const url = (process.env.AGENTS_URL ?? file.url ?? "http://localhost:8787").replace(/\/$/, "");
  // ponytail: the dev token only ever applies to a local wrangler dev server.
  const local = /^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(url);
  const token = process.env.AGENTS_TOKEN ?? file.token ?? (local ? "dev-token" : undefined);
  return { url, token };
}

async function call(path: string, init: RequestInit = {}) {
  const { url, token } = config();
  if (!token) throw new Error("no token: set AGENTS_TOKEN or ~/.config/agent-tracker/config.json");
  const res = await fetch(url + path, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers },
  }).catch((e) => {
    throw new Error(`cannot reach ${url} (${e.cause?.code ?? e.message}). Is \`npm run dev -w @agent-tracker/worker\` running?`);
  });
  const body: any = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${body.error ?? ""}${body.matches ? ": " + body.matches.join(", ") : ""}`);
  return body;
}

const COLOR: Record<string, Parameters<typeof styleText>[0]> = {
  needs_me: "yellow", failed: "red", underway: "cyan", gated: "magenta", landed: "green", idle: "gray", unknown: "gray",
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
      if (!rest[0]) throw new Error("usage: agents show <id>");
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
