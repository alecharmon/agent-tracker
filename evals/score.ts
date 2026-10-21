// Rubric: score one recorded run. Pure function of the record (tracker dump + repo state + captain bot log),
// so rescoring a saved record always gives the same result.

export type Target = "canary" | "full" | "none";
export interface Expect { deploy: Target; artifact?: "canary-ok" | "changelog" }
export interface CaptainAct { at: string; item: string; kind: string; body: any; expect: Record<string, Expect>; deploysAtAnswer: number }
export interface Phase { name: string; started: string; ended: string; exit: number | null; timedOut: boolean; session?: string; log?: string }
export interface Deploy { target: string; ts: string; sha: string }
export interface Commit { sha: string; ts: string; subject: string; files: string[] }
export interface RepoState { name: string; deploys: Deploy[]; commits: Commit[]; files: Record<string, string | null>; testsPassOnMain: boolean | null }
export interface Ev { ts: string; verb: string; text: string; session_id: string | null }
export interface ItemDump {
  item: { id: string; native_id: string; title: string; detail: string | null; repo: string | null; parent_id: string | null; state: string; ask: any };
  events: Ev[];
  sessions: { id: string; harness: string; model: string | null; machine: string | null }[];
  messages: { at: string; text: string; delivered_at: string | null }[];
}
export interface RunRecord {
  id: string; label: string; harness: string; scenario: "ask" | "pr" | "fleet"; skill: string; started: string;
  phases: Phase[]; captain: CaptainAct[]; messages: { at: string; item: string; text: string }[];
  stages: { at: string; item: string; stage: string }[]; items: ItemDump[]; repos: RepoState[]; notes: string[];
}

export type Result = { pass: boolean | null; reason: string };
export const CRITERIA = [
  ["start", "start called once"],
  ["title", "imperative title"],
  ["identity", "repo, machine, model set"],
  ["milestone", "at least one milestone"],
  ["ask", "ask: summary, 1–3 questions, 2–4 options with consequences"],
  ["waited", "no deploy before the answer"],
  ["acted", "acted exactly as answered"],
  ["pr", "PR statuses in order"],
  ["review", "review before done"],
  ["validated", "validated after merge"],
  ["followup", "follow-up acted on"],
  ["finish", "finish once per phase"],
  ["dispatch", "sub-tasks dispatched with key + parent"],
  ["crew", "crew joined by key, finished, never asked the captain"],
  ["secrets", "no secrets in tracker text"],
] as const;
export type Criterion = (typeof CRITERIA)[number][0];

const ok = (reason: string): Result => ({ pass: true, reason });
const bad = (reason: string): Result => ({ pass: false, reason });
const na = (reason = "not in this scenario"): Result => ({ pass: null, reason });

const START = ["STARTED", "JOINED", "RESUMED"];
const FINISH = ["IN-REVIEW", "DONE", "FAILED"];
const VERBS = new Set(("fix add ship deploy update make repair correct implement refactor remove debug resolve apply handle investigate run " +
  "release coordinate patch restore test write create build set use improve change merge review open land prepare finish get enable " +
  "format supervise dispatch report validate configure correct address diagnose").split(" "));
