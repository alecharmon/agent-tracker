import { AlertTriangleIcon, AsteriskIcon, MailCheckIcon, WavesIcon, BotIcon, CircleAlertIcon, CircleIcon, ApertureIcon, LoaderCircleIcon, PauseIcon, SparkleIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { provider } from "@/lib/api"

/** One color per state, shared by both views. Color is never the only signal: a label goes alongside. */
export const TONE: Record<string, { bar: string; text: string; dot: string }> = {
  underway: {
    bar: "border-blue-500/30 bg-linear-to-r from-blue-500/10 via-blue-500/20 to-blue-500/35 text-blue-700 dark:text-blue-200",
    text: "text-blue-600 dark:text-blue-400",
    dot: "text-blue-500",
  },
  needs_me: {
    bar: "border-amber-500/30 bg-linear-to-r from-amber-500/10 to-amber-500/25 text-amber-800 dark:text-amber-200",
    text: "text-amber-600 dark:text-amber-400",
    dot: "text-amber-500",
  },
  // Captain answered; the agent hasn't picked it up yet.
  answered: {
    bar: "border-violet-500/30 bg-linear-to-r from-violet-500/10 to-violet-500/25 text-violet-700 dark:text-violet-200",
    text: "text-violet-600 dark:text-violet-400",
    dot: "text-violet-500",
  },
  failed: {
    bar: "border-red-500/30 bg-linear-to-r from-red-500/10 to-red-500/25 text-red-700 dark:text-red-300",
    text: "text-red-600 dark:text-red-400",
    dot: "text-red-500",
  },
  landed: { bar: "border-border bg-muted/70 text-muted-foreground", text: "text-emerald-600 dark:text-emerald-400", dot: "text-emerald-500" },
  gated: { bar: "border-border bg-muted/70 text-muted-foreground", text: "text-muted-foreground", dot: "text-violet-500" },
}
export const tone = (s: string) => TONE[s] ?? TONE.gated

export function StateIcon({ state, className }: { state: string; className?: string }) {
  const c = cn("size-3.5 shrink-0", className)
  if (state === "underway") return <LoaderCircleIcon className={cn(c, "animate-spin [animation-duration:1.6s]")} aria-hidden />
  if (state === "needs_me") return <AlertTriangleIcon className={c} aria-hidden />
  if (state === "answered") return <MailCheckIcon className={c} aria-hidden />
  if (state === "failed") return <CircleAlertIcon className={c} aria-hidden />
  if (state === "landed") return <CircleIcon className={cn(c, "size-2 fill-current")} aria-hidden />
  return <PauseIcon className={c} aria-hidden />
}

export function ProviderMark({ model, harness, className }: { model: string | null; harness?: string | null; className?: string }) {
  const p = provider(model, harness)
  const c = cn("size-4", className)
  if (p === "anthropic") return <AsteriskIcon className={cn(c, "text-orange-500")} strokeWidth={2.5} aria-hidden />
  if (p === "openai") return <ApertureIcon className={c} aria-hidden />
  if (p === "devin") return <WavesIcon className={cn(c, "text-teal-500")} aria-hidden />
  if (p === "google") return <SparkleIcon className={cn(c, "fill-blue-500 text-blue-500")} aria-hidden />
  return <BotIcon className={c} aria-hidden />
}
