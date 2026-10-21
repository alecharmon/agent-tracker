import assert from "node:assert/strict";
import { test } from "node:test";
import { fromBearings, fromStatusLogs, parseLeadingJson } from "./normalize.ts";
import { nodeDb } from "./node-sqlite.ts";
import { getItem, ingest, listItems, listPrs, migrate, summary } from "./store.ts";

const now = new Date("2026-10-20T21:00:00Z");
const snap = {
  schema: "fm-bearings.v1", home: "vm/firstmate",
  in_flight: [{ id: "a", kind: "ship", repo: "r", name: "Ship A", doing: "coding" }],
  decisions_open: [{ id: "d", summary: "Pick X", verb: "captain-hold", owner: "(main)" }],
  gates: [{ id: "d", title: "dup of decision", blocked_by: "-", reason: "-", filed: "2026-10-01" },
          { id: "g", title: "Gate G", blocked_by: "a", reason: "-", filed: "2026-10-02" }],
  landed: [{ id: "l", what: "Report L", artifact: "data/l.md" }],
};
const logs = [
  "==> /home/x/briefs/one/status.log <==",
  "2026-10-20T20:00:00Z WORKING: on it",
  "PR-READY https://github.com/o/r/pull/7 " + "a".repeat(40),
  "==> /home/x/briefs/two/status.log <==",
  "2026-10-10T10:00:00Z WORKING: old",
  "==> /home/x/briefs/three/status.log <==",
  "2026-10-20T20:30:00Z BLOCKED: login needed",
].join("\n");

test("parseLeadingJson ignores trailing terminal escapes and braces in strings", () => {
  assert.deepEqual(parseLeadingJson('{"a":"}{"}\n\x1b[?25h'), { a: "}{" });
});

test("fromBearings maps lists to states; decision wins over gate", () => {
  const p = fromBearings(snap);
  const by = Object.fromEntries(p.items.map((i) => [i.native_id, i.state]));
  assert.deepEqual(by, { a: "underway", d: "needs_me", g: "gated", l: "landed" });
  assert.equal(p.items.find((i) => i.native_id === "g")!.detail, "a");
});

test("fromStatusLogs: state from last line, PR + inherited ts", () => {
  const p = fromStatusLogs(logs, "worker-host", now);
  const by = Object.fromEntries(p.items.map((i) => [i.native_id, i]));
  assert.equal(by.one.state, "underway");
  assert.equal(by.one.url, "https://github.com/o/r/pull/7");
  assert.equal(by.two.state, "idle");
  assert.equal(by.three.state, "needs_me");
  assert.equal(p.events!.find((e) => e.verb === "PR-READY")!.ts, "2026-10-20T20:00:00Z");
});

test("store: ingest is idempotent, absent items go present=0, filters work", async () => {
  const db = nodeDb();
  await migrate(db);
  const t = now.toISOString();
  await ingest(db, fromBearings(snap), t);
  await ingest(db, fromStatusLogs(logs, "worker-host", now), t);
  await ingest(db, fromStatusLogs(logs, "worker-host", now), t);
  assert.equal((await db.all("SELECT count(*) n FROM events"))[0].n, 4);
  assert.equal((await listPrs(db))[0].sha, "a".repeat(40));

  await ingest(db, { ...fromBearings(snap), items: fromBearings(snap).items.filter((i) => i.native_id !== "a") }, t);
  assert.ok(!(await listItems(db)).some((i) => i.native_id === "a"));
  assert.ok((await listItems(db, { all: true })).some((i) => i.native_id === "a"));
  assert.deepEqual((await listItems(db, { state: "needs_me" })).map((i) => i.native_id).sort(), ["d", "three"]);
  assert.equal((await listItems(db, { q: "login" })).length, 1);

  const one = await getItem(db, "one");
  assert.ok(one && "item" in one && one.events.length === 2 && one.prs.length === 1);
  assert.equal((await summary(db)).counts.needs_me, 2);
});

test("timeline returns active items and windowed events", async () => {
  const db = nodeDb();
  await migrate(db);
  await ingest(db, fromStatusLogs(logs, "worker-host", now), now.toISOString());
  const { timeline } = await import("./store.ts");
  const t = await timeline(db, "2026-10-20T19:00:00Z");
  assert.deepEqual(t.items.map((i) => i.native_id).sort(), ["one", "three"]);
  assert.equal(t.events.length, 3);
});

