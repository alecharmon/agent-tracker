import * as React from "react"
import { Button } from "@/components/ui/button"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { TooltipProvider } from "@/components/ui/tooltip"
import { type Item, getToken, setToken, Unauthorized, usePoll } from "@/lib/api"
import { AskSheet } from "@/views/AskSheet"
import { Inbox } from "@/views/Inbox"
import { Lanes } from "@/views/Lanes"

type View = "inbox" | "lanes"
const readView = (): View => (location.hash === "#lanes" ? "lanes" : "inbox")

export default function App() {
  const [view, setView] = React.useState<View>(readView)
  const [authed, setAuthed] = React.useState(!!getToken())
  const [asking, setAsking] = React.useState<Item | null>(null)
  // Answered items move to Running right away; the next poll confirms it.
  const [moved, setMoved] = React.useState<Record<string, string>>({})
  React.useEffect(() => {
    const on = () => setView(readView())
    addEventListener("hashchange", on)
    return () => removeEventListener("hashchange", on)
  }, [])

  const items = usePoll<Item[]>(authed ? "/api/items" : null, 10_000)
  React.useEffect(() => setMoved({}), [items.data])
  const all = React.useMemo(() => (items.data ?? []).map((i) => (moved[i.id] ? { ...i, state: moved[i.id] as Item["state"] } : i)), [items.data, moved])
  if (items.error instanceof Unauthorized || !authed)
    return <TokenForm onSave={(t) => (setToken(t), setAuthed(true), location.reload())} />

  return (
    <TooltipProvider delay={120}>
      <div className="mx-auto flex min-h-svh max-w-6xl flex-col gap-4 px-4 py-6 sm:px-6">
        <nav className="flex items-center gap-3">
          <span className="text-sm font-semibold">Agent tracker</span>
          <ToggleGroup className="ml-auto" value={[view]} onValueChange={(v) => v[0] && (location.hash = v[0] === "lanes" ? "lanes" : "")} size="sm">
            <ToggleGroupItem value="inbox">Inbox</ToggleGroupItem>
            <ToggleGroupItem value="lanes">Lanes</ToggleGroupItem>
          </ToggleGroup>
        </nav>
        {items.error && !items.data ? (
          <p role="alert" className="text-sm text-destructive">Could not load: {items.error.message}</p>
        ) : view === "inbox" ? (
          <Inbox items={all} loading={!items.data} onAsk={setAsking} />
        ) : (
          <Lanes onAsk={setAsking} />
        )}
      </div>
      <AskSheet item={asking} onClose={() => setAsking(null)} onAnswered={(id) => setMoved((m) => ({ ...m, [id]: "underway" }))} />
    </TooltipProvider>
  )
}

function TokenForm({ onSave }: { onSave: (t: string) => void }) {
  const [t, setT] = React.useState("")
  return (
    <form className="mx-auto mt-24 flex max-w-sm flex-col gap-3 px-4" onSubmit={(e) => (e.preventDefault(), t.trim() && onSave(t.trim()))}>
      <h1 className="text-lg font-semibold">Agent tracker</h1>
      <label className="flex flex-col gap-1.5 text-sm">
        API token
        <input type="password" autoComplete="current-password" className="rounded-md border bg-transparent px-3 py-2" value={t} onChange={(e) => setT(e.target.value)} />
      </label>
      <Button type="submit">Save</Button>
    </form>
  )
}
