import { prUrls } from "./normalize.ts";
import { type Db, getItem, hash, type Stmt } from "./store.ts";
import { type Ask, type CaptainMessage, PR_STATUSES, type PrStatus, type TrackerResponse } from "./types.ts";

// Agent-reported tasks. The task is the unit the captain tracks; agents join it as sessions.
// A task has a stable key (e.g. a first mate's task id) so the agent that plans it, the crewmate that
// builds it and the reviewer that checks it all report into one task.
// Agents hold an opaque handle `<task id>@<session id>`, so every call is attributed to its session.
// Unlike snapshot ingest, nothing here marks other items absent.

export const HARNESSES = ["claude-code", "codex", "opencode", "pi", "devin", "other"] as const;

/** Map an MCP clientInfo.name or a free-form harness name onto our harness ids. */
export function harnessOf(name: string | undefined | null): string {
  const n = (name ?? "").toLowerCase();
  if (/claude/.test(n)) return "claude-code";
  if (/codex/.test(n)) return "codex";
  if (/opencode/.test(n)) return "opencode";
  if (/devin|cognition|windsurf/.test(n)) return "devin";
  if (/^pi\b|pi-agent|pi-coding/.test(n)) return "pi";
  return n.replace(/[^a-z0-9-]/g, "").slice(0, 40) || "other";
}

export interface TaskStartIn {
  title: string;
  /** Stable task key. Starting with an existing key joins that task as a new session. */
  key?: string;
  /** Key or id of the task that dispatched this one. */
  parent?: string;
  /** Create the task for another agent to join by key; the caller doesn't join it. */
  dispatch?: boolean;
  detail?: string;
  harness?: string;
  machine?: string;
  repo?: string;
  model?: string;
  /** Lane name on the timeline; defaults to the harness. */
  agent?: string;
  /** Harness session id: starting again with it resumes the same session instead of adding one. */
  session?: string;
  url?: string;
}

const str = (v: unknown, max: number) => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const opt = (v: unknown, max: number) => v === undefined || v === null || (typeof v === "string" && v.length <= max);
function check(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`bad task: ${msg}`);
}

export const taskIdOf = (key: string) => `task:${key}`;
const KEY_RE = /^[A-Za-z0-9._/-]{1,120}$/;
const handle = (taskId: string, sessionId: string) => `${taskId}@${sessionId}`;
/** "<task id>@<session id>" -> parts. A bare task id or key works too (no session attribution). */
export function parseHandle(h: string) {
  const at = h.lastIndexOf("@");
  return at > 0 ? { task: h.slice(0, at), session: h.slice(at + 1) } : { task: h, session: null };
}

function eventStmts(id: string, ts: string, verb: string, text: string, session: string | null = null): Stmt[] {
  const out: Stmt[] = [{
    sql: `INSERT OR IGNORE INTO events (id, item_id, ts, verb, text, session_id) VALUES (?,?,?,?,?,?)`,
    params: [hash(`${id}|${ts}|${verb}|${text}`), id, ts, verb, text, session],
  }];
  for (const url of prUrls(text))
    out.push({
      sql: `INSERT INTO prs (url, item_id, verb, sha, seen_at) VALUES (?,?,?,NULL,?)
            ON CONFLICT (url) DO UPDATE SET verb=excluded.verb, seen_at=excluded.seen_at`,
      params: [url, id, verb, ts],
    });
  return out;
}

async function peekTask(db: Db, h: string) {
  const { task, session } = parseHandle(h);
  const r = (await getItem(db, task)) ?? (KEY_RE.test(task) ? await getItem(db, taskIdOf(task)) : null);
  if (!r || "ambiguous" in r) throw new Error(`not found: task ${task}`);
  return { item: r.item, session };
}