test("stub seeds replace their own events instead of piling up", async () => {
  const db = nodeDb();
  await migrate(db);
  const { stubPayloads } = await import("./fixtures.ts");
  for (const at of [now, new Date(now.getTime() + 60_000)]) for (const p of stubPayloads(at)) await ingest(db, p);
  assert.equal((await db.all("SELECT count(*) n FROM events"))[0].n, 14);
});

test("respond: validates against the ask, records it, moves the item to running", async () => {
  const db = nodeDb();
  await migrate(db);
  const { stubPayloads } = await import("./fixtures.ts");
  const { respond } = await import("./store.ts");
  for (const p of stubPayloads(now)) await ingest(db, p);
  await assert.rejects(respond(db, "migrate-users-table", { action: "answer", answers: { run: { option: "nope" } } }), /unknown option/);
  await assert.rejects(respond(db, "migrate-users-table", { action: "answer", answers: { backup: { other: "x" } } }), /no free text/);
  await assert.rejects(respond(db, "migrate-users-table", { action: "answer" }), /answer a question/);
  await assert.rejects(respond(db, "draft-pricing-page", { action: "answer", feedback: "hi" }), /not waiting/);
  const r = await respond(db, "migrate-users-table", {
    action: "answer", answers: { run: { option: "window" }, backup: { option: "yes" } }, feedback: "ping me after",
  });
  assert.ok(r && "item" in r);
  assert.equal(r.item.state, "answered");
  assert.equal(r.responses[0].answers!.run.option, "window");
  assert.match(r.events[0].text, /maintenance window; Yes, snapshot first; "ping me after"/);
  const retry = await respond(db, "sync-crm", { action: "retry" });
  assert.ok(retry && "item" in retry && retry.item.state === "answered");
  const tl = await (await import("./store.ts")).timeline(db, new Date(now.getTime() - 3600_000).toISOString());
  assert.equal(tl.items.find((i) => i.native_id === "draft-pricing-page")!.handoff_from, "herdr:stub/herdr:competitor-pricing");
});

test("agent task lifecycle: start, update, ask, answered until the agent's next call, done", async () => {
  const db = nodeDb();
  await migrate(db);
  const t = await import("./tasks.ts");
  const { respond, getItem } = await import("./store.ts");
  const state = async (id: string) => { const r = await getItem(db, t.parseHandle(id).task); return r && "item" in r ? r.item.state : null; };
  const { task_id } = await t.taskStart(db, { title: "Fix login bug", harness: "claude-code", machine: "mbp", repo: "shop-web", model: "Opus 5.5" });
  assert.match(task_id, /^task:t-[0-9a-f]+@s-[0-9a-f]+$/);
  await t.taskUpdate(db, task_id, { text: "found it: https://github.com/o/r/pull/9" });
  await assert.rejects(t.taskAsk(db, task_id, { summary: "x", questions: [{ id: "a", prompt: "?", options: [] }] }), /1-6 options/);
  await t.taskAsk(db, task_id, { summary: "Ship the fix?", questions: [{ id: "ship", prompt: "Merge now?", options: [{ id: "y", label: "Yes" }, { id: "n", label: "No" }] }] });
  assert.equal((await t.taskAnswer(db, task_id)).status, "pending");
  await respond(db, t.parseHandle(task_id).task, { action: "answer", answers: { ship: { option: "y" } } });
  assert.equal(await state(task_id), "answered");
  assert.equal((await t.taskUpdate(db, task_id, { text: "still running tests" })).state, "answered");
  // The first read delivers but doesn't acknowledge: a read lost to a timeout leaves it visible and re-readable.
  const a = await t.taskAnswer(db, task_id);
  assert.ok(a.status === "answered" && a.answers[0].answer === "Yes");
  assert.equal(await state(task_id), "answered");
  const again = await t.taskAnswer(db, task_id);
  assert.ok(again.status === "answered" && again.answers[0].answer === "Yes");
  assert.equal(await state(task_id), "underway");
  const after = await getItem(db, t.parseHandle(task_id).task);
  assert.ok(after && "item" in after && after.responses[0].acked_at && after.prs.length === 1);
  assert.ok(after.events.filter((e) => e.verb !== "RESPONDED").every((e) => e.session_id === t.parseHandle(task_id).session));
  await t.taskFinish(db, task_id, { outcome: "done", text: "merged" });
  assert.equal(t.harnessOf("codex-mcp-client"), "codex");
});

