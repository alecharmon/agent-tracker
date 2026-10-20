export const STATES = ["underway", "needs_me", "failed", "gated", "landed", "idle", "unknown"] as const;
export type State = (typeof STATES)[number];

/** What a needs-you item is asking the captain. */
export interface Ask {
  /** Plain-language explanation of what is needed and why. */
  summary: string;
  questions: {
    id: string;
    prompt: string;
    options: { id: string; label: string; description?: string }[];
    /** Offer a free-text "Other" answer. Default true. */
    allow_other?: boolean;
  }[];
}

export type ResponseAction = "answer" | "retry";
export interface ResponseIn {
  action: ResponseAction;
  /** question id -> chosen option id, or free text for "Other". */
  answers?: Record<string, { option?: string; other?: string }>;
  feedback?: string;
}
export interface TrackerResponse extends ResponseIn {
  id: number;
  item_id: string;
  at: string;
}

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
  /** Native id of the item whose output this one picked up (drawn as a hand-off on the timeline). */
  handoff_from?: string | null;
  ask?: Ask | null;
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
  /** Drop this scope's stored events first. For generated stubs, whose timestamps move on every seed. */
  replace_events?: boolean;
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
  handoff_from: string | null;
  ask: Ask | null;
  first_seen: string;
  last_seen: string;
  present: number;
  event_count: number;
  pr_count: number;
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