/** Resolve a handle, task id or key; touch the session; acknowledge answers it has already read. */
async function mustTask(db: Db, h: string, now: string) {
  const { task, session } = parseHandle(h);
  const r = (await getItem(db, task)) ?? (KEY_RE.test(task) ? await getItem(db, taskIdOf(task)) : null);
  if (!r) throw new Error(`not found: task ${task}`);
  if ("ambiguous" in r) throw new Error(`bad task: ambiguous id ${task}`);
  const item = r.item;
  const stmts: Stmt[] = [];
  if (session) stmts.push({ sql: `UPDATE sessions SET last_seen = ? WHERE id = ? AND task_id = ?`, params: [now, session, item.id] });
  // Any call after reading an answer proves the agent got it: answered -> running.
  const read = r.responses.find((x) => x.delivered_at && !x.acked_at);
  if (read)
    stmts.push(
      { sql: `UPDATE responses SET acked_at = ? WHERE item_id = ? AND delivered_at IS NOT NULL AND acked_at IS NULL`, params: [now, item.id] },
      { sql: `UPDATE items SET state = CASE WHEN state = 'answered' THEN 'underway' ELSE state END WHERE id = ?`, params: [item.id] },
      ...eventStmts(item.id, now, "ACKED", "picked up the answer", session),
    );
  // Queued captain messages ride along on the agent's next call, whatever the task's state.
  const queued = session ? r.messages.filter((m) => !m.delivered_at).reverse() : [];
  if (queued.length)
    stmts.push(
      { sql: `UPDATE messages SET delivered_at = ?, session_id = ? WHERE item_id = ? AND delivered_at IS NULL`, params: [now, session, item.id] },
      ...eventStmts(item.id, now, "DELIVERED", `${queued.length} message${queued.length > 1 ? "s" : ""} from the captain`, session),
    );
  if (stmts.length) await db.batch(stmts);
  return { item: read && item.state === "answered" ? { ...item, state: "underway" as const } : item, session, inbox: queued };
}

/** Answers spelled out, so the agent doesn't need to map ids back to labels. */
export function spellAnswers(ask: Ask | null, resp: Pick<TrackerResponse, "answers">) {
  return Object.entries(resp.answers ?? {}).map(([qid, a]) => {
    const q = ask?.questions.find((x) => x.id === qid);
    return {
      question_id: qid, question: q?.prompt ?? qid,
      ...(a.option ? { option_id: a.option, answer: q?.options.find((o) => o.id === a.option)?.label ?? a.option } : {}),
      ...(a.other ? { answer: a.other, free_text: true } : {}),
    };
  });
}

/** Attach delivered captain messages to an agent-facing result. */
const withInbox = <T extends object>(result: T, inbox: CaptainMessage[]) =>
  inbox.length
    ? { ...result, captain_messages: inbox.map((m) => ({ at: m.at, text: m.text })),
        note: "The captain sent you these messages: treat them as instructions and act on them." }
    : result;

