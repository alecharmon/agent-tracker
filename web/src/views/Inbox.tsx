import { ExternalLinkIcon, GitPullRequestIcon, KanbanIcon, ListIcon, MessageSquareIcon, RotateCwIcon, SparkleIcon } from "lucide-react"
import { AnimatePresence, LayoutGroup, motion } from "motion/react"
import * as React from "react"
import { RichText } from "@/components/rich-text"
import { RollingNumber } from "@/components/rolling-number"
import { Button } from "@/components/ui/button"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { ago, api, duration, endOf, harnessLabel, type Item, type ItemDetail, lane, respond, STATE_LABEL, useNow } from "@/lib/api"
import { cn } from "@/lib/utils"
import { ProviderMark, StateIcon, tone } from "./states"

const COLUMNS = [
  { key: "needs", title: "Needs you", states: ["needs_me", "failed"], dot: "text-amber-500" },
  { key: "running", title: "Running", states: ["answered", "underway"], dot: "text-blue-500" },
  { key: "done", title: "Done", states: ["landed"], dot: "text-emerald-500" },
]
const spring = { type: "spring", stiffness: 380, damping: 34, mass: 0.9 } as const

export function Inbox({ items, loading, onAsk }: { items: Item[]; loading: boolean; onAsk: (i: Item) => void }) {
  const [mode, setMode] = React.useState<"board" | "list">("board")
  const [open, setOpen] = React.useState<string | null>(null)
  const now = useNow(1_000)
  const toggle = (id: string) => setOpen((o) => (o === id ? null : id))
  const pick = (i: Item) => (i.state === "needs_me" ? onAsk(i) : toggle(i.id))


  return (
    <section aria-label="Agent inbox" className="flex flex-col gap-4 rounded-2xl border bg-card/40 p-4 sm:p-5">
      <div className="flex items-center gap-2 text-sm">
        <span className="text-muted-foreground">Agents</span>
        <span className="text-muted-foreground/60">/</span>
        <h2 className="font-medium">Agent inbox</h2>
        <ToggleGroup className="ml-auto" value={[mode]} onValueChange={(v) => v[0] && setMode(v[0] as "board" | "list")} size="sm">
          <ToggleGroupItem value="board"><KanbanIcon aria-hidden /> Board</ToggleGroupItem>
          <ToggleGroupItem value="list"><ListIcon aria-hidden /> List</ToggleGroupItem>
        </ToggleGroup>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <LayoutGroup>
          {mode === "board" ? (
            <div className="grid items-start gap-2 md:grid-cols-3">
              {COLUMNS.map((c) => {
                const col = items.filter((i) => c.states.includes(i.state))
                return (
                  <div key={c.key} className="flex flex-col gap-1.5 rounded-xl bg-muted/40 p-1.5">
                    <h3 className="flex items-center px-2 py-1.5 text-[11px] font-medium tracking-[0.14em] text-muted-foreground uppercase">
                      <SparkleIcon className={cn("size-3.5", c.dot)} aria-hidden />
                      <span className="flex-1 text-center">{c.title}</span>
                      <span className="rounded-md bg-muted px-1.5 py-0.5 tracking-normal"><RollingNumber value={col.length} /></span>
                    </h3>
                    <AnimatePresence initial={false} mode="popLayout">
                      {col.map((i) => (
                        <Card key={i.id} item={i} now={now} open={open === i.id} onPick={() => pick(i)} onAsk={() => onAsk(i)} />
                      ))}
                    </AnimatePresence>
                    {!col.length && <p className="px-2 py-6 text-center text-xs text-muted-foreground">Nothing here</p>}
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <ul className="flex flex-col gap-1.5">
                <AnimatePresence initial={false} mode="popLayout">
                  {items.map((i) => (
                    <Card key={i.id} as="li" item={i} now={now} open={open === i.id} onPick={() => pick(i)} onAsk={() => onAsk(i)} row />
                  ))}
                </AnimatePresence>
              </ul>
            </div>
          )}
        </LayoutGroup>
      )}
    </section>
  )
}

function Card({ item: i, now, open, onPick, onAsk, row, as = "article" }: {
  item: Item; now: number; open: boolean; onPick: () => void; onAsk: () => void; row?: boolean; as?: "article" | "li"
}) {
  const M = as === "li" ? motion.li : motion.article
  return (
    <M
      layout
      layoutId={i.id}
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.97 }}
      transition={spring}
      className={cn("overflow-hidden rounded-lg border bg-card shadow-xs", open && "ring-1 ring-ring/50")}
    >
      <motion.button layout="position" type="button" onClick={onPick} aria-expanded={i.state === "needs_me" ? undefined : open}
        aria-haspopup={i.state === "needs_me" ? "dialog" : undefined}
        className={cn("flex w-full gap-2 p-3 text-left outline-none focus-visible:bg-muted/50", row ? "items-center" : "flex-col")}>
        <span className={cn("flex min-w-0 items-start gap-2 text-sm font-medium", row && "flex-1 items-center")}>
          <SparkleIcon className={cn("mt-0.5 size-3.5 shrink-0", tone(i.state).dot, row && "mt-0")} aria-hidden />
          <span className={cn(row && "truncate")}>{i.title}</span>
        </span>
        {!row && summaryOf(i) && <span className="line-clamp-2 text-[13px] leading-snug text-muted-foreground"><RichText text={summaryOf(i)!} links={false} /></span>}
        {row && <span className="hidden w-24 truncate text-xs text-muted-foreground sm:block">{i.repo ?? lane(i)}</span>}
        <span className={cn("flex items-center gap-3 text-xs text-muted-foreground", !row && "mt-0.5")}>
          <Status item={i} now={now} />
          {i.harnesses.length > 0 && (
            <span className="flex shrink-0 -space-x-1" title={`Worked on by ${i.harnesses.map(harnessLabel).join(", ")}`}>
              {i.harnesses.map((h) => (
                <span key={h} className="flex size-4 items-center justify-center rounded-full border bg-card">
                  <ProviderMark harness={h} model={null} className="size-2.5" />
                </span>
              ))}
              <span className="sr-only">Worked on by {i.harnesses.map(harnessLabel).join(", ")}</span>
            </span>
          )}
          <span className={cn("flex items-center gap-1", !row && "ml-auto")} title="Status events">
            <ListIcon className="size-3.5" aria-hidden />{i.event_count}<span className="sr-only"> events</span>
          </span>
          <span className="flex items-center gap-1 border-l pl-3" title="Pull requests">
            <GitPullRequestIcon className="size-3.5" aria-hidden />{i.pr_count}<span className="sr-only"> pull requests</span>
          </span>
        </span>
      </motion.button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="detail"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ height: spring, opacity: { duration: 0.15 } }}
          >
            <Steps item={i} now={now} onAsk={onAsk} />
          </motion.div>
        )}
      </AnimatePresence>
    </M>
  )
}

