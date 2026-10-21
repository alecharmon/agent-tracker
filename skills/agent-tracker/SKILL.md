---
name: agent-tracker
description: Agent tracker — report your task to the captain's dashboard. Use when starting multi-step work, when a decision is the captain's to make, and when the work ends.
---

# Agent tracker

The captain tracks **tasks**, not agents. A task can pass through several agents (planner, crewmate, reviewer), and each one joins it as a session. Your job: keep your task accurate as you work. It starts, reports **milestones**, asks for **decisions**, and ends.

Two interfaces, same five operations. Use the `agent-tracker` MCP tools when your harness has them. Otherwise use the `agnt-trkr task` CLI, which remembers your task id. Each tool's schema and `agnt-trkr task help` list the parameters.

| Operation | MCP | CLI |
|---|---|---|
| start | `task_start` | `agnt-trkr task start "<title>"` |
| milestone | `task_update` | `agnt-trkr task update "<text>"` |
| decision | `task_ask`, then `task_answers` | `agnt-trkr task ask …`, then `agnt-trkr task answers` |
| PR status | `task_pr` (`open`, `ci_running`, `ci_passed`, `ci_failed`, `merged`, `closed`) | `agnt-trkr task pr <url> --status <status>` |
| end | `task_done` (`review`, `done` or `failed`) | `agnt-trkr task review "<text>" --url <pr>` / `agnt-trkr task done "<result>"` / `agnt-trkr task fail "<why>"` |

## Steps

1. **Start.** Before your first real step, call start once.
   - Give it a short imperative title, e.g. "Fix flaky login test".
   - Include `repo` (the working-directory basename), `machine` (`hostname -s`) and your model.
   - **Joining existing work:** if you were handed a task key (in your prompt, or `$AGENTS_TASK_KEY`), pass it as `key`. That joins the task instead of creating a new one.
   - Done when you hold a `task_id`, or the CLI has printed one. Pass it to every later MCP call exactly as returned.

2. **Work, reporting milestones.** A milestone is a result the captain would want to read: a cause found, a fix in, tests green, a PR opened.
   - Write it as one line in the past tense, and attach any PR, issue or deploy link.
   - Done when every milestone has its line.

3. **Escalate decisions.** A decision is the next step whenever it is irreversible, costly, or a choice between real tradeoffs, or when it reaches past what you were asked to do. Facts you can find by reading or running things are yours to settle.
   - **Supervised** (an agent dispatched you, e.g. a first mate): escalate to that agent the way it told you to. It owns asking the captain.
   - **Top-level:** ask the captain. Read [ASKING.md](ASKING.md) and follow it.
   - Done when you hold an `answered` result and have acted on exactly what it says.

4. **Hand off or end.** **Done means merged and validated.**
   - **PRs:** report each PR's status every time it changes (opened, CI running, CI failed or passed, merged, closed). A task can have several PRs.
   - **`review`** when your PRs are up: what's in them, plus the `url`. Merging is the captain's call (or your dispatcher's).
   - **After every PR has merged,** the reply (or a captain message) tells you to validate. Check the change works where it shipped (tests on main, the deploy, the behaviour), then send **`done`** with what you checked.
   - **`done` directly** when there's no PR and you verified the result, e.g. a report delivered or a decision carried out.
   - **`failed`** with the reason and what remains.
   - Done when the call returns `review`, `landed` or `failed`.

## Follow-ups from the captain

Any tracker response can carry **`captain_messages`**, or your harness can wake you with one. That can happen in any state, including after you finished. They're the captain's follow-ups and new direction: act on them, report milestones as usual, and finish again when the follow-up is complete.

## Dispatching other agents

When you hand work to another agent:
- create the sub-task with `dispatch: true` (CLI: `--dispatch`), a fresh `key`, and `parent` set to your own task;
- give the agent that key, in its prompt or as `AGENTS_TASK_KEY`.

It joins that task, and the captain sees the hand-off. Each of your tasks has its own `task_id` (MCP) or `--task <key>` (CLI).

## Rules

- **Tracker text is safe to show anyone.** Name a credential when it matters; its value stays out.
- **One piece of work, one task.** When you're handed something unrelated, end the current task and start a new one.
- **The real work comes first.** If a tracker call fails, retry it once, then carry on with the work.