export async function taskStart(db: Db, t: TaskStartIn, now = new Date().toISOString()) {
  check(str(t?.title, 200), "title is required (max 200 chars)");
  for (const k of ["detail", "harness", "machine", "repo", "model", "agent", "session", "url", "key", "parent"] as const)
    check(opt(t[k], k === "detail" ? 2000 : 300), `${k} too long`);
  check(t.key === undefined || t.key === null || KEY_RE.test(t.key), "key may use letters, digits and . _ / - (max 120)");
  const harness = harnessOf(t.harness);
  const machine = t.machine?.trim() || null;
  const key = t.key?.trim() || `t-${hash(`${harness}|${machine}|${now}|${Math.random()}`).slice(0, 10)}`;
  const id = taskIdOf(key);
  const found = await getItem(db, id);
  const existing = found && "item" in found ? found : null;
  let parent: string | null = null;
  if (t.parent?.trim()) {
    const p = (await getItem(db, parseHandle(t.parent.trim()).task)) ?? (await getItem(db, taskIdOf(t.parent.trim())));
    check(!!p && !("ambiguous" in p), `parent ${t.parent} not found: start the parent task first`);
    parent = (p as any).item.id;
    check(parent !== id, "a task cannot be its own parent");
  }
  const sid = t.session?.trim()
    ? `s-${hash(`${id}|${harness}|${t.session.trim()}`).slice(0, 10)}`
    : `s-${hash(`${id}|${harness}|${now}|${Math.random()}`).slice(0, 10)}`;
  const resumed = !!existing?.sessions.some((x) => x.id === sid);
  const text = t.detail?.trim() || t.title.trim();
  const lane = t.agent?.trim() || harness;
  if (t.dispatch) {
    check(!existing, `task ${key} already exists: give the new task its own key`);
    await db.batch([
      { sql: `INSERT INTO items (id, source, home, native_id, kind, state, title, detail, repo, owner, agent, model, url, started_at, updated_at, parent_id, first_seen, last_seen, present)
              VALUES (?, 'agents', 'tasks', ?, 'task', 'underway', ?,?,?, NULL, 'dispatched', NULL, ?,?,?,?,?,?, 1)`,
        params: [id, key, t.title.trim(), text, t.repo ?? null, t.url ?? null, now, now, parent, now, now] },
      ...eventStmts(id, now, "DISPATCHED", `${harness} dispatched: ${text}`),
    ]);
    return { task_id: id, key, dispatched: true };
  }
  await db.batch([
    {
      // A joining agent keeps the task's title; the first one names it.
      sql: `INSERT INTO items (id, source, home, native_id, kind, state, title, detail, repo, owner, agent, model, url, started_at, updated_at, parent_id, first_seen, last_seen, present)
            VALUES (?, 'agents', 'tasks', ?, 'task', 'underway', ?,?,?, NULL, ?,?,?,?,?,?,?,?, 1)
            ON CONFLICT (id) DO UPDATE SET
              state = CASE WHEN items.state IN ('needs_me', 'answered') THEN items.state ELSE 'underway' END,
              detail=excluded.detail, repo=coalesce(items.repo, excluded.repo), agent=excluded.agent, model=coalesce(excluded.model, items.model),
              url=coalesce(excluded.url, items.url), parent_id=coalesce(items.parent_id, excluded.parent_id),
              updated_at=excluded.updated_at, last_seen=excluded.last_seen, present=1`,
      params: [id, key, t.title.trim(), text, t.repo ?? null, lane, t.model ?? null, t.url ?? null, now, now, parent, now, now],
    },
    {
      sql: `INSERT INTO sessions (id, task_id, harness, model, machine, agent, started_at, last_seen, external_id) VALUES (?,?,?,?,?,?,?,?,?)
            ON CONFLICT (id) DO UPDATE SET last_seen=excluded.last_seen, ended_at=NULL, model=coalesce(excluded.model, sessions.model)`,
      params: [sid, id, harness, t.model ?? null, machine, lane, now, now, t.session?.trim() || null],
    },
    ...eventStmts(id, now, !existing ? "STARTED" : resumed ? "RESUMED" : "JOINED", `${harness}${t.model ? ` (${t.model})` : ""}: ${text}`, sid),
  ]);
  const delivered = await mustTask(db, handle(id, sid), now);
  const out = withInbox({ task_id: handle(id, sid), key, joined: !!existing && !resumed, resumed }, delivered.inbox);
  // A joining agent needs the state of play, including an ask still waiting on the captain.
  if (existing && existing.item.state !== "underway")
    return { ...out, state: existing.item.state, ...(existing.item.state === "needs_me" ? { waiting_on: existing.item.ask?.summary } : {}) };
  return out;
}

export async function taskUpdate(db: Db, idOrNative: string, u: { text: string; url?: string }, now = new Date().toISOString()) {
  check(str(u?.text, 2000), "text is required (max 2000 chars)");
  check(opt(u.url, 500), "url too long");
  const { item, session, inbox } = await mustTask(db, idOrNative, now);
  // An update while waiting on the captain doesn't clear the ask; only an answer does.
  await db.batch([
    { sql: `UPDATE items SET detail = ?, url = coalesce(?, url), updated_at = ?, last_seen = ?,
              state = CASE WHEN state IN ('needs_me', 'answered', 'review', 'validating') THEN state ELSE 'underway' END WHERE id = ?`,
      params: [u.text.trim(), u.url ?? null, now, now, item.id] },
    ...eventStmts(item.id, now, "WORKING", u.text.trim() + (u.url && !u.text.includes(u.url) ? ` ${u.url}` : ""), session),
  ]);
  const state = ["needs_me", "answered", "review", "validating"].includes(item.state) ? item.state : "underway";
  return withInbox({ task_id: idOrNative, state, ...(state === "answered" ? { note: "The captain answered your question: call task_answers to read it." } : {}) }, inbox);
}

