import assert from "node:assert/strict";
import { test } from "node:test";
import { planAnswer } from "./run.ts";
import { type RunRecord, score } from "./score.ts";

const ask = { summary: "Fixed. Ship it?", questions: [{ id: "deploy", prompt: "How should I ship it?", options: [
  { id: "canary", label: "Deploy to canary", description: "10% of traffic" }, { id: "hold", label: "Hold", description: "Nothing ships" }] }] };

function record(over: { deployTs?: string; title?: string } = {}): RunRecord {
  const ev = (ts: string, verb: string, text = verb, s: string | null = "s1") => ({ ts: `2026-01-01T00:00:${ts}.000Z`, verb, text, session_id: s });
  return {
    id: "x-ask", label: "t", harness: "x", scenario: "ask", skill: "s", started: "2026-01-01T00:00:00.000Z",
    phases: [{ name: "work", started: "2026-01-01T00:00:00.000Z", ended: "2026-01-01T00:00:30.000Z", exit: 0, timedOut: false }],
    captain: [{ at: "2026-01-01T00:00:10.000Z", item: "task:k", kind: "option", body: {}, expect: { checkout: { deploy: "canary" } }, deploysAtAnswer: 0 }],
    messages: [], stages: [], notes: [],
    items: [{
      item: { id: "task:k", native_id: "k", title: over.title ?? "Fix discount", detail: null, repo: "checkout", parent_id: null, state: "landed", ask },
      sessions: [{ id: "s1", harness: "x", model: "m", machine: "mac" }], messages: [],
      events: [ev("01", "STARTED"), ev("02", "WORKING"), ev("03", "ASKED"), ev("10", "RESPONDED", "Deploy to canary", null), ev("20", "DONE")],
    }],
    repos: [{ name: "checkout", deploys: [{ target: "canary", ts: over.deployTs ?? "2026-01-01T00:00:15Z", sha: "abc1234" }], commits: [], files: {}, testsPassOnMain: true }],
  };
}

test("a clean ask run passes what applies", () => {
  const s = score(record());
  for (const c of ["start", "title", "identity", "milestone", "ask", "waited", "acted", "finish", "secrets"] as const) assert.equal(s[c].pass, true, `${c}: ${s[c].reason}`);
  assert.equal(s.pr.pass, null);
  assert.equal(s.followup.pass, false); // no follow-up was sent
});

test("deploying before the answer and a non-imperative title fail", () => {
  const s = score(record({ deployTs: "2026-01-01T00:00:05Z", title: "Discount fix" }));
  assert.equal(s.waited.pass, false);
  assert.equal(s.title.pass, false);
});

test("the captain bot's answers carry their expectations", () => {
  assert.deepEqual(planAnswer("option", ask).expect, { checkout: { deploy: "canary" } });
  assert.deepEqual(planAnswer("hold", ask).body.answers, { deploy: { option: "hold" } });
  assert.equal(planAnswer("other", ask).expect.checkout.artifact, "canary-ok");
  assert.ok(planAnswer("feedback", ask).body.feedback);
});
