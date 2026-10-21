# Asking the captain

The captain answers from a phone, between other agents, without opening your session. Write the ask so it can be answered in seconds.

## 1. Ask

- **summary:** 2–4 sentences: what you found, what needs deciding, what you'll do once it's decided.
- **questions:** 1–3, each a single decision, phrased as a question ending in "?".
- **options:** 2–4 per question.
  - `label`: a concrete action, e.g. "Deploy to canary".
  - `description`: its consequence or cost, e.g. "10% of traffic; full rollout tomorrow".
  - Offer holding as an option when it's a real path.
- **ids:** short slugs, e.g. `deploy` / `canary`.
- **allow_other:** leave it on (the default) so the captain can answer in their own words. Turn it off only when your options are the complete set.

CLI: `agnt-trkr task ask "<summary>" -q "<question?>" -o "<label>|<consequence>" -o … [-q … -o …]`.

Done when the call returns `needs_me`.

## 2. Wait

Everything the decision covers waits for the answer. Work that holds up whichever way the captain decides can go on.

- **Hooked session** (a tracker hook told you, in this session, that it wakes when the captain answers): end your turn. The answer starts your next turn.
- **Otherwise, poll.** This is the default, and it holds in headless runs. Call `task_answers` (CLI: `agnt-trkr task answers`). Each call waits up to 25s, so give a shell call a timeout of 30s or more. On `pending`, poll again; keep polling until `answered`. A timed-out read loses nothing: the answer stays on the tracker.

Done when `status` is `answered`.

## 3. Act

- Do exactly what the answer says, then report it as a milestone.
- **Free text wins.** When an answer has `free_text: true`, or there's `feedback`, the captain's own words are the instruction, over your options.

Done when what the answer asked for is done and reported.
