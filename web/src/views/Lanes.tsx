import { AlertTriangleIcon, SparkleIcon } from "lucide-react"
import { AnimatePresence, motion } from "motion/react"
import * as React from "react"
import { RollingNumber } from "@/components/rolling-number"
import { Badge } from "@/components/ui/badge"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { duration, endOf, type Item, lane, startOf, STATE_LABEL, type TrackerEvent, useNow, usePoll } from "@/lib/api"
import { cn } from "@/lib/utils"
import { ProviderMark, StateIcon, tone } from "./states"

const WINDOWS = { "30": "Last 30m", "120": "Last 2h", "1440": "Last 24h" } as const
type Win = keyof typeof WINDOWS
const ROW = 40 // px per bar row
const GAP = 8
const LANE_PAD = 10

/** Greedy interval packing: overlapping blocks in one lane go to the next row. */
function pack(items: Item[], now: number) {
  const rows: { end: number; items: Item[] }[] = []
  for (const i of [...items].sort((a, b) => startOf(a) - startOf(b))) {
    const row = rows.find((r) => r.end <= startOf(i))
    if (row) (row.items.push(i), (row.end = endOf(i, now)))
    else rows.push({ end: endOf(i, now), items: [i] })
  }
  return rows.map((r) => r.items)
}

export function Lanes({ onAsk }: { onAsk: (i: Item) => void }) {
  const [win, setWin] = React.useState<Win>("30")
  const minutes = Number(win)
  const t = usePoll<{ items: Item[]; events: TrackerEvent[] }>(`/api/timeline?minutes=${minutes}`)
  const now = useNow(1_000)
  const span = minutes * 60_000
  const from = now - span
  const x = (ms: number) => ((Math.min(Math.max(ms, from), now) - from) / span) * 100

  // Lay every lane out once so blocks and hand-off lines share coordinates.
  const layout = React.useMemo(() => {
    let y = 0
    const lanes = [...Map.groupBy(t.data?.items ?? [], lane)].map(([name, items]) => {
      const rows = pack(items, now)
      const height = LANE_PAD * 2 + rows.length * ROW + (rows.length - 1) * GAP
      const top = y
      y += height
      return {
        name, items, rows, top, height,
        model: items.find((i) => i.model)?.model ?? null,
        needs: items.some((i) => i.state === "needs_me"),
        idle: !items.some((i) => ["underway", "needs_me"].includes(i.state)),
      }
    })
    const pos = new Map<string, number>() // item id -> bar center y
    for (const l of lanes) l.rows.forEach((r, k) => r.forEach((i) => pos.set(i.id, l.top + LANE_PAD + k * (ROW + GAP) + ROW / 2)))
    return { lanes, pos, height: y }
    // ponytail: re-pack on data change only; `now` drift between polls doesn't reorder rows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t.data])
  const eventsBy = React.useMemo(() => Map.groupBy(t.data?.events ?? [], (e) => e.item_id), [t.data])
  const items = t.data?.items ?? []
  const byId = new Map(items.map((i) => [i.id, i]))
  const running = items.filter((i) => i.state === "underway").length
  const needs = items.filter((i) => i.state === "needs_me").length
  const ticks = [5, 4, 3, 2, 1].map((k) => (k * minutes) / 6)
  const fmt = (m: number) => (m >= 120 ? `−${Math.round(m / 60)}h` : `−${Math.round(m)}m`)

  return (
    <section aria-label="Agent lanes" className="flex flex-col gap-3 rounded-2xl border bg-card/40 p-4 sm:p-5">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
        <SparkleIcon className="size-4 fill-blue-500/20 text-blue-500" aria-hidden />
        <h2 className="font-semibold">Agents</h2>
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <span className="size-1.5 rounded-full bg-blue-500" aria-hidden /><RollingNumber value={running} /> running
        </span>
        <span className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
          <span className="size-1.5 rounded-full bg-amber-500" aria-hidden /><RollingNumber value={needs} /> need you
        </span>
        <ToggleGroup className="ml-auto" value={[win]} onValueChange={(v) => v[0] && setWin(v[0] as Win)} size="sm" variant="outline">
          {Object.entries(WINDOWS).map(([k, label]) => <ToggleGroupItem key={k} value={k}>{label}</ToggleGroupItem>)}
        </ToggleGroup>
      </header>

      <div className="overflow-x-auto rounded-xl border bg-card">
        <div className="grid min-w-[680px] grid-cols-[14rem_1fr] px-4 pt-3 pb-2">
          <div />
          <div className="relative h-6 text-xs text-muted-foreground tabular-nums">
            {ticks.map((m) => (
              <span key={m} className="absolute -translate-x-1/2" style={{ left: `${(1 - m / minutes) * 100}%` }}>{fmt(m)}</span>
            ))}
            <span className="absolute right-0 rounded bg-blue-500/15 px-1.5 font-medium text-blue-600 dark:text-blue-300">now</span>
          </div>

          {t.error && !t.data && <p role="alert" className="col-span-2 py-6 text-sm text-destructive">{t.error.message}</p>}
          {t.data && !layout.lanes.length && <p className="col-span-2 py-10 text-center text-sm text-muted-foreground">No agent activity in this window.</p>}

          <div>
            {layout.lanes.map((l) => (
              <div key={l.name} className="flex items-center gap-3 border-t first:border-t-0" style={{ height: l.height }}>
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full border bg-muted/40">
                  <ProviderMark model={l.model} />
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate font-medium capitalize">{l.name}</span>
                    <AnimatePresence initial={false}>
                      {l.needs ? (
                        <motion.span key="n" initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.8 }}>
                          <Badge className="bg-amber-500/15 text-amber-700 dark:text-amber-300">Needs you</Badge>
                        </motion.span>
                      ) : l.idle ? (
                        <motion.span key="i" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                          <Badge variant="secondary">Idle</Badge>
                        </motion.span>
                      ) : null}
                    </AnimatePresence>
                  </span>
                  {l.model && <span className="truncate text-xs text-muted-foreground">{l.model}</span>}
                </span>
              </div>
            ))}
          </div>

          {/* The track fades out at the left edge: blocks drift off it as time moves. */}
          <div className="relative [mask-image:linear-gradient(to_right,transparent,black_5%)]" style={{ height: layout.height }}>
            {layout.lanes.map((l) => (
              <div key={l.name} aria-hidden className="absolute inset-x-0 border-t first:border-t-0" style={{ top: l.top }} />
            ))}
            {ticks.map((m) => (
              <span key={m} aria-hidden className="absolute inset-y-0 border-l border-dashed border-border/70" style={{ left: `${(1 - m / minutes) * 100}%` }} />
            ))}
            <svg aria-hidden className="pointer-events-none absolute inset-0 size-full overflow-visible" viewBox={`0 0 100 ${layout.height || 1}`} preserveAspectRatio="none">
              {items.filter((i) => i.handoff_from && byId.has(i.handoff_from)).map((i) => {
                const p = byId.get(i.handoff_from!)!
                const x1 = x(endOf(p, now)), y1 = layout.pos.get(p.id)!, x2 = x(startOf(i)), y2 = layout.pos.get(i.id)!
                const mid = (x1 + x2) / 2
                return (
                  <motion.path key={i.id} d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
                    initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.8, ease: "easeOut" }}
                    fill="none" stroke="currentColor" className="text-blue-500/60" strokeWidth={1.5} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
                )
              })}
            </svg>
            {layout.lanes.flatMap((l) =>
              l.rows.flatMap((r, k) =>
                r.map((i) => (
                  <Block key={i.id} item={i} lane={l.name} events={eventsBy.get(i.id) ?? []} now={now}
                    left={x(startOf(i))} right={x(endOf(i, now))} top={l.top + LANE_PAD + k * (ROW + GAP)} onAsk={() => onAsk(i)} />
                )),
              ),
            )}
          </div>
        </div>
      </div>
    </section>
  )
}