/** The ask explains a waiting card; once answered, the latest line is what matters. */
const summaryOf = (i: Item) => (i.state === "needs_me" ? i.ask?.summary ?? i.detail : i.detail)

function Status({ item: i, now }: { item: Item; now: number }) {
  const t = tone(i.state)
  const text =
    i.state === "failed" ? "Failed"
    : i.state === "needs_me" ? `Waiting ${duration(i.updated_at ?? i.last_seen, now)}`
    : i.state === "answered" ? `Answered · unread ${duration(i.updated_at ?? i.last_seen, now)}`
    : duration(i.started_at ?? i.first_seen, endOf(i, now)) || STATE_LABEL[i.state]
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5 font-medium tabular-nums", t.text)}>
      <StateIcon state={i.state} className="size-3" />
      <span className="sr-only">{STATE_LABEL[i.state]}: </span>
      <span className="truncate">{text}</span>
    </span>
  )
}

function Steps({ item, now, onAsk }: { item: Item; now: number; onAsk: () => void }) {
  const [d, setD] = React.useState<ItemDetail | { error: string } | null>(null)
  const [busy, setBusy] = React.useState(false)
  React.useEffect(() => {
    api<ItemDetail>(`/api/items/${encodeURIComponent(item.id)}`).then(setD, (e) => setD({ error: e.message }))
  }, [item.id, item.updated_at])

  const events = d && "events" in d ? [...d.events].slice(0, 5).reverse() : []
  const url = item.url ?? (d && "prs" in d ? d.prs[0]?.url : undefined)
  return (
    <div className="mx-3 flex flex-col gap-2.5 border-t py-3 text-sm">
      {item.model && <p className="text-xs text-muted-foreground">{item.model}</p>}
      {!d ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : "error" in d ? (
        <p role="alert" className="text-xs text-destructive">{d.error}</p>
      ) : (
        <ol className="flex flex-col gap-1.5">
          {events.map((e, k) => (
            <motion.li key={e.id} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: k * 0.04 }}
              className="flex items-start gap-2 text-[13px]">
              <span aria-hidden className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", k === events.length - 1 ? "bg-foreground" : "bg-muted-foreground/50")} />
              <span className={cn("min-w-0 flex-1 break-words", k !== events.length - 1 && "text-muted-foreground")}><RichText text={e.text || e.verb} /></span>
              <span className="shrink-0 text-xs text-muted-foreground">{ago(e.ts, now)}</span>
            </motion.li>
          ))}
          {!events.length && <li className="text-xs text-muted-foreground"><RichText text={item.detail ?? "No steps recorded"} /></li>}
        </ol>
      )}
      <div className="flex justify-end gap-2">
        {item.state === "needs_me" && <Button size="sm" onClick={onAsk}><MessageSquareIcon aria-hidden /> Respond</Button>}
        {item.state === "failed" && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => (setBusy(true), respond(item, { action: "retry" }).finally(() => setBusy(false)))}>
            <RotateCwIcon aria-hidden className={cn(busy && "animate-spin")} /> Retry
          </Button>
        )}
        {url && !["needs_me", "failed"].includes(item.state) && (
          <Button size="sm" variant="outline" nativeButton={false} render={<a href={url} target="_blank" rel="noreferrer" />}>
            Open <ExternalLinkIcon aria-hidden />
          </Button>
        )}
      </div>
    </div>
  )
}
