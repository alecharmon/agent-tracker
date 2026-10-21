# Shipping a PR

**Done means merged and validated.** Merging is the captain's call (or your dispatcher's).

1. **PR status.** Call `task_pr` every time a PR's status changes, in the order it happens: `open`, `ci_running`, then `ci_passed` or `ci_failed`. A task can have several PRs; report each by its URL.
   - Done when the tracker shows every PR's current status.

2. **Review.** Once your PRs are up and their CI is reported, finish with outcome `review`: what's in them, plus the PR `url`. Then end your turn; the merge reaches you as a captain message.
   - Done when the call returns `review`.

3. **Validate.** When a reply's `note` or a captain message says your PRs merged, check that the change works where it shipped: tests on main, the deploy, the behaviour.
   - Done when you've run that check and seen its result.

4. **Finish.** `done` with what you checked, or `failed` with what broke and what remains.
   - Done when the call returns `landed` or `failed`.
