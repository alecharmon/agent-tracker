import { prUrls } from "./normalize.ts";
import type { IngestPayload, Item, ItemFilter, Pr, Summary, TrackerEvent } from "./types.ts";

export type Row = Record<string, any>;
export interface Stmt { sql: string; params?: unknown[] }

/** The whole storage contract. DO SQLite and node:sqlite each implement it in a few lines. */
export interface Db {
  all<T = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Runs atomically. */
  batch(stmts: Stmt[]): Promise<void>;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY, source TEXT NOT NULL, home TEXT NOT NULL, native_id TEXT NOT NULL,
    kind TEXT NOT NULL, state TEXT NOT NULL, title TEXT NOT NULL, detail TEXT, repo TEXT, owner TEXT, agent TEXT, model TEXT,
    url TEXT, started_at TEXT, updated_at TEXT, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
    present INTEGER NOT NULL DEFAULT 1, raw TEXT)`,
  `CREATE INDEX IF NOT EXISTS items_scope ON items (source, home)`,
  `CREATE INDEX IF NOT EXISTS items_state ON items (state, present)`,
  `CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY, item_id TEXT NOT NULL, ts TEXT, verb TEXT NOT NULL, text TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS events_item ON events (item_id, ts)`,
  `CREATE TABLE IF NOT EXISTS prs (
    url TEXT PRIMARY KEY, item_id TEXT NOT NULL, verb TEXT, sha TEXT, seen_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS ingests (
    id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, home TEXT NOT NULL, at TEXT NOT NULL,
    items INTEGER NOT NULL, events INTEGER NOT NULL)`,
];

export async function migrate(db: Db) {
  await db.batch(SCHEMA.map((sql) => ({ sql })));
}

export const itemId = (source: string, home: string, nativeId: string) => `${source}:${home}:${nativeId}`;

/** FNV-1a 64-bit, hex. Stable event ids so re-ingesting the same tail is idempotent. */
export function hash(s: string): string {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < s.length; i++) h = BigInt.asUintN(64, (h ^ BigInt(s.charCodeAt(i))) * 0x100000001b3n);
  return h.toString(16).padStart(16, "0");
}

export function validatePayload(p: any): asserts p is IngestPayload {
  const str = (v: unknown) => typeof v === "string" && v.length > 0 && v.length < 300;
  if (!p || !str(p.source) || !str(p.home) || !Array.isArray(p.items)) throw new Error("payload needs source, home, items[]");
  for (const it of p.items) if (!str(it?.native_id) || !str(it?.kind) || typeof it?.title !== "string") throw new Error("bad item");
  for (const e of p.events ?? []) if (!str(e?.native_id) || !str(e?.verb) || typeof e?.text !== "string") throw new Error("bad event");
}

export async function ingest(db: Db, p: IngestPayload, now = new Date().toISOString()) {
  const stmts: Stmt[] = [
    { sql: `UPDATE items SET present = 0 WHERE source = ? AND home = ?`, params: [p.source, p.home] },
  ];
  const sha = (t: string) => t.match(/\b[0-9a-f]{40}\b/)?.[0] ?? null;
  for (const it of p.items) {
    const id = itemId(p.source, p.home, it.native_id);
    stmts.push({
      sql: `INSERT INTO items (id, source, home, native_id, kind, state, title, detail, repo, owner, agent, model, url, started_at, updated_at, first_seen, last_seen, present, raw)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)
            ON CONFLICT (id) DO UPDATE SET kind=excluded.kind, state=excluded.state, title=excluded.title,
              detail=excluded.detail, repo=coalesce(excluded.repo, items.repo), owner=excluded.owner, agent=coalesce(excluded.agent, items.agent), model=coalesce(excluded.model, items.model),
              started_at=coalesce(items.started_at, excluded.started_at),
              url=coalesce(excluded.url, items.url), updated_at=coalesce(excluded.updated_at, items.updated_at),
              last_seen=excluded.last_seen, present=1, raw=excluded.raw`,
      params: [id, p.source, p.home, it.native_id, it.kind, it.state, it.title, it.detail ?? null, it.repo ?? null,
        it.owner ?? null, it.agent ?? null, it.model ?? null, it.url ?? null, it.started_at ?? null, it.updated_at ?? null, now, now, it.raw === undefined ? null : JSON.stringify(it.raw)],
    });
    for (const url of prUrls(`${it.url ?? ""} ${it.detail ?? ""}`))
      stmts.push({ sql: `INSERT OR IGNORE INTO prs (url, item_id, verb, sha, seen_at) VALUES (?,?,?,?,?)`, params: [url, id, null, null, now] });
  }
  for (const e of p.events ?? []) {
    const id = itemId(p.source, p.home, e.native_id);
    stmts.push({
      sql: `INSERT OR IGNORE INTO events (id, item_id, ts, verb, text) VALUES (?,?,?,?,?)`,
      params: [hash(`${id}|${e.ts}|${e.verb}|${e.text}`), id, e.ts, e.verb, e.text],
    });
    for (const url of prUrls(e.text))
      stmts.push({
        sql: `INSERT INTO prs (url, item_id, verb, sha, seen_at) VALUES (?,?,?,?,?)
              ON CONFLICT (url) DO UPDATE SET verb=excluded.verb, sha=coalesce(excluded.sha, prs.sha), seen_at=excluded.seen_at`,
        params: [url, id, e.verb, sha(e.text), e.ts ?? now],
      });
  }
  stmts.push({
    sql: `INSERT INTO ingests (source, home, at, items, events) VALUES (?,?,?,?,?)`,
    params: [p.source, p.home, now, p.items.length, p.events?.length ?? 0],
  });
  await db.batch(stmts);
  return { items: p.items.length, events: p.events?.length ?? 0 };
}

const ITEM_COLS = `id, source, home, native_id, kind, state, title, detail, repo, owner, agent, model, url, started_at, updated_at, first_seen, last_seen, present`;

export async function listItems(db: Db, f: ItemFilter = {}): Promise<Item[]> {
  const where: string[] = [], params: unknown[] = [];
  // Landed items drop out of the source snapshot quickly; keep them visible for a week.
  if (!f.all) {
    where.push("(present = 1 OR (state = 'landed' AND last_seen > ?))");
    params.push(new Date(Date.now() - 7 * 86400_000).toISOString());
  }
  for (const k of ["state", "source", "home", "repo", "kind", "agent"] as const)
    if (f[k]) { where.push(`${k} = ?`); params.push(f[k]); }
  if (f.q) {
    where.push("(title LIKE ? OR detail LIKE ? OR native_id LIKE ?)");
    params.push(...Array(3).fill(`%${f.q}%`));
  }
  params.push(Math.min(f.limit ?? 500, 2000));
  return db.all<Item>(
    `SELECT ${ITEM_COLS} FROM items ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY CASE state WHEN 'needs_me' THEN 0 WHEN 'failed' THEN 1 WHEN 'underway' THEN 2 WHEN 'gated' THEN 3 WHEN 'landed' THEN 4 ELSE 5 END,
       coalesce(updated_at, last_seen) DESC LIMIT ?`,
    params,
  );
}

/** Accepts a full id or a unique native id. */
export async function getItem(db: Db, idOrNative: string) {
  const rows = await db.all<Item & { raw: string | null }>(
    `SELECT ${ITEM_COLS}, raw FROM items WHERE id = ? OR native_id = ? LIMIT 2`, [idOrNative, idOrNative]);
  if (rows.length !== 1) return rows.length ? { ambiguous: rows.map((r) => r.id) } : null;
  const item = rows[0];
  const [events, prs] = await Promise.all([
    db.all<TrackerEvent>(`SELECT * FROM events WHERE item_id = ? ORDER BY ts DESC, rowid DESC LIMIT 200`, [item.id]),
    db.all<Pr>(`SELECT * FROM prs WHERE item_id = ? ORDER BY seen_at DESC`, [item.id]),
  ]);
  return { item: { ...item, raw: item.raw ? JSON.parse(item.raw) : null }, events, prs };
}

export async function listPrs(db: Db, limit = 100) {
  return db.all<Pr & { title: string }>(
    `SELECT prs.*, items.title FROM prs JOIN items ON items.id = prs.item_id ORDER BY prs.seen_at DESC LIMIT ?`, [limit]);
}

export async function summary(db: Db): Promise<Summary> {
  const rows = await db.all<{ state: string; n: number }>(`SELECT state, count(*) AS n FROM items WHERE present = 1 GROUP BY state`);
  const last = await db.all<{ source: string; home: string; at: string }>(
    `SELECT source, home, max(at) AS at FROM ingests GROUP BY source, home ORDER BY at DESC`);
  return { counts: Object.fromEntries(rows.map((r) => [r.state, Number(r.n)])), last_ingest: last };
}

/** Items active since `since` (plus anything still running or waiting) with their events in the window. */
export async function timeline(db: Db, since: string) {
  const items = await db.all<Item>(
    `SELECT ${ITEM_COLS} FROM items WHERE present = 1 AND
       (state IN ('underway', 'needs_me', 'failed') OR coalesce(updated_at, last_seen) >= ?)
     ORDER BY coalesce(agent, title), coalesce(started_at, first_seen)`, [since]);
  const events = await db.all<TrackerEvent>(
    `SELECT * FROM events WHERE ts >= ? ORDER BY ts`, [since]);
  return { since, items, events };
}
