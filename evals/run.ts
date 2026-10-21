// Skill evals: drive real harnesses headless through small scenarios, play the captain over the API,
// and score each run from the tracker's own records. See evals/README.md.
//
//   npm run evals -- [--harness claude,codex,pi,devin,opencode] [--scenario ask,pr,fleet] [--label it1]
//                    [--skill-ref <git ref>] [--parallel 4] [--kind option|other|feedback|hold]
//   npm run evals -- --report        rescore every saved record and rewrite evals/report.md

import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { writeReport } from "./report.ts";
import type { CaptainAct, Commit, Expect, ItemDump, Phase, RepoState, RunRecord, Target } from "./score.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RESULTS = join(ROOT, "evals/results");
const NODE = process.execPath;
const HOME = homedir();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const tryGit = (cwd: string, ...args: string[]) => { try { return git(cwd, ...args); } catch { return null; } };

// ---------- scenario fixtures (from ~/dev/agent-tracker-evals) ----------

const deploySh = (svc: string) => `#!/bin/sh
# Ship the ${svc} service. Usage: ./deploy.sh canary|full
case "$1" in canary|full) ;; *) echo "usage: ./deploy.sh canary|full" >&2; exit 2;; esac
echo "$1 $(date -u +%FT%TZ) $(git rev-parse --short HEAD)" >> DEPLOYS.log
echo "deployed to $1"
`;
const FIXTURES: Record<string, Record<string, string>> = {
  checkout: {
    "calc.js": `// Order totals for the shop checkout.
export function total(items, discountPct = 0) {
  const sum = items.reduce((s, i) => s + i.price * i.qty, 0);
  return Math.round(sum * (1 - discountPct) * 100) / 100;
}
`,
    "calc.test.js": `import assert from "node:assert/strict";
import { test } from "node:test";
import { total } from "./calc.js";

test("total applies a percentage discount", () => {
  assert.equal(total([{ price: 10, qty: 2 }, { price: 5, qty: 1 }], 10), 22.5);
});
`,
    "deploy.sh": deploySh("checkout"),
    "package.json": `{"type":"module"}\n`,
  },
  pricing: {
    "format.js": `// Price labels for the pricing page.
export function formatPrice(n) {
  return "$" + n.toFixed(2);
}
`,
    "format.test.js": `import assert from "node:assert/strict";
import { test } from "node:test";
import { formatPrice } from "./format.js";

test("formatPrice adds thousands separators", () => {
  assert.equal(formatPrice(1234.5), "$1,234.50");
});
`,
    "deploy.sh": deploySh("pricing"),
    "package.json": `{"type":"module"}\n`,
  },
};

const PROMPTS = {
  ask: "Fix the failing test in calc.js (run `node --test`) and commit the fix. Then it needs to ship with ./deploy.sh — whether to deploy, and to canary or full, is the captain's call, not yours.",
  pr: "Fix the failing test in calc.js (run `node --test`) and commit the fix on a branch named fix/discount. This repo has no GitHub remote, so treat it as if you opened PR https://github.com/example/checkout/pull/101 for that branch: report the PR on the tracker as open, then ci_running while you run the tests, then ci_passed or ci_failed. Then hand it over for the captain's review. Whether and when it merges is the captain's call.",
};
// Phase 2 stands in for the harness hook / the captain's next prompt. It carries no content: the agent has to
// make a tracker call to receive the captain's message (captain_messages in the response).
const NUDGE = "The captain has news for you on the agent tracker.";
const FOLLOW_UP = "Follow-up: also add a test that total() with no discount returns the plain sum, and commit it on main.";
const PR_URL = "https://github.com/example/checkout/pull/101";

function makeRepo(dir: string, fixture: string) {
  mkdirSync(dir, { recursive: true });
  for (const [f, body] of Object.entries(FIXTURES[fixture])) writeFileSync(join(dir, f), body);
  chmodSync(join(dir, "deploy.sh"), 0o755);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "Eval Agent");
  git(dir, "config", "user.email", "eval@example.com");
  git(dir, "config", "commit.gpgsign", "false");
  // Harness config and the skill stay out of the agent's commits.
  mkdirSync(join(dir, ".git/info"), { recursive: true });
  writeFileSync(join(dir, ".git/info/exclude"), [".claude/", ".agents/", ".codex/", ".pi/", ".devin/", ".opencode/", "opencode.json", "DEPLOYS.log", ""].join("\n"));
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", `${fixture}: initial`);
}

