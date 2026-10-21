import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";

// agent-tracker for Pi: liveness from lifecycle events, and wake-on-answer.
// When a turn ends while the task waits on the captain, watch for the answer and start a new turn with it.
// Talks to the tracker over HTTP (AGENTS_URL, default http://127.0.0.1:8787; AGENTS_TOKEN if auth is on).

const BASE = (process.env.AGENTS_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const TOKEN = process.env.AGENTS_TOKEN ?? (/^http:\/\/(localhost|127\.0\.0\.1)/.test(BASE) ? "dev-token" : "");
const enc = encodeURIComponent;

async function call(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    signal: init.signal ?? AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

function answerMessage(a: any) {
  const lines = (a.answers ?? []).map((x: any) => `- ${x.question} → ${x.answer}${x.free_text ? " (in the captain's own words)" : ""}`);
  if (a.feedback) lines.push(`- Feedback: ${a.feedback}`);
  return [
    "agent-tracker: the captain answered your question on the tracker.",
    ...lines,
    "Act on exactly this now (the captain's own words take precedence over your options), then keep the task updated.",
  ].join("\n");
}

const CONTEXT =
  "agent-tracker: this session wakes automatically when the captain answers a task question: after `agents task ask`, end your turn instead of polling `agents task answers`; the answer starts your next turn.";

export default function (pi: ExtensionAPI) {
  let session = "";
  let told = false;
  let watching: AbortController | null = null;
  const base = () => `/api/agent-sessions/pi/${enc(session)}`;
  const quiet = (p: Promise<unknown>) => p.catch(() => {});

  const stopWatching = () => {
    watching?.abort();
    watching = null;
  };

  async function watch(taskId: string) {
    stopWatching();
    const ac = new AbortController();
    watching = ac;
    const deadline = Date.now() + Number(process.env.AGENTS_HOOK_WAIT_HOURS ?? 1) * 3600_000;
    while (!ac.signal.aborted && Date.now() < deadline) {
      let peek: any;
      try {
        peek = await call(`/api/tasks/${enc(taskId)}/answers?peek=1&wait=25`, { signal: AbortSignal.any([ac.signal, AbortSignal.timeout(35_000)]) });
      } catch {
        if (ac.signal.aborted) return;
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      if (peek.status === "answered") {
        if (!peek.delivered && !ac.signal.aborted) {
          const a = await call(`/api/tasks/${enc(taskId)}/answers`);
          pi.sendMessage({ customType: "agent-tracker", content: answerMessage(a), display: true }, { triggerTurn: true, deliverAs: "followUp" });
        }
        break;
      }
      if (peek.status !== "pending" || !["needs_me", "answered"].includes(peek.state)) break;
    }
    if (watching === ac) watching = null;
  }

  pi.on("session_start", async (_event, ctx) => {
    const file = ctx.sessionManager.getSessionFile?.();
    session = file ? basename(file).replace(/\.jsonl$/, "") : `pi-${process.pid}`;
    // bash children inherit these, so `agents task …` links tasks to this session
    process.env.AGENTS_HARNESS = "pi";
    process.env.AGENTS_SESSION = session;
  });
  pi.on("before_agent_start", async () => {
    if (told) return;
    told = true;
    return { message: { customType: "agent-tracker", content: CONTEXT, display: false } };
  });
  pi.on("agent_start", async () => {
    stopWatching();
    if (session) await quiet(call(`${base()}/active`, { method: "POST" }));
  });
  pi.on("agent_end", async () => {
    if (!session) return;
    try {
      const t = await call(base());
      if (!t?.task_id) return;
      if (t.waiting) void watch(t.task_id);
      else await call(`${base()}/idle`, { method: "POST" });
    } catch {}
  });
  pi.on("session_shutdown", async () => {
    stopWatching();
    if (session) await quiet(call(`${base()}/end`, { method: "POST" }));
  });
}
