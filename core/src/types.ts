// review: PR open, waiting on the captain. validating: merged, the agent is checking it works.
// landed ("Done") means merged AND validated.
export const STATES = ["underway", "needs_me", "answered", "review", "validating", "failed", "gated", "landed", "idle", "unknown"] as const;
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
  /** First time the agent read it. */
  delivered_at: string | null;
  /** The agent's next tracker call after reading: proof it got it. Until then the item stays "answered". */
  acked_at: string | null;
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
  /** Task that dispatched this one (e.g. a first mate's task), if any. */
  parent_id: string | null;
  first_seen: string;
  last_seen: string;
  present: number;
  event_count: number;
  pr_count: number;
  /** Harnesses whose sessions worked on this task. */
  harnesses: string[];
  /** Every PR on the task with its last reported status. */
  pr_list: { url: string; status: PrStatus | null }[];
}

export interface TrackerEvent {
  id: string;
  item_id: string;
  ts: string | null;
  verb: string;
  text: string;
  /** Agent session that reported it; null for the captain's own actions and for snapshot sources. */
  session_id: string | null;
}

export const PR_STATUSES = ["open", "ci_running", "ci_passed", "ci_failed", "merged", "closed"] as const;
export type PrStatus = (typeof PR_STATUSES)[number];

export interface Pr {
  url: string;
  item_id: string;
  verb: string | null;
  sha: string | null;
  seen_at: string;
  /** Reported by the agent; null when the PR was only seen in status text. */
  status: PrStatus | null;
  note: string | null;
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

/** A follow-up or direction from the captain to whichever agent works the task. */
export interface CaptainMessage {
  id: number;
  item_id: string;
  at: string;
  text: string;
  /** When an agent received it, and which session. Null while queued. */
  delivered_at: string | null;
  session_id: string | null;
}