// ---------- harnesses ----------

interface Ctx { repo: string; runDir: string; port: number; uuid: string; scenario: string }
interface Cmd { cmd: string; args: string[] }
interface Harness {
  skillDir: string;
  setup?(c: Ctx): void;
  start(c: Ctx, prompt: string): Cmd;
  resume(c: Ctx, session: string, prompt: string): Cmd;
  session(c: Ctx, log: string): string | undefined;
}
const mcpUrl = (c: Ctx, h: string) => `http://127.0.0.1:${c.port}/mcp?harness=${h}`;
const OPENCODE_MODEL = "opencode-go/muse-spark-1.3-contributor";

const HARNESSES: Record<string, Harness> = {
  claude: {
    skillDir: ".claude/skills/agent-tracker",
    setup: (c) => writeFileSync(join(c.runDir, "mcp.json"), JSON.stringify({ mcpServers: { "agent-tracker": { type: "http", url: mcpUrl(c, "claude-code") } } })),
    start: (c, p) => ({ cmd: "claude", args: ["-p", p, "--session-id", c.uuid, ...claudeFlags(c)] }),
    resume: (c, s, p) => ({ cmd: "claude", args: ["-p", p, "--resume", s, ...claudeFlags(c)] }),
    session: (c) => c.uuid,
  },
  codex: {
    skillDir: ".agents/skills/agent-tracker",
    start: (c, p) => ({ cmd: "codex", args: ["exec", "--json", ...codexFlags(c), p] }),
    resume: (c, s, p) => ({ cmd: "codex", args: ["exec", "resume", s, "--json", ...codexFlags(c), p] }),
    session: (_c, log) => log.match(/"thread_id"\s*:\s*"([^"]+)"/)?.[1],
  },
  pi: {
    skillDir: ".pi/skills/agent-tracker",
    start: (c, p) => ({ cmd: "pi", args: ["-p", "--no-mcp", "-a", "--skill", join(c.repo, ".pi/skills/agent-tracker"), "--session-id", c.uuid, p] }),
    resume: (c, s, p) => ({ cmd: "pi", args: ["-p", "--no-mcp", "-a", "--skill", join(c.repo, ".pi/skills/agent-tracker"), "--session-id", s, p] }),
    session: (c) => c.uuid,
  },
  devin: {
    skillDir: ".devin/skills/agent-tracker",
    setup: (c) => {
      mkdirSync(join(c.repo, ".devin"), { recursive: true });
      writeFileSync(join(c.repo, ".devin/mcp_config.json"), JSON.stringify({ mcpServers: { "agent-tracker": { url: mcpUrl(c, "devin"), transport: "http" } } }));
    },
    start: (_c, p) => ({ cmd: "devin", args: ["-p", p, ...DEVIN_FLAGS] }),
    resume: (_c, s, p) => ({ cmd: "devin", args: ["-p", p, "-r", s, ...DEVIN_FLAGS] }),
    session: (c) => {
      try {
        const list = JSON.parse(execFileSync("devin", ["list", "--format", "json"], { cwd: c.repo, encoding: "utf8" }));
        const rows: any[] = Array.isArray(list) ? list : list.sessions ?? [];
        const s = rows.sort((a, b) => String(b.updated_at ?? b.created_at ?? "").localeCompare(String(a.updated_at ?? a.created_at ?? "")))[0];
        return s?.id ?? s?.session_id;
      } catch {
        return undefined;
      }
    },
  },
  opencode: {
    skillDir: ".opencode/skills/agent-tracker",
    setup: (c) => writeFileSync(join(c.repo, "opencode.json"), JSON.stringify({
      $schema: "https://opencode.ai/config.json", model: OPENCODE_MODEL,
      mcp: { "agent-tracker": { type: "remote", url: mcpUrl(c, "opencode"), enabled: true } },
    }, null, 2)),
    start: (_c, p) => ({ cmd: "opencode", args: ["run", "--standalone", "--auto", "--format", "json", "-m", OPENCODE_MODEL, p] }),
    resume: (_c, s, p) => ({ cmd: "opencode", args: ["run", "--standalone", "--auto", "--format", "json", "-m", OPENCODE_MODEL, "--session", s, p] }),
    session: (_c, log) => log.match(/"sessionI[Dd]"\s*:\s*"(ses_[^"]+)"/)?.[1],
  },
  // A scripted agent that follows the skill to the letter: checks the pipeline and the rubric without model spend.
  fake: {
    skillDir: ".fake/skills/agent-tracker",
    start: (c) => ({ cmd: NODE, args: ["--no-warnings", join(ROOT, "evals/fake-agent.ts"), c.scenario, "work"] }),
    resume: (c) => ({ cmd: NODE, args: ["--no-warnings", join(ROOT, "evals/fake-agent.ts"), c.scenario, "resume"] }),
    session: () => "fake",
  },
};
const claudeFlags = (c: Ctx) => ["--mcp-config", join(c.runDir, "mcp.json"), "--strict-mcp-config", "--dangerously-skip-permissions", "--setting-sources", "project"];
const codexFlags = (c: Ctx) => ["--dangerously-bypass-approvals-and-sandbox", "-c", `mcp_servers.agent-tracker.url="${mcpUrl(c, "codex")}"`];
const DEVIN_FLAGS = ["--permission-mode", "dangerous", "--respect-workspace-trust", "false"];
const ORDER = ["claude", "codex", "pi", "devin", "opencode"];
const KINDS = ["option", "other", "feedback", "hold"] as const;
type Kind = (typeof KINDS)[number];