export function validateAsk(a: any): asserts a is Ask {
  check(str(a?.summary, 2000), "summary is required: explain what you need and why (max 2000 chars)");
  check(Array.isArray(a.questions) && a.questions.length <= 5, "questions must be an array of at most 5");
  const ids = new Set<string>();
  for (const q of a.questions) {
    check(str(q?.id, 40) && !ids.has(q.id), "each question needs a unique id");
    ids.add(q.id);
    check(str(q.prompt, 300), `question ${q.id} needs a prompt`);
    check(Array.isArray(q.options) && q.options.length >= 1 && q.options.length <= 6, `question ${q.id} needs 1-6 options`);
    const oids = new Set<string>();
    for (const o of q.options) {
      check(str(o?.id, 40) && !oids.has(o.id), `question ${q.id}: each option needs a unique id`);
      oids.add(o.id);
      check(str(o.label, 120) && opt(o.description, 300), `question ${q.id}: option ${o.id} needs a label`);
    }
    check(q.allow_other === undefined || typeof q.allow_other === "boolean", "allow_other must be a boolean");
  }
}

export async function taskAsk(db: Db, idOrNative: string, ask: unknown, now = new Date().toISOString()) {
  validateAsk(ask);
  const { item, session, inbox } = await mustTask(db, idOrNative, now);
  check(!["landed", "failed"].includes(item.state), "task is finished; start a new one");
  const clean: Ask = {
    summary: ask.summary.trim(),
    questions: ask.questions.map((q) => ({
      id: q.id, prompt: q.prompt.trim(), allow_other: q.allow_other,
      options: q.options.map((o) => ({ id: o.id, label: o.label.trim(), ...(o.description ? { description: o.description.trim() } : {}) })),
    })),
  };
  await db.batch([
    { sql: `UPDATE items SET state = 'needs_me', ask = ?, detail = ?, updated_at = ?, last_seen = ? WHERE id = ?`,
      params: [JSON.stringify(clean), clean.summary, now, now, item.id] },
    ...eventStmts(item.id, now, "ASKED", clean.questions.map((q) => q.prompt).join(" / ") || clean.summary, session),
  ]);
  return withInbox({ task_id: idOrNative, state: "needs_me" as const }, inbox);
}

/**
 * The captain's answer to the latest ask, if there is one yet. Reading marks it delivered; the agent's
 * next call (of any kind) acknowledges it, so an answer lost to a timed-out read is never swallowed.
 */
export async function taskAnswer(db: Db, idOrNative: string, now = new Date().toISOString(), opts: { peek?: boolean } = {}) {
  // A peek (hooks watching for the answer) reads without touching the session or delivering.
  const { item, session, inbox } = opts.peek ? { ...(await peekTask(db, idOrNative)), inbox: [] as CaptainMessage[] } : await mustTask(db, idOrNative, now);
  const [ask] = await db.all<{ ts: string }>(
    `SELECT ts FROM events WHERE item_id = ? AND verb = 'ASKED' ORDER BY ts DESC, rowid DESC LIMIT 1`, [item.id]);
  if (!ask) return withInbox({ task_id: idOrNative, status: "no_question" as const }, inbox);
  const [r] = await db.all(`SELECT * FROM responses WHERE item_id = ? AND at >= ? ORDER BY id DESC LIMIT 1`, [item.id, ask.ts]);
  if (!r) return withInbox({ task_id: idOrNative, status: "pending" as const, state: item.state }, inbox);
  const resp = { ...r, answers: r.answers ? JSON.parse(r.answers) : undefined } as TrackerResponse;
  if (opts.peek) return { task_id: idOrNative, status: "answered" as const, delivered: !!resp.delivered_at, state: item.state };
  if (!resp.delivered_at)
    await db.batch([
      { sql: `UPDATE responses SET delivered_at = ? WHERE id = ?`, params: [now, resp.id] },
      ...eventStmts(item.id, now, "DELIVERED", "read the answer", session),
    ]);
  return withInbox({ task_id: idOrNative, status: "answered" as const, at: resp.at, answers: spellAnswers(item.ask, resp), feedback: resp.feedback ?? null }, inbox);
}

/**
 * The agent's part ends. done = merged and validated (or no PR, verified); review = PR open, waiting on the
 * captain; failed = couldn't do it. The session stays attached so the captain can still send follow-ups.
 */
