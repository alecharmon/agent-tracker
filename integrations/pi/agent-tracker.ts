import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { basename } from "node:path";

// agent-tracker for Pi: liveness from lifecycle events, and wake-on-answer.
// After each turn, watch for the captain's answer or follow-up messages, and start a new turn with them.
// Talks to the tracker over HTTP (AGENTS_URL, default http://127.0.0.1:8787; AGENTS_TOKEN if auth is on).

// Tracker URL: AGENTS_URL, else the CLI's configured url (`agnt-trkr config get url`, which also applies;
// AGENTS_URL and defaults to http://127.0.0.1:8787). Resolved once per process.;
let base: Promise<string> | null = null;
function baseUrl(): Promise<string> {
  base ??= process.env.AGENTS_URL
    ? Promise.resolve(process.env.AGENTS_URL)
    : new Promise((resolve) =>
        execFile("agnt-trkr", ["config", "get", "url"], { timeout: 10_000 }, (err, out) =>
          resolve(!err && out.trim() ? out.trim() : "http://127.0.0.1:8787"),
        ),
      );
  return base.then((u) => u.replace(/\/$/, ""));
}
// Token: AGENTS_TOKEN, else the CLI's stored sign-in (`agnt-trkr token`, refreshed as needed);
// with auth disabled locally neither is needed.;
let cached: { token: string; at: number } | null = null;
function token(): Promise<string> {
  if (process.env.AGENTS_TOKEN) return Promise.resolve(process.env.AGENTS_TOKEN);
  if (cached && Date.now() - cached.at < 5 * 60_000) return Promise.resolve(cached.token);
  return new Promise((resolve) =>
    execFile("agnt-trkr", ["token"], { timeout: 15_000 }, (err, out) => {
      cached = err ? null : { token: out.trim(), at: Date.now() };
      resolve(cached?.token ?? "");
    }),
  );
}
const enc = encodeURIComponent;

async function authHeaders(): Promise<Record<string, string>> {
  const t = await token();
  return t ? { authorization: `Bearer ${t}`, "content-type": "application/json" } : { "content-type": "application/json" };
}

async function call(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch((await baseUrl()) + path, {
    ...init,
    headers: await authHeaders(),
    signal: init.signal ?? AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

function answerMessage(a: any) {
  const out: string[] = []
  if (a.status === "answered") {
    out.push("agent-tracker: the captain answered your question on the tracker.")
    for (const x of a.answers ?? []) out.push(`- ${x.question} → ${x.answer}${x.free_text ? " (in the captain's own words)" : ""}`)
    if (a.feedback) out.push(`- Feedback: ${a.feedback}`)
  }
  if (a.captain_messages?.length) {
    out.push("agent-tracker: message from the captain:")
    for (const m of a.captain_messages) out.push(`- ${m.text}`)
  }
  if (!out.length) return null
  out.push("Act on exactly this now (the captain's own words take precedence over your options), then keep the task updated.")
  return out.join("\n")
}

const CONTEXT =
  "agent-tracker: this session wakes automatically when the captain answers a task question: after `agnt-trkr task ask`, end your turn instead of polling `agnt-trkr task answers`; the answer starts your next turn.";


/** Everything delivered from the session inbox, as one message; names each task when there are several. */
function inboxMessage(entries: { task_id: string; title: string; answer: any; messages: { text: string }[] }[]) {
  const parts = entries.map((e) => {
    const body = (answerMessage({ status: e.answer ? "answered" : "none", answers: e.answer?.answers, feedback: e.answer?.feedback, captain_messages: e.messages }) ?? "")
      .split("\n").filter((l) => !l.startsWith("Act on exactly this")).join("\n");
    return entries.length > 1 ? `For task "${e.title}" (task_id ${e.task_id}):\n${body}` : `${body}\n(task "${e.title}", task_id ${e.task_id})`
  });
  return parts.length ? [...parts, "Act on exactly this now (the captain's own words take precedence over your options), then keep each task updated."].join("\n\n") : null
}

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

  // Watches every task this session owns or dispatched: an answer or follow-up on any of them starts a turn.
  async function watch() {
    stopWatching();
    const ac = new AbortController();
    watching = ac;
    const deadline = Date.now() + Number(process.env.AGENTS_HOOK_WAIT_HOURS ?? 1) * 3600_000;
    while (!ac.signal.aborted && Date.now() < deadline) {
      let p: any;
      try {
        p = await call(`${base()}/inbox?wait=25`, { signal: AbortSignal.any([ac.signal, AbortSignal.timeout(35_000)]) });
      } catch {
        if (ac.signal.aborted) return;
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      if (ac.signal.aborted) return;
      if (p.pending > 0) {
        const msg = inboxMessage((await call(`${base()}/inbox`, { method: "POST" })).entries);
        if (msg) pi.sendMessage({ customType: "agent-tracker", content: msg, display: true }, { triggerTurn: true, deliverAs: "followUp" });
        break;
      }
    }
    if (watching === ac) watching = null;
  }

  pi.on("session_start", async (_event, ctx) => {
    const file = ctx.sessionManager.getSessionFile?.();
    session = file ? basename(file).replace(/\.jsonl$/, "") : `pi-${process.pid}`;
    // bash children inherit these, so `agnt-trkr task …` links tasks to this session
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
      if (!t.waiting) await call(`${base()}/idle`, { method: "POST" });
      // Watch in any state: the captain's answer or a follow-up starts the next turn.
      void watch();
    } catch {}
  });
  pi.on("session_shutdown", async () => {
    stopWatching();
    if (session) await quiet(call(`${base()}/end`, { method: "POST" }));
  });
}
