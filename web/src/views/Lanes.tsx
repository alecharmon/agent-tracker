import { AlertTriangleIcon, CornerDownRightIcon, SparkleIcon } from "lucide-react"
import { motion } from "motion/react"
import * as React from "react"
import { RichText } from "@/components/rich-text"
import { RollingNumber } from "@/components/rolling-number"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { duration, harnessLabel, type Item, type Session, STATE_LABEL, type TrackerEvent, useNow, usePoll } from "@/lib/api"
import { apply, type ViewOptions } from "@/lib/view-options"
import { cn } from "@/lib/utils"
import { ProviderMark, StateIcon, tone } from "./states"

const PRESETS = [30, 120, 1440] // minutes
const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl"
const MIN_SPAN = 5
const MAX_SPAN = 7 * 1440
// Fetch in coarse buckets so zooming doesn't refetch on every wheel tick.
const BUCKETS = [30, 120, 360, 1440, 4320, MAX_SPAN]
const spanLabel = (m: number) => (m < 120 ? `${Math.round(m)}m` : m < 2880 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`)
/** ~5 evenly spaced ticks on round numbers of minutes. */
function ticksFor(minutes: number) {
  const step = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440, 2880].find((s) => minutes / s <= 6) ?? 2880
  const out: number[] = []
  for (let m = step; m < minutes * 0.97; m += step) out.push(m)
  return out
}
const ROW = 36 // px per segment row
const GAP = 6
const PAD = 9
const MIN_BLOCK = 36 // px
const LIVE = ["underway", "needs_me", "answered", "validating"]
const curve = (x1: number, y1: number, x2: number, y2: number, k: number) =>
  `M ${x1} ${y1} C ${x1 + k} ${y1}, ${x2 - k} ${y2}, ${x2} ${y2}`
// Segments grow into "now" and drift left on a 1s linear clock; hand-off streams use the same one.
// While zooming, they follow the wheel instead.
const TICK = { duration: 1, ease: "linear" } as const
const ZOOM = { duration: 0.12, ease: "easeOut" } as const
type Motion = typeof TICK | typeof ZOOM

type Seg = { s: Session; task: Item; start: number; end: number; latest: boolean }

/** Greedy packing: sessions of one task that overlap (parallel agents) go to the next row. */
function pack(segs: Seg[]) {
  const rows: { end: number; segs: Seg[] }[] = []
  for (const g of [...segs].sort((a, b) => a.start - b.start)) {
    const row = rows.find((r) => r.end <= g.start)
    if (row) (row.segs.push(g), (row.end = g.end))
    else rows.push({ end: g.end, segs: [g] })
  }
  return rows.map((r) => r.segs)
}

/** Parents first, each followed by its children (depth-first), in start order. */
function order(items: Item[]) {
  const byParent = Map.groupBy(items, (i) => (i.parent_id && items.some((p) => p.id === i.parent_id) ? i.parent_id : ""))
  const out: { item: Item; depth: number }[] = []
  const walk = (pid: string, depth: number) => {
    for (const i of byParent.get(pid) ?? []) (out.push({ item: i, depth }), walk(i.id, depth + 1))
  }
  walk("", 0)
  return out
}

export function Lanes({ onOpen, options }: { onOpen: (i: Item, siblings: Item[]) => void; options: ViewOptions }) {
  const [minutes, setMinutes] = React.useState(30)
  const fetchMinutes = BUCKETS.find((b) => b >= minutes) ?? MAX_SPAN
  const t = usePoll<{ items: Item[]; sessions: Session[]; events: TrackerEvent[] }>(`/api/timeline?minutes=${fetchMinutes}`, 5_000)
  // ⌘/Ctrl + scroll (and trackpad pinch, which arrives as ctrl+wheel) zooms; the right edge stays "now".
  const card = React.useRef<HTMLDivElement>(null)
  const lastZoom = React.useRef(0)
  React.useEffect(() => {
    const el = card.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.metaKey && !e.ctrlKey) return
      e.preventDefault()
      lastZoom.current = Date.now()
      setMinutes((m) => Math.min(Math.max(m * Math.exp(e.deltaY * 0.004), MIN_SPAN), MAX_SPAN))
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, [])
  const tick: Motion = Date.now() - lastZoom.current < 400 ? ZOOM : TICK
  const now = useNow(1_000)
  const span = minutes * 60_000
  const from = now - span
  const track = React.useRef<HTMLDivElement>(null)
  const [width, setWidth] = React.useState(0)
  React.useLayoutEffect(() => {
    const el = track.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  // Time -> px, with blocks kept inside the track: a short block near "now" ends at the edge, not past it.
  const px = (ms: number) => ((Math.min(Math.max(ms, from), now) - from) / span) * width

  const items = apply(t.data?.items ?? [], options)
  const sessions = t.data?.sessions ?? []
  const byTask = Map.groupBy(sessions, (s) => s.task_id)
  const rows = order(items).map(({ item, depth }) => {
    const ss = (byTask.get(item.id) ?? []).sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at))
    const segs: Seg[] = ss.map((s, k) => {
      const latest = k === ss.length - 1
      const end = s.ended_at ? Date.parse(s.ended_at) : latest && LIVE.includes(item.state) ? now : Date.parse(s.last_seen)
      return { s, task: item, start: Date.parse(s.started_at), end: Math.max(end, Date.parse(s.started_at)), latest }
    })
    return { item, depth, packed: pack(segs) }
  })
    // The fetch bucket can be wider than the zoomed view: keep only tasks visible in it.
    .filter((r) => LIVE.includes(r.item.state) || r.packed.flat().some((g) => g.end >= from))
  let y = 0
  const laid = rows.map((r) => {
    const height = PAD * 2 + Math.max(r.packed.length, 1) * ROW + (Math.max(r.packed.length, 1) - 1) * GAP
    const out = { ...r, top: y, height }
    y += height
    return out
  })
  const height = y

  // Geometry of every segment, in px, for blocks and the streams between them.
  const geo = new Map<string, { x1: number; x2: number; cy: number; seg: Seg }>()
  for (const r of laid)
    r.packed.forEach((row, k) =>
      row.forEach((g) => {
        const x1 = Math.min(px(g.start), Math.max(width - MIN_BLOCK, 0))
        geo.set(g.s.id, { x1, x2: Math.max(px(g.end), x1 + MIN_BLOCK), cy: r.top + PAD + k * (ROW + GAP) + ROW / 2, seg: g })
      }),
    )
  const firstOf = (taskId: string) => (byTask.get(taskId) ?? []).map((s) => geo.get(s.id)).filter(Boolean).sort((a, b) => a!.x1 - b!.x1)[0]
  const lastOf = (taskId: string) => (byTask.get(taskId) ?? []).map((s) => geo.get(s.id)).filter(Boolean).sort((a, b) => b!.x2 - a!.x2)[0]
  const streams: { id: string; d: string; kind: "handoff" | "dispatch" }[] = []
  for (const r of laid) {
    const ss = r.packed.flat().sort((a, b) => a.start - b.start)
    // agent -> agent on the same task
    for (let k = 1; k < ss.length; k++) {
      const a = geo.get(ss[k - 1].s.id)!, b = geo.get(ss[k].s.id)!
      if (a.cy !== b.cy || b.x1 > a.x2 + 2) streams.push({ id: `${ss[k].s.id}-h`, d: curve(a.x2, a.cy, b.x1, b.cy, Math.max(14, Math.abs(b.x1 - a.x2) / 2)), kind: "handoff" })
    }
    const first = firstOf(r.item.id)
    // parent -> the task it dispatched: drop from the parent's block at the moment the child started
    const parent = r.item.parent_id ? lastOf(r.item.parent_id) : undefined
    if (first && parent) {
      const x = Math.min(Math.max(first.x1, parent.x1 + 6), parent.x2)
      streams.push({ id: `${r.item.id}-p`, d: `M ${x} ${parent.cy + ROW / 2 - 2} C ${x} ${first.cy}, ${x} ${first.cy}, ${first.x1} ${first.cy}`, kind: "dispatch" })
    }
    // a task that picks up another task's output
    const prev = r.item.handoff_from ? lastOf(r.item.handoff_from) : undefined
    if (first && prev) streams.push({ id: `${r.item.id}-f`, d: curve(prev.x2, prev.cy, first.x1, first.cy, Math.max(14, Math.abs(first.x1 - prev.x2) / 2)), kind: "handoff" })
  }

  const eventsBy = Map.groupBy(t.data?.events ?? [], (e) => e.session_id ?? `${e.item_id}#0`)
  const running = items.filter((i) => i.state === "underway").length
  const needs = items.filter((i) => i.state === "needs_me").length
  const ticks = ticksFor(minutes)
  const fmt = (m: number) => `−${m >= 1440 && m % 1440 === 0 ? `${m / 1440}d` : m >= 60 && m % 60 === 0 ? `${m / 60}h` : `${m}m`}`

  return (
    <section aria-label="Task lanes" className="flex flex-col gap-3 rounded-2xl border bg-card/40 p-4 sm:p-5">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
        <SparkleIcon className="size-4 fill-blue-500/20 text-blue-500" aria-hidden />
        <h2 className="font-semibold">Tasks</h2>
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <span className="size-1.5 rounded-full bg-blue-500" aria-hidden /><RollingNumber value={running} /> running
        </span>
        <span className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
          <span className="size-1.5 rounded-full bg-amber-500" aria-hidden /><RollingNumber value={needs} /> need you
        </span>
        <span className="ml-auto hidden text-xs text-muted-foreground sm:inline">
          <kbd className="rounded border px-1 font-sans">{MOD}</kbd> + scroll to zoom · last <span className="tabular-nums text-foreground">{spanLabel(minutes)}</span>
        </span>
        <ToggleGroup value={PRESETS.includes(minutes) ? [String(minutes)] : []}
          onValueChange={(v) => v[0] && setMinutes(Number(v[0]))} size="sm" variant="outline">
          {PRESETS.map((m) => <ToggleGroupItem key={m} value={String(m)}>{spanLabel(m)}</ToggleGroupItem>)}
        </ToggleGroup>
      </header>

      <div ref={card} className="overflow-x-auto rounded-xl border bg-card">
        <div className="grid min-w-[720px] grid-cols-[17rem_1fr] px-4 pt-3 pb-2">
          <div />
          <div className="relative h-6 text-xs text-muted-foreground tabular-nums">
            {ticks.map((m) => (
              <span key={m} className="absolute -translate-x-1/2" style={{ left: `${(1 - m / minutes) * 100}%` }}>{fmt(m)}</span>
            ))}
            <span className="absolute right-0 rounded bg-blue-500/15 px-1.5 font-medium text-blue-600 dark:text-blue-300">now</span>
          </div>

          {t.error && !t.data && <p role="alert" className="col-span-2 py-6 text-sm text-destructive">{t.error.message}</p>}
          {t.data && !laid.length && <p className="col-span-2 py-10 text-center text-sm text-muted-foreground">No tasks in this window.</p>}

          <div>
            {laid.map((r) => {
              const harnesses = [...new Set(r.packed.flat().map((g) => g.s.harness))]
              return (
                <div key={r.item.id} className={cn("flex items-center gap-2 pr-3", r.depth === 0 && "border-t first:border-t-0")}
                  style={{ height: r.height, paddingLeft: r.depth * 18 }}>
                  {r.depth > 0 && <CornerDownRightIcon className="size-3.5 shrink-0 text-muted-foreground/60" aria-hidden />}
                  <span className="flex min-w-0 flex-col">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <StateIcon state={r.item.state} className={cn("size-3", tone(r.item.state).text)} />
                      <span className="truncate text-sm font-medium" title={r.item.title}>{r.item.title}</span>
                    </span>
                    <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                      <span className="truncate">{[STATE_LABEL[r.item.state], r.item.repo, r.item.machines.join(", ")].filter(Boolean).join(" · ")}</span>
                      <span className="ml-1 flex shrink-0 -space-x-1">
                        {harnesses.map((h) => (
                          <span key={h} title={harnessLabel(h)} className="flex size-4 items-center justify-center rounded-full border bg-card">
                            <ProviderMark harness={h} model={r.packed.flat().find((g) => g.s.harness === h)?.s.model ?? null} className="size-2.5" />
                          </span>
                        ))}
                      </span>
                    </span>
                  </span>
                </div>
              )
            })}
          </div>

          {/* The track fades out at the left edge: blocks drift off it as time moves. */}
          <div ref={track} className="relative [mask-image:linear-gradient(to_right,transparent,black_5%)]" style={{ height }}>
            {laid.filter((r) => r.depth === 0).map((r) => (
              <div key={r.item.id} aria-hidden className="absolute inset-x-0 border-t first:border-t-0" style={{ top: r.top }} />
            ))}
            {ticks.map((m) => (
              <span key={m} aria-hidden className="absolute inset-y-0 border-l border-dashed border-border/70" style={{ left: `${(1 - m / minutes) * 100}%` }} />
            ))}
            <svg aria-hidden className="pointer-events-none absolute inset-0 size-full overflow-visible">
              {width > 0 && streams.map((st) => (
                <motion.path key={st.id} initial={{ opacity: 0, d: st.d }} animate={{ opacity: 1, d: st.d }}
                  transition={{ d: tick, opacity: { duration: 0.4 } }}
                  fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round"
                  className={cn("agents-flow", st.kind === "dispatch" ? "text-violet-400/60" : "text-blue-400/70")} />
              ))}
            </svg>
            {width > 0 && [...geo.values()].map(({ x1, x2, cy, seg }) => (
              <Block key={seg.s.id} seg={seg} events={eventsBy.get(seg.s.id) ?? []} now={now} track={width} tick={tick}
                left={x1} width={x2 - x1} top={cy - ROW / 2} onOpen={() => onOpen(seg.task, laid.map((r) => r.item))} />
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}

const NARROW = 110 // px: below this a block can't hold its label, so the label sits beside it

function Block({ seg, events, now, left, width, top, track, tick, onOpen }: {
  seg: Seg; events: TrackerEvent[]; now: number; left: number; width: number; top: number; track: number; tick: Motion; onOpen: () => void
}) {
  const { s, task, latest } = seg
  // Only the session holding the task now carries its state; earlier stints read as finished.
  const state = latest ? task.state : "landed"
  const live = latest && LIVE.includes(task.state)
  const steps = (events.length ? events.slice(-3).map((e) => e.text || e.verb) : [task.detail ?? ""]).filter(Boolean)
  const who = s.id.endsWith("#0") ? (s.agent ?? harnessLabel(s.harness)) : harnessLabel(s.harness)
  const narrow = width < NARROW
  // Beside the block: to its right, or to its left when it hugs "now".
  const side = left + width + 6 + 160 > track ? { right: track - left + 6 } : { left: left + width + 6 }
  const label = <>{who}{s.model ? <span className="font-normal opacity-70"> · {s.model}</span> : null}</>
  return (
    <>
    {narrow && (
      <motion.span aria-hidden initial={false} animate={side} transition={{ left: tick, right: tick }}
        className="pointer-events-none absolute flex max-w-40 items-center truncate text-xs font-medium whitespace-nowrap text-muted-foreground"
        style={{ top, height: ROW }}>
        <span className="truncate">{label}</span>
      </motion.span>
    )}
    <Tooltip>
      <TooltipTrigger
        render={
          <motion.button
            type="button"
            onClick={onOpen}
            initial={{ opacity: 0, scaleX: 0.85, left, width }}
            animate={{ opacity: 1, scaleX: 1, left, width }}
            transition={{ left: tick, width: tick, default: { type: "spring", stiffness: 260, damping: 30 } }}
            className={cn(
              "absolute flex origin-left items-center gap-1.5 overflow-hidden rounded-md border px-2 text-left text-xs font-medium whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring",
              tone(state).bar,
              live && "border-r-2",
              state === "underway" && "border-r-blue-400",
              state === "needs_me" && "border-r-amber-400",
              state === "answered" && "border-r-violet-400",
            )}
            style={{ top, height: ROW }}
            aria-haspopup="dialog"
            aria-label={`${task.title}: ${who}, ${STATE_LABEL[state]}${state === "needs_me" ? ", open to respond" : ", open details"}`}
          />
        }
      >
        {state === "underway" && <span aria-hidden className="agents-sweep pointer-events-none absolute inset-0" />}
        <ProviderMark harness={s.harness} model={s.model} className="relative size-3.5" />
        {!narrow && <span className="relative truncate">{label}</span>}
        {state === "needs_me" && !narrow && (
          <span className="relative ml-auto hidden shrink-0 items-center gap-1 rounded bg-amber-500/20 px-1.5 py-0.5 sm:flex">
            <AlertTriangleIcon className="size-3" aria-hidden /> Needs you
          </span>
        )}
      </TooltipTrigger>
      <TooltipContent className="flex-col items-start gap-1 px-3 py-2">
        <span className="opacity-60">
          {[who, s.model, s.machine].filter(Boolean).join(" · ")} · {STATE_LABEL[state]} ·{" "}
          {duration(s.started_at, live ? now : seg.end).replace(/ \d+s$/, "")}
        </span>
        <span className="font-medium">{task.title}</span>
        <ul className="flex flex-col gap-0.5">
          {steps.map((x, k) => (
            <li key={k} className="flex gap-1.5"><span aria-hidden className="opacity-50">•</span><span className="line-clamp-2"><RichText text={x} links={false} /></span></li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
    </>
  )
}