test("tasks by key: a first mate dispatches, crewmates join the same task as sessions", async () => {
  const db = nodeDb();
  await migrate(db);
  const t = await import("./tasks.ts");
  const { getItem, timeline } = await import("./store.ts");
  const fm = await t.taskStart(db, { title: "Ship dark mode", key: "fm/dark-mode", harness: "claude-code", model: "Opus 5.5" });
  const child = await t.taskStart(db, { title: "Build dark mode toggle", key: "fm/dark-mode-toggle", parent: "fm/dark-mode", harness: "claude-code", dispatch: true });
  assert.equal(child.task_id, "task:fm/dark-mode-toggle"); // no session: the dispatcher doesn't join
  await assert.rejects(t.taskStart(db, { title: "dup", key: "fm/dark-mode-toggle", dispatch: true }), /already exists/);
  const crew = await t.taskStart(db, { title: "toggle (crewmate's own words)", key: "fm/dark-mode-toggle", harness: "codex", model: "GPT-6" });
  assert.equal(crew.joined, true);
  assert.equal(t.parseHandle(crew.task_id).task, "task:fm/dark-mode-toggle");
  const r = await getItem(db, "task:fm/dark-mode-toggle");
  assert.ok(r && "item" in r);
  assert.equal(r.item.title, "Build dark mode toggle"); // the first agent names it
  assert.equal(r.item.parent_id, "task:fm/dark-mode");
  assert.deepEqual(r.sessions.map((s) => s.harness), ["codex"]);
  // Restarting with the same harness session resumes it instead of adding a session.
  const s1 = await t.taskStart(db, { title: "x", key: "fm/dark-mode", harness: "pi", session: "abc" });
  const s2 = await t.taskStart(db, { title: "x", key: "fm/dark-mode", harness: "pi", session: "abc" });
  assert.equal(s1.task_id, s2.task_id);
  assert.equal(s2.resumed, true);
  // The first mate can address any of its tasks by key.
  await t.taskUpdate(db, "fm/dark-mode-toggle", { text: "first mate note" });
  await assert.rejects(t.taskStart(db, { title: "orphan", parent: "nope" }), /parent nope not found/);
  const tl = await timeline(db, "2000-01-01T00:00:00Z");
  assert.equal(tl.sessions.filter((s) => s.task_id === "task:fm/dark-mode-toggle").length, 1);
  void fm; void child;
});

test("hook signals: lookup by harness session, idle/active/end, peek never delivers", async () => {
  const db = nodeDb();
  await migrate(db);
  const t = await import("./tasks.ts");
  const { respond } = await import("./store.ts");
  assert.equal(await t.sessionTask(db, "claude-code", "sess-1"), null);
  const { task_id } = await t.taskStart(db, { title: "Hooked task", harness: "claude-code", session: "sess-1" });
  assert.equal((await t.sessionTask(db, "claude-code", "sess-1"))!.task_id, task_id);
  assert.equal((await t.sessionSignal(db, "claude-code", "sess-1", "idle")).state, "idle");
  assert.equal((await t.sessionSignal(db, "claude-code", "sess-1", "active")).state, "underway");
  await t.taskAsk(db, task_id, { summary: "s", questions: [{ id: "q", prompt: "Go?", options: [{ id: "y", label: "Yes" }] }] });
  assert.equal((await t.sessionSignal(db, "claude-code", "sess-1", "idle")).state, "needs_me"); // asks untouched
  await respond(db, t.parseHandle(task_id).task, { action: "answer", answers: { q: { option: "y" } } });
  const peek = await t.taskAnswer(db, task_id, undefined, { peek: true });
  assert.ok(peek.status === "answered" && peek.delivered === false);
  assert.equal((await t.taskAnswer(db, task_id, undefined, { peek: true })).delivered, false); // still undelivered
  await t.taskAnswer(db, task_id); // the real read
  assert.equal((await t.taskAnswer(db, task_id, undefined, { peek: true })).delivered, true);
  assert.equal((await t.sessionSignal(db, "claude-code", "sess-1", "end")).state, "answered");
});

