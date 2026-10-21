# Asking the captain for a decision

The captain answers from a phone or a dashboard, often while running other agents. Write the ask so it can be answered in seconds, without opening your session.

## Write the ask

- **summary:** 2–4 sentences covering what you found, what you need decided, and what you'll do once you have the answer.
- **questions:** 1–3, each a single decision phrased as a question ending in "?".
- **options:** 2–4 per question.
  - Each `label` is a concrete action, e.g. "Run it in tonight's window".
  - Each `description` states its consequence or cost, e.g. "02:00 UTC, ~40s write lock".
  - Include "hold" only when holding is a real path.
- **ids:** short slugs, e.g. `deploy` / `tonight`.
- **allow_other:** leave free text on (the default) so the captain can answer in their own words. Set `allow_other: false` only when your options are the complete set.

CLI form: `agents task ask "<summary>" -q "<question?>" -o "<label>|<consequence>" -o … [-q … -o …]`.

## Wait for the answer

**Woken by your harness?** If an agent-tracker hook told you this session wakes when the captain answers, end your turn after asking. The answer starts your next turn, and you skip the rest of this section until then.

Otherwise call `task_answers`, or `agents task answers` (each waits up to 25s, so give the shell call a timeout of at least 30s), and branch on `status`:

- **`pending`:** carry on with work that holds up whichever way the captain decides, then check again. If none is left, keep waiting with `task_answers`.
- **`answered`:** read `answers` and `feedback`.
  - Do what the chosen option says.
  - When `free_text` is true, or there's feedback, the captain's own words are the instruction: follow them over your options.
  - Your next tracker call acknowledges it, and your task shows as running again. If a read times out, call `task_answers` again: the answer is still there.

Done when you're acting on an `answered` result.