function Block({ item: i, lane, events, now, left, right, top, onAsk }: {
  item: Item; lane: string; events: TrackerEvent[]; now: number; left: number; right: number; top: number; onAsk: () => void
}) {
  const live = ["underway", "needs_me"].includes(i.state)
  const steps = (events.length ? events.slice(-3).map((e) => e.text || e.verb) : [i.detail ?? ""]).filter(Boolean)
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <motion.button
            type="button"
            onClick={i.state === "needs_me" ? onAsk : undefined}
            initial={{ opacity: 0, scaleX: 0.85 }}
            animate={{ opacity: 1, scaleX: 1 }}
            transition={{ type: "spring", stiffness: 260, damping: 30 }}
            className={cn(
              "absolute flex origin-left items-center gap-1.5 overflow-hidden rounded-md border px-2.5 text-left text-[13px] font-medium whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring",
              // Blocks glide as the clock ticks: they grow into "now", then drift left.
              "transition-[left,width] duration-1000 ease-linear",
              tone(i.state).bar,
              live && "border-r-2",
              i.state === "underway" && "border-r-blue-400",
              i.state === "needs_me" && "cursor-pointer border-r-amber-400",
            )}
            style={{ top, height: ROW, left: `${left}%`, width: `max(2.25rem, ${right - left}%)` }}
            aria-label={`${i.title}: ${STATE_LABEL[i.state]}${i.state === "needs_me" ? ", open to respond" : ""}`}
          />
        }
      >
        {i.state === "underway" && <span aria-hidden className="agents-sweep pointer-events-none absolute inset-0" />}
        <StateIcon state={i.state} className="relative" />
        <span className="relative truncate">{i.title}</span>
        {i.state === "needs_me" && (
          <span className="relative ml-auto hidden shrink-0 items-center gap-1 rounded bg-amber-500/20 px-1.5 py-0.5 text-xs sm:flex">
            <AlertTriangleIcon className="size-3" aria-hidden /> Needs you
          </span>
        )}
      </TooltipTrigger>
      <TooltipContent className="flex-col items-start gap-1 px-3 py-2">
        <span className="opacity-60 capitalize">
          {lane} · {STATE_LABEL[i.state]} · {duration(i.started_at ?? i.first_seen, live ? now : Date.parse(i.updated_at ?? i.last_seen)).replace(/ \d+s$/, "")}
        </span>
        <ul className="flex flex-col gap-0.5">
          {steps.map((s, k) => (
            <li key={k} className="flex gap-1.5"><span aria-hidden className="opacity-50">•</span><span className="line-clamp-2">{s}</span></li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  )
}
