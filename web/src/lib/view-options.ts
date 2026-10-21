import { harnessLabel, type Item } from "@/lib/api"

export const STATUS = [
  { key: "all", label: "All", states: null },
  { key: "needs", label: "Needs you", states: ["needs_me", "failed"] },
  { key: "live", label: "Running", states: ["underway", "answered", "validating", "idle"] },
  { key: "review", label: "In review", states: ["review"] },
  { key: "done", label: "Done", states: ["landed"] },
] as const
export type StatusKey = (typeof STATUS)[number]["key"]

export const SORTS = {
  updated: { label: "Recently updated", cmp: (a: Item, b: Item) => time(b, "updated") - time(a, "updated") },
  started: { label: "Recently started", cmp: (a: Item, b: Item) => time(b, "started") - time(a, "started") },
  attention: {
    label: "Needs you first",
    cmp: (a: Item, b: Item) => rank(a) - rank(b) || time(b, "updated") - time(a, "updated"),
  },
  title: { label: "Title", cmp: (a: Item, b: Item) => a.title.localeCompare(b.title) },
} as const
export type SortKey = keyof typeof SORTS

const RANK = ["needs_me", "failed", "review", "answered", "validating", "underway", "idle", "gated", "landed", "unknown"]
const rank = (i: Item) => RANK.indexOf(i.state)
const time = (i: Item, k: "updated" | "started") =>
  Date.parse((k === "updated" ? i.updated_at : i.started_at) ?? i.last_seen ?? i.first_seen)

export interface ViewOptions {
  q: string
  status: StatusKey
  project: string // repo; "" = any
  sort: SortKey
}
export const DEFAULT_OPTIONS: ViewOptions = { q: "", status: "all", project: "", sort: "attention" }

export function matches(i: Item, o: ViewOptions) {
  const st = STATUS.find((s) => s.key === o.status)?.states
  if (st && !(st as readonly string[]).includes(i.state)) return false
  if (o.project && i.repo !== o.project) return false
  if (o.q.trim()) {
    const hay = [i.title, i.detail, i.repo, i.native_id, i.model, ...i.machines, ...i.harnesses.map(harnessLabel)].join(" ").toLowerCase()
    if (!o.q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w))) return false
  }
  return true
}

export const apply = (items: Item[], o: ViewOptions) => items.filter((i) => matches(i, o)).sort(SORTS[o.sort].cmp)
