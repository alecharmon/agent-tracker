import * as React from "react"
import { Button } from "@/components/ui/button"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { TooltipProvider } from "@/components/ui/tooltip"
import { type Item, Unauthorized, usePoll } from "@/lib/api"
import { ViewToolbar } from "@/components/view-toolbar"
import { apply, DEFAULT_OPTIONS, type ViewOptions } from "@/lib/view-options"
import { TaskModal } from "@/views/AskSheet"
import { Inbox } from "@/views/Inbox"
import { Lanes } from "@/views/Lanes"

type View = "inbox" | "lanes"
const readView = (): View => (location.hash === "#lanes" ? "lanes" : "inbox")

export default function App() {
  const [view, setView] = React.useState<View>(readView)
  // The open task and the list it was opened from (j/k step through it). Resolved against live data.
  const [opened, setOpened] = React.useState<{ id: string; ids: string[] } | null>(null)
  const open = (i: Item, siblings: Item[]) => setOpened({ id: i.id, ids: siblings.map((s) => s.id) })
  // Answered items move to Running right away; the next poll confirms it.
  const [moved, setMoved] = React.useState<Record<string, string>>({})
  const [opts, setOpts] = React.useState<ViewOptions>(DEFAULT_OPTIONS)
  React.useEffect(() => {
    const on = () => setView(readView())
    addEventListener("hashchange", on)
    return () => removeEventListener("hashchange", on)
  }, [])
  // I: Inbox, L: Lanes, unless typing or a modifier is held.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return
      const t = e.target as HTMLElement | null
      if (t?.closest("input, textarea, select, [contenteditable=true], [role=dialog]")) return
      if (e.key === "i") location.hash = ""
      else if (e.key === "l") location.hash = "lanes"
    }
    addEventListener("keydown", onKey)
    return () => removeEventListener("keydown", onKey)
  }, [])

  const items = usePoll<Item[]>("/api/items", 10_000)
  React.useEffect(() => setMoved({}), [items.data])
  const all = React.useMemo(() => (items.data ?? []).map((i) => (moved[i.id] ? { ...i, state: moved[i.id] as Item["state"] } : i)), [items.data, moved])
  const byId = new Map(all.map((i) => [i.id, i]))
  const current = opened ? byId.get(opened.id) ?? null : null
  const siblings = opened ? opened.ids.map((id) => byId.get(id)).filter((i): i is Item => !!i) : []
  if (items.error instanceof Unauthorized && !items.data) return <SignIn />

  return (
    <TooltipProvider delay={120}>
      <div className="mx-auto flex min-h-svh max-w-6xl flex-col gap-4 px-4 py-6 sm:px-6">
        <nav className="flex items-center gap-3">
          <span className="text-sm font-semibold">Agent tracker</span>
          <ToggleGroup className="ml-auto" value={[view]} onValueChange={(v) => v[0] && (location.hash = v[0] === "lanes" ? "lanes" : "")} size="sm">
            <ToggleGroupItem value="inbox" title="Inbox (I)">Inbox <kbd className="ml-1 hidden rounded border px-1 font-sans text-[10px] text-muted-foreground sm:inline" aria-hidden>I</kbd></ToggleGroupItem>
            <ToggleGroupItem value="lanes" title="Lanes (L)">Lanes <kbd className="ml-1 hidden rounded border px-1 font-sans text-[10px] text-muted-foreground sm:inline" aria-hidden>L</kbd></ToggleGroupItem>
          </ToggleGroup>
        </nav>
        <ViewToolbar items={all} value={opts} onChange={setOpts} />
        {items.error && !items.data ? (
          <p role="alert" className="text-sm text-destructive">Could not load: {items.error.message}</p>
        ) : view === "inbox" ? (
          <Inbox items={apply(all, opts)} loading={!items.data} selected={opened?.id ?? null} onOpen={open} />
        ) : (
          <Lanes onOpen={open} options={opts} />
        )}
      </div>
      <TaskModal item={current} siblings={siblings} onClose={() => setOpened(null)}
        onNavigate={(i) => setOpened((o) => (o ? { ...o, id: i.id } : o))}
        onAnswered={(id) => setMoved((m) => ({ ...m, [id]: "answered" }))} />
    </TooltipProvider>
  )
}

function SignIn() {
  const next = encodeURIComponent(location.pathname + location.hash)
  return (
    <main className="mx-auto mt-24 flex max-w-sm flex-col gap-3 px-4">
      <h1 className="text-lg font-semibold">Agent tracker</h1>
      <p className="text-sm text-muted-foreground">Sign in with your Cloudflare Access login to see your agents' work.</p>
      <Button render={<a href={`/login?next=${next}`} />} nativeButton={false}>Sign in</Button>
    </main>
  )
}