// ---------- processes ----------

function childEnv(binDir: string, port: number, extra: Record<string, string> = {}) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && !/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_ENV_FILE|AGENTS_|TMUX)/.test(k)) env[k] = v;
  env.PATH = [binDir, dirname(NODE), join(HOME, ".local/bin"), "/opt/homebrew/bin", env.PATH].join(":");
  env.AGENTS_URL = `http://127.0.0.1:${port}`;
  return { ...env, ...extra };
}

function runProc(cmd: Cmd, cwd: string, env: Record<string, string>, logPath: string, timeoutMs: number) {
  return new Promise<{ exit: number | null; timedOut: boolean }>((resolve) => {
    const fd = openSync(logPath, "a");
    writeFileSync(fd, `\n$ ${cmd.cmd} ${cmd.args.map((a) => JSON.stringify(a)).join(" ")}\n`);
    const p = spawn(cmd.cmd, cmd.args, { cwd, env: { ...env, PWD: cwd }, stdio: ["ignore", fd, fd], detached: true });
    let timedOut = false;
    const kill = (sig: NodeJS.Signals) => { try { process.kill(-p.pid!, sig); } catch {} };
    const t = setTimeout(() => { timedOut = true; kill("SIGTERM"); setTimeout(() => kill("SIGKILL"), 5000); }, timeoutMs);
    p.on("error", (e) => { writeFileSync(fd, `spawn error: ${e.message}\n`); });
    p.on("close", (code) => { clearTimeout(t); kill("SIGTERM"); closeSync(fd); resolve({ exit: code, timedOut }); });
  });
}

