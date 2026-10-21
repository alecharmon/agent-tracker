import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { machineName } from "./config.ts";
import { join } from "node:path";

type Call = (path: string, init?: RequestInit) => Promise<any>;

// `agnt-trkr hook <claude-code|codex> <event>`: hook handlers. Hook JSON arrives on stdin.
// Claude Code's Stop hook runs in the background (asyncRewake: exit 2 wakes the idle session);
// Codex and Devin have no rewake, so their Stop hook holds the turn and continues it with {"decision":"block","reason":answer}.
// Hooks only ever track; they never block the agent's real work, so every failure exits 0 quietly.

export const WAKES_HELD =
  "After a task_ask, end your turn instead of polling task_answers: a hook holds the turn until the captain answers, then continues it with the answer.";
export const WAKES =
  "This session wakes automatically when the captain answers a task_ask: after asking, end your turn instead of polling task_answers; the answer starts your next turn.";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const enc = encodeURIComponent;

function stdinJson(): any {
  try {
    return JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {
    return {};
  }
}

/** The answer and/or captain messages, as one message the woken agent can act on. */
export function answerMessage(a: any) {
  const out: string[] = [];
  if (a.status === "answered") {
    out.push("agent-tracker: the captain answered your question on the tracker.");
    for (const x of a.answers ?? []) out.push(`- ${x.question} → ${x.answer}${x.free_text ? " (in the captain's own words)" : ""}`);
    if (a.feedback) out.push(`- Feedback: ${a.feedback}`);
  }
  if (a.captain_messages?.length) {
    out.push("agent-tracker: message from the captain:");
    for (const m of a.captain_messages) out.push(`- ${m.text}`);
  }
  if (!out.length) return null;
  out.push("Act on exactly this now (the captain's own words take precedence over your options), then keep the task updated.");
  return out.join("\n");
}

const waiterDir = join(homedir(), ".cache/agent-tracker/waiters");
function claimWaiter(key: string) {
  mkdirSync(waiterDir, { recursive: true });
  const f = join(waiterDir, key.replace(/[^\w.-]/g, "_"));
  try {
    const pid = Number(readFileSync(f, "utf8"));
    if (pid && pid !== process.pid) {
      process.kill(pid, 0); // throws if gone
      return null; // another waiter already watches this session
    }
  } catch {}
  writeFileSync(f, String(process.pid));
  return () => rmSync(f, { force: true });
}

/** The agent is back (new prompt, or session over): a waiter for this session would wake it twice. */
function stopWaiter(key: string) {
  const f = join(waiterDir, key.replace(/[^\w.-]/g, "_"));
  try {
    const pid = Number(readFileSync(f, "utf8"));
    if (pid && pid !== process.pid) process.kill(pid, "SIGTERM");
  } catch {}
  rmSync(f, { force: true });
}

/** Everything delivered from the session inbox, as one message. Names each task when there's more than one. */
export function inboxMessage(entries: { task_id: string; title: string; answer: any; messages: { text: string }[] }[]) {
  const parts = entries.map((e) => {
    const body = answerMessage({ status: e.answer ? "answered" : "none", answers: e.answer?.answers, feedback: e.answer?.feedback, captain_messages: e.messages })
      ?.split("\n").filter((l) => !l.startsWith("Act on exactly this")).join("\n");
    return entries.length > 1 ? `For task "${e.title}" (task_id ${e.task_id}):\n${body}` : `${body}\n(task "${e.title}", task_id ${e.task_id})`;
  });
  if (!parts.length) return null;
  return [...parts, "Act on exactly this now (the captain's own words take precedence over your options), then keep each task updated."].join("\n\n");
}

/**
 * Wait until something is waiting for this session on any task it owns or dispatched (an answer, a follow-up),
 * then deliver it once. Resolves to the message, or null at the deadline. `answersOnly`: give up as soon as none
 * of its tasks is waiting on the captain (harnesses that hold the turn must not hold it for nothing).
 */
export async function waitForInbox(call: Call, base: string, deadline: number, answersOnly = false) {
  while (Date.now() < deadline) {
    const left = Math.min(25, Math.max(1, Math.floor((deadline - Date.now()) / 1000)));
    let p: any;
    try {
      p = await call(`${base}/inbox?wait=${left}`, { signal: AbortSignal.timeout((left + 5) * 1000) });
    } catch {
      await sleep(3000); // tracker restarting or unreachable: keep watching
      continue;
    }
    if (p.pending > 0) return inboxMessage((await call(`${base}/inbox`, { method: "POST" })).entries);
    if (answersOnly && !p.waiting) return null;
  }
  return null;
}

const HOOKED = ["claude-code", "codex", "devin"];
// Harnesses whose Stop hook must hold the turn (no background rewake).
const HELD = ["codex", "devin"];

export async function hook(call: Call, harness: string, event: string) {
  if (!HOOKED.includes(harness)) throw new Error(`agnt-trkr hook supports ${HOOKED.join(", ")}; Pi uses integrations/pi`);
  const input = stdinJson();
  const sid: string | undefined = input.session_id;
  if (!sid) return;
  const base = `/api/agent-sessions/${harness}/${enc(sid)}`;
  const quiet = async (f: () => Promise<unknown>) => {
    try {
      await f();
    } catch {}
  };

  switch (event) {
    case "session-start": {
      // Later Bash commands inherit these, so `agnt-trkr task …` links to this session.
      if (process.env.CLAUDE_ENV_FILE)
        appendFileSync(process.env.CLAUDE_ENV_FILE, `export AGENTS_HARNESS=${harness}\nexport AGENTS_SESSION=${JSON.stringify(sid)}\nexport AGENTS_MACHINE=${JSON.stringify(machineName())}\n`);
      let current: any = null;
      await quiet(async () => (current = await call(base)));
      const context = [
        `agent-tracker: your harness session id is ${sid} and this machine is "${machineName()}". Pass session: "${sid}" and machine: "${machineName()}" to task_start (the CLI picks both up itself).`,
        HELD.includes(harness) ? WAKES_HELD : WAKES,
        current?.task_id
          ? `This session already works on "${current.title}" (task_id ${current.task_id}, state ${current.state}); keep using that task_id.`
          : "",
      ].filter(Boolean).join(" ");
      console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } }));
      return;
    }
    case "prompt": {
      stopWaiter(sid);
      await quiet(() => call(`${base}/active`, { method: "POST" }));
      // Hand over anything waiting on any of this session's tasks (e.g. a follow-up sent while Codex/Devin sat idle).
      let msg: string | null = null;
      await quiet(async () => (msg = inboxMessage((await call(`${base}/inbox`, { method: "POST" })).entries)));
      if (msg) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: msg } }));
      return;
    }
    case "session-end":
      stopWaiter(sid);
      return quiet(() => call(`${base}/end`, { method: "POST" }));
    case "stop": {
      let t: any = null;
      await quiet(async () => (t = await call(base)));
      if (!t?.task_id) return;
      if (!t.waiting) await quiet(() => call(`${base}/idle`, { method: "POST" }));
      // Claude Code waits in the background in any state (answers and follow-ups on any of its tasks wake it).
      // Codex/Devin hold the turn, so only while one of the session's tasks waits on the captain; their
      // follow-ups arrive with the next prompt.
      let anyWaiting = t.waiting;
      await quiet(async () => (anyWaiting = (await call(`${base}/inbox?wait=0`)).waiting || t.waiting));
      if (HELD.includes(harness) && !anyWaiting) return;
      const release = claimWaiter(sid);
      if (!release) return;
      try {
        // Keep inside the configured hook timeout (integrations/*: 3600s).
        const hours = Number(process.env.AGENTS_HOOK_WAIT_HOURS ?? 1);
        const message = await waitForInbox(call, base, Date.now() + hours * 3600_000 - 30_000, HELD.includes(harness));
        if (!message) return;
        if (HELD.includes(harness)) console.log(JSON.stringify({ decision: "block", reason: message }));
        else {
          // asyncRewake: exit 2 wakes the idle session with stderr as a system reminder.
          process.stderr.write(message + "\n");
          process.exitCode = 2;
        }
      } finally {
        release();
      }
      return;
    }
    default:
      throw new Error(`unknown hook event ${event}: session-start | prompt | stop | session-end`);
  }
}
