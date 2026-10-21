---
name: agent-tracker
description: Report your task to the captain's tracker. Use when you start multi-step work, when a decision is the captain's call, when you dispatch another agent, and when your work ends.
---

# Agent tracker

The captain follows **tasks**, not agents, and reads them from a phone. Your job is to keep your task's record true: one start, a milestone per result, the captain's calls asked, one finish.

Use the `agent-tracker` MCP tools when you have them; otherwise the `agents task` CLI, which remembers your task (`agents task help` lists its flags).

| | MCP | CLI |
|---|---|---|
| start | `task_start` | `agents task start` |
| milestone | `task_update` | `agents task update` |
| ask | `task_ask`, then `task_answers` | `agents task ask`, then `agents task answers` |
| PR status | `task_pr` | `agents task pr` |
| finish | `task_done` | `agents task review` / `done` / `fail` |

## Steps

1. **Start**, once, before your first real step.
   - Title: a short imperative, e.g. "Fix flaky login test".
   - Pass `repo` (the working-directory basename), `machine` (`hostname -s`) and `model` (your model name). Pass `session` when your harness gave you a session id. The CLI fills repo and machine itself; give it `--model`.
   - Handed a task key, in your prompt or as `$AGENTS_TASK_KEY`? Pass it as `key`: you join that task.
   - Done when you hold a `task_id`. Give repo, machine and model in that one call: it is your only start. Pass that `task_id` unchanged to every later MCP call, for the rest of the session, including after you finish. The CLI remembers it: later commands need no `--task`.

2. **Milestone** each result the captain would want to read: cause found, fix committed, tests green, PR opened, deploy run.
   - One line, past tense, with its link when there is one.
   - Done when every result has its line.

3. **Ask** when the next step is the captain's call: irreversible, costly, a real tradeoff, or beyond what you were asked. Facts you can find by reading or running things are yours to settle.
   - **Top-level:** before you ask, read [ASKING.md](ASKING.md). The ask's fields, the wait and acting on the answer are all there; the summary alone is not an ask.
   - **Supervised** (another agent dispatched you): raise it with that agent the way it told you to; it owns asking the captain.
   - Done when the answer is in and you've done exactly what it says.

4. **Finish**, once per piece of work. **Done means merged and validated.**
   - **Opened a PR:** before your first `task_pr`, read [SHIPPING.md](SHIPPING.md). It takes you through PR status, `review`, and validating after the merge.
   - **No PR:** `done`, with what you verified, e.g. "Deployed canary a1b2c3d; tests pass".
   - **Couldn't do it:** `failed`, with why and what remains.
   - Done when the call returns `review`, `landed` or `failed`.

## Captain messages

Any tracker response can carry `captain_messages`, in any state, including after you finished. They are the captain's follow-ups: new instructions. Carry them out with milestones as usual, then finish again.

Told the captain has news, with no message in front of you? Make a tracker call to receive it: a `task_update` saying what you're picking up.

## Dispatching another agent

1. Create its sub-task: `task_start` with `dispatch: true`, a fresh `key` (e.g. `fm/checkout-fix`), and `parent` set to your own task. CLI: `--dispatch --key <key> --parent <your key>`.
2. Give the agent that key, in its prompt or as `AGENTS_TASK_KEY`. It joins the sub-task, and the captain sees the hand-off.
3. Its decisions come to you; ask the captain the ones that are the captain's call.

Each task has its own id. Address a sub-task with its `task_id` (MCP) or `--task <key>` (CLI).

## Rules

- **Tracker text is safe to show anyone.** Name a credential when it matters; its value stays out.
- **One piece of work, one task.** Handed something unrelated? Finish this task and start a new one.
- **Real work comes first.** A failed tracker call gets one retry, then the work carries on.
