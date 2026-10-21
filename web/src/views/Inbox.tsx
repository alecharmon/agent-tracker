import { CheckCheckIcon, ExternalLinkIcon, LaptopIcon, GitMergeIcon, LoaderCircleIcon, GitPullRequestIcon, KanbanIcon, ListIcon, MessageSquareIcon, RotateCwIcon, SendIcon, SparkleIcon, XIcon } from "lucide-react"
import { AnimatePresence, LayoutGroup, motion } from "motion/react"
import * as React from "react"
import { RichText, shortUrl } from "@/components/rich-text"
import { Textarea } from "@/components/ui/textarea"
import { RollingNumber } from "@/components/rolling-number"
import { Button } from "@/components/ui/button"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { ago, api, duration, endOf, harnessLabel, type Item, type ItemDetail, lane, respond, sendMessage, setStage, STATE_LABEL, useNow } from "@/lib/api"
import { cn } from "@/lib/utils"
import { ProviderMark, StateIcon, tone } from "./states"

const COLUMNS = [
  { key: "needs", title: "Needs you", states: ["needs_me", "failed"], dot: "text-amber-500" },
  { key: "running", title: "Running", states: ["answered", "validating", "underway", "idle"], dot: "text-blue-500" },
  { key: "review", title: "In review", states: ["review"], dot: "text-sky-500" },
  { key: "done", title: "Done", states: ["landed"], dot: "text-emerald-500" },
]
const spring = { type: "spring", stiffness: 380, damping: 34, mass: 0.9 } as const