test("migrate upgrades a database created by an older schema", async () => {
  const db = nodeDb();
  // The v1 shape: no parent_id, session_id, delivered_at, acked_at, external_id.
  await db.batch([
    { sql: `CREATE TABLE items (id TEXT PRIMARY KEY, source TEXT NOT NULL, home TEXT NOT NULL, native_id TEXT NOT NULL,
      kind TEXT NOT NULL, state TEXT NOT NULL, title TEXT NOT NULL, detail TEXT, repo TEXT, owner TEXT, agent TEXT, model TEXT,
      url TEXT, started_at TEXT, updated_at TEXT, handoff_from TEXT, ask TEXT, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
      present INTEGER NOT NULL DEFAULT 1, raw TEXT)` },
    { sql: `CREATE TABLE events (id TEXT PRIMARY KEY, item_id TEXT NOT NULL, ts TEXT, verb TEXT NOT NULL, text TEXT NOT NULL)` },
    { sql: `CREATE TABLE responses (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT NOT NULL, at TEXT NOT NULL, action TEXT NOT NULL, answers TEXT, feedback TEXT)` },
    { sql: `CREATE TABLE sessions (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, harness TEXT NOT NULL, model TEXT, machine TEXT, agent TEXT,
      started_at TEXT NOT NULL, last_seen TEXT NOT NULL, ended_at TEXT)` },
  ]);
  await migrate(db);
  await migrate(db); // idempotent
  const t = await import("./tasks.ts");
  const r = await t.taskStart(db, { title: "after upgrade", harness: "pi", session: "x" });
  assert.equal((await t.sessionTask(db, "pi", "x"))!.task_id, r.task_id);
});

test("done means merged and validated: review -> merged (agent told to validate) -> done", async () => {
  const db = nodeDb();
  await migrate(db);
  const t = await import("./tasks.ts");
  const { getItem } = await import("./store.ts");
  const st = async (h: string) => { const r = await getItem(db, t.parseHandle(h).task); return r && "item" in r ? r.item.state : null; };
  const { task_id } = await t.taskStart(db, { title: "Fix login", harness: "codex", session: "c1" });
  await assert.rejects(t.taskFinish(db, task_id, { outcome: "review", text: "opened it" }), /needs the PR link/);
  await t.taskFinish(db, task_id, { outcome: "review", text: "PR up", url: "https://github.com/o/r/pull/5" });
  assert.equal(await st(task_id), "review");
  await t.captainStage(db, t.parseHandle(task_id).task, "merged");
  assert.equal(await st(task_id), "validating");
  // The agent's next call carries the "validate it" message.
  const u = await t.taskUpdate(db, task_id, { text: "checking main" });
  assert.match((u as any).captain_messages[0].text, /Merged: https:\/\/github.com\/o\/r\/pull\/5\. Validate it/);
  assert.equal(u.state, "validating");
  await t.taskFinish(db, task_id, { outcome: "done", text: "main green, deploy verified" });
  assert.equal(await st(task_id), "landed");
  await assert.rejects(t.captainStage(db, t.parseHandle(task_id).task, "shipped"), /stage must be/);
});

test("captain messages reach the agent in any state, once; queued ones go to the next agent to join", async () => {
  const db = nodeDb();
  await migrate(db);
  const t = await import("./tasks.ts");
  const { task_id } = await t.taskStart(db, { title: "Write docs", key: "docs", harness: "pi", session: "p1" });
  await t.taskFinish(db, task_id, { outcome: "done", text: "done" });
  await t.captainMessage(db, "task:docs", "Also add a FAQ section");
  assert.deepEqual(await t.taskPending(db, task_id), { state: "landed", answer: "none", messages: 1 });
  const r = await t.taskUpdate(db, task_id, { text: "on it" }) as any; // follow-up on a done task
  assert.equal(r.captain_messages[0].text, "Also add a FAQ section");
  assert.equal(((await t.taskUpdate(db, task_id, { text: "again" })) as any).captain_messages, undefined); // once
  await t.captainMessage(db, "task:docs", "Hand-off note for whoever picks this up");
  const joined = await t.taskStart(db, { title: "x", key: "docs", harness: "claude-code" }) as any;
  assert.equal(joined.captain_messages[0].text, "Hand-off note for whoever picks this up");
  await assert.rejects(t.captainMessage(db, "task:docs", "  "), /message text is required/);
});

