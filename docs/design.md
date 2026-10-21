# Agent tracker — design (v1)

One personal backend that records all of the captain's agent work, with a CLI, a web dashboard and a Raycast extension on top of it. The first source is the Firstmate fleet.

## Data model
The stored data is small: hundreds to low thousands of rows.

| table | key | fields |
|---|---|---|
| `items` | `id` = `<source>:<home>:<native id>` | source, home, native_id, kind, state, title, detail, repo, owner, url, first_seen, last_seen, updated_at, present, raw (JSON) |
| `events` | `id` = hash(item_id, ts, line) | item_id, ts, verb, text |
| `prs` | `url` | item_id, sha, verb, seen_at |
| `ingests` | autoinc | source, home, at, item/event counts |

- **`state`** is one of `underway` · `needs_me` · `gated` · `landed` · `idle` · `unknown`.
- **Mapping from a fleet snapshot:**

  | snapshot field | state |
  |---|---|
  | `in_flight` | underway |
  | `decisions_open` | needs_me |
  | `gates` | gated |
  | `landed` | landed |

- **Mapping from a `status.log` line** (`[ISO-ts] VERB[: ] text`, read from a worker host's `~/briefs/*/status.log`). Each brief becomes one item, and each line becomes one event. The item's state comes from its last line:
  - `BLOCKED*`, `NEEDS*`, `QUESTION*` or `DECISION-NEEDED*` → needs_me
  - `DONE`, `MERGED*` or `LANDED*` → landed
  - otherwise, underway if the line is less than 24h old, else idle.
- **PR URLs** found in event text are upserted into `prs`.
- **Sync semantics:** an ingest is a full snapshot for one (source, home). Items in that scope that are missing from the snapshot get `present=0`, and their history is kept. Nothing is ever deleted.

## Backend choice
| | Durable Object (SQLite) | D1 | Turso (libSQL) |
|---|---|---|---|
| Fit for one user, one writer | exact: a single DO instance is a strongly consistent single writer | fine, but it is a separate resource and adds replica lag on reads | fine; useful later for local/embedded replicas |
| Extra infra | none (a binding in the same Worker) | a database plus a binding | an external account and token |
| Push to clients later | WebSocket hibernation is built in | no | no |
| Cost here | $0: DO SQLite runs on the Workers Free plan | $0 | $0 (free tier) |

The plan is **DO first**: one `Tracker` DO named `"main"`.

The storage logic is plain SQL behind a tiny `Db` interface (`all`, `batch`). The same `store.ts` runs on DO `ctx.storage.sql` and on `node:sqlite` in the tests.

**Turso is deferred** at the captain's call. A libSQL adapter is about 20 lines against `Db` whenever it's wanted.

## Ingest flow
`agnt-trkr sync`, run on the Mac by hand or from launchd every 5 minutes, works like this:
1. `ssh firstmate-vm 'cd ~/firstmate && bin/fm-bearings-snapshot.sh --json --all-queued --all-decisions'`. The collector parses the leading JSON object, because the script's stdout ends in terminal escape codes.
2. It runs a single `ssh worker-host` command that prints `tail -n 200` of every `~/briefs/*/status.log`, with file markers.
3. It normalizes the data in the CLI (`core/normalize.ts`) and makes one `POST /api/ingest` per (source, home).

The collector only reads over ssh. It never writes to either host and never fetches secret values; status text is stored as-is.

## API and auth
- **Endpoints:**
  - `GET /api/items?state=&source=&home=&repo=&q=&all=`
  - `GET /api/items/:id`, which includes its events and PRs
  - `GET /api/decisions`
  - `GET /api/prs`
  - `GET /api/summary`, which returns the counts for Raycast
  - `POST /api/ingest`
- **Auth** is a single bearer token, the Worker secret `TRACKER_TOKEN`, checked with a constant-time compare.
  - It lives only on the captain's devices: `~/.config/agent-tracker/config.json` (mode 0600, or `AGENTS_TOKEN`), a Raycast password preference, and the web app's localStorage.
  - Cloudflare Access can be put in front of the web route later. It's free for under 50 users, so no code change is needed.
- **The web dashboard** is Vite, React, Tailwind and shadcn (base-nova style). [ReUI](https://reui.io) components such as Trace (`@reui/c-trace-4`) show each item as a parent row over its event children. It is built as static files and served by the same Worker through `assets`.

## Cost
Requests, at about 300/day from a 5-minute sync plus casual reads, stay far below the free plan's 100k/day. DO storage stays well under 1 GB. The expected cost is **$0** on Workers Free or within the Workers Paid baseline. 
**Account:** this runs on the captain's **personal** Cloudflare account, not a work account. `worker/wrangler.jsonc` pins the personal `account_id`, so deploys can't land in another account. Nothing is deployed until the captain says so; development uses `wrangler dev` locally.
