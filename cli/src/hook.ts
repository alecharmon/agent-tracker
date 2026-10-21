import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type Call = (path: string, init?: RequestInit) => Promise<any>;

// `agents hook <claude-code|codex> <event>`: hook handlers. Hook JSON arrives on stdin.
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

/** What the captain said, as one message the woken agent can act on. */
export function answerMessage(a: any) {
  const lines = (a.answers ?? []).map((x: any) => `- ${x.question} → ${x.answer}${x.free_text ? " (in the captain's own words)" : ""}`);
  if (a.feedback) lines.push(`- Feedback: ${a.feedback}`);
  return [
    "agent-tracker: the captain answered your question on the tracker.",
    ...lines,
    "Act on exactly this now (the captain's own words take precedence over your options), then keep the task updated.",
  ].join("\n");
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

/**
 * Wait for the captain's answer without delivering it, then deliver it once.
 * Resolves to the answer message, or null when the agent read it itself, the ask went away, or time ran out.
 */
export async function waitForAnswer(call: Call, taskId: string, deadline: number) {
  while (Date.now() < deadline) {
    const left = Math.min(25, Math.max(1, Math.floor((deadline - Date.now()) / 1000)));
    let peek: any;
    try {
      peek = await call(`/api/tasks/${enc(taskId)}/answers?peek=1&wait=${left}`, { signal: AbortSignal.timeout((left + 5) * 1000) });
    } catch {
      await sleep(3000); // tracker restarting or unreachable: keep watching
      continue;
    }
    if (peek.status === "answered") {
      if (peek.delivered) return null; // the agent already has it
      return answerMessage(await call(`/api/tasks/${enc(taskId)}/answers`));
    }
    if (peek.status !== "pending" || !["needs_me", "answered"].includes(peek.state)) return null;
  }
  return null;
}

const HOOKED = ["claude-code", "codex", "devin"];
// Harnesses whose Stop hook must hold the turn (no background rewake).
const HELD = ["codex", "devin"];

export async function hook(call: Call, harness: string, event: string) {
  if (!HOOKED.includes(harness)) throw new Error(`agents hook supports ${HOOKED.join(", ")}; Pi uses integrations/pi`);
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
      // Later Bash commands inherit these, so `agents task …` links to this session.
      if (process.env.CLAUDE_ENV_FILE)
        appendFileSync(process.env.CLAUDE_ENV_FILE, `export AGENTS_HARNESS=${harness}\nexport AGENTS_SESSION=${JSON.stringify(sid)}\n`);
      let current: any = null;
      await quiet(async () => (current = await call(base)));
      const context = [
        `agent-tracker: your harness session id is ${sid}. Pass session: "${sid}" to task_start (the CLI picks it up from $AGENTS_SESSION).`,
        HELD.includes(harness) ? WAKES_HELD : WAKES,
        current?.task_id
          ? `This session already works on "${current.title}" (task_id ${current.task_id}, state ${current.state}); keep using that task_id.`
          : "",
      ].filter(Boolean).join(" ");
      console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } }));
      return;
    }
    case "prompt":
      stopWaiter(sid);
      return quiet(() => call(`${base}/active`, { method: "POST" }));
    case "session-end":
      stopWaiter(sid);
      return quiet(() => call(`${base}/end`, { method: "POST" }));
    case "stop": {
      let t: any = null;
      await quiet(async () => (t = await call(base)));
      if (!t?.task_id) return;
      if (!t.waiting) return quiet(() => call(`${base}/idle`, { method: "POST" }));
      const release = claimWaiter(sid);
      if (!release) return;
      try {
        // Keep inside the configured hook timeout (integrations/*: 3600s).
        const hours = Number(process.env.AGENTS_HOOK_WAIT_HOURS ?? 1);
        const message = await waitForAnswer(call, t.task_id, Date.now() + hours * 3600_000 - 30_000);
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