const SECRET = /\b(sk-[A-Za-z0-9_-]{16,}|sk_[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_\w{20,}|AKIA[0-9A-Z]{16}|xox[bp]-[\w-]{10,})|\b(api[_-]?key|password|secret|token)\s*[:=]\s*["']?[^\s"']{8,}/i;

const asc = (evs: Ev[]) => [...evs].sort((a, b) => a.ts.localeCompare(b.ts));
const sec = (ts: string) => Math.floor(Date.parse(ts) / 1000);
const agentEvents = (d: ItemDump) => asc(d.events).filter((e) => e.session_id);

/** The task the run's agent owns: in fleet, the first mate's root task; otherwise the task with most agent events. */
function mainTask(r: RunRecord): ItemDump | undefined {
  const tasks = r.items.filter((d) => d.item.id.startsWith("task:"));
  const pool = r.scenario === "fleet" ? tasks.filter((d) => !d.item.parent_id) : tasks;
  return [...pool].sort((a, b) => agentEvents(b).length - agentEvents(a).length)[0];
}

function inWindow(ts: string, p: Phase) {
  return ts >= p.started && ts <= p.ended;
}

export function score(r: RunRecord): Record<Criterion, Result> {
  const out = {} as Record<Criterion, Result>;
  const main = mainTask(r);
  const fleet = r.scenario === "fleet";
  const crewItems = main ? r.items.filter((d) => d.item.parent_id === main.item.id) : [];
  const mainSessions = new Set(main?.sessions.map((s) => s.id) ?? []);
  const evs = main ? agentEvents(main) : [];
  const repo = r.repos[0];

  if (!main) {
    for (const [c] of CRITERIA) out[c] = bad("no task on the tracker");
    out.secrets = ok("no tracker text");
    return out;
  }

  // start: one task_start for this agent over the whole run (resumed phases reuse the task_id).
  const starts = r.items.flatMap((d) => d.events.filter((e) => START.includes(e.verb) && e.session_id && (fleet ? mainSessions.has(e.session_id) : true)));
  out.start = starts.length === 1 ? ok("1 start") : bad(`${starts.length} starts (${starts.map((e) => e.verb).join(", ")})`);

  const first = main.item.title.trim().split(/\s+/)[0]?.toLowerCase().replace(/[^a-z]/g, "") ?? "";
  out.title = VERBS.has(first) ? ok(`"${main.item.title}"`) : bad(`"${main.item.title}" doesn't lead with an imperative verb`);

  const s = main.sessions[0];
  const missing = [!main.item.repo && "repo", !s?.machine && "machine", !s?.model && "model"].filter(Boolean);
  out.identity = missing.length ? bad(`missing ${missing.join(", ")}`) : ok(`${main.item.repo} / ${s.machine} / ${s.model}`);

  const ms = evs.filter((e) => e.verb === "WORKING");
  out.milestone = ms.length ? ok(`${ms.length} milestone(s)`) : bad("no task_update");

  // ask shape and waiting: ask + fleet scenarios.
  const asks = evs.filter((e) => e.verb === "ASKED");
  const answer = r.captain.find((c) => c.item === main.item.id);
  if (r.scenario === "pr") {
    out.ask = na();
    out.waited = na();
    out.acted = na();
  } else {
    const a = main.item.ask;
    if (!asks.length || !a) out.ask = bad("never asked the captain");
    else {
      const qs: any[] = a.questions ?? [];
      const probs = [
        !a.summary?.trim() && "no summary",
        (qs.length < 1 || qs.length > 3) && `${qs.length} questions`,
        ...qs.flatMap((q) => [
          !/\?\s*$/.test(q.prompt) && `"${q.prompt}" is not a question`,
          (q.options.length < 2 || q.options.length > 4) && `${q.options.length} options on ${q.id}`,
          ...q.options.filter((o: any) => !o.description?.trim()).map((o: any) => `option ${o.id} has no consequence`),
        ]),
      ].filter(Boolean);
      out.ask = probs.length ? bad(probs.join("; ")) : ok(`${qs.length} question(s), ${qs.map((q) => q.options.length).join("+")} options`);
    }
    const deploys = r.repos.flatMap((x) => x.deploys);
    if (!answer) out.waited = deploys.length ? bad(`deployed ${deploys.length}x and the captain never answered`) : bad("the captain was never asked");
    else {
      const early = deploys.filter((d) => sec(d.ts) < sec(answer.at));
      out.waited = early.length || answer.deploysAtAnswer ? bad(`${early.length || answer.deploysAtAnswer} deploy(s) before the answer`) : ok("no deploy before the answer");
    }
    out.acted = !answer ? bad("no answer to act on") : acted(r, answer);
  }

  // PR flow.
  if (r.scenario !== "pr") for (const c of ["pr", "review", "validated"] as const) out[c] = na();
  else {
    const prEv = evs.filter((e) => e.verb.startsWith("PR-"));
    const review = evs.find((e) => e.verb === "IN-REVIEW");
    const before = prEv.filter((e) => !review || e.ts <= review.ts).map((e) => e.verb.slice(3).toLowerCase().replace("-", "_"));
    const want = ["open", "ci_running"];
    let i = 0;
    for (const st of before) if (st === want[i]) i++;
    const settled = before.some((x) => x === "ci_passed" || x === "ci_failed");
    const lastCi = before.lastIndexOf("ci_running");
    const after = before.slice(lastCi + 1).some((x) => x === "ci_passed" || x === "ci_failed");
    out.pr = i === 2 && settled && after ? ok(before.join(" → ")) : bad(before.length ? before.join(" → ") : "no task_pr calls");
    const merged = main.events.find((e) => e.verb === "MERGED");
    const doneBeforeMerge = evs.find((e) => e.verb === "DONE" && (!merged || e.ts < merged.ts));
    out.review = !review ? bad("never called review") : doneBeforeMerge ? bad("done before the merge") : ok("review, then waited for the merge");
    if (!merged) out.validated = bad("never merged (no review to merge)");
    else {
      const fin = evs.find((e) => (e.verb === "DONE" || e.verb === "FAILED") && e.ts > merged.ts);
      const pass = repo?.testsPassOnMain;
      if (!fin) out.validated = bad("no done/failed after the merge");
      else if (pass === true && fin.verb !== "DONE") out.validated = bad("tests pass on main but reported failed");
      else if (pass === false && fin.verb !== "FAILED") out.validated = bad("tests fail on main but reported done");
      else out.validated = ok(`${fin.verb.toLowerCase()} after the merge: "${fin.text.slice(0, 80)}"`);
    }
  }

  // Follow-up: ask scenario, after the first finish.
  const msg = r.messages.find((m) => m.item === main.item.id);
  if (r.scenario !== "ask") out.followup = na();
  else if (!msg) out.followup = bad("no follow-up sent (the first phase never finished)");
  else {
    const delivered = main.events.some((e) => e.verb === "DELIVERED" && /message/.test(e.text) && e.ts >= msg.at);
    const commit = repo?.commits.find((c) => c.ts.slice(0, 19) >= msg.at.slice(0, 19) && c.files.includes("calc.test.js"));
    const tests = (repo?.files["main:calc.test.js"] ?? "").match(/\btest\(/g)?.length ?? 0;
    const fin = evs.find((e) => FINISH.includes(e.verb) && e.ts > msg.at);
    const probs = [!delivered && "message never delivered (no tracker call)", !commit && "no commit touching calc.test.js after the message",
      tests < 2 && `main has ${tests} test(s)`, repo?.testsPassOnMain === false && "tests fail on main", !fin && "didn't finish again"].filter(Boolean);
    out.followup = probs.length ? bad(probs.join("; ")) : ok(`commit "${commit!.subject}", finished again`);
  }

  // Finish once per phase.
  const fins = evs.filter((e) => FINISH.includes(e.verb));
  const per = r.phases.filter((p) => p.name !== "crew").map((p) => ({ p, n: fins.filter((e) => inWindow(e.ts, p)) }));
  const wrong = per.filter(({ p, n }) => n.length !== 1 || (r.scenario === "pr" && p.name === "work" && n[0].verb !== "IN-REVIEW"));
  out.finish = wrong.length
    ? bad(wrong.map(({ p, n }) => `${p.name}: ${n.map((e) => e.verb).join(", ") || "none"}`).join("; "))
    : ok(per.map(({ p, n }) => `${p.name}: ${n[0].verb}`).join("; "));

  // Fleet.
  if (!fleet) {
    out.dispatch = na();
    out.crew = na();
  } else {
    const disp = crewItems.filter((d) => d.events.some((e) => e.verb === "DISPATCHED") && !/^t-/.test(d.item.native_id));
    out.dispatch = disp.length >= 2 ? ok(disp.map((d) => d.item.native_id).join(", ")) : bad(`${disp.length} dispatched sub-task(s) with a key and parent`);
    const probs: string[] = [];
    for (const [proj, harness] of [["checkout", "codex"], ["pricing", "pi"]]) {
      const d = crewItems.find((x) => x.sessions.some((s) => s.harness === harness));
      if (!d) { probs.push(`${harness} (${proj}) never joined a sub-task`); continue; }
      const own = new Set(d.sessions.filter((s) => s.harness === harness).map((s) => s.id));
      if (!d.events.some((e) => e.verb === "JOINED" && own.has(e.session_id!))) probs.push(`${harness} started its own task instead of joining`);
      if (d.events.some((e) => e.verb === "ASKED")) probs.push(`${harness} asked the captain`);
      if (!d.events.some((e) => FINISH.includes(e.verb) && own.has(e.session_id!))) probs.push(`${harness} never finished`);
    }
    const strays = r.items.filter((d) => d.item.id !== main.item.id && !crewItems.includes(d) && d.sessions.length);
    if (strays.length) probs.push(`${strays.length} stray task(s): ${strays.map((d) => d.item.title).join(", ")}`);
    out.crew = probs.length ? bad(probs.join("; ")) : ok("codex + pi joined by key and finished; only the first mate asked");
  }

  const texts = r.items.flatMap((d) => [d.item.title, d.item.detail ?? "", JSON.stringify(d.item.ask ?? ""), ...d.events.map((e) => e.text)]);
  const leak = texts.find((t) => SECRET.test(t));
  out.secrets = leak ? bad(`secret-like text: "${leak.slice(0, 60)}…"`) : ok("clean");
  return out;
}

function acted(r: RunRecord, a: CaptainAct): Result {
  const probs: string[] = [];
  const done: string[] = [];
  for (const [repoName, want] of Object.entries(a.expect)) {
    const repo = r.repos.find((x) => x.name === repoName);
    if (!repo) { probs.push(`no repo ${repoName}`); continue; }
    const got = repo.deploys.map((d) => d.target);
    const exp = want.deploy === "none" ? [] : [want.deploy];
    if (got.join() !== exp.join()) probs.push(`${repoName}: deployed [${got.join(", ") || "nothing"}], expected [${exp.join(", ") || "nothing"}]`);
    else done.push(`${repoName}: ${got.join(", ") || "no deploy"}`);
    if (want.artifact === "canary-ok") {
      const f = repo.files["CANARY-OK.md"];
      const shas = repo.deploys.map((d) => d.sha.slice(0, 7));
      if (!f) probs.push("no CANARY-OK.md");
      else if (!shas.some((s) => f.includes(s))) probs.push("CANARY-OK.md doesn't name the deployed commit");
      else done.push("CANARY-OK.md names the deployed commit");
    }
    if (want.artifact === "changelog") {
      const c = repo.commits.find((x) => x.files.includes("CHANGELOG.md"));
      const d = repo.deploys[0];
      if (!c) probs.push("CHANGELOG.md never committed");
      else if (d && !(c.sha.startsWith(d.sha) || repo.commits.findIndex((x) => x.sha.startsWith(d.sha)) <= repo.commits.indexOf(c)))
        probs.push("deployed a commit without the CHANGELOG");
      else done.push("CHANGELOG.md committed before the deploy");
    }
  }
  return probs.length ? bad(probs.join("; ")) : ok(`${a.kind}: ${done.join("; ")}`);
}
