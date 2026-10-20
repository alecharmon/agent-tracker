import type { Ask, Item, Pr, ResponseIn, Session, TrackerEvent, TrackerResponse } from "@agent-tracker/core"
import * as React from "react"

export type { Ask, Item, Pr, ResponseIn, Session, TrackerEvent, TrackerResponse }
export type ItemDetail = { item: Item; events: TrackerEvent[]; prs: Pr[]; responses: TrackerResponse[]; sessions: Session[] }

const KEY = "agents-token"
const isLocal = ["localhost", "127.0.0.1"].includes(location.hostname)

export function getToken(): string | null {
  try {
    return localStorage.getItem(KEY) ?? (isLocal ? "dev-token" : null)
  } catch {
    return isLocal ? "dev-token" : null
  }
}
export function setToken(t: string | null) {
  try {
    if (t) localStorage.setItem(KEY, t)
    else localStorage.removeItem(KEY)
  } catch {}
}

export class Unauthorized extends Error {}

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${getToken() ?? ""}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (res.status === 401) throw new Unauthorized("unauthorized")
  if (!res.ok) throw new Error(`${res.status} ${(await res.json().catch(() => ({}))).error ?? res.statusText}`)
  return res.json()
}

const REFRESH = "agents:refresh"
/** Ask every poller to refetch now, e.g. after a response. */
export const refreshAll = () => dispatchEvent(new Event(REFRESH))

export async function respond(item: Item, r: ResponseIn) {
  const out = await api<ItemDetail>(`/api/items/${encodeURIComponent(item.id)}/respond`, r)
  refreshAll()
  return out
}

/** Fetch `path` now and every `ms`; refetches when `path` changes. */
export function usePoll<T>(path: string | null, ms = 15_000) {
  const [state, setState] = React.useState<{ data?: T; error?: Error }>({})
  React.useEffect(() => {
    if (!path) return
    let live = true
    const load = () =>
      api<T>(path).then(
        (data) => live && setState({ data }),
        (error) => live && setState((s) => ({ ...s, error })),
      )
    load()
    const t = setInterval(load, ms)
    addEventListener(REFRESH, load)
    return () => {
      live = false
      clearInterval(t)
      removeEventListener(REFRESH, load)
    }
  }, [path, ms])
  return state
}

/** Re-render every `ms` so relative times stay fresh. */
export function useNow(ms = 10_000) {
  const [now, setNow] = React.useState(Date.now())
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

export function duration(fromIso: string | null, toMs: number) {
  if (!fromIso) return ""
  const s = Math.max(0, Math.round((toMs - Date.parse(fromIso)) / 1000))
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  if (s < 172800) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
  return `${Math.floor(s / 86400)}d`
}

export function ago(iso: string | null, now: number) {
  if (!iso) return ""
  const m = Math.round((now - Date.parse(iso)) / 60_000)
  return m < 1 ? "now" : m < 60 ? `${m}m ago` : m < 2880 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`
}

export const lane = (i: Item) => i.agent ?? i.owner ?? i.source
/** When an item stops on the timeline: live ones run to now. */
export const endOf = (i: Item, now: number) =>
  ["underway", "needs_me", "answered"].includes(i.state) ? now : Date.parse(i.updated_at ?? i.last_seen)
export const startOf = (i: Item) => Date.parse(i.started_at ?? i.first_seen)

const HARNESS: Record<string, string> = {
  "claude-code": "Claude Code", codex: "Codex", opencode: "OpenCode", pi: "Pi", devin: "Devin", firstmate: "Firstmate", herdr: "Herdr",
}
export const harnessLabel = (h: string) => HARNESS[h] ?? h.replace(/^./, (c) => c.toUpperCase())

/** Provider mark for a model name: Anthropic, OpenAI, Google or generic. */
export function provider(model: string | null, harness?: string | null) {
  const m = `${model ?? ""} ${harness ?? ""}`.toLowerCase()
  if (/opus|sonnet|haiku|claude|fable/.test(m)) return "anthropic"
  if (/devin|swe-/.test(m)) return "devin"
  if (/gpt|o\d|openai|codex/.test(m)) return "openai"
  if (/gemini/.test(m)) return "google"
  return "other"
}

export const STATE_LABEL: Record<string, string> = {
  needs_me: "Needs you", answered: "Answered", failed: "Failed", underway: "Running", landed: "Done", gated: "Gated", idle: "Idle", unknown: "Unknown",
}