export async function taskFinish(db: Db, idOrNative: string, f: { outcome: "done" | "review" | "failed"; text: string; url?: string }, now = new Date().toISOString()) {
  check(["done", "review", "failed"].includes(f?.outcome), "outcome must be done, review or failed");
  check(str(f.text, 2000), "text is required: say what happened (max 2000 chars)");
  check(opt(f.url, 500), "url too long");
  if (f.outcome === "review") check(!!(f.url || prUrls(f.text).length), "review needs the PR link (url)");
  const { item, session, inbox } = await mustTask(db, idOrNative, now);
  const state = f.outcome === "done" ? "landed" : f.outcome;
  const verb = { done: "DONE", review: "IN-REVIEW", failed: "FAILED" }[f.outcome];
  const reviewPrs = f.outcome === "review" ? [...new Set([f.url, ...prUrls(f.text)].filter((u): u is string => !!u && PR_RE.test(u)))] : [];
  await db.batch([
    ...reviewPrs.map((u) => ({
      sql: `INSERT INTO prs (url, item_id, verb, sha, seen_at, status) VALUES (?,?,'PR',NULL,?,'open')
            ON CONFLICT (url) DO UPDATE SET status = coalesce(prs.status, 'open'), item_id = excluded.item_id`,
      params: [u, item.id, now] })),
    { sql: `UPDATE items SET state = ?, detail = ?, url = coalesce(?, url), updated_at = ?, last_seen = ? WHERE id = ?`,
      params: [state, f.text.trim(), f.url ?? null, now, now, item.id] },
    ...eventStmts(item.id, now, verb, f.text.trim() + (f.url && !f.text.includes(f.url) ? ` ${f.url}` : ""), session),
  ]);
  return withInbox({ task_id: idOrNative, state }, inbox);
}

export async function captainMessage(db: Db, idOrNative: string, text: unknown, now = new Date().toISOString(), by: string | null = null) {
  check(str(text, 4000), "message text is required (max 4000 chars)");
  const item = (await peekTask(db, idOrNative)).item;
  await db.batch([
    { sql: `INSERT INTO messages (item_id, at, text, by) VALUES (?,?,?,?)`, params: [item.id, now, (text as string).trim(), by] },
    ...eventStmts(item.id, now, "MESSAGE", (text as string).trim()),
  ]);
  return { task_id: item.id, queued: true };
}

/** Captain moves a task along: the PR merged (agent validates next), validated (done), or closed unmerged. */
export async function captainStage(db: Db, idOrNative: string, stage: unknown, now = new Date().toISOString(), by: string | null = null) {
  check(["merged", "validated", "closed"].includes(stage as string), "stage must be merged, validated or closed");
  const item = (await peekTask(db, idOrNative)).item;
  const to = { merged: "validating", validated: "landed", closed: "failed" }[stage as "merged" | "validated" | "closed"];
  const verb = { merged: "MERGED", validated: "VALIDATED", closed: "CLOSED" }[stage as "merged" | "validated" | "closed"];
  const detail = { merged: "Merged; validating", validated: "Validated by the captain", closed: "PR closed without merging" }[stage as "merged" | "validated" | "closed"];
  const stmts: Stmt[] = [
    { sql: `UPDATE items SET state = ?, detail = ?, updated_at = ?, last_seen = ? WHERE id = ?`, params: [to, detail, now, now, item.id] },
    ...eventStmts(item.id, now, verb, by ? `${detail} (${by})` : detail),
  ];
  // The captain's call covers every PR still in flight on the task.
  if (stage !== "validated")
    stmts.push({ sql: `UPDATE prs SET status = ?, seen_at = ? WHERE item_id = ? AND coalesce(status, 'open') NOT IN ('merged', 'closed')`,
      params: [stage === "merged" ? "merged" : "closed", now, item.id] });
  if (stage === "merged") {
    const prs = (await db.all<{ url: string }>(`SELECT url FROM prs WHERE item_id = ? AND coalesce(status, 'open') != 'closed'`, [item.id])).map((p) => p.url);
    stmts.push({ sql: `INSERT INTO messages (item_id, at, text) VALUES (?,?,?)`,
      params: [item.id, now, `The captain marked it merged. ${VALIDATE(prs.join(", ") || item.url || "the PR")}`] });
  }
  await db.batch(stmts);
  return { task_id: item.id, state: to };
}

