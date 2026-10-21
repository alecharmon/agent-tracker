import { Plugin } from "@opencode/plugin"
import { execFile } from "node:child_process"
import { appendFileSync } from "node:fs"

// agent-tracker for OpenCode (v2 plugin API): liveness from session status, and wake-on-answer.
// After each turn, watch for the captain's answer or follow-up messages, and prompt the session with them.

const BASE = (process.env.AGENTS_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "")
// Token: AGENTS_TOKEN, else the CLI's stored sign-in (`agnt-trkr token`, refreshed as needed)
// with auth disabled locally neither is needed.
let cached: { token: string; at: number } | null = null
function token(): Promise<string> {
  if (process.env.AGENTS_TOKEN) return Promise.resolve(process.env.AGENTS_TOKEN)
  if (cached && Date.now() - cached.at < 5 * 60_000) return Promise.resolve(cached.token)
  return new Promise((resolve) =>
    execFile("agnt-trkr", ["token"], { timeout: 15_000 }, (err, out) => {
      cached = err ? null : { token: out.trim(), at: Date.now() }
      resolve(cached?.token ?? "")
    }),
  )
}
const DEBUG = process.env.AGENTS_DEBUG_LOG
const enc = encodeURIComponent
const log = (...a: unknown[]) => DEBUG && appendFileSync(DEBUG, a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ") + "\n")

async function authHeaders(): Promise<Record<string, string>> {
  const t = await token()
  return t ? { authorization: `Bearer ${t}`, "content-type": "application/json" } : { "content-type": "application/json" }
}

async function call(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: await authHeaders(),
    signal: init.signal ?? AbortSignal.timeout(60_000),
  })
  if (!res.ok) throw new Error(`${res.status}`)
  return res.json()
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
        let p: any
        try {
          p = await call(`/api/tasks/${enc(taskId)}/pending?wait=25`, { signal: AbortSignal.any([ac.signal, AbortSignal.timeout(35_000)]) })
        } catch {
          if (ac.signal.aborted) break
          await new Promise((r) => setTimeout(r, 3000))
          continue
        }
        if (ac.signal.aborted) break
        if (p.answer === "ready" || p.messages > 0) {
          const msg = answerMessage(await call(`/api/tasks/${enc(taskId)}/answers`))
          log("wake", sid)
          if (msg) await ctx.session.prompt({ sessionID: sid, text: msg })
          break
        }
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
            if (!t.waiting) await call(`${base(sid)}/idle`, { method: "POST" })
            // Watch in any state: the captain's answer or a follow-up prompts the session.
            void watch(sid, t.task_id)
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
