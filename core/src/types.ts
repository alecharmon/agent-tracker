export const STATES = ["underway", "needs_me", "failed", "gated", "landed", "idle", "unknown"] as const;
export type State = (typeof STATES)[number];

export interface ItemIn {
  native_id: string;
  kind: string;
  state: State;
  title: string;
  detail?: string | null;
  repo?: string | null;
  owner?: string | null;
  /** Timeline lane, e.g. a worker or role name; the model running it. */
  agent?: string | null;
  model?: string | null;
  url?: string | null;
  started_at?: string | null;
  updated_at?: string | null;
  raw?: unknown;
}

export interface EventIn {
  native_id: string; // item native id
  ts: string | null;
  verb: string;
  text: string;
}

/** One full snapshot for one (source, home). Items in scope that are missing become present=0. */
export interface IngestPayload {
  source: string;
  home: string;
  items: ItemIn[];
  events?: EventIn[];
}

export interface Item {
  id: string;
  source: string;
  home: string;
  native_id: string;
  kind: string;
  state: State;
  title: string;
  detail: string | null;
  repo: string | null;
  owner: string | null;
  agent: string | null;
  model: string | null;
  url: string | null;
  started_at: string | null;
  updated_at: string | null;
  first_seen: string;
  last_seen: string;
  present: number;
}

export interface TrackerEvent {
  id: string;
  item_id: string;
  ts: string | null;
  verb: string;
  text: string;
}

export interface Pr {
  url: string;
  item_id: string;
  verb: string | null;
  sha: string | null;
  seen_at: string;
}

export interface ItemFilter {
  state?: string;
  source?: string;
  home?: string;
  repo?: string;
  kind?: string;
  agent?: string;
  q?: string;
  all?: boolean; // include present=0
  limit?: number;
}

export interface Summary {
  counts: Record<string, number>;
  last_ingest: { source: string; home: string; at: string }[];
}