const PR_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;
const VALIDATE = (prs: string) =>
  `Merged: ${prs}. Validate it now: confirm the change works where it landed (tests on main, and the live behaviour if it is already deployed; deploying further is the captain's call), then call task_done with outcome done and what you checked, or report what failed.`;

/**
 * A task's PRs settle its state: every PR merged or closed (at least one merged) -> validating;
 * every PR closed unmerged -> failed. Returns the statements and the new state, if it changes.
 */
async function settle(db: Db, taskId: string, state: string, now: string, session: string | null) {
  const prs = await db.all<{ url: string; status: string | null }>(`SELECT url, status FROM prs WHERE item_id = ? AND status IS NOT NULL`, [taskId]);
  if (!prs.length || prs.some((p) => !["merged", "closed"].includes(p.status!)) || ["landed", "validating", "failed"].includes(state)) return null;
  const merged = prs.filter((p) => p.status === "merged").map((p) => p.url);
  const to = merged.length ? "validating" : "failed";
  return {
    to,
    stmts: [
      { sql: `UPDATE items SET state = ?, detail = ?, updated_at = ?, last_seen = ? WHERE id = ?`,
        params: [to, merged.length ? "Merged; validating" : "All PRs closed without merging", now, now, taskId] },
      ...eventStmts(taskId, now, merged.length ? "MERGED" : "CLOSED", merged.length ? `all PRs settled: ${merged.join(", ")}` : "all PRs closed unmerged", session),
    ] as Stmt[],
    merged,
  };
}

/** The agent reports one PR's status. A task can have several PRs. */
export async function taskPr(db: Db, idOrNative: string, p: { url: string; status: string; note?: string }, now = new Date().toISOString()) {
  check(typeof p?.url === "string" && PR_RE.test(p.url.trim()), "url must be a GitHub pull request URL");
  check(PR_STATUSES.includes(p.status as PrStatus), `status must be one of ${PR_STATUSES.join(", ")}`);
  check(opt(p.note, 500), "note too long");
  const { item, session, inbox } = await mustTask(db, idOrNative, now);
  const url = p.url.trim();
  await db.batch([
    { sql: `INSERT INTO prs (url, item_id, verb, sha, seen_at, status, note) VALUES (?,?,?,NULL,?,?,?)
            ON CONFLICT (url) DO UPDATE SET item_id=excluded.item_id, status=excluded.status, note=excluded.note, seen_at=excluded.seen_at, verb=excluded.verb`,
      params: [url, item.id, "PR", now, p.status, p.note?.trim() || null] },
    { sql: `UPDATE items SET url = coalesce(url, ?), updated_at = ?, last_seen = ? WHERE id = ?`, params: [url, now, now, item.id] },
    ...eventStmts(item.id, now, `PR-${p.status.toUpperCase().replace("_", "-")}`, `${url}${p.note ? ` ${p.note.trim()}` : ""}`, session),
  ]);
  const s = await settle(db, item.id, item.state, now, session);
  if (s) await db.batch(s.stmts);
  const out = { task_id: idOrNative, pr: { url, status: p.status }, state: s?.to ?? item.state };
  // The agent that reported the merge validates next; say so in the reply rather than a queued message.
  return withInbox(s?.to === "validating" ? { ...out, note: VALIDATE(s.merged.join(", ")) } : out, inbox);
}

/** What a hook watcher waits for: an undelivered answer or queued captain messages. Never delivers. */
export async function taskPending(db: Db, idOrNative: string) {
  const { item } = await peekTask(db, idOrNative);
  const r = await getItem(db, item.id);
  const d = r && "item" in r ? r : null;
  const [ask] = await db.all<{ ts: string }>(
    `SELECT ts FROM events WHERE item_id = ? AND verb = 'ASKED' ORDER BY ts DESC, rowid DESC LIMIT 1`, [item.id]);
  const answer = ask ? d?.responses.find((x) => x.at >= ask.ts) : undefined;
  return {
    state: item.state,
    answer: !ask ? "none" : !answer ? "pending" : answer.delivered_at ? "delivered" : "ready",
    messages: d?.messages.filter((m) => !m.delivered_at).length ?? 0,
  };
}