test("multiple PRs per task: the agent reports each status; all merged -> validating", async () => {
  const db = nodeDb();
  await migrate(db);
  const t = await import("./tasks.ts");
  const { getItem } = await import("./store.ts");
  const get = async (h: string) => { const r = await getItem(db, t.parseHandle(h).task); return r && "item" in r ? r : null; };
  const { task_id } = await t.taskStart(db, { title: "Dark mode", harness: "codex", session: "c" });
  const A = "https://github.com/o/web/pull/1", B = "https://github.com/o/api/pull/2";
  await t.taskPr(db, task_id, { url: A, status: "ci_running" });
  await t.taskPr(db, task_id, { url: B, status: "open" });
  await t.taskFinish(db, task_id, { outcome: "review", text: "two PRs up", url: A });
  assert.equal((await get(task_id))!.item.state, "review");
  await assert.rejects(t.taskPr(db, task_id, { url: A, status: "shipped" }), /status must be one of/);
  await assert.rejects(t.taskPr(db, task_id, { url: "https://example.com/x", status: "open" }), /pull request URL/);
  await t.taskPr(db, task_id, { url: A, status: "ci_failed", note: "lint" });
  await t.taskPr(db, task_id, { url: A, status: "merged" });
  assert.equal((await get(task_id))!.item.state, "review"); // B still open
  const r = await t.taskPr(db, task_id, { url: B, status: "merged" }) as any;
  assert.equal(r.state, "validating");
  assert.match(r.note, /Validate it now/);
  const d = (await get(task_id))!;
  assert.deepEqual(d.prs.map((p) => p.status).sort(), ["merged", "merged"]);
  assert.equal(d.prs.find((p) => p.url === A)!.note, null);
});

test("captain Mark merged settles every open PR; all closed unmerged -> failed", async () => {
  const db = nodeDb();
  await migrate(db);
  const t = await import("./tasks.ts");
  const { getItem } = await import("./store.ts");
  const { task_id } = await t.taskStart(db, { title: "x", harness: "pi", session: "p" });
  await t.taskPr(db, task_id, { url: "https://github.com/o/a/pull/1", status: "open" });
  await t.taskPr(db, task_id, { url: "https://github.com/o/a/pull/2", status: "ci_passed" });
  await t.taskFinish(db, task_id, { outcome: "review", text: "up", url: "https://github.com/o/a/pull/1" });
  await t.captainStage(db, t.parseHandle(task_id).task, "merged");
  const r = await getItem(db, t.parseHandle(task_id).task);
  assert.ok(r && "item" in r && r.item.state === "validating" && r.prs.every((p) => p.status === "merged"));
  const two = await t.taskStart(db, { title: "y", harness: "pi", session: "q" });
  await t.taskPr(db, two.task_id, { url: "https://github.com/o/b/pull/3", status: "open" });
  const closed = await t.taskPr(db, two.task_id, { url: "https://github.com/o/b/pull/3", status: "closed" });
  assert.equal(closed.state, "failed");
});

test("session inbox: one session owns many tasks and its dispatched ones; any answer or message wakes it, once", async () => {
  const db = nodeDb();
  await migrate(db);
  const t = await import("./tasks.ts");
  const { respond } = await import("./store.ts");
  const a = await t.taskStart(db, { title: "Fleet: ship A", key: "fm/a", harness: "claude-code", session: "fm-1" });
  const b = await t.taskStart(db, { title: "Fleet: ship B", key: "fm/b", harness: "claude-code", session: "fm-1" });
  await t.taskStart(db, { title: "Crew task", key: "fm/a-1", parent: "fm/a", harness: "claude-code", dispatch: true });
  assert.equal((await t.sessionInbox(db, "claude-code", "fm-1")).tasks, 3);
  await t.taskAsk(db, a.task_id, { summary: "s", questions: [{ id: "q", prompt: "Go?", options: [{ id: "y", label: "Yes" }] }] });
  assert.equal((await t.sessionInbox(db, "claude-code", "fm-1")).waiting, true);
  await respond(db, "task:fm/a", { action: "answer", answers: { q: { option: "y" } } });
  await t.captainMessage(db, "task:fm/b", "also bump the version");
  await t.captainMessage(db, "task:fm/a-1", "crew: use the staging db");
  const peek = await t.sessionInbox(db, "claude-code", "fm-1");
  assert.equal(peek.entries.length, 3);
  const got = await t.sessionInbox(db, "claude-code", "fm-1", { deliver: true });
  const byTitle = Object.fromEntries(got.entries.map((e) => [e.title, e]));
  assert.equal(byTitle["Fleet: ship A"].answer!.answers[0].answer, "Yes");
  assert.equal(byTitle["Fleet: ship A"].task_id, a.task_id); // a handle with the owning session
  assert.equal(byTitle["Fleet: ship B"].messages[0].text, "also bump the version");
  assert.equal(byTitle["Crew task"].task_id, "task:fm/a-1"); // dispatched: bare id, no session of its own here
  assert.equal((await t.sessionInbox(db, "claude-code", "fm-1")).entries.length, 0); // delivered once
  void b;
});

