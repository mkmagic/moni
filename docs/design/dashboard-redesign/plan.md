# Dashboard layout redesign

## Context

The current dashboard (`src/app/(app)/dashboard/page.tsx`) spreads day-to-day
information thin and duplicates the headline number. Concretely, verified in the
code:

- **Duplicate net worth.** The hero card (`page.tsx:77`) and a grid `StatCard`
  (`page.tsx:101`) are both titled "Net Worth" — and the stat card's sparkline
  plots `overview.months[].net` (monthly income − expenses), a *different* metric
  under the same label.
- **Suggestion chip is far from the name.** In `needs-review-card.tsx` each row is
  `date · merchant(flex-1) · amount · [w-44 chip slot]` — the category suggestion
  is pinned to a fixed 176px right slot with the amount between it and the name,
  so the eye ping-pongs.
- **No synthesized signal.** The dashboard shows raw stat tiles and a full area
  chart ("deep dive") but never tells the user what *changed* or *needs them*.

Goal: an **at-a-glance, actionable** dashboard — one net-worth number, tightly
grouped "this month" figures, a prominent plain-language insight strip, the
review queue with the suggestion next to the name, and an **adaptive top** that
leads with the review queue when there's work to do and with net worth when the
day is clear. Mobile stacking is considered from the start (issue #6).

Interactive mockup (approved direction): the published Artifact
"Moni Dashboard — Layout Redesign".

## Confirmed design decisions

_Approved against the published Artifact mockup, incl. the second revision._

1. **Adaptive top.**
   - **Busy** (uncategorized entries OR over-budget categories OR a notable
     spending change): the insight panel + review queue lead; net-worth/health
     is last.
   - **Clear** (nothing to act on): net-worth hero + the graphs lead, and the
     insight panel drops to the **bottom** as a calm "all caught up" footer. The
     Needs-categorizing card is **not rendered at all** when the queue is empty.
2. **Insight panel — a card, feed-style (chosen over the "briefing" prose
   variant).** One panel titled "Needs you today" / "All caught up" containing a
   notification-style list: a soft severity icon (amber action / coral warning /
   teal good / blue neutral), the fact, and a muted inline link on the right
   (→ Review, → Budget). Items:
   - *N transactions need a category* → the review queue (amber action accent).
   - *N categories over budget — <named> +₪X* → `/budget` (coral).
   - *Spending up/down X% vs last month* (teal/coral).
   - **Last sync recency** as a quiet footer meta line ("Last synced N days ago ·
     Sync now"); it **escalates** into a colored feed row once stale (e.g. the
     8-hour reminder threshold already in `sync reminder`, or a days-based rule —
     to confirm at build). Amber is used only on the one action item, per §2 of
     the design doc.
3. **One net worth** hero with its 6-month sparkline; delete the duplicate grid
   card.
4. **Grouped "This month"** card: income, expenses (with MoM delta), budget bar —
   one card, not three tiles. Income-vs-Expenses becomes a compact two-line
   sparkline inside it, not a full-height area chart.
5. **Over-budget is legible without drilling.** The budget block links to
   `/budget`; the offending categories are **named inline with their overage**
   (`Groceries +₪120 · Dining +₪80`), each linking to that category's filtered
   transactions (`/transactions?category=…`). (Alternatives considered and set
   aside: per-category mini-bars; a dedicated "Over budget" mini-card.)
6. **Chip beside the name** in the review queue.
7. **Dark-only, Moni tokens**, per `docs/design/ui-and-feel.md`.

## Implementation approach

_All files below were read during exploration; the plan reuses existing
components and the single domain access path._

### Domain — derive the insight facts (no new data source)

`src/domain/dashboard.ts` already returns `months[]` (6 months of
income/expenses/net) and net-worth history. Add a small **insight derivation**
here (or a sibling `getDashboardInsights(session)`), computed with `decimal.js`
so no ratio/percentage math happens at the display edge:

- `expenseChangePct` + direction — current month vs. previous month from
  `months[]` (guard divide-by-zero; suppress when prior month is ~0).
- Net-worth 6-month change % from `netWorthHistory` (for the hero delta).
- Reuse `getBudgetSummary` (`src/domain/budget.ts`) for `overBudgetCount`, and
  the review-queue length from `listEntries(..., { uncategorized: true })`.

Return structured facts (numbers as exact strings + direction flags), never
pre-formatted strings — formatting stays at the edge (`money-and-currency.md`).

A page-level boolean `hasWork = needsReview.length > 0 || overBudgetCount > 0`
drives the adaptive ordering.

### Components

- **`src/components/insight-panel.tsx`** (new) — server component; one card with
  a heading and a **feed list** of rows (severity icon + fact + a muted `<Link>`
  on the right). Amber only on the action row; coral/teal/blue are money-signal
  semantics, not a second accent (ui-and-feel §2). Renders a "busy" and an "all
  caught up" set from the derived facts, plus the last-sync footer meta line.
  Sync recency comes from `connections[].lastSyncAt` (already loaded via
  `listConnections`) — reuse the existing server-side date formatting pattern
  (`Intl.DateTimeFormat`), never format a date in a client component (see the
  2026-07-26 feedback note).
- **`src/components/needs-review-card.tsx`** (edit) — restructure the `<li>` grid
  so the `SuggestionChip` sits in the `namecell` immediately after the merchant
  (`grid-template-columns: date 1fr amount`; chip wraps under the name on narrow
  widths). Keep the button/chip-as-siblings structure (a button inside a button
  is invalid — noted in the file). The amount stays right-aligned in its own
  column; the fixed `w-44` slot goes away.
- **`src/components/this-month-card.tsx`** (new) — groups income, expenses+delta,
  and the budget bar (reuse `BudgetBar` from `budget-bar.tsx`) in one card, plus
  the two-line Income-vs-Expenses sparkline.
- **Income-vs-Expenses sparkline** — `Sparkline` (`src/components/sparkline.tsx`)
  is single-series; either extend it to accept a second series or add a small
  `dual-sparkline.tsx`. Keep the documented Recharts style (gradient fade, no
  resting dots, non-zero margins so the active dot isn't clipped).
- **Retire** the net-worth `StatCard` and the standalone `IncomeExpenseChart`
  card from the dashboard (the component can stay for a detail page). Remove only
  imports/props my changes orphan.

### Page — `src/app/(app)/dashboard/page.tsx`

Reorder into: header → `InsightStrip` → then, keyed on `hasWork`,
`[NeedsReviewCard, health]` or `[health, NeedsReviewCard]`, where `health` =
net-worth hero + `ThisMonthCard`. Net-worth hero keeps its existing markup +
`pt-7` headroom. Health split is `md:grid-cols-2`, stacking to one column on
mobile.

## Verification

- Gates (CLAUDE.md §5): `npm run typecheck && npm run lint && npm run format:check
  && npm run test` — all four; read exit codes.
- Unit-test the domain insight derivation (MoM delta sign, zero-prior guard,
  net-worth %); extend `tests/unit/dashboard-*` / `tests/db/dashboard-*`.
- Browser pass (ui-developer skill) at `http://localhost:3000` as
  `dana@moni.demo` / `moni-demo`: verify both adaptive states (the demo seed's
  current month may need spend under a ceiling to reach the "busy" branch — see
  the 2026-08-04 feedback note on backdating ceilings via the page console),
  the chip-beside-name at desktop + mobile widths, bidi on Hebrew merchants
  (`<bdi>`), and the two-line sparkline's active dots not clipping. Screenshot
  and compare to the mockup.
- Append a dated entry to the ui-developer feedback log.

## Out of scope

New data sources, an AI write path, a job runner for budget alerts (all passive/
in-app), and any light theme.
