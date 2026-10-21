import assert from "node:assert/strict";
import { test } from "node:test";
import { answerMessage, waitForAnswer } from "./hook.ts";

// A fake tracker: a script of peek results, then the real (delivering) read.
function tracker(peeks: any[]) {
  const calls: string[] = [];
  const call = async (path: string) => {
    calls.push(path);
    if (path.includes("peek=1")) return peeks.shift() ?? { status: "pending", state: "needs_me" };
    return { status: "answered", answers: [{ question: "Ship?", answer: "Canary" }], feedback: "after lunch" };
  };
  return { call, calls };
}

test("waiter delivers once when the answer lands undelivered", async () => {
  const t = tracker([{ status: "pending", state: "needs_me" }, { status: "answered", delivered: false, state: "answered" }]);
  const msg = await waitForAnswer(t.call, "task:x@s", Date.now() + 60_000);
  assert.match(msg!, /Ship\? → Canary/);
  assert.match(msg!, /Feedback: after lunch/);
  assert.equal(t.calls.filter((c) => !c.includes("peek=1")).length, 1);
});

test("waiter stays quiet when the agent already read the answer, or the ask went away", async () => {
  assert.equal(await waitForAnswer(tracker([{ status: "answered", delivered: true }]).call, "t", Date.now() + 60_000), null);
  assert.equal(await waitForAnswer(tracker([{ status: "no_question" }]).call, "t", Date.now() + 60_000), null);
  assert.equal(await waitForAnswer(tracker([{ status: "pending", state: "landed" }]).call, "t", Date.now() + 60_000), null);
});

test("answer message marks free text as the captain's own words", () => {
  assert.match(answerMessage({ answers: [{ question: "Q?", answer: "do X", free_text: true }] }), /do X \(in the captain's own words\)/);
});