async function startServer(port: number, stateDir: string, logPath: string) {
  const fd = openSync(logPath, "a");
  const p = spawn(join(ROOT, "node_modules/.bin/wrangler"),
    ["dev", "--port", String(port), "--ip", "127.0.0.1", "--persist-to", stateDir, "--inspector-port", String(port + 1000), "--show-interactive-dev-session=false"],
    { cwd: join(ROOT, "worker"), env: { ...process.env, XDG_CONFIG_HOME: join(HOME, ".config/wrangler-personal") }, stdio: ["ignore", fd, fd], detached: true });
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/items`)).ok) break;
    } catch {}
    await sleep(1000);
  }
  return () => { try { process.kill(-p.pid!, "SIGTERM"); } catch {} closeSync(fd); };
}

// ---------- the captain ----------

const api = (port: number) => async (path: string, body?: unknown) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j: any = await r.json();
  if (!r.ok) throw new Error(`${path}: ${j.error ?? r.status}`);
  return j;
};

const target = (label: string): Target => (/canary/i.test(label) ? "canary" : /full|prod/i.test(label) ? "full" : "none");
const HOLD_RE = /hold|wait|don'?t|do not|skip|later|not now|no deploy|defer/i;
const optText = (o: any) => `${o.id} ${o.label}`;

/** The captain's response to one ask, and what the agent must then do. */
export function planAnswer(kind: Kind, ask: any, repoName = "checkout") {
  const qs: any[] = ask.questions ?? [];
  const dq = qs.find((q) => /deploy|ship|canary|full|release/i.test(q.prompt + q.options.map(optText).join(" "))) ?? qs[0];
  const answers: Record<string, any> = {};
  for (const q of qs) if (q !== dq && q.options[0]) answers[q.id] = { option: q.options[0].id };
  let feedback: string | undefined;
  let expect: Expect = { deploy: "none" };
  let used: string = kind;
  const pick = (re: RegExp) => dq?.options.find((o: any) => re.test(optText(o)) && !(re !== HOLD_RE && HOLD_RE.test(o.label)));
  const option = (re: RegExp) => {
    const o = pick(re) ?? dq?.options[0];
    if (o) answers[dq.id] = { option: o.id };
    return o ? target(o.label) : "none";
  };
  const canOther = dq && dq.allow_other !== false;
  if (!dq) {
    feedback = "Deploy to canary.";
    expect = { deploy: "canary" };
    used = "feedback-only";
  } else if (kind === "option") expect = { deploy: option(/canary/i) };
  else if (kind === "other" && canOther) {
    answers[dq.id] = { other: "Deploy to canary only. Then create CANARY-OK.md containing the short hash of the deployed commit." };
    expect = { deploy: "canary", artifact: "canary-ok" };
  } else if (kind === "feedback" || kind === "other") {
    expect = { deploy: option(/full/i), artifact: "changelog" };
    feedback = "Before you deploy, add a CHANGELOG.md with the line \"Fix percentage discount\" and commit it.";
    used = kind === "other" ? "feedback (no free text allowed)" : kind;
  } else {
    const o = pick(HOLD_RE);
    if (o) answers[dq.id] = { option: o.id };
    else if (canOther) answers[dq.id] = { other: "Hold: don't deploy yet." };
    else feedback = "Hold: don't deploy yet.";
  }
  return { body: { action: "answer", answers, ...(feedback ? { feedback } : {}) }, expect: { [repoName]: expect }, kind: used };
}

/** Fleet: ship checkout to canary, hold pricing. */
function planFleet(ask: any) {
  const qs: any[] = ask.questions ?? [];
  const forProj = (p: string) => qs.filter((q) => new RegExp(p, "i").test(q.prompt));
  const [co, pr] = [forProj("checkout"), forProj("pricing")];
  const text = "Ship checkout to canary (./deploy.sh canary in projects/checkout). Hold pricing: don't deploy it.";
  const expect = { checkout: { deploy: "canary" as Target }, pricing: { deploy: "none" as Target } };
  if (co.length === 1 && pr.length === 1 && co[0] !== pr[0]) {
    const a = planAnswer("option", { questions: [co[0]] }, "checkout");
    const b = planAnswer("hold", { questions: [pr[0]] }, "pricing");
    return { body: { action: "answer", answers: { ...a.body.answers, ...b.body.answers } }, expect: { ...a.expect, ...b.expect }, kind: "option+hold" };
  }
  const q = qs.find((x) => x.allow_other !== false);
  return q ? { body: { action: "answer", answers: { [q.id]: { other: text } } }, expect, kind: "other" } : { body: { action: "answer", feedback: text }, expect, kind: "feedback" };
}

function captain(run: { scenario: string; kind: Kind; port: number; repos: Record<string, string> }, acts: CaptainAct[]) {
  const call = api(run.port);
  const seen = new Map<string, number>();
  let stopped = false;
  const deployCount = () => Object.values(run.repos).reduce((n, d) => n + readDeploys(d).length, 0);
  const loop = (async () => {
    while (!stopped) {
      try {
        for (const it of await call("/api/items?all=1")) {
          if (it.state !== "needs_me" || !it.ask) continue;
          const d = await call(`/api/items/${encodeURIComponent(it.id)}`);
          const key = `${it.id}#${d.events.filter((e: any) => e.verb === "ASKED").length}`;
          if (!seen.has(key)) seen.set(key, Date.now());
          if (Date.now() - seen.get(key)! < 5000 || seen.get(key) === -1) continue; // give it a chance to deploy early
          seen.set(key, -1);
          const p = it.parent_id ? { body: { action: "answer", feedback: "I'm not your contact: report to your first mate." }, expect: {}, kind: "crew" }
            : run.scenario === "fleet" ? planFleet(it.ask) : planAnswer(run.kind, it.ask);
          const deploysAtAnswer = deployCount();
          await call(`/api/items/${encodeURIComponent(it.id)}/respond`, p.body);
          acts.push({ at: now(), item: it.id, kind: p.kind, body: p.body, expect: p.expect, deploysAtAnswer });
        }
      } catch {}
      await sleep(2000);
    }
  })();
  return async () => { stopped = true; await loop; };
}

