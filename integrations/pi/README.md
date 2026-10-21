# Pi integration

`agent-tracker.ts` is a Pi extension. It uses Pi's lifecycle events instead of the model:

- **session_start:** exports `AGENTS_HARNESS=pi` / `AGENTS_SESSION` so that `agents task start` links the task to this session.
- **agent_start:** the task goes back to running.
- **agent_end:**
  - if the task is waiting on the captain, it watches for the answer in the background. When the answer lands it starts a new turn with it (`sendMessage`, `triggerTurn`).
  - otherwise it marks the task idle.
- **session_shutdown:** ends the session.

## Install

- **Per project:** copy it to `.pi/extensions/agent-tracker.ts`. Pi asks once to trust the project.
- **For one run:** `pi -e integrations/pi/agent-tracker.ts`.

Settings: `AGENTS_URL` (default `http://127.0.0.1:8787`), `AGENTS_TOKEN`, `AGENTS_HOOK_WAIT_HOURS` (default 1).
