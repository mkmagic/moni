# Dashboard redesign

Work-in-progress design for a better dashboard layout — at-a-glance, actionable,
no duplicated net worth, no deep dives. Nothing here is wired into the app yet;
this branch is the design + plan to build from.

## Contents

- **`mockup.html`** — a self-contained interactive mockup in Moni's own tokens
  (dark-only). Open it directly in a browser. Three toggles:
  - **Busy day / Clear day** — the adaptive top: on a busy day the feed panel +
    "Needs categorizing" lead; on a clear day net worth + graphs lead and the
    summary drops to the bottom (and the empty queue isn't shown).
  - **Insights: Briefing / Feed** — the chosen style is **Feed**.
  - **Desktop / Mobile** — mobile stacking (issue #6).
- **`plan.md`** — the implementation plan: which files change, what stays in the
  domain layer (the spending-vs-last-month % is derived with `decimal.js`, not at
  the display edge), reused components, and how to verify.

## Design decisions (settled)

1. Adaptive top (busy → act; clear → know, summary at the bottom).
2. Feed-style insight panel with a last-sync footer that escalates when stale.
3. One net-worth hero (the duplicate grid card, which plotted monthly *flow*
   under a "Net Worth" label, is dropped).
4. Grouped "This month" card; Income-vs-Expenses shrinks to a two-line sparkline.
5. Over-budget categories named inline with their overage, each linking to the
   category's filtered transactions.
6. Suggestion chip sits beside the merchant name in the review queue.

See `plan.md` for the build steps.
