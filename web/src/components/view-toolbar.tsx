import { ArrowUpDownIcon, SearchIcon, XIcon } from "lucide-react"
import { RollingNumber } from "@/components/rolling-number"
import type { Item } from "@/lib/api"
import { cn } from "@/lib/utils"
import { matches, SORTS, type SortKey, STATUS, type ViewOptions } from "@/lib/view-options"

const control = "h-8 rounded-md border bg-transparent px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring dark:bg-input/30"

/** Filter + sort, shared by Inbox and Lanes. */
export function ViewToolbar({ items, value, onChange }: { items: Item[]; value: ViewOptions; onChange: (v: ViewOptions) => void }) {
  const set = (p: Partial<ViewOptions>) => onChange({ ...value, ...p })
  const projects = [...new Set(items.map((i) => i.repo).filter((r): r is string => !!r))].sort()
  return (
    <div role="toolbar" aria-label="Filter and sort" className="flex flex-wrap items-center gap-2">
      <label className="relative flex min-w-48 flex-1 items-center sm:max-w-xs">
        <SearchIcon className="pointer-events-none absolute left-2.5 size-3.5 text-muted-foreground" aria-hidden />
        <span className="sr-only">Search tasks</span>
        <input
          type="search"
          value={value.q}
          onChange={(e) => set({ q: e.target.value })}
          placeholder="Search tasks, repos, agents"
          className={cn(control, "w-full pr-7 pl-8 [&::-webkit-search-cancel-button]:hidden")}
        />
        {value.q && (
          <button type="button" onClick={() => set({ q: "" })} aria-label="Clear search" className="absolute right-1.5 rounded p-0.5 text-muted-foreground hover:text-foreground">
            <XIcon className="size-3.5" />
          </button>
        )}
      </label>
      <div role="radiogroup" aria-label="Status" className="flex rounded-md border p-0.5">
        {STATUS.map((s) => {
          const n = items.filter((i) => matches(i, { ...value, status: s.key })).length
          return (
            <button key={s.key} type="button" role="radio" aria-checked={value.status === s.key} onClick={() => set({ status: s.key })}
              className={cn("flex h-7 items-center gap-1.5 rounded px-2.5 text-sm text-muted-foreground transition-colors hover:text-foreground",
                value.status === s.key && "bg-muted text-foreground")}>
              {s.label}
              <RollingNumber value={n} className="text-xs text-muted-foreground" />
            </button>
          )
        })}
      </div>
      {projects.length > 1 && (
        <select aria-label="Project" value={value.project} onChange={(e) => set({ project: e.target.value })} className={control}>
          <option value="">All projects</option>
          {projects.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      )}
      <label className="ml-auto flex items-center gap-1.5 text-sm text-muted-foreground">
        <ArrowUpDownIcon className="size-3.5" aria-hidden />
        <span className="sr-only">Sort</span>
        <select aria-label="Sort" value={value.sort} onChange={(e) => set({ sort: e.target.value as SortKey })} className={cn(control, "text-foreground")}>
          {Object.entries(SORTS).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}
        </select>
      </label>
    </div>
  )
}
