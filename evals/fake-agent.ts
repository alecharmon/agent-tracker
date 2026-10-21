// A scripted agent that follows the skill to the letter (through the `agnt-trkr task` CLI). The `fake` harness runs it
// to check the eval pipeline and rubric end to end without model spend: it should score every criterion.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const [scenario, phase] = process.argv.slice(2);
const sh = (cmd: string, ...args: string[]) => execFileSync(cmd, args, { encoding: "utf8" }).trim();
const agents = (...args: string[]) => JSON.parse(sh("agnt-trkr", "task", ...args));
const commit = (msg: string) => { sh("git", "add", "-A"); sh("git", "commit", "-q", "-m", msg); };
const fix = () => writeFileSync("calc.js", readFileSync("calc.js", "utf8").replace("(1 - discountPct)", "(1 - discountPct / 100)"));
const PR = "https://github.com/example/checkout/pull/101";

if (scenario === "ask" && phase === "work") {
  fix();
  sh("node", "--test");
  commit("Fix percentage discount");
  agents("start", "Fix discount calculation", "--model", "fake-1");
  agents("update", "Fixed the percentage discount; tests pass");
  agents("ask", "The discount fix is committed and tests pass. It still needs to ship with ./deploy.sh. Once you decide, I'll run it and report back.",
    "-q", "How should I ship the fix?", "-o", "Deploy to canary|Small blast radius; full rollout later", "-o", "Deploy to full|Every customer gets it now",
    "-o", "Hold the deploy|Nothing ships until you say so");
  let a: any;
  do a = agents("answers", "--wait", "25"); while (a.status !== "answered");
  const words = `${a.answers.map((x: any) => x.answer).join(" ")} ${a.feedback ?? ""}`;
  if (/CHANGELOG/.test(words)) { writeFileSync("CHANGELOG.md", "Fix percentage discount\n"); commit("Add changelog"); }
  const target = /hold|don't deploy/i.test(words) ? null : /canary/i.test(words) ? "canary" : "full";
  if (target) sh("./deploy.sh", target);
  if (/CANARY-OK/.test(words)) writeFileSync("CANARY-OK.md", `Canary: ${sh("git", "rev-parse", "--short", "HEAD")}\n`);
  agents("done", target ? `Deployed to ${target}` : "Held the deploy as the captain asked");
} else if (scenario === "ask") {
  const r = agents("update", "Picking up the captain's follow-up");
  if (r.captain_messages?.some((m: any) => /test/.test(m.text))) {
    appendFileSync("calc.test.js", `\ntest("total without a discount is the plain sum", () => {\n  assert.equal(total([{ price: 10, qty: 2 }]), 20);\n});\n`);
    sh("node", "--test");
    commit("Test total without a discount");
  }
  agents("done", "Added the no-discount test on main");
} else if (scenario === "pr" && phase === "work") {
  sh("git", "checkout", "-q", "-b", "fix/discount");
  fix();
  commit("Fix percentage discount");
  agents("start", "Fix discount calculation", "--model", "fake-1");
  agents("update", "Fixed the percentage discount on fix/discount");
  agents("pr", PR, "--status", "open");
  agents("pr", PR, "--status", "ci_running");
  sh("node", "--test");
  agents("pr", PR, "--status", "ci_passed");
  agents("review", "Fixes the percentage discount in calc.js", "--url", PR);
} else {
  const r = agents("update", "Checking the tracker");
  if (r.captain_messages?.some((m: any) => /merged/i.test(m.text))) {
    sh("git", "checkout", "-q", "main");
    sh("node", "--test");
    agents("done", "Validated on main: node --test passes");
  }
}