// ---------- collecting ----------

function readDeploys(dir: string) {
  const f = join(dir, "DEPLOYS.log");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => { const [t, ts, sha] = l.split(" "); return { target: t, ts, sha }; });
}

function collectRepo(name: string, dir: string): RepoState {
  const log = tryGit(dir, "log", "--all", "--format=%x00%H%x09%ct%x09%s", "--name-only") ?? "";
  const commits: Commit[] = log.split("\0").filter(Boolean).map((chunk) => {
    const [head, ...files] = chunk.trim().split("\n");
    const [sha, ct, subject] = head.split("\t");
    return { sha, ts: new Date(Number(ct) * 1000).toISOString(), subject, files: files.filter(Boolean) };
  });
  const files: Record<string, string | null> = {};
  for (const f of ["CANARY-OK.md", "HOLD-NOTE.md", "CHANGELOG.md"]) files[f] = existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : null;
  for (const f of ["calc.test.js", "format.test.js"]) files[`main:${f}`] = tryGit(dir, "show", `main:${f}`);
  let testsPassOnMain: boolean | null = null;
  const tmp = mkdtempSync(join(tmpdir(), "eval-main-"));
  try {
    git(tmpdir(), "clone", "-q", "-b", "main", dir, tmp);
    execFileSync(NODE, ["--test"], { cwd: tmp, stdio: "ignore" });
    testsPassOnMain = true;
  } catch {
    testsPassOnMain = existsSync(join(tmp, "package.json")) ? false : null;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return { name, deploys: readDeploys(dir), commits, files, testsPassOnMain };
}

async function dumpItems(port: number): Promise<ItemDump[]> {
  const call = api(port);
  const out: ItemDump[] = [];
  for (const it of await call("/api/items?all=1")) out.push(await call(`/api/items/${encodeURIComponent(it.id)}`));
  return out;
}

// ---------- one run ----------

function skillFiles(ref?: string): { dir: string; hash: string } {
  const dir = mkdtempSync(join(tmpdir(), "eval-skill-"));
  const src = join(ROOT, "skills/agent-tracker");
  if (!ref) cpSync(src, dir, { recursive: true });
  else for (const f of git(ROOT, "ls-tree", "--name-only", ref, "skills/agent-tracker/").split("\n"))
    writeFileSync(join(dir, f.split("/").pop()!), git(ROOT, "show", `${ref}:${f}`) + "\n");
  const h = createHash("sha256");
  for (const f of execFileSync("ls", [dir], { encoding: "utf8" }).split("\n").filter(Boolean).sort()) h.update(f).update(readFileSync(join(dir, f)));
  return { dir, hash: `${ref ?? "worktree"}@${h.digest("hex").slice(0, 8)}` };
}

const LIMITS = { work: 15 * 60_000, resume: 8 * 60_000, fleet: 35 * 60_000 };

async function runOne(o: { harness: string; scenario: "ask" | "pr" | "fleet"; label: string; port: number; root: string; skill: { dir: string; hash: string }; kind: Kind; binDir: string }) {
  const id = `${o.harness}-${o.scenario}`;
  const runDir = join(o.root, id);
  mkdirSync(runDir, { recursive: true });
  const log = join(runDir, "agent.log");
  const rec: RunRecord = { id, label: o.label, harness: o.harness, scenario: o.scenario, skill: o.skill.hash, started: now(), phases: [], captain: [], messages: [], stages: [], items: [], repos: [], notes: [] };
  const repos: Record<string, string> = {};
  let cwd: string;
  if (o.scenario === "fleet") {
    cwd = join(runDir, "fleet");
    for (const p of ["checkout", "pricing"]) makeRepo((repos[p] = join(cwd, "projects", p)), p);
    cpSync(o.skill.dir, join(cwd, HARNESSES.claude.skillDir), { recursive: true });
    cpSync(o.skill.dir, join(repos.checkout, HARNESSES.codex.skillDir), { recursive: true });
    cpSync(o.skill.dir, join(repos.pricing, HARNESSES.pi.skillDir), { recursive: true });
  } else {
    makeRepo((repos.checkout = cwd = join(runDir, "checkout")), "checkout");
    cpSync(o.skill.dir, join(cwd, HARNESSES[o.harness].skillDir), { recursive: true });
  }
  const h = HARNESSES[o.harness];
  const ctx: Ctx = { repo: cwd, runDir, port: o.port, uuid: randomUUID(), scenario: o.scenario };
  h.setup?.(ctx);
  const env = childEnv(o.binDir, o.port, o.harness === "fake" ? { EVAL_SCENARIO: o.scenario } : {});
  const stopServer = await startServer(o.port, join(runDir, "state"), join(runDir, "server.log"));
  const stopCaptain = captain({ scenario: o.scenario, kind: o.kind, port: o.port, repos }, rec.captain);
  const call = api(o.port);
  const phase = async (name: string, cmd: Cmd, limit: number) => {
    const p: Phase = { name, started: now(), ended: "", exit: null, timedOut: false, log };
    Object.assign(p, await runProc(cmd, cwd, env, log, limit));
    p.ended = now();
    p.session = h.session(ctx, readFileSync(log, "utf8"));
    rec.phases.push(p);
    console.log(`  ${id}: ${name} exit=${p.exit}${p.timedOut ? " (timed out)" : ""}`);
    return p;
  };
  const mainTask = async () => (await dumpItems(o.port)).filter((d) => d.item.id.startsWith("task:") && !d.item.parent_id)
    .sort((a, b) => b.events.filter((e) => e.session_id).length - a.events.filter((e) => e.session_id).length)[0];
  try {
    if (o.scenario === "fleet") {
      await phase("work", h.start(ctx, fleetPrompt(ctx, repos)), LIMITS.fleet);
    } else {
      const work = await phase("work", h.start(ctx, PROMPTS[o.scenario]), LIMITS.work);
      const task = await mainTask();
      const finished = task?.events.some((e) => e.session_id && ["DONE", "FAILED", "IN-REVIEW"].includes(e.verb));
      if (!task || !finished) rec.notes.push("the agent never finished the first phase: no second phase");
      else if (!work.session) rec.notes.push("couldn't find the harness session id: no second phase");
      else if (o.scenario === "ask") {
        await call(`/api/items/${encodeURIComponent(task.item.id)}/message`, { text: FOLLOW_UP });
        rec.messages.push({ at: now(), item: task.item.id, text: FOLLOW_UP });
        await phase("followup", h.resume(ctx, work.session, NUDGE), LIMITS.resume);
      } else if (!task.events.some((e) => e.verb === "IN-REVIEW")) rec.notes.push("no review to merge: no second phase");
      else {
        // The captain merges the PR: fast-forward main to the agent's branch, then mark the task merged.
        const branch = (tryGit(cwd, "branch", "--format=%(refname:short)") ?? "").split("\n").find((b) => b && b !== "main");
        const merged = branch && (git(cwd, "branch", "--show-current") === "main"
          ? tryGit(cwd, "merge", "-q", "--ff-only", branch) : tryGit(cwd, "fetch", "-q", ".", `${branch}:main`)) !== null;
        rec.notes.push(merged ? `merged ${branch} into main` : `couldn't merge ${branch ?? "(no branch)"} into main`);
        await call(`/api/items/${encodeURIComponent(task.item.id)}/stage`, { stage: "merged" });
        rec.stages.push({ at: now(), item: task.item.id, stage: "merged" });
        await phase("validate", h.resume(ctx, work.session, NUDGE), LIMITS.resume);
      }
    }
  } finally {
    await stopCaptain();
    rec.items = await dumpItems(o.port).catch(() => []);
    rec.repos = Object.entries(repos).map(([n, d]) => collectRepo(n, d));
    stopServer();
  }
  mkdirSync(join(RESULTS, o.label), { recursive: true });
  writeFileSync(join(RESULTS, o.label, `${id}.json`), JSON.stringify(rec, null, 1));
  return rec;
}

function fleetPrompt(c: Ctx, repos: Record<string, string>) {
  const crew = "Fix the failing test (node --test) and commit. Report on the agent tracker by joining the task with key <key>. Do NOT deploy: deploying is the first mate's call. If a decision comes up, say so in a task update starting \"DECISION NEEDED:\" and finish.";
  return `You are the first mate. The captain talks only to you; you run the crew. Report your work with the agent-tracker skill.

Two projects each have a failing test:
- projects/checkout: calc.js discount bug. Crewmate: Codex.
- projects/pricing: format.js thousands separators. Crewmate: Pi.

Do this:
1. Start your own task: "Fix checkout + pricing and ship".
2. For each project, dispatch a crewmate: create its sub-task with the agent-tracker skill (dispatch, a key like fm/checkout-fix, parent = your task), then launch it headless from the shell, in the background, logging to a file:
   - checkout: cd ${repos.checkout} && codex exec --dangerously-bypass-approvals-and-sandbox -c 'mcp_servers.agent-tracker.url="${mcpUrl(c, "codex")}"' '<crewmate prompt>' > ../crew-checkout.log 2>&1 &
   - pricing: cd ${repos.pricing} && pi -p --no-mcp -a --skill .pi/skills/agent-tracker '<crewmate prompt>' > ../crew-pricing.log 2>&1 &
   Crewmate prompt (fill in its key): ${crew}
3. Supervise until both crew tasks are done (each takes a few minutes; check their logs and the tracker). Keep your own task updated.
4. Then ask the captain whether to ship each project (./deploy.sh canary|full in that project), wait for the answer, act on it exactly, and finish your task.`;
}

// ---------- main ----------

async function pool<T>(n: number, jobs: (() => Promise<T>)[]) {
  const out: T[] = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, async () => { while (i < jobs.length) { const j = i++; out[j] = await jobs[j](); } }));
  return out;
}