// Harness hooks: they know the harness's own session id, not our task handle.

/** The task this harness session is working on (its most recent), or null. */
export async function sessionTask(db: Db, harness: string, external: string) {
  const [s] = await db.all<{ id: string; task_id: string; ended_at: string | null }>(
    `SELECT id, task_id, ended_at FROM sessions WHERE harness = ? AND external_id = ? ORDER BY started_at DESC LIMIT 1`,
    [harnessOf(harness), external]);
  if (!s) return null;
  const r = await getItem(db, s.task_id);
  if (!r || "ambiguous" in r) return null;
  return {
    task_id: handle(s.task_id, s.id), title: r.item.title, state: r.item.state,
    waiting: r.item.state === "needs_me" || r.item.state === "answered",
  };
}

/**
 * Liveness from hooks, without the model:
 * idle — the turn ended with the task still running; active — the agent picked back up; end — the session closed.
 * Asks are never touched: a task waiting on the captain stays needs_me / answered.
 */
export async function sessionSignal(db: Db, harness: string, external: string, kind: "idle" | "active" | "end", now = new Date().toISOString()) {
  check(["idle", "active", "end"].includes(kind), "signal must be idle, active or end");
  const t = await sessionTask(db, harness, external);
  if (!t) return { task_id: null, state: null };
  const { task, session } = parseHandle(t.task_id);
  const to = kind === "active" ? (t.state === "idle" ? "underway" : t.state) : t.state === "underway" ? "idle" : t.state;
  const stmts: Stmt[] = [
    { sql: `UPDATE sessions SET last_seen = ?${kind === "end" ? ", ended_at = ?" : ""} WHERE id = ?`, params: kind === "end" ? [now, now, session] : [now, session] },
  ];
  if (to !== t.state) {
    stmts.push({ sql: `UPDATE items SET state = ?, last_seen = ? WHERE id = ?`, params: [to, now, task] });
    stmts.push(...eventStmts(task, now, kind === "active" ? "ACTIVE" : kind === "end" ? "ENDED" : "IDLE",
      kind === "active" ? "back at work" : kind === "end" ? "session closed" : "turn ended; waiting for input", session));
  }
  await db.batch(stmts);
  return { task_id: t.task_id, state: to };
}

// ---- inboxes: everything waiting for an agent or an external system ----------------------------------------

export interface InboxEntry {
  task_id: string; // a handle with this session where it owns the task; else the bare id
  title: string;
  state: string;
  answer: { at: string; answers: ReturnType<typeof spellAnswers>; feedback: string | null } | null;
  messages: { at: string; text: string }[];
}

/**
 * Collect undelivered answers and captain messages on `taskIds`. With `deliver`, mark them delivered (and, with
 * `ack`, acknowledged too: for systems with no agent session to acknowledge later).
 */
