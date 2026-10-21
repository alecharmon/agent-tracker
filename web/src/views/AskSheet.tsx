import { CheckIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react"
import { AnimatePresence, motion } from "motion/react"
import * as React from "react"
import { RichText } from "@/components/rich-text"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet"
import { Textarea } from "@/components/ui/textarea"
import { Trace, TraceDescription, TraceLine, TraceTitle } from "@/components/ui/trace"
import { ago, api, duration, harnessLabel, type Item, type ItemDetail, lane, respond, STATE_LABEL, useNow } from "@/lib/api"
import { cn } from "@/lib/utils"
import { PrLink, prsOf, Status, Steps } from "./Inbox"
import { StateIcon, tone } from "./states"

const OTHER = "__other"
const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl "
type Answers = Record<string, { option?: string; other?: string }>

function useWide(query = "(min-width: 768px)") {
  const [wide, setWide] = React.useState(() => matchMedia(query).matches)
  React.useEffect(() => {
    const m = matchMedia(query)
    const on = () => setWide(m.matches)
    m.addEventListener("change", on)
    return () => m.removeEventListener("change", on)
  }, [query])
  return wide
}

/**
 * The task modal: a centered dialog on wider screens, a full-height sheet on phones.
 * Needs-you tasks show the agent's questions; everything else shows steps, PRs, actions and the message box.
 * j / → and k / ← step through `siblings` (the column the task was opened from).
 */
export function TaskModal({ item, siblings, onNavigate, onClose, onAnswered }: {
  item: Item | null
  siblings: Item[]
  onNavigate: (i: Item) => void
  onClose: () => void
  onAnswered: (id: string) => void
}) {
  const wide = useWide()
  const at = item ? siblings.findIndex((s) => s.id === item.id) : -1
  const go = React.useCallback((d: number) => {
    const next = siblings[at + d]
    if (next) onNavigate(next)
  }, [siblings, at, onNavigate])
  React.useEffect(() => {
    if (!item) return
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      // Typing, or arrowing through a question's options, keeps its keys.
      if ((e.target as HTMLElement | null)?.closest("input, textarea, select, [contenteditable=true], [role=radiogroup]")) return
      if (e.key === "j" || e.key === "ArrowRight") (e.preventDefault(), go(1))
      else if (e.key === "k" || e.key === "ArrowLeft") (e.preventDefault(), go(-1))
    }
    addEventListener("keydown", onKey)
    return () => removeEventListener("keydown", onKey)
  }, [item, go])

  // Opened programmatically (not from a Trigger), so point initial focus into the modal ourselves.
  const focusRef = React.useRef<HTMLDivElement>(null)
  const Title = wide ? DialogTitle : SheetTitle
  const Description = wide ? DialogDescription : SheetDescription
  const nav = siblings.length > 1 && at >= 0 && (
    <div className="flex shrink-0 items-center gap-1 border-b px-3 py-1.5 pr-12 text-xs text-muted-foreground">
      <Button size="icon-sm" variant="ghost" disabled={at <= 0} onClick={() => go(-1)} aria-label="Previous task (k)"><ChevronLeftIcon /></Button>
      <Button size="icon-sm" variant="ghost" disabled={at >= siblings.length - 1} onClick={() => go(1)} aria-label="Next task (j)"><ChevronRightIcon /></Button>
      <span className="tabular-nums">{at + 1} of {siblings.length}</span>
      <span className="ml-auto hidden sm:inline"><kbd className="rounded border px-1 font-sans">j</kbd> <kbd className="rounded border px-1 font-sans">k</kbd> or <kbd className="rounded border px-1 font-sans">←</kbd> <kbd className="rounded border px-1 font-sans">→</kbd></span>
    </div>
  )
  const body = item && (
    <div ref={focusRef} tabIndex={-1} className="flex min-h-0 flex-1 flex-col outline-none">
      {nav}
      {item.state === "needs_me" ? (
        <AskBody key={item.id} item={item} Title={Title} Description={Description}
          onDone={() => {
            // Answered: on to the next task in the column, or close at the end.
            onAnswered(item.id)
            const next = siblings[at + 1]
            if (next) onNavigate(next)
            else onClose()
          }} />
      ) : (
        <DetailBody key={item.id} item={item} Title={Title} Description={Description} />
      )}
    </div>
  )
  const onOpenChange = (o: boolean) => !o && onClose()
  return wide ? (
    <Dialog open={!!item} onOpenChange={onOpenChange}>
      <DialogContent initialFocus={focusRef} className="flex max-h-[min(85vh,52rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-xl">{body}</DialogContent>
    </Dialog>
  ) : (
    <Sheet open={!!item} onOpenChange={onOpenChange}>
      <SheetContent initialFocus={focusRef} className="gap-0 p-0 data-[side=right]:w-full">{body}</SheetContent>
    </Sheet>
  )
}

