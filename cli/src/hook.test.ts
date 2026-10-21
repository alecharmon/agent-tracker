import assert from "node:assert/strict";
import { test } from "node:test";
import { answerMessage, waitForAnswer } from "./hook.ts";

// A fake tracker: a script of peek results, then the real (delivering) read.
function tracker(pending: any[], delivered: any = { status: "answered", answers: [{ question: "Ship?", answer: "Canary" }], feedback: "after lunch" }) {
  const calls: string[] = [];
  const call = async (path: string) => {
    calls.push(path);
    if (path.includes("/pending")) return pending.shift() ?? { answer: "pending", messages: 0 };
    return delivered;
  };
  return { call, calls };
}

test("waiter delivers once when the answer lands undelivered", async () => {
  const t = tracker([{ answer: "pending", messages: 0 }, { answer: "ready", messages: 0 }]);
  const msg = await waitForAnswer(t.call, "task:x@s", Date.now() + 60_000);
  assert.match(msg!, /Ship\? → Canary/);
  assert.match(msg!, /Feedback: after lunch/);
  assert.equal(t.calls.filter((c) => !c.includes("/pending")).length, 1);
});

test("held harnesses stop waiting once no question is outstanding; others keep watching for follow-ups", async () => {
  assert.equal(await waitForAnswer(tracker([{ answer: "delivered", messages: 0 }]).call, "t", Date.now() + 60_000, true), null);
  assert.equal(await waitForAnswer(tracker([{ answer: "none", messages: 0 }]).call, "t", Date.now() + 60_000, true), null);
  // Not answers-only: a follow-up on a finished task still wakes the agent.
  const t = tracker([{ answer: "none", messages: 0 }, { answer: "none", messages: 1 }], { status: "no_question", captain_messages: [{ text: "Add a FAQ" }] });
  assert.match((await waitForAnswer(t.call, "t", Date.now() + 60_000))!, /message from the captain:\n- Add a FAQ/);
});

test("answer message marks free text as the captain's own words", () => {
  assert.match(answerMessage({ status: "answered", answers: [{ question: "Q?", answer: "do X", free_text: true }] })!, /do X \(in the captain's own words\)/);
});