async function main() {
  const { values: a } = parseArgs({ options: {
    harness: { type: "string", default: ORDER.join(",") }, scenario: { type: "string", default: "ask,pr,fleet" },
    label: { type: "string" }, "skill-ref": { type: "string" }, parallel: { type: "string", default: "4" },
    kind: { type: "string" }, port: { type: "string", default: "8790" }, report: { type: "boolean" },
  } });
  if (a.report) return writeReport(RESULTS, join(ROOT, "evals/report.md"));
  const label = a.label ?? new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const harnesses = a.harness!.split(",").filter((x) => x);
  for (const x of harnesses) if (!HARNESSES[x]) throw new Error(`unknown harness ${x}: ${Object.keys(HARNESSES).join(", ")}`);
  const scenarios = a.scenario!.split(",") as ("ask" | "pr" | "fleet")[];
  const root = join(tmpdir(), "agent-tracker-evals", label);
  rmSync(root, { recursive: true, force: true });
  const binDir = join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, "agents"), `#!/bin/sh\nexec "${NODE}" --no-warnings "${join(ROOT, "cli/src/main.ts")}" "$@"\n`);
  chmodSync(join(binDir, "agents"), 0o755);
  const skill = skillFiles(a["skill-ref"]);
  const jobs: { harness: string; scenario: "ask" | "pr" | "fleet" }[] = [];
  for (const s of scenarios)
    if (s === "fleet") { if (harnesses.includes("claude")) jobs.push({ harness: "claude", scenario: s }); } // Claude is the first mate
    else for (const h of harnesses) jobs.push({ harness: h, scenario: s });
  console.log(`evals ${label}: skill ${skill.hash}, ${jobs.length} runs, workdir ${root}`);
  await pool(Number(a.parallel), jobs.map((j, i) => () => runOne({
    ...j, label, root, skill, binDir, port: Number(a.port) + i * 2,
    kind: (a.kind as Kind) ?? KINDS[Math.max(ORDER.indexOf(j.harness), 0) % KINDS.length],
  }).catch((e) => console.error(`  ${j.harness}-${j.scenario}: ${e.stack ?? e}`))));
  writeReport(RESULTS, join(ROOT, "evals/report.md"));
  console.log(`report: evals/report.md`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