async function inboxFor(db: Db, taskIds: string[], opts: { deliver: boolean; ack: boolean; sessionOf: (task: string) => string | null; now: string }) {
  if (!taskIds.length) return [];
  const marks = taskIds.map(() => "?").join(",");
  const [items, resps, msgs] = await Promise.all([
    db.all<{ id: string; title: string; state: string; ask: string | null }>(`SELECT id, title, state, ask FROM items WHERE id IN (${marks})`, taskIds),
    db.all<{ id: number; item_id: string; at: string; answers: string | null; feedback: string | null }>(
      `SELECT id, item_id, at, answers, feedback FROM responses WHERE item_id IN (${marks}) AND delivered_at IS NULL ORDER BY id`, taskIds),
    db.all<{ id: number; item_id: string; at: string; text: string }>(
      `SELECT id, item_id, at, text FROM messages WHERE item_id IN (${marks}) AND delivered_at IS NULL ORDER BY id`, taskIds),
  ]);
  const out: InboxEntry[] = [];
  const stmts: Stmt[] = [];
  for (const it of items) {
    const rs = resps.filter((r) => r.item_id === it.id);
    const ms = msgs.filter((m) => m.item_id === it.id);
    if (!rs.length && !ms.length) continue;
    const last = rs.at(-1);
    const ask = it.ask ? (JSON.parse(it.ask) as Ask) : null;
    const session = opts.sessionOf(it.id);
    out.push({
      task_id: session ? handle(it.id, session) : it.id,
      title: it.title, state: it.state,
      answer: last ? { at: last.at, answers: spellAnswers(ask, { answers: last.answers ? JSON.parse(last.answers) : undefined }), feedback: last.feedback } : null,
      messages: ms.map((m) => ({ at: m.at, text: m.text })),
    });
    if (!opts.deliver) continue;
    if (rs.length)
      stmts.push({ sql: `UPDATE responses SET delivered_at = ?${opts.ack ? ", acked_at = ?" : ""} WHERE item_id = ? AND delivered_at IS NULL`,
        params: opts.ack ? [opts.now, opts.now, it.id] : [opts.now, it.id] });
    if (rs.length && opts.ack)
      stmts.push({ sql: `UPDATE items SET state = CASE WHEN state = 'answered' THEN 'underway' ELSE state END, updated_at = ? WHERE id = ?`, params: [opts.now, it.id] });
    if (ms.length)
      stmts.push({ sql: `UPDATE messages SET delivered_at = ?, session_id = ? WHERE item_id = ? AND delivered_at IS NULL`, params: [opts.now, session, it.id] });
    const what = [rs.length ? "the answer" : "", ms.length ? `${ms.length} message${ms.length > 1 ? "s" : ""}` : ""].filter(Boolean).join(" and ");
    stmts.push(...eventStmts(it.id, opts.now, "DELIVERED", `${what} delivered${session ? "" : " to its source"}`, session));
  }
  if (stmts.length) await db.batch(stmts);
  return out;
}

/**
 * Everything waiting for one harness session: answers and messages on every task it started or joined, and on the
 * tasks it dispatched. A first mate runs many tasks from one session; any of them should wake it.
 */
export async function sessionInbox(db: Db, harness: string, external: string, opts: { deliver?: boolean; now?: string } = {}) {
  const sessions = await db.all<{ id: string; task_id: string }>(
    `SELECT id, task_id FROM sessions WHERE harness = ? AND external_id = ? ORDER BY started_at`, [harnessOf(harness), external]);
  const own = new Map(sessions.map((s) => [s.task_id, s.id])); // latest session per task wins
  if (!own.size) return { tasks: 0, waiting: false, entries: [] as InboxEntry[] };
  const ownIds = [...own.keys()];
  const children = (await db.all<{ id: string }>(
    `SELECT id FROM items WHERE parent_id IN (${ownIds.map(() => "?").join(",")})`, ownIds)).map((r) => r.id);
  const ids = [...new Set([...ownIds, ...children])];
  const states = await db.all<{ state: string }>(`SELECT state FROM items WHERE id IN (${ids.map(() => "?").join(",")})`, ids);
  const entries = await inboxFor(db, ids, {
    deliver: !!opts.deliver, ack: false, now: opts.now ?? new Date().toISOString(), sessionOf: (t) => own.get(t) ?? null,
  });
  return { tasks: ids.length, waiting: states.some((s) => s.state === "needs_me"), entries };
}

/**
 * Everything waiting for an external system that seeds items (a fleet snapshot, the collector): answers and
 * messages on its items. Claiming acknowledges them too: no agent session will call back for these items.
 */
export async function sourceInbox(db: Db, scope: { source?: string; home?: string }, opts: { deliver?: boolean; now?: string } = {}) {
  const where = ["source != 'agents'"];
  const params: unknown[] = [];
  if (scope.source) (where.push("source = ?"), params.push(scope.source));
  if (scope.home) (where.push("home = ?"), params.push(scope.home));
  const ids = (await db.all<{ id: string }>(
    `SELECT id FROM items WHERE ${where.join(" AND ")} AND (
       EXISTS (SELECT 1 FROM responses r WHERE r.item_id = items.id AND r.delivered_at IS NULL) OR
       EXISTS (SELECT 1 FROM messages m WHERE m.item_id = items.id AND m.delivered_at IS NULL))`, params)).map((r) => r.id);
  return inboxFor(db, ids, { deliver: !!opts.deliver, ack: true, now: opts.now ?? new Date().toISOString(), sessionOf: () => null });
}
