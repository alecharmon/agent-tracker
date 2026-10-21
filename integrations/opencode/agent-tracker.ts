import { Plugin } from "@opencode/plugin"
import { appendFileSync } from "node:fs"

// agent-tracker for OpenCode (v2 plugin API): liveness from session status, and wake-on-answer.
// When a session goes idle while its task waits on the captain, watch for the answer and prompt the session with it.

const BASE = (process.env.AGENTS_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "")
const TOKEN = process.env.AGENTS_TOKEN ?? (/^http:\/\/(localhost|127\.0\.0\.1)/.test(BASE) ? "dev-token" : "")
const DEBUG = process.env.AGENTS_DEBUG_LOG
const enc = encodeURIComponent
const log = (...a: unknown[]) => DEBUG && appendFileSync(DEBUG, a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ") + "\n")

async function call(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    signal: init.signal ?? AbortSignal.timeout(60_000),
  })
  if (!res.ok) throw new Error(`${res.status}`)
  return res.json()
}

function answerMessage(a: any) {
  const lines = (a.answers ?? []).map((x: any) => `- ${x.question} → ${x.answer}${x.free_text ? " (in the captain's own words)" : ""}`)
  if (a.feedback) lines.push(`- Feedback: ${a.feedback}`)
  return [
    "agent-tracker: the captain answered your question on the tracker.",
    ...lines,
    "Act on exactly this now (the captain's own words take precedence over your options), then keep the task updated.",
  ].join("\n")
}

const sessionOf = (e: any): string | undefined => e?.properties?.sessionID ?? e?.data?.sessionID ?? e?.sessionID
// OpenCode v2 brackets each turn with session.execution.started / .succeeded (or .failed/.cancelled);
// older builds send session.status / session.idle.
const statusOf = (e: any): string | undefined => {
  if (e?.type === "session.execution.started") return "busy"
  if (/^session\.execution\.(succeeded|failed|cancelled|canceled|ended|interrupted)$/.test(e?.type ?? "")) return "idle"
  if (e?.type === "session.idle") return "idle"
  if (e?.type !== "session.status") return undefined
  const s = e?.properties?.status ?? e?.data?.status ?? e?.status
  return typeof s === "string" ? s : s?.type
}

export default Plugin.define({
  id: "agent-tracker",
  setup(ctx: any) {
    const stop = new AbortController()
    const watchers = new Map<string, AbortController>()
    const base = (sid: string) => `/api/agent-sessions/opencode/${enc(sid)}`

    async function watch(sid: string, taskId: string) {
      watchers.get(sid)?.abort()
      const ac = new AbortController()
      watchers.set(sid, ac)
      const deadline = Date.now() + Number(process.env.AGENTS_HOOK_WAIT_HOURS ?? 1) * 3600_000
      while (!ac.signal.aborted && Date.now() < deadline) {
        let peek: any
        try {
          peek = await call(`/api/tasks/${enc(taskId)}/answers?peek=1&wait=25`, { signal: AbortSignal.any([ac.signal, AbortSignal.timeout(35_000)]) })
        } catch {
          if (ac.signal.aborted) break
          await new Promise((r) => setTimeout(r, 3000))
          continue
        }
        if (peek.status === "answered") {
          if (!peek.delivered && !ac.signal.aborted) {
            const a = await call(`/api/tasks/${enc(taskId)}/answers`)
            log("wake", sid)
            await ctx.session.prompt({ sessionID: sid, text: answerMessage(a) })
          }
          break
        }
        if (peek.status !== "pending" || !["needs_me", "answered"].includes(peek.state)) break
      }
      if (watchers.get(sid) === ac) watchers.delete(sid)
    }

    // Tell the model its session id, so task_start links the task to this session.
    void ctx.session.hook("context", (event: any) => {
      const sid = event.sessionID ?? event.session?.id
      log("context keys", Object.keys(event), sid)
      if (!sid) return
      event.system.push({
        type: "text",
        text: `agent-tracker: your harness session id is ${sid}; pass session: "${sid}" to task_start. This session wakes automatically when the captain answers a task_ask: after asking, end your turn instead of polling task_answers; the answer starts your next turn.`,
      })
    })

    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: stop.signal })) {
        const sid = sessionOf(event)
        const status = statusOf(event)
        if (event?.type?.startsWith?.("session.")) log("event", event.type, sid, status)
        if (!sid || !status) continue
        try {
          if (status === "busy") {
            watchers.get(sid)?.abort()
            await call(`${base(sid)}/active`, { method: "POST" })
          } else if (status === "idle") {
            const t = await call(base(sid))
            if (!t?.task_id) continue
            if (t.waiting) void watch(sid, t.task_id)
            else await call(`${base(sid)}/idle`, { method: "POST" })
          }
        } catch (e) {
          log("error", String(e))
        }
      }
    })()

    return () => {
      stop.abort()
      for (const w of watchers.values()) w.abort()
    }
  },
})
