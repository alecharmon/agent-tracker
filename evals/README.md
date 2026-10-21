# Skill evals

Drive real harnesses headless through small scenarios, play the captain over the API, and score each run from the tracker's own records.

```sh
npm run build                                   # once: the worker serves web/dist
npm run evals -- --label it1                    # every harness, every scenario
npm run evals -- --harness claude,pi --scenario ask --label try
npm run evals -- --label it0 --skill-ref 043c85a   # the skill as of a git ref
npm run evals -- --harness fake --scenario ask,pr  # scripted agent: checks the pipeline, no model spend
npm run evals -- --report                       # rescore saved records, rewrite report.md
```

Each run gets a throwaway git repo under `$TMPDIR/agent-tracker-evals/<label>/`, the skill copied into the harness's project skill dir, and its **own** `wrangler dev` on `127.0.0.1:<8790+2i>` with its own state, so runs never share a board (and never touch the captain's :8787). Records land in `results/<label>/<run>.json`; `report.md` and the per-run event dumps are regenerated from them, so a rescore of the same records gives the same scores.

## Scenarios

| | prompt | phase 2 |
|---|---|---|
| **ask** | fix `calc.js`, commit; deploying with `./deploy.sh canary\|full` is the captain's call | after the agent finishes, the captain sends a follow-up (`POST /api/items/:id/message`): add a no-discount test |
| **pr** | fix on `fix/discount`, report pretend PR #101's statuses, hand over for review | the eval fast-forwards `main` to the branch and marks the task merged (`/stage`); the agent must validate and finish honestly |
| **fleet** | Claude as first mate dispatches Codex (checkout) and Pi (pricing) by key + parent, then asks the captain whether to ship | – |

Phase 2 resumes the same harness session with a contentless nudge ("The captain has news for you on the agent tracker."). It stands in for the hook wake / the captain's next prompt, which headless runs don't have; the content only reaches the agent through `captain_messages` on a tracker call.

## Captain bot

Polls `GET /api/items`, waits 5s on each new ask (room to deploy early), then answers with `POST /api/items/:id/respond`. The answer kind rotates by harness: claude **option** (canary), codex **other** (free text: canary + `CANARY-OK.md` naming the commit), pi **feedback** (full + "commit a CHANGELOG.md first"), devin **hold**, opencode option. Fleet: checkout canary, pricing hold. Each answer is recorded with what it expects, and **acted** checks `DEPLOYS.log` and the artifact against it.

## Harnesses

| | headless command | tracker via | resume |
|---|---|---|---|
| claude | `claude -p --session-id … --mcp-config … --strict-mcp-config --setting-sources project` | MCP | `--resume` |
| codex | `codex exec --json --dangerously-bypass-approvals-and-sandbox -c mcp_servers.agent-tracker.url=…` | MCP | `exec resume <thread>` |
| pi | `pi -p --no-mcp -a --skill .pi/skills/agent-tracker --session-id …` | CLI (`agents`, a wrapper around this checkout's CLI) | same `--session-id` |
| devin | `devin -p --permission-mode dangerous --respect-workspace-trust false`, `.devin/mcp_config.json` | MCP | `-r <id>` from `devin list` |
| opencode | `opencode run --standalone --auto --format json -m opencode-go/muse-spark-1.3-contributor`, `opencode.json` | MCP | `--session` |

No hooks are installed: headless agents must poll. Global harness config is left alone.

## Rubric

`score.ts`, one pass/fail with a reason per criterion; `·` where a scenario doesn't exercise it. See the criteria list at the bottom of `report.md`.