/** Clicking a card opens it in the task modal; `siblings` is its column, for j/k stepping. */
export function Inbox({ items, loading, selected, onOpen }: {
  items: Item[]; loading: boolean; selected: string | null; onOpen: (i: Item, siblings: Item[]) => void
}) {
  const [mode, setMode] = React.useState<"board" | "list">("board")
  const now = useNow(1_000)


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
            <div className="-mx-1 flex snap-x snap-mandatory scroll-px-1 items-start gap-2 overflow-x-auto px-1 pb-2">
              {COLUMNS.map((c) => {
                const col = items.filter((i) => c.states.includes(i.state))
                return (
                  <div key={c.key} className="flex w-[min(20rem,85vw)] shrink-0 snap-start flex-col gap-1.5 rounded-xl bg-muted/40 p-1.5">
                    <h3 className="flex items-center px-2 py-1.5 text-[11px] font-medium tracking-[0.14em] text-muted-foreground uppercase">
                      <SparkleIcon className={cn("size-3.5", c.dot)} aria-hidden />
                      <span className="flex-1 text-center">{c.title}</span>
                      <span className="rounded-md bg-muted px-1.5 py-0.5 tracking-normal"><RollingNumber value={col.length} /></span>
                    </h3>
                    <AnimatePresence initial={false} mode="popLayout">
                      {col.map((i) => (
                        <Card key={i.id} item={i} now={now} open={selected === i.id} onPick={() => onOpen(i, col)} />
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
                    <Card key={i.id} as="li" item={i} now={now} open={selected === i.id} onPick={() => onOpen(i, items)} row />
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

function Card({ item: i, now, open, onPick, row, as = "article" }: {
  item: Item; now: number; open: boolean; onPick: () => void; row?: boolean; as?: "article" | "li"
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
      <motion.button layout="position" type="button" onClick={onPick} aria-haspopup="dialog"
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
          {i.machines.length > 0 && (
            <span className="flex min-w-0 items-center gap-1 truncate" title={`Running on ${i.machines.join(", ")}`}>
              <LaptopIcon className="size-3.5 shrink-0" aria-hidden />
              <span className="truncate">{i.machines.join(", ")}</span>
            </span>
          )}
          <span className={cn("flex shrink-0 items-center gap-1", !row && "ml-auto")} title="Status events">
            <ListIcon className="size-3.5" aria-hidden />{i.event_count}<span className="sr-only"> events</span>
          </span>
          <span className="flex items-center gap-1 border-l pl-3" title="Pull requests">
            <GitPullRequestIcon className="size-3.5" aria-hidden />{i.pr_count}<span className="sr-only"> pull requests</span>
          </span>
        </span>
      </motion.button>
      {!row && prsOf(i).length > 0 && (
        <div className="-mt-1 flex flex-wrap gap-1.5 px-3 pb-3">
          {prsOf(i).map((p) => <PrLink key={p.url} url={p.url} status={p.status} />)}
        </div>
      )}
    </M>
  )
}

/** The ask explains a waiting card; once answered, the latest line is what matters. */
const summaryOf = (i: Item) => (i.state === "needs_me" ? i.ask?.summary ?? i.detail : i.detail)

const PR_URL = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/
/** The task's PRs; a PR only mentioned in text (no reported status) still shows. */
export const prsOf = (i: Item) =>
  i.pr_list.length ? i.pr_list : i.url && PR_URL.test(i.url) ? [{ url: i.url, status: null }] : []

const PR_STATUS: Record<string, { label: string; cls: string; spin?: boolean }> = {
  open: { label: "Open", cls: "text-sky-700 dark:text-sky-300" },
  ci_running: { label: "CI running", cls: "text-blue-700 dark:text-blue-300", spin: true },
  ci_passed: { label: "CI passed", cls: "text-emerald-700 dark:text-emerald-300" },
  ci_failed: { label: "CI failed", cls: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300" },
  merged: { label: "Merged", cls: "border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-300" },
  closed: { label: "Closed", cls: "text-muted-foreground line-through" },
}

export function PrLink({ url, status }: { url: string; status: string | null }) {
  const st = PR_STATUS[status ?? "open"] ?? PR_STATUS.open
  const Icon = status === "merged" ? GitMergeIcon : status === "ci_running" ? LoaderCircleIcon : GitPullRequestIcon
  return (
    <a href={url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}
      className={cn("inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium hover:bg-muted", st.cls)}>
      <Icon className={cn("size-3", st.spin && "animate-spin")} aria-hidden />
      <span className={cn(status === "closed" && "line-through")}>{shortUrl(url)}</span>
      {status && <span className="font-normal opacity-80">· {st.label}</span>}
      <ExternalLinkIcon className="size-3 opacity-60" aria-hidden />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  )
}

export function Status({ item: i, now }: { item: Item; now: number }) {
  const t = tone(i.state)
  const text =
    i.state === "failed" ? "Failed"
    : i.state === "needs_me" ? `Waiting ${duration(i.updated_at ?? i.last_seen, now)}`
    : i.state === "answered" ? `Answered · unread ${duration(i.updated_at ?? i.last_seen, now)}`
    : i.state === "idle" ? `Idle · ${ago(i.last_seen, now)}`
    : i.state === "review" ? `In review · ${ago(i.updated_at ?? i.last_seen, now)}`
    : i.state === "validating" ? `Validating · ${duration(i.updated_at ?? i.last_seen, endOf(i, now))}`
    : duration(i.started_at ?? i.first_seen, endOf(i, now)) || STATE_LABEL[i.state]
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5 font-medium tabular-nums", t.text)}>
      <StateIcon state={i.state} className="size-3" />
      <span className="sr-only">{STATE_LABEL[i.state]}: </span>
      <span className="truncate">{text}</span>
    </span>
  )
}

/** A task's steps, actions and the message box: the body of the task modal for anything not waiting on an answer. */
export function Steps({ item, now, onAsk }: { item: Item; now: number; onAsk: () => void }) {
  const [d, setD] = React.useState<ItemDetail | { error: string } | null>(null)
  const [busy, setBusy] = React.useState(false)
  const act = (f: () => Promise<unknown>) => (setBusy(true), f().finally(() => setBusy(false)))
  React.useEffect(() => {
    api<ItemDetail>(`/api/items/${encodeURIComponent(item.id)}`).then(setD, (e) => setD({ error: e.message }))
  }, [item.id, item.updated_at])

  const events = d && "events" in d ? [...d.events].slice(0, 5).reverse() : []
  const url = item.url ?? (d && "prs" in d ? d.prs[0]?.url : undefined)
  return (
    <div className="flex flex-col gap-2.5 text-sm">
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
              <span className={cn("min-w-0 flex-1 break-words", k !== events.length - 1 && "text-muted-foreground")}>
                {e.verb.startsWith("PR-") && <span className="font-medium">{PR_STATUS[e.verb.slice(3).toLowerCase().replace("-", "_")]?.label ?? e.verb} · </span>}
                <RichText text={e.text || e.verb} />
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">{ago(e.ts, now)}</span>
            </motion.li>
          ))}
          {!events.length && <li className="text-xs text-muted-foreground"><RichText text={item.detail ?? "No steps recorded"} /></li>}
        </ol>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        {item.state === "needs_me" && <Button size="sm" onClick={onAsk}><MessageSquareIcon aria-hidden /> Respond</Button>}
        {item.state === "failed" && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => act(() => respond(item, { action: "retry" }))}>
            <RotateCwIcon aria-hidden className={cn(busy && "animate-spin")} /> Retry
          </Button>
        )}
        {item.state === "review" && (
          <>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(() => setStage(item, "closed"))}>
              <XIcon aria-hidden /> Close
            </Button>
            <Button size="sm" disabled={busy} onClick={() => act(() => setStage(item, "merged"))}>
              <GitMergeIcon aria-hidden /> Merged
            </Button>
          </>
        )}
        {item.state === "validating" && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => act(() => setStage(item, "validated"))}>
            <CheckCheckIcon aria-hidden /> Validated
          </Button>
        )}
        {url && !["needs_me", "failed", "review"].includes(item.state) && (
          <Button size="sm" variant="outline" nativeButton={false} render={<a href={url} target="_blank" rel="noreferrer" />}>
            Open <ExternalLinkIcon aria-hidden />
          </Button>
        )}
      </div>
      {d && "messages" in d && <Messages item={item} messages={d.messages} now={now} />}
    </div>
  )
}

/** Follow-ups and direction to whichever agent works the task, in any state. */
function Messages({ item, messages, now }: { item: Item; messages: ItemDetail["messages"]; now: number }) {
  const [text, setText] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const attached = item.harnesses.length > 0
  async function send() {
    if (!text.trim() || busy) return
    setBusy(true)
    try {
      await sendMessage(item, text.trim())
      setText("")
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-col gap-2 border-t pt-2.5">
      {[...messages].reverse().map((m) => (
        <p key={m.id} className="flex items-start gap-2 text-[13px]">
          <MessageSquareIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 flex-1">{m.text}</span>
          <span className={cn("shrink-0 text-xs", m.delivered_at ? "text-muted-foreground" : "text-amber-600 dark:text-amber-400")}>
            {m.delivered_at ? `delivered ${ago(m.delivered_at, now)}` : "queued"}
          </span>
        </p>
      ))}
      <form className="flex items-end gap-2" onSubmit={(e) => (e.preventDefault(), send())}
        onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && (e.preventDefault(), send())}>
        <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={1}
          aria-label="Message the agent"
          placeholder={attached ? "Message the agent: a follow-up or new direction" : "Message: delivered when an agent picks this up"}
          className="min-h-8 flex-1 resize-none py-1.5 text-[13px]" />
        <Button type="submit" size="sm" variant="outline" disabled={!text.trim() || busy} aria-label="Send message (⌘↵)">
          <SendIcon aria-hidden />
        </Button>
      </form>
    </div>
  )
}
