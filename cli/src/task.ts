import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, join } from "node:path";
import { harnessOf } from "@agent-tracker/core";

type Call = (path: string, init?: RequestInit) => Promise<any>;

export const TASK_USAGE = `agents task — report your work (for agents)

  agents task start "<title>" [--key k] [--parent k] [--dispatch] [--detail d] [--model m] [--repo r]
                                      --dispatch creates it for another agent (yours stays current)
                                      --key joins the task with that key (default: $AGENTS_TASK_KEY)
  agents task update "<what you did or are doing>" [--url u]
  agents task ask "<what you need and why>" -q "<question?>" -o "<option>[|<consequence>]" [-o …] [-q …] [--no-other]
  agents task ask --ask-json '<{"summary":…,"questions":[…]}>'
  agents task answers [--wait 25]     the captain's answer: answered | pending | no_question
  agents task pr <pr-url> --status <open|ci_running|ci_passed|ci_failed|merged|closed> [--note n]
                                                       report each PR's status as it changes (several PRs per task is fine)
  agents task review "<what's in the PR>" --url <pr>   PR open: done comes after merge + validation
  agents task done "<result>" [--url u]                merged and validated (or no PR, verified)
  agents task fail "<why>"
  Any reply may carry captain_messages: follow-ups and direction from the captain. Act on them.
  agents task id                      print the current task id

  The task is remembered per tmux pane (or working directory). Juggling several tasks? Address one with
  --task <key or task_id>, or set AGENTS_TASK_ID.`;

/** Which harness is running us: walk parent processes for a known agent binary. */
export function detectHarness(): string {
  if (process.env.AGENTS_HARNESS) return harnessOf(process.env.AGENTS_HARNESS);
  let pid = process.ppid;
  for (let depth = 0; depth < 12 && pid > 1; depth++) {
    let line = "";
    try {
      line = execFileSync("ps", ["-o", "ppid=,command=", "-p", String(pid)], { encoding: "utf8" }).trim();
    } catch {
      break;
    }
    const m = line.match(/^(\d+)\s+(.*)$/);
    if (!m) break;
    const exe = basename(m[2].split(/\s+/)[0]);
    const known = /^(claude|codex|opencode|devin|pi)$/.exec(exe) ?? /\b(claude|codex|opencode|devin)\b/.exec(m[2]) ?? /\/bin\/(pi)\b/.exec(m[2]);
    if (known) return harnessOf(known[1] === "claude" ? "claude-code" : known[1]);
    pid = Number(m[1]);
  }
  return "other";
}

function repoName() {
  try {
    return basename(execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
  } catch {
    return basename(process.cwd());
  }
}

const cacheDir = join(homedir(), ".cache/agent-tracker/tasks");
const cacheKey = () => (process.env.TMUX_PANE ? `pane-${process.env.TMUX_PANE.replace("%", "")}` : `cwd-${process.cwd().replace(/[^\w.-]+/g, "_")}`);
const cachePath = () => join(cacheDir, `${cacheKey()}.id`);

function currentTask(explicit?: string): string {
  const id = explicit ?? process.env.AGENTS_TASK_ID ?? (() => {
    try {
      return readFileSync(cachePath(), "utf8").trim();
    } catch {
      return "";
    }
  })();
  if (!id) throw new Error('no current task: run `agents task start "<title>"` first (or pass --task <id>)');
  return id;
}

const slug = (s: string, n: number) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || `q${n}`;

/** -q/-o flags, in order, into ask questions. */
export function askFromFlags(argv: string[], noOther: boolean) {
  const questions: any[] = [];
  for (let k = 0; k < argv.length; k++) {
    const flag = argv[k], val = argv[k + 1];
    if (flag === "-q" || flag === "--question") {
      questions.push({ id: slug(val ?? "", questions.length + 1), prompt: val, options: [], ...(noOther ? { allow_other: false } : {}) });
      k++;
    } else if (flag === "-o" || flag === "--option") {
      if (!questions.length) throw new Error("-o must follow a -q question");
      const [label, ...desc] = (val ?? "").split("|");
      const q = questions.at(-1);
      q.options.push({ id: slug(label, q.options.length + 1), label: label.trim(), ...(desc.length ? { description: desc.join("|").trim() } : {}) });
      k++;
    }
  }
  return questions;
}

export async function task(call: Call, args: string[], flags: Record<string, any>, raw: string[], print: (o: unknown) => void) {
  const [sub, ...rest] = args;
  const text = rest.join(" ").trim();
  const post = (path: string, body: unknown) => call(path, { method: "POST", body: JSON.stringify(body) });
  const enc = (id: string) => encodeURIComponent(id);
  switch (sub) {
    case "start": {
      if (!text) throw new Error('usage: agents task start "<title>"');
      const r = await post("/api/tasks", {
        title: text, key: flags.key ?? process.env.AGENTS_TASK_KEY, parent: flags.parent, detail: flags.detail,
        model: flags.model ?? process.env.AGENTS_MODEL, agent: flags.agent,
        repo: flags.repo ?? repoName(), machine: hostname().split(".")[0], harness: flags.harness ?? detectHarness(),
        session: flags.session ?? process.env.AGENTS_SESSION, dispatch: flags.dispatch,
      });
      if (!r.dispatched) {
        mkdirSync(cacheDir, { recursive: true });
        writeFileSync(cachePath(), r.task_id);
      }
      return print(r);
    }
    case "update":
      if (!text) throw new Error('usage: agents task update "<text>"');
      return print(await post(`/api/tasks/${enc(currentTask(flags.task))}/update`, { text, url: flags.url }));
    case "ask": {
      const ask = flags["ask-json"] ? JSON.parse(flags["ask-json"]) : { summary: text, questions: askFromFlags(raw, !!flags["no-other"]) };
      return print(await post(`/api/tasks/${enc(currentTask(flags.task))}/ask`, ask));
    }
    case "answers": {
      const id = currentTask(flags.task);
      const wait = Math.min(Math.max(Number(flags.wait ?? 25), 0), 50);
      // Never outlive the wait: a dropped long-poll (server reload, flaky network) must not hang the agent's
      // tool call past its timeout. The answer stays on the server, so "call again" loses nothing.
      try {
        return print(await call(`/api/tasks/${enc(id)}/answers?wait=${wait}`, { signal: AbortSignal.timeout((wait + 3) * 1000) }));
      } catch (e: any) {
        if (!/abort|timeout|cannot reach|fetch failed/i.test(`${e?.name} ${e?.message}`)) throw e;
        return print({ task_id: id, status: "pending", note: "No reply from the tracker in time; call `agents task answers` again." });
      }
    }
    case "done":
    case "review":
    case "fail": {
      if (!text) throw new Error(`usage: agents task ${sub} "<text>"`);
      // The task stays current: the captain can still send follow-ups to this session.
      return print(await post(`/api/tasks/${enc(currentTask(flags.task))}/done`, { outcome: sub === "fail" ? "failed" : sub, text, url: flags.url }));
    }
    case "pr": {
      const [url] = rest;
      if (!url || !flags.status) throw new Error("usage: agents task pr <pr-url> --status <open|ci_running|ci_passed|ci_failed|merged|closed> [--note n]");
      return print(await post(`/api/tasks/${enc(currentTask(flags.task))}/pr`, { url, status: flags.status, note: flags.note }));
    }
    case "id":
      return print({ task_id: currentTask(flags.task) });
    default:
      throw new Error(TASK_USAGE);
  }
}
