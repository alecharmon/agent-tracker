# Using the tracker from firstmate

Answers and follow-ups you send from the board reach a first mate in one of two ways, depending on how its items got onto the board.

## Items it seeds (fleet snapshots)

Seeded items have no agent session attached, so no hook watches them. The first mate's watcher picks them up with `agnt-trkr inbox` instead. Add one line to the bash watcher that already sleeps until something needs the first mate:

```sh
# Blocks until an answer or message is waiting on items from this source, claims them, prints JSON, exits 0.
agnt-trkr inbox --source <source the first mate seeds with> --wait forever
```

Wake the first mate with that JSON. Each entry has the item's `task_id` and `title`, the `answer` (each question with the chosen answer, marked `free_text` when you wrote your own, plus any `feedback`), and any `messages`. Claiming marks them delivered and acknowledged, so the board shows "Answered · delivered" and the same answer is never handed over twice.

- `--wait 0` checks once. It exits 3 when nothing is waiting.
- `--peek` shows what's waiting without claiming it.
- `--home <home>` narrows to one firstmate home when several seed the same source.

The CLI must be signed in on the first mate's machine: `agnt-trkr login`, or `agnt-trkr login --remote` over ssh. Point it at the tracker with `agnt-trkr config set url <tracker url>`.

## Tasks it creates through the task API (preferred)

If the first mate creates its board with `task_start` instead of seeding, everything else follows from the hooks:

- use its own task ids as `key`;
- create crew sub-tasks with `dispatch: true` and `parent` set to its task;
- give each crewmate its key (`AGENTS_TASK_KEY`).

Crewmates then join those tasks as sessions. The first mate's own session owns every task it started or dispatched, and its harness hook waits on all of them at once: an answer or message on any of them wakes it, with a note saying which task it's for. No watcher line is needed.
