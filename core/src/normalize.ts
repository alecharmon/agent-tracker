import type { EventIn, IngestPayload, ItemIn, State } from "./types.ts";

const PR_RE = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;
const LINE_RE = /^(\d{4}-\d\d-\d\dT[\d:.]+Z)?\s*([A-Z][A-Z0-9_-]*)(?::\s*|\s+|$)(.*)$/;

export function prUrls(text: string): string[] {
  return [...new Set(text.match(PR_RE) ?? [])];
}

/** The bearings script's stdout ends in terminal escapes; take the leading JSON value. */
export function parseLeadingJson(text: string): any {
  const start = text.indexOf("{");
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return JSON.parse(text.slice(start, i + 1));
  }
  throw new Error("no complete JSON object in input");
}

// Higher wins when one native id shows up in several snapshot lists.
const RANK: Record<State, number> = { needs_me: 7, answered: 6, review: 6, validating: 5, failed: 5, underway: 4, gated: 3, landed: 2, idle: 1, unknown: 0 };

/** fm-bearings.v1 snapshot -> one ingest for (firstmate, home). */
export function fromBearings(snap: any): IngestPayload {
  const items = new Map<string, ItemIn>();
  const put = (it: ItemIn) => {
    const prev = items.get(it.native_id);
    if (!prev || RANK[it.state] > RANK[prev.state]) items.set(it.native_id, it);
  };
  for (const x of snap.in_flight ?? [])
    put({ native_id: x.id, kind: x.kind ?? "ship", state: "underway", title: x.name ?? x.id, detail: x.doing, repo: x.repo, raw: x });
  for (const x of snap.secondmates ?? [])
    put({ native_id: x.id ?? x.name, kind: "secondmate", state: "underway", title: x.name ?? x.id, detail: x.doing ?? x.state, raw: x });
  for (const x of snap.decisions_open ?? [])
    put({ native_id: x.id, kind: "decision", state: "needs_me", title: x.summary ?? x.id, detail: x.verb, owner: x.owner, raw: x });
  for (const x of snap.gates ?? [])
    put({
      native_id: x.id, kind: "gate", state: "gated", title: x.title ?? x.id,
      detail: [x.blocked_by, x.reason].filter((v) => v && v !== "-").join(" · ") || null,
      owner: x.owner, updated_at: x.filed, raw: x,
    });
  for (const x of snap.landed ?? [])
    put({ native_id: x.id, kind: "landed", state: "landed", title: x.what ?? x.id, detail: x.artifact, owner: x.owner, raw: x });
  for (const pr of snap.recorded_prs ?? []) {
    const url = typeof pr === "string" ? pr : pr.url;
    const it = pr.id && items.get(pr.id);
    if (it && url && !it.url) it.url = url;
  }
  // Firstmate's own work ("(main)" or no owner) is one timeline lane; secondmates get their own.
  for (const it of items.values()) it.agent = !it.owner || it.owner === "(main)" ? "firstmate" : it.owner;
  return { source: "firstmate", home: snap.home ?? "firstmate", items: [...items.values()] };
}

/** Classify a brief by its last status line. */
export function stateFromLine(verb: string, ts: string | null, now: Date): State {
  if (/^(BLOCKED|NEEDS|QUESTION|DECISION-NEEDED)/.test(verb)) return "needs_me";
  if (/^(FAILED|ERROR)/.test(verb)) return "failed";
  if (/^(DONE|MERGED|LANDED)/.test(verb)) return "landed";
  if (!ts) return "unknown";
  return now.getTime() - Date.parse(ts) < 24 * 3600_000 ? "underway" : "idle";
}

/**
 * `tail` output over many `<briefs>/<name>/status.log` files (with `==> path <==` headers)
 * -> one ingest for (herdr, home). Each brief is an item; each line is an event.
 */
export function fromStatusLogs(text: string, home: string, now = new Date()): IngestPayload {
  const items: ItemIn[] = [];
  const events: EventIn[] = [];
  let cur: { name: string; lines: EventIn[] } | null = null;
  const flush = () => {
    if (!cur || !cur.lines.length) return;
    const last = cur.lines[cur.lines.length - 1];
    const lastTs = [...cur.lines].reverse().find((l) => l.ts)?.ts ?? null;
    const prs = cur.lines.flatMap((l) => prUrls(l.text));
    items.push({
      native_id: cur.name, kind: "brief", state: stateFromLine(last.verb, lastTs, now),
      title: cur.name, agent: cur.name, started_at: cur.lines.find((l) => l.ts)?.ts ?? null, detail: `${last.verb}${last.text ? ": " + last.text : ""}`.slice(0, 500),
      url: prs.at(-1) ?? null, updated_at: lastTs,
    });
    events.push(...cur.lines);
  };
  let lastTs: string | null = null;
  for (const raw of text.split("\n")) {
    const header = raw.match(/^==> (.*) <==$/);
    if (header) {
      flush();
      const parts = header[1].split("/");
      cur = { name: parts.at(-2) ?? header[1], lines: [] };
      lastTs = null;
      continue;
    }
    const m = cur && raw.trim() && raw.match(LINE_RE);
    if (!m || !cur) continue;
    lastTs = m[1] ?? lastTs; // untimestamped lines inherit the previous line's time
    cur.lines.push({ native_id: cur.name, ts: lastTs, verb: m[2], text: m[3].trim() });
  }
  flush();
  return { source: "herdr", home, items, events };
}
