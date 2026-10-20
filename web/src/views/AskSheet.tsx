import { CheckIcon } from "lucide-react"
import { AnimatePresence, motion } from "motion/react"
import * as React from "react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet"
import { Textarea } from "@/components/ui/textarea"
import { Trace, TraceDescription, TraceLine, TraceTitle } from "@/components/ui/trace"
import { ago, api, duration, type Item, type ItemDetail, lane, respond, useNow } from "@/lib/api"
import { cn } from "@/lib/utils"
import { StateIcon } from "./states"

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
 * Needs-you detail: what the agent needs, its questions as choices (or your own words), and free feedback.
 * A centered modal on wider screens, a full-height sheet on phones.
 */
export function AskSheet({ item, onClose, onAnswered }: {
  item: Item | null
  onClose: () => void
  onAnswered: (id: string) => void
}) {
  const wide = useWide()
  const body = item && (
    <AskBody key={item.id} item={item} onDone={() => (onAnswered(item.id), onClose())}
      Title={wide ? DialogTitle : SheetTitle} Description={wide ? DialogDescription : SheetDescription} />
  )
  const onOpenChange = (o: boolean) => !o && onClose()
  return wide ? (
    <Dialog open={!!item} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(85vh,52rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-xl">{body}</DialogContent>
    </Dialog>
  ) : (
    <Sheet open={!!item} onOpenChange={onOpenChange}>
      <SheetContent className="gap-0 p-0 data-[side=right]:w-full">{body}</SheetContent>
    </Sheet>
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
        <Description className="text-sm text-muted-foreground">{[lane(item), item.model, item.repo].filter(Boolean).join(" · ")}</Description>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-5">
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">What's needed</h3>
          <p className="text-sm leading-relaxed text-pretty">{ask?.summary ?? item.detail ?? "The agent is waiting on you."}</p>
        </section>

        {steps.length > 0 && (
          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Last steps</h3>
            <Trace>
              {steps.map((e) => (
                <TraceLine key={e.id} className="w-full items-start">
                  <TraceTitle className="min-w-0 flex-1 whitespace-normal">{e.text || e.verb}</TraceTitle>
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