function DetailBody({ item, Title, Description }: { item: Item; Title: Slot; Description: Slot }) {
  const now = useNow(1_000)
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 flex-col gap-2 border-b p-5 pr-12">
        <span className={cn("flex items-center gap-1.5 text-xs font-medium", tone(item.state).text)}>
          <StateIcon state={item.state} className="size-3" /> {STATE_LABEL[item.state] ?? item.state}
        </span>
        <Title className="text-base font-semibold">{item.title}</Title>
        <Description className="text-sm text-muted-foreground">
          {[item.repo, item.harnesses.map(harnessLabel).join(" → ") || lane(item), item.model].filter(Boolean).join(" · ")}
        </Description>
        <div className="flex flex-wrap items-center gap-2 text-xs"><Status item={item} now={now} /></div>
        {prsOf(item).length > 0 && (
          <div className="flex flex-wrap gap-1.5">{prsOf(item).map((p) => <PrLink key={p.url} url={p.url} status={p.status} />)}</div>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <Steps item={item} now={now} onAsk={() => {}} />
      </div>
    </div>
  )
}

type Slot = React.ComponentType<{ className?: string; children?: React.ReactNode }>

function AskBody({ item, onDone, Title, Description }: { item: Item; onDone: () => void; Title: Slot; Description: Slot }) {
  const now = useNow(1_000)
  const [detail, setDetail] = React.useState<ItemDetail | null>(null)
  const [answers, setAnswers] = React.useState<Answers>({})
  const [feedback, setFeedback] = React.useState("")
  const [status, setStatus] = React.useState<{ busy?: boolean; error?: string; sent?: boolean }>({})
  React.useEffect(() => {
    api<ItemDetail>(`/api/items/${encodeURIComponent(item.id)}`).then(setDetail, () => {})
  }, [item.id])

  const ask = item.ask
  const set = (qid: string, v: { option?: string; other?: string }) => setAnswers((a) => ({ ...a, [qid]: { ...a[qid], ...v } }))
  const payload = Object.fromEntries(
    Object.entries(answers)
      .map(([qid, a]) => [qid, a.option === OTHER ? { other: a.other?.trim() } : { option: a.option }] as const)
      .filter(([, a]) => a.option || a.other),
  )
  const ready = Object.keys(payload).length > 0 || feedback.trim().length > 0

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!ready) return
    setStatus({ busy: true })
    try {
      await respond(item, { action: "answer", answers: payload, feedback: feedback.trim() || undefined })
      setStatus({ sent: true })
      setTimeout(onDone, 700)
    } catch (err) {
      setStatus({ error: err instanceof Error ? err.message : String(err) })
    }
  }

  const steps = (detail?.events ?? []).slice(0, 4).reverse()
  return (
    <form
      onSubmit={submit}
      // ⌘↵ / Ctrl↵ sends from any field, including the text boxes.
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) (e.preventDefault(), e.currentTarget.requestSubmit())
      }}
      className="flex min-h-0 flex-1 flex-col"
    >
      <header className="flex shrink-0 flex-col gap-2 border-b p-5 pr-12">
        <span className="flex items-center gap-1.5 text-xs font-medium text-amber-600 dark:text-amber-400">
          <StateIcon state="needs_me" className="size-3" /> Needs you · waiting {duration(item.updated_at ?? item.last_seen, now)}
        </span>
        <Title className="text-base font-semibold">{item.title}</Title>
        <Description className="text-sm text-muted-foreground">{[item.repo, item.harnesses.map(harnessLabel).join(" → ") || lane(item), item.model].filter(Boolean).join(" · ")}</Description>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-5">
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">What's needed</h3>
          <p className="text-sm leading-relaxed text-pretty"><RichText text={ask?.summary ?? item.detail ?? "The agent is waiting on you."} /></p>
        </section>

        {steps.length > 0 && (
          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Last steps</h3>
            <Trace>
              {steps.map((e) => (
                <TraceLine key={e.id} className="w-full items-start">
                  <TraceTitle className="min-w-0 flex-1 break-words whitespace-normal"><RichText text={e.text || e.verb} /></TraceTitle>
                  <TraceDescription className="shrink-0">{ago(e.ts, now)}</TraceDescription>
                </TraceLine>
              ))}
            </Trace>
          </section>
        )}

        {ask?.questions.map((q, qi) => {
          const a = answers[q.id] ?? {}
          return (
            <fieldset key={q.id} className="flex flex-col gap-2">
              <legend className="mb-2 text-sm font-medium">
                <span className="mr-1.5 text-muted-foreground tabular-nums">{qi + 1}.</span>{q.prompt}
              </legend>
              <RadioGroup value={a.option ?? null} onValueChange={(v) => set(q.id, { option: v as string })} className="gap-1.5">
                {[...q.options, ...(q.allow_other === false ? [] : [{ id: OTHER, label: "Other…", description: "Answer in your own words" }])].map((o) => (
                  <Label
                    key={o.id}
                    className={cn(
                      "flex cursor-pointer items-start gap-3 rounded-lg border p-3 font-normal transition-colors hover:bg-muted/50",
                      a.option === o.id && "border-primary/60 bg-muted/60",
                    )}
                  >
                    <RadioGroupItem value={o.id} className="mt-0.5" />
                    <span className="flex flex-col gap-0.5">
                      <span className="text-sm font-medium">{o.label}</span>
                      {o.description && <span className="text-xs text-muted-foreground">{o.description}</span>}
                    </span>
                  </Label>
                ))}
              </RadioGroup>
              <AnimatePresence initial={false}>
                {a.option === OTHER && (
                  <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                    <Textarea
                      autoFocus
                      aria-label={`Your answer: ${q.prompt}`}
                      placeholder="Your answer"
                      value={a.other ?? ""}
                      onChange={(e) => set(q.id, { other: e.target.value })}
                      className="mt-1"
                    />
                  </motion.div>
                )}
              </AnimatePresence>
            </fieldset>
          )
        })}

        <section className="flex flex-col gap-2">
          <Label htmlFor="feedback" className="text-sm font-medium">
            {ask?.questions.length ? "Anything else for the agent?" : "Your answer"}
          </Label>
          <Textarea id="feedback" placeholder="Optional feedback or instructions" value={feedback} onChange={(e) => setFeedback(e.target.value)} rows={3} />
        </section>

        {!!detail?.responses.length && (
          <section className="flex flex-col gap-1.5 text-xs text-muted-foreground">
            <h3 className="font-medium tracking-wide uppercase">Earlier answers</h3>
            {detail.responses.map((r) => (
              <p key={r.id}>{ago(r.at, now)} · {r.action}{r.feedback ? `: “${r.feedback}”` : ""}</p>
            ))}
          </section>
        )}
      </div>

      <footer className="flex shrink-0 items-center justify-end gap-2 border-t bg-popover p-4">
        {status.error && <p role="alert" className="mr-auto text-xs text-destructive">{status.error}</p>}
        <p role="status" className="sr-only">{status.sent ? "Answer sent" : ""}</p>
        <Button type="submit" disabled={!ready || status.busy || status.sent} className="min-w-28">
          <AnimatePresence mode="wait" initial={false}>
            <motion.span key={status.sent ? "sent" : "send"} initial={{ y: 6, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -6, opacity: 0 }} className="flex items-center gap-1.5">
              {status.sent ? <><CheckIcon className="size-4" aria-hidden /> Sent</> : status.busy ? "Sending…" : <>Send answer <kbd className="ml-1 rounded bg-primary-foreground/15 px-1 font-sans text-[11px]" aria-hidden>{mod}↵</kbd></>}
            </motion.span>
          </AnimatePresence>
        </Button>
      </footer>
    </form>
  )
}
