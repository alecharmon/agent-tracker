import assert from "node:assert/strict";
import { test } from "node:test";
import { answerMessage, inboxMessage, waitForInbox } from "./hook.ts";

// A fake tracker: a script of inbox peeks, then the delivering POST.
const entry = (title: string, extra: object) => ({ task_id: `task:${title}`, title, answer: null, messages: [], ...extra });
function tracker(peeks: any[], delivered: any[] = [entry("a", { answer: { answers: [{ question: "Ship?", answer: "Canary" }], feedback: "after lunch" } })]) {
  const calls: string[] = [];
  const call = async (path: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${path}`);
    if (init?.method === "POST") return { entries: delivered };
    return peeks.shift() ?? { pending: 0, waiting: true };
  };
  return { call, calls };
}
const base = "/api/agent-sessions/claude-code/s1";

test("waiter delivers once when anything lands on any of the session's tasks", async () => {
  const t = tracker([{ pending: 0, waiting: true }, { pending: 1, waiting: false }]);
  const msg = await waitForInbox(t.call, base, Date.now() + 60_000);
  assert.match(msg!, /Ship\? → Canary/);
  assert.match(msg!, /Feedback: after lunch/);
  assert.equal(t.calls.filter((c) => c.startsWith("POST")).length, 1);
});

test("held harnesses stop waiting once no task waits on the captain; others keep watching", async () => {
  assert.equal(await waitForInbox(tracker([{ pending: 0, waiting: false }]).call, base, Date.now() + 60_000, true), null);
  const t = tracker([{ pending: 0, waiting: false }, { pending: 1, waiting: false }], [entry("docs", { messages: [{ text: "Add a FAQ" }] })]);
  assert.match((await waitForInbox(t.call, base, Date.now() + 60_000))!, /message from the captain:\n- Add a FAQ/);
});

test("several tasks: the message names each one", () => {
  const msg = inboxMessage([entry("ship A", { messages: [{ text: "bump version" }] }), entry("ship B", { answer: { answers: [{ question: "Go?", answer: "Yes" }], feedback: null } })])!;
  assert.match(msg, /For task "ship A" \(task_id task:ship A\):[\s\S]*bump version/);
  assert.match(msg, /For task "ship B"[\s\S]*Go\? → Yes/);
  assert.equal(msg.match(/Act on exactly this/g)!.length, 1);
});

test("answer message marks free text as the captain's own words", () => {
  assert.match(answerMessage({ status: "answered", answers: [{ question: "Q?", answer: "do X", free_text: true }] })!, /do X \(in the captain's own words\)/);
});