test("source inbox: answers on seeded items reach their source, acknowledged on claim", async () => {
  const db = nodeDb();
  await migrate(db);
  const { respond, getItem } = await import("./store.ts");
  const t = await import("./tasks.ts");
  const { stubPayloads } = await import("./fixtures.ts");
  for (const p of stubPayloads(now)) await ingest(db, p);
  const id = "firstmate:stub/firstmate:migrate-users-table";
  await respond(db, id, { action: "answer", answers: { run: { option: "window" } }, feedback: "after the backup" });
  await t.captainMessage(db, "firstmate:stub/firstmate:checkout-redesign", "add a rollback plan");
  assert.equal((await t.sourceInbox(db, { source: "herdr" })).length, 0);
  const got = await t.sourceInbox(db, { source: "firstmate" }, { deliver: true });
  assert.deepEqual(got.map((e) => e.title.slice(0, 13)).sort(), ["Checkout rede", "Migrate users"]);
  assert.equal(got.find((e) => e.answer)!.answer!.answers[0].answer, "Run in tonight's maintenance window");
  const r = await getItem(db, id);
  assert.ok(r && "item" in r && r.item.state === "underway" && r.responses[0].acked_at);
  assert.equal((await t.sourceInbox(db, { source: "firstmate" })).length, 0);
});

test("source re-sync of an answered ask doesn't reopen it, and the answer stays deliverable", async () => {
  const db = nodeDb();
  await migrate(db);
  const { respond, getItem } = await import("./store.ts");
  const t = await import("./tasks.ts");
  const { stubPayloads } = await import("./fixtures.ts");
  const fm = () => stubPayloads(now).filter((p) => p.source === "firstmate");
  for (const p of stubPayloads(now)) await ingest(db, p);
  const id = "firstmate:stub/firstmate:migrate-users-table";
  await respond(db, id, { action: "answer", answers: { run: { option: "window" } } });
  for (const p of fm()) await ingest(db, p); // firstmate still reports the decision as needs_me
  const r = await getItem(db, id);
  assert.ok(r && "item" in r && r.item.state === "answered");
  const got = await t.sourceInbox(db, { source: "firstmate" }, { deliver: true });
  assert.equal(got.find((e) => e.answer)!.answer!.answers[0].answer, "Run in tonight's maintenance window");
  for (const p of fm()) await ingest(db, p);
  const after = await getItem(db, id);
  assert.ok(after && "item" in after && after.item.state === "underway");
  assert.equal((await t.sourceInbox(db, { source: "firstmate" })).length, 0); // delivered once
  // A different ask on the same item does reopen it.
  for (const p of fm()) {
    for (const it of p.items) if (it.ask) it.ask = { ...it.ask, summary: "new question" };
    await ingest(db, p);
  }
  const reopened = await getItem(db, id);
  assert.ok(reopened && "item" in reopened && reopened.item.state === "needs_me");
});

test("deleteItem removes a task and its history", async () => {
  const db = nodeDb();
  await migrate(db);
  const t = await import("./tasks.ts");
  const { deleteItem, getItem } = await import("./store.ts");
  const a = await t.taskStart(db, { title: "Stray e2e task", key: "e2e/x", harness: "claude-code", session: "s1" });
  await t.captainMessage(db, "task:e2e/x", "hi");
  assert.deepEqual(await deleteItem(db, "task:e2e/x"), { deleted: "task:e2e/x" });
  assert.equal(await getItem(db, "task:e2e/x"), null);
  assert.equal((await db.all(`SELECT 1 FROM sessions WHERE task_id = ?`, ["task:e2e/x"])).length, 0);
  assert.equal(await deleteItem(db, "task:e2e/x"), null);
  void a;
});
