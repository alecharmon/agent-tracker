import { fromBearings, fromStatusLogs } from "./normalize.ts";
import type { Ask, IngestPayload } from "./types.ts";

// Stub fleet for local development, generated relative to `now` so the timeline always looks live.
// Shaped like the real fm-bearings.v1 snapshot and herdr status.log tails.
export function stubPayloads(now = new Date()): IngestPayload[] {
  const ago = (min: number) => new Date(now.getTime() - min * 60_000).toISOString().replace(/\.\d+Z$/, "Z");
  const day = (d: number) => ago(d * 1440).slice(0, 10);

  const bearings = fromBearings({
    schema: "fm-bearings.v1",
    home: "stub/firstmate",
    in_flight: [{ id: "checkout-redesign", kind: "ship", repo: "shop-web", name: "Checkout redesign", doing: "implementing step 2 of 4" }],
    decisions_open: [
      { id: "migrate-users-table", summary: "Migrate users table: dry run clean, wants to run on production", verb: "captain-hold", owner: "(main)" },
      { id: "vendor-pick", summary: "Pick a search vendor: Typesense vs Meilisearch report ready", verb: "captain-decide", owner: "(main)" },
    ],
    gates: [
      { id: "release-v2-4", title: "Release v2.4 after checkout redesign lands", blocked_by: "checkout-redesign", reason: "-", owner: "(main)", filed: day(1) },
      { id: "perf-budget", title: "Perf budget for the dashboard (parked)", blocked_by: "-", reason: "until next sprint", owner: "(main)", filed: day(6) },
    ],
    landed: [{ id: "weekly-metrics-digest", what: "Weekly metrics digest posted to #metrics", artifact: "data/weekly-metrics/report.md", owner: "(main)" }],
  });

  const log = (name: string, lines: [number, string][]) =>
    [`==> /home/stub/briefs/${name}/status.log <==`, ...lines.map(([m, l]) => `${ago(m)} ${l}`)].join("\n");
  // One brief per task; `lanes` maps it to the agent that ran it (timeline lane) and its model.
  const lanes: Record<string, [string, string, string]> = {
    "competitor-pricing": ["researcher", "Opus 5.5", "Competitor pricing"],
    "customer-interviews": ["researcher", "Opus 5.5", "Customer interviews"],
    "draft-pricing-page": ["writer", "Sonnet 5.5", "Draft pricing page"],
    "review-pr-482": ["reviewer", "GPT-6 Sol", "Review PR #482"],
    "sync-crm": ["ops", "Gemini 3.8 Flash", "Clean up CRM contacts"],
    "rotate-api-keys": ["ops", "Gemini 3.8 Flash", "Rotate API keys"],
    "release-notes-v2-4": ["release", "Haiku 5.5", "Release notes v2.4"],
  };
  const herdr = fromStatusLogs(
    [
      log("competitor-pricing", [
        [29, "WORKING: reading 6 competitor pricing pages"],
        [20, "DONE: pricing table drafted in data/pricing.md"],
      ]),
      log("customer-interviews", [
        [11, "WORKING: tagging 14 interview transcripts"],
        [3, "WORKING: 9/14 tagged"],
      ]),
      log("draft-pricing-page", [
        [17, "WORKING: outlined the page"],
        [12, "WORKING: wrote plan copy and FAQ"],
        [2, "PR-READY https://github.com/example/shop-web/pull/490 3f1c2a9b8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a"],
      ]),
      log("review-pr-482", [
        [30, "WORKING: billing webhooks: reading the diff and the test run"],
        [24, "DONE: https://github.com/example/shop-web/pull/482 reviewed, 2 nits left"],
      ]),
      log("sync-crm", [
        [29, "WORKING: matching likely duplicate contacts"],
        [25, "FAILED: merge hit the API rate limit after 1,312 matches"],
      ]),
      log("rotate-api-keys", [
        [16, "WORKING: new keys staged"],
        [1, "BLOCKED: needs approval to revoke the old production key"],
      ]),
      log("release-notes-v2-4", [
        [6, "WORKING: grouping 23 merged pull requests into features and fixes"],
      ]),
    ].join("\n"),
    "stub/herdr",
    now,
  );
  for (const it of herdr.items) [it.agent, it.model, it.title] = lanes[it.native_id] ?? [it.native_id, null, it.title];
  // Snapshots carry no times; give the stub fleet items plausible ones for the timeline.
  const times: Record<string, [number, number]> = {
    "checkout-redesign": [27, 4], "migrate-users-table": [14, 6], "vendor-pick": [40, 18], "weekly-metrics-digest": [26, 22],
  };
  for (const it of bearings.items) {
    const t = times[it.native_id];
    if (t) [it.started_at, it.updated_at] = [ago(t[0]), ago(t[1])];
    it.model = "Opus 5.5";
  }
  // What each needs-you item is asking, and who handed work to whom.
  const asks: Record<string, Ask> = {
    "migrate-users-table": {
      summary:
        "The migration that splits users into accounts and profiles (0042_split_users) passed a dry run on staging with no errors. Running it on production locks the users table for about 40 seconds, so it needs your go-ahead.",
      questions: [
        {
          id: "run", prompt: "Run the migration on production?",
          options: [
            { id: "now", label: "Run it now", description: "About 40s of write lock on users" },
            { id: "window", label: "Run in tonight's maintenance window", description: "02:00 UTC, lower traffic" },
            { id: "hold", label: "Hold", description: "Keep the migration ready; don't run it yet" },
          ],
        },
        {
          id: "backup", prompt: "Take a fresh snapshot first?",
          options: [{ id: "yes", label: "Yes, snapshot first" }, { id: "no", label: "No, last night's backup is enough" }],
          allow_other: false,
        },
      ],
    },
    "vendor-pick": {
      summary:
        "The search vendor comparison is done (report in data/search-vendors/report.md). Both fit the 50 ms p95 budget; they differ in hosting and price.",
      questions: [
        {
          id: "vendor", prompt: "Which search vendor should we adopt?",
          options: [
            { id: "typesense", label: "Typesense", description: "Self-host on the existing VM, ~$0 extra" },
            { id: "meili", label: "Meilisearch Cloud", description: "Managed, ~$30/month, less ops" },
          ],
        },
      ],
    },
    "rotate-api-keys": {
      summary:
        "New API keys are staged and every service reads them. Revoking the old production key is irreversible, and two cron jobs last used it 3 days ago.",
      questions: [
        {
          id: "revoke", prompt: "Revoke the old production key?",
          options: [
            { id: "revoke", label: "Revoke now" },
            { id: "after-cron", label: "Wait until the cron jobs run on the new key", description: "Next run in 6 hours" },
          ],
        },
      ],
    },
  };
  const handoffs: Record<string, string> = { "draft-pricing-page": "competitor-pricing" };
  for (const it of [...bearings.items, ...herdr.items]) {
    it.ask = asks[it.native_id] ?? null;
    it.handoff_from = handoffs[it.native_id] ?? null;
  }
  return [bearings, herdr].map((p) => ({ ...p, replace_events: true }));
}
