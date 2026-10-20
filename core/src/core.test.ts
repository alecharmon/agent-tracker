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
