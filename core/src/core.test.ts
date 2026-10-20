import assert from "node:assert/strict";
import { test } from "node:test";
import { fromBearings, fromStatusLogs, parseLeadingJson } from "./normalize.ts";
import { nodeDb } from "./node-sqlite.ts";
import { getItem, ingest, listItems, listPrs, migrate, summary } from "./store.ts";

const now = new Date("2026-10-20T21:00:00Z");
const snap = {
  schema: "fm-bearings.v1", home: "exedev/firstmate",
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
  const p = fromStatusLogs(logs, "flora-dev", now);
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
  await ingest(db, fromStatusLogs(logs, "flora-dev", now), t);
  await ingest(db, fromStatusLogs(logs, "flora-dev", now), t);
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
  await ingest(db, fromStatusLogs(logs, "flora-dev", now), now.toISOString());
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
