# UI Developer Skill

Build and refine Moni's user interface so it stays visually consistent and matches the
owner's taste. **Authoritative design spec:** `../../../docs/design/ui-and-feel.md` (the palette,
typography, layout, and component patterns) — read it before touching any UI, and keep it truthful:
if you add a real pattern, document it there. `src/app/globals.css` is the token source of truth.

This skill is the **living record of UI feedback** the owner has given on real work. It grows every
time they react to something you built. Treat the "Feedback log" below as hard-won taste that
overrides your defaults — re-read it before starting UI work, and append a new dated entry whenever
new feedback lands.

## Stack & where things live

- Hand-rolled Tailwind v4 components (no shadcn/ui yet — may be added later). Deps: `recharts@3`,
  `lucide-react@1`, `geist` fonts.
- **Tokens:** `src/app/globals.css` `@theme` (oklch) → utilities (`bg-card`, `text-positive`,
  `border-border`, `rounded-[var(--radius)]`, …). Never hand-pick a colour outside these tokens; add
  a token first, then use it.
- **Primitives:** `src/components/ui/{card,button,input,badge}.tsx`; `cn` in `src/lib/utils.ts`.
- **Composite components:** `src/components/*` (`sidebar`, `stat-card`, `sparkline`,
  `income-expense-chart`, `money`, `transactions-table`, `account-card`).
- **Pages:** server components under `src/app/(app)/` call `requireSession()` → the domain layer;
  interactive/chart bits are `"use client"` leaf components.
- **Money at the edge:** the domain layer returns exact decimal **strings**; only
  `formatMoney`/`isNegative` (`src/lib/format`) format for display, and `Number()` on a money value
  is allowed _only_ inside a Recharts data array or a chart-tooltip formatter. Never format/round in
  the domain layer, never render a JS float for money.

## Workflow for any UI task

1. Read `../../../docs/design/ui-and-feel.md` and the **Feedback log** below.
2. Build with existing tokens/primitives; match the surrounding component's style.
3. Gates must all pass: `npm run typecheck`, `npm run lint`, `npm run format`, `npm run test`.
   - `next dev` mutates `tsconfig.json` (`jsx: preserve → react-jsx`, adds `.next/dev/types`) — if
     it shows up in a diff, `git checkout tsconfig.json`; it is never your change.
4. **Verify visually in the browser** (Claude-in-Chrome), don't just trust the diff. Log in at
   `http://localhost:3000` as `dana@moni.demo` / `moni-demo` (dev server: `npm run dev`). Screenshot
   the changed views; **hover and click** interactive elements (glow, tooltips, active dots, links);
   `zoom` into details like padding, dot clipping, and gradient edges. Compare against the feedback
   below.

## Feedback log (newest first — append, don't overwrite)

### 2026-08-14 — mobile verification: `resize_window` can't be trusted, and don't fix mobile by breaking desktop

- **`resize_window` does not reliably reflow the content viewport.** Chrome keeps the content at its
  wide width, and the automation window can't shrink below a floor, so a post-resize screenshot stays
  wide and the mobile pass reads as inconclusive (or worse, falsely "fine"). This recurred across
  sessions. Don't verify a narrow-layout change from a resize + screenshot alone.
- **What actually works:** inject a **same-origin iframe sized to the target viewport** (e.g. 390px)
  and measure with `getBoundingClientRect` / `scrollWidth` via `javascript_tool` — deterministic,
  and it catches horizontal overflow the screenshot hides. Screenshot zoom-region mapping is also
  unreliable; measure the DOM, don't eyeball the pixels.
- **Don't fix mobile by neglecting desktop.** Capture a desktop baseline *before* the change and
  confirm it's unchanged *after* — a responsive pass that only checks the phone width regularly
  regresses the desktop layout.

### 2026-08-09 — dashboard redesign: an adaptive top, a feed panel, and a spending % that would have lied

- **The dashboard top is adaptive, by the owner's own call.** When there's work (uncategorized
  entries OR over-budget categories) the insight panel + "Needs categorizing" lead and net worth
  follows; on a clear day net worth + the graphs lead and the panel drops to a calm "All caught up"
  footer. `hasWork` in `dashboard/page.tsx` picks the order. The review card is simply **not rendered**
  when the queue is empty — "no empty-state card" was an explicit request, not a nicety.
- **"Spending down 8% vs last month" is a trap the projectedSpend precedent already ruled on.** The
  current month is month-to-date; last month is complete, so a naive comparison always reads "down"
  early in the month. `Overview.expenseTrend` compares MTD against the **same day-span** of the prior
  month (`day-of-month <= today`), computed in the domain with decimal.js — never partial-vs-full,
  never a projection. A DB test seeds a large prior-month charge _after_ today's day and asserts it's
  excluded (baseline 100 not 1100). Same reasoning gave `netWorthTrend` (now vs six months ago).
- **A percentage is a ratio, not money — so it's rounded in the domain, not at the edge.** `Trend.pct`
  is a whole number the display just prints. This kept the money-arithmetic invariant while still
  answering "is my spending up or down" — the owner relaxed "UI only" to allow it, asking only that
  domain touches be explicit. Two domain files changed: `dashboard.ts` (the two trends) and
  `budget.ts` (`getBudgetSummary.overCategories`, so the panel can _name_ the over-budget categories,
  not just count them — derived from the same rows `overBudgetCount` is).
- **Chip-beside-the-name needs an overlay button, not a nested one.** The row opens the categorize
  dialog _and_ the chip carries its own accept/reject buttons — a button inside a button is invalid.
  The fix: an `absolute inset-0` transparent `<button>` sibling as the row's click target, with the
  chip `relative z-10` above it. This let the suggestion sit right after the merchant (killing the
  far-right `w-44` slot the 2026-07-28 note created) while the row stays one click target. Verified in
  the browser: `נווה מדבר [Culture & Events ✓ ✗] … −₪25.00`, bidi intact.
- **Insight strip → a feed _panel_, because pills read as a toolbar.** The owner rejected the button
  look. It's now one Card with notification rows (severity icon + fact + a muted "→ Review/Budget"
  link), amber only on the one `action` row. Last-sync is a quiet footer that **escalates** into a
  coral row past `STALE_SYNC_DAYS` (7).
- **Two ambers when the sync-reminder card is showing.** The reminder card's "Sync now" is a filled
  amber button, and the insight panel's `action` row icon chip is also amber — the reminder is the
  2026-07-28 "amber stays with the reminder card" case, so the insight action arguably should yield
  while it shows. Left as-is (the reminder is transient/dismissible and the chip is a 15%-tint icon,
  not a fill); flag for the owner. **Watch for this whenever a new persistent-accent surface lands on
  the dashboard.**
- **The duplicate net-worth card plotted the wrong series, and a source-string test encoded it.**
  `tests/unit/dashboard-net-worth-sparkline.test.ts` asserted `series={overview.months.map((m) =>
m.net)}` — the removed card that charted monthly _flow_ under a "Net Worth" label. Updated the test
  to the new structure. `StatCard` and `BudgetCard` are now orphaned by the redesign; left in place
  and flagged rather than deleted (they hold the clickable-card glow pattern a detail view may want).
- **Verification notes.** The demo `dana@moni.demo` is a _clear-day_ user (curl login → "All caught
  up", no review card), which conveniently exercised that branch server-side; the browser already
  held a _busy-day_ session that exercised the other. `resize_window` did **not** reflow the content
  viewport (screenshot stayed wide), so the mobile pass was inconclusive from here — leave it to the
  owner. Pre-existing, not mine: `investments.test.ts` "one current quote decision" fails on the base
  branch too (date-sensitive Tiingo test), and `tsc` can't resolve `pdfjs-dist/legacy/build/pdf.mjs`
  because that build is absent from this env's `node_modules`.

### 2026-08-05 — long-term savings follow-ups: a table scoped to one report, and a skip named after one connector

- **A table fed by "the newest snapshot" is not a history.** The deposits disclosure read
  `latest.deposits`, so importing Q1 2026 and then backfilling Q3 2025 showed four deposits and hid
  twenty-one. `deposits` moved from `LongTermSavingsSnapshotView` up to
  `LongTermSavingsAccountView`, built from **the newest report of each fiscal year** — a quarterly
  report restates the whole year, so concatenating every report would print January twice while
  taking only the newest prints one year and drops the rest. **When a figure is per-report and a
  table is per-account, the domain type has to say which.**
- **Name a skip by what it costs, not by the one connector that first needed it.** The onboarding
  passkey step offered "Import a Schwab statement without a passkey", which was already wrong the day
  a Harel PDF existed. Now "Skip for now" plus a sentence naming what stays out of reach (anything
  with a stored login) and what does not (file imports).
- **`px-0` loses to the Button primitive's own `px-4`** — the 2026-07-28 `cn`-is-a-plain-join trap
  again, computed `padding-left: 16px`, label sitting 16px right of the sentence beneath it. A
  negative margin (`-ml-4`) isn't fighting a utility and lands it back on the text column. Several
  existing ghost buttons still carry the ineffective `px-0`.
- **A picker tile should name the provider, not the document.** "Harel · Quarterly Pension Report"
  read as a different kind of thing beside "Bank Leumi". The tile is now "Harel" and its reports live
  one screen in, which is also the shape a second Harel parser needs.
- **Offer the file where the connection is made.** A `user_mediated_import` connection ended on
  "Connection created. Import a report from Long-term savings when you're ready" — a detour to
  another screen with nothing in it. The outcome now carries a primary "Import a file now" that opens
  the shared `ImportDialog`, whose `connections` prop was narrowed from `ConnectionView` to a local
  `ImportTarget` so the flow can pass the connection it just created rather than one read back.
- **Verifying an outcome screen without writing a connection:** stub `window.fetch` to answer
  `POST /api/connections` with `201 {"id":"…"}` (same technique as the 2026-08-01 busy-state note).
  The onboarding passkey step needs a _user_ with no passkey, though — a throwaway signup
  (`signupToken: dev-signup-token`), then `DELETE /api/account` with its own password. **Logging in
  as the throwaway replaces whoever was signed in**, and `dana@moni.demo` is not necessarily that
  person — check who the session belongs to before you take it.

### 2026-08-05 (later) — the long-term savings card: an account is a product, and one statement is not a history

- **Name the thing, not the document that reported it.** The card read "Harel Quarterly Pension Report". The owner: _"should show 'Harel Pension'."_ A long-term savings statement carries **no** account name and no account number, so everything in `accounts.name_ct` is either a nickname or a string Moni derived — and the derived one was provider + _document_ when the account is a pension held at a provider. Fixed at both ends: the sync route now derives provider + `PRODUCT_LABEL[product]`, and `longTermSavingsAccountName` corrects the old default at the display edge so existing rows heal without a re-import. **When a name is Moni's own invention, the display edge may correct it; a nickname must be left alone, so match the old default exactly rather than guessing.**
- **The pinned vocabulary had already decided the thing I deferred.** `CONTEXT.md`'s "Stated period" entry says per-quarter figures are _"derived in the view by differencing consecutive snapshots"_. I shipped only the latest snapshot's year-to-date flows and flagged the gap in prose — and the owner hit it immediately: _"Shouldn't 'contributions' show all contributions up until this point?"_ **A deferral that contradicts a term in CONTEXT.md is a bug, not a scope decision. Grep it before deciding something is out of scope.**
- **Differencing is keyed on the fiscal year, not on adjacency.** An Israeli report restates flows from January, so a report is differenced against the previous report _of the same year_ and stands alone otherwise. That makes Q1 correct with no predecessor, and makes a Q3 with no Q2 fall back to the document's own year-to-date figures — labelled "year to date" in the table rather than passed off as a quarter. Summing the differenced periods is also the only way the totals can be right: adding four year-to-date figures counts January four times.
- **Two rows called "Fees" on one card is a puzzle.** The cumulative row and the rates row both said Fees. Renamed to "Fees paid" and "Management fees".
- **A cost's sign belongs in its label, not its figure.** The report signs fees as a movement, so "Fees paid −₪1.00" read as a refund. The row now shows `abs()`; Gains keeps its sign, because there the direction _is_ the information. **Ask per row whether the sign carries meaning or just bookkeeping direction.**
- **The cumulative figures came back out the same session they went in, and the owner's reason generalises.** "Contributed ₪26,447 across 2 reports" is only ever the sum of the reports you happen to have imported — _"it's confusing if someone joins Moni with already existing data"_. Same call as `projectedSpend` on 2026-08-04: **when a number's problem is that it isn't trustworthy, no caption rescues it**, and here the trustworthy version already existed one disclosure away under Reports. The hero is now balance → trend → fees and nothing else. Worth noticing that the _caveat I was proud of_ ("some periods have no report") was the tell: a figure that needs to disclaim itself on every render is a figure that shouldn't be there. The per-report differencing stayed — it feeds the Reports table and is exact.
- **"What does this label mean?" is a bug report.** The Reports table tagged undifferenced rows "year to date". It was accurate and useless: it names the _mechanism_ (the statement restates from January) rather than the _consequence_ (this row's ₪19,371 is nine months, not a quarter). Worse, it fired on every Q1 row, where the year-to-date figures already are the quarter and there is nothing to warn about — **a caveat shown when nothing is wrong trains the reader to ignore it when something is.** Now `includesEarlierQuarters`, computed in the domain, and the words say the cost. A report with no stated quarter counts as wider, since a caveat shown in error is cheaper than one withheld.
- **`next dev` refuses to start at all when another dev server is running — even on a free port.** It prints the port it wanted, then `⨯ Another next dev server is already running` and exits; `curl` on the new port fails while the _old_ server is still serving your worktree happily. Check `lsof -p <pid>` for the existing server's cwd before starting a second one; if it's your worktree, just use it.

### 2026-08-05 — long-term savings UI (issue #77): a shared dialog, and a provider's name in three more places

- **"Confirm rather than design" turned up two things that didn't work.** #77 put the onboarding path out of scope on the assumption it would fall out of the existing connect flow. It didn't: `institution-picker.tsx` enumerates three hardcoded kinds, so a Harel connector was unreachable — the feature had no way in at all — and once the group was added, the connect flow told the user _"Create the connection now, then import a Schwab Positions CSV from Investments"_ with a **"Create Schwab connection"** button. That is the 2026-08-01 "don't name a shared surface after one provider" note recurring in three new files (`connect-flow.tsx`, `connect-form.tsx`, and the connect page's own subtitle). **When an issue says a path should already work, click it — the confirmation is the deliverable.**
- **A long-term savings account is named `<provider> <document>`, so `title === source` never fires.** The card read "Harel Quarterly Pension Report / via Quarterly Pension Report". The existing suppression tested equality; it needs `title.includes(source)`. Same bug class as SnapTrade's, one layer subtler.
- **Two Hebrew phrases in one English sentence need one `<bdi>` each.** _"Your pension, קרן השתלמות and קופת גמל, from the reports you import"_ rendered with the two terms **swapped** — the English "and" between them got absorbed into a single RTL run. Wrapping the whole line, or trusting the string because it looks right in the editor, does not work. Caught only by zooming the rendered subtitle.
- **Subtotals belong in the domain layer, not the page.** Grouping assets by liquidity horizon needs an ILS figure per group, which needs the FX rule net worth already uses (BOI observation ≤7 days). Summing in the server component would have been money arithmetic at the display edge; instead `usableIlsRate` moved out of `dashboard.ts` into `src/domain/ils-rate.ts` and both callers share it — two ILS totals derived by two rate rules are two numbers the user cannot reconcile. The group also reports `unvaluedCount`, so a subtotal smaller than the cards above it says why.
- **A callout that fires on every visit gets the app closed.** The fee row states the rates quietly and promotes itself to an amber callout **only** when the member is above the fund average. Because that callout owns the view's accent when it shows, "Import document" is `variant="outline"` — same yielding rule as the dashboard's reminder card.
- **Verifying the loud branch meant editing the DB.** The real report is below average, so the callout was unreachable. `fee_rate_deposit` is a plaintext `numeric`, so a superuser `UPDATE` shows it without touching ciphertext — `DATABASE_URL_MIGRATE`'s role is RLS-bound and silently updates **zero rows**, which looks exactly like a failed query. Restore the value afterwards.
- **`file_upload` can only reach files the session may read.** `~/Downloads` is refused; copying the PDF into the session scratchpad first works, and that is how the import was exercised end to end rather than simulated.
- **The dev server was already on :3000 (another session) and quietly took :3002.** Read the startup line rather than assuming the port.

### 2026-08-04 (later) — the budget history tab: an estimate is not a fact, and grouped bars are one group

- **The owner cut a feature rather than reword it.** The hero read `27 days left · on track for ₪4,500.00`, and the fix on offer was better wording. Their answer: _"I'm concerned this 'on track' prediction isn't really valid, it's just an estimate. I suggest we drop it."_ `projectedSpend` is gone from `BudgetMonthView` entirely — the domain field, the computation, and its tests. **When a number's problem is that it isn't trustworthy, no label rescues it.** The hero now states days-left and nothing more; the pace signal still lives on the Everyday rows, where a marker means something.
- **`maxBarSize` is the wrong instrument for fat bars in a grouped chart.** Three series across three months filled the whole plot. `maxBarSize={28}` shrank the bars but Recharts keeps each bar centred in a slot it no longer fills, so the group floated apart into three unrelated columns. The space belongs _between_ categories: drop `maxBarSize`, set `barCategoryGap`. It is also far more aggressive than it reads — `"45%"` gave ~10px bars where the 10% default gave ~60px; `"25%"` was right. **Tune it in the browser; you cannot compute it.**
- **A suggestion the API would reject is a broken button.** The "Ceilings worth revisiting" rows offer a one-click "Lower to ₪X". A residual line with a ₪2,000 ceiling and zero spend produced `Lower to ₪0.00` — and `PositiveAmount` in `src/app/api/budget/schema.ts` refuses a ceiling of zero, so the click would have 400'd. Kept the row (the finding is true and useful) and replaced only the button with a plain "Never used": lowering to zero isn't a ceiling, it's `endCeiling`, a different action. **Whenever a component proposes a value to a validated endpoint, check the proposal against that endpoint's own constraints.**
- **Two baselines in one sentence read as a contradiction.** The verdict line compares the average to the ceiling in force _now_, while "over budget in N of them" counts against each month's _own_ ceiling. With an unchanged ceiling they agree; right after an edit they look wrong. Fixed with two words — "at the time" — rather than by dropping one of the numbers.
- **Recharts tooltip position needs a second screenshot, again.** The first frame after hovering Jul put the tooltip next to May. It was mid-animation; the next capture was correct. Same note as the donut (2026-08-01) and the area chart (2026-08-03) — this is now three for three, so **never file a Recharts bug off one frame.**
- **The dataviz skill's lightness band fails Moni's own tokens, and Moni wins.** `validate_palette.js` on teal/coral/blue (`chart-2/3/4`) FAILs "Lightness band" while passing chroma, CVD separation (ΔE 9.6 deutan), normal-vision (26.6) and contrast. The band is the skill's default-palette parameter, not a universal; `globals.css` is the token source of truth here. **Run the validator for the CVD and contrast checks — those are real — and expect the band to complain.**
- **Verification needed the seed backdated, and it is easy to leave litter.** dana's ceilings all start 2026-07, so the window was a single month. Shifting `effective_from` on the _existing_ rows works where inserting new ones does not — `encText` binds the ciphertext to `(id, column, version)`, so a copied amount under a fresh id will not decrypt. Two traps on the way back: `effective_from` is a `date`, and a `pg` readout renders it in local time, so `2026-06-30T21:00Z` is **2026-07-01** — restoring the printed string is off by one. And editing a ceiling through the UI _creates_ a row for the current month if none existed, which the seed then keeps.

### 2026-08-04 (last) — the residual ceiling: a value import from `@/domain` broke the page

- **A `"use client"` component may import _types_ from `@/domain`, never _values_.** Adding `import { RESIDUAL_KEY } from "@/domain/budget"` to `budget-screen.tsx` pulled `src/db/client.ts` and then `pg` into the browser bundle, and every request 500'd with `Can't resolve 'util/types'`. Types are erased; runtime constants are not. The fix is the pattern `src/lib/recurring/range.ts` already documents — the constant lives in `src/lib/budget/residual.ts` and the domain re-exports it for server callers. **The import trace in the Next dev log names the exact chain; read it before guessing.**
- **Money that moves must be seen to move.** Dropping a category in the wizard now adds its amount to the "Everything else" line, so the budgeted total is unchanged by the removal. Watching ₪150 leave Public Transport and arrive in the residual is what makes the residual's purpose obvious without a paragraph explaining it.
- **Don't show the same money in two places.** Once an "Everything else" ceiling exists it is an ordinary Everyday row, so the standalone "Unbudgeted spending" card is suppressed and the hero's "a further X went to categories with no ceiling" line was deleted outright. That card is now the place the residual is _offered_, not a second display of it.
- **No link is better than a link that lies.** Every budget row drills into `/transactions?category=…`; the residual has no single category, and no filter expresses "whatever no other ceiling reaches". It renders as plain text with a muted "everything not budgeted above" gloss instead.
- **Editing a migration in place needs both databases pushed.** Drizzle records migrations as applied by filename, and the test harness (`tests/db/setup-test-db.ts`) keeps its own applied-files table — so an edited `0023` re-runs for neither. `DROP DATABASE moni_test WITH (FORCE)` as the superuser (`TEST_SUPERUSER_URL`, not `DATABASE_URL_MIGRATE` — the app role doesn't own it) rebuilds the test DB; the dev DB needs the ALTERs applied by hand.

### 2026-08-04 (later) — the budget planner (issue #69): a question with no way to say yes

- **The affordance has to match the question.** The empty state asked _"Create a budget from your existing history?"_ and then offered pills labelled `Last 3 months` / `Last 6 months`. Clicking one _was_ the yes — and with only three months seeded, exactly one pill rendered beside "Set ceilings manually", so there was visibly nothing to agree to. The owner's report: _"I see 'Create a budget from your existing history?' but nowhere to choose 'yes'."_ One primary **Plan my budget** button now answers the question; the window became a detail inside the flow. **When a control's label names a parameter, it cannot also be the answer to a yes/no question.**
- **Split a wizard by the kind of question, not to shorten a form.** Fixed costs are near-certain and get _confirmed_; everyday spending is a judgement and gets shown against the months it came from; income is the verdict on both. Three steps, one Card, `Step N of 3 · <what>` headings, Back left / forward right in a footer rule.
- **A mean nobody can see behind is just an assertion.** Everyday rows carry one small bar per month of the window plus Tight / Typical / Roomy chips priced from the user's own cheapest, mean and dearest months — never an invented percentage. Bar heights are the only floats; every figure still goes through `<Money>`.
- **Round a proposed number at the display edge, and round it up.** The wizard first pre-filled `1242.68333333` into an input. The domain is forbidden from rounding (`money-and-currency.md` §3), so `roundCeiling` lives in the component — up to the next ₪10, because a ceiling rounded _down_ is one the user's own history already breaks.
- **A projection must not extrapolate a lump.** The new hero card read _"on track for ₪34,875"_ on the 4th, because ₪4,500 of rent paid on the 1st got scaled by the fraction of the month elapsed. Fixed costs are now counted once at what they have already cost, and only everyday spending is extrapolated. Same reasoning retired the hero's pace marker: the total includes rent, which is 100% spent on day one by design — exactly why Fixed rows never had one.
- **Two figures side by side must be comparable.** The hero it replaced showed Planned (`income − ceilings`, assuming every ceiling is spent to the brim, budgeted categories only) against Actual (`income − everything that left`). Different universes, and a part-finished month against a whole month's plan reads euphoric on the 4th. **When the owner says a card is "confusing", check first whether its two halves are even measuring the same thing.**
- **Re-seeding logs you out, and `/login` will not show while a stale session cookie exists** — it redirects to `/onboarding` for a user that no longer exists. `POST /api/auth/logout` first, then log in.
- **Identical demo months teach nothing.** Every seeded month had the same grocery amounts, so Tight / Typical / Roomy were one number three times. `MONTHLY_SPEND` now varies per month, and the seed derives a partial **current** month so the budget page — whose whole subject is the month you are in — doesn't open empty.

### 2026-08-04 — the budget page (issue #69): a bar's colour is a fact about the numbers, not about its own width

- **A progress ratio cannot decide "over budget" once rollover exists.** `BudgetBar` computed `ratio = spent / available` and called it over when `ratio > 1`. With rollover on, a carried deficit drives `available` to zero or below — Groceries showed ₪581.40 spent against a ₪300 ceiling with −₪562.80 carried in, so the row said "₪844.20 over" in coral **next to a full teal bar**. The guard `available > 0 ? spent > available : spent > 0` fixes it. **Whenever a denominator can legitimately reach zero, decide the state on the operands and use the ratio only for geometry.**
- **An empty state on a past month must not offer to create things.** `/budget?month=2026-07` rendered the whole "Create a budget from your existing history?" flow, because "no ceiling in force this month" and "no budget at all" are the same boolean. Accepting it there would have backdated ceilings the user never lived under. The setup flow is now gated on `isCurrentMonth`, and a finished month with no ceiling says so instead. **A view that is parameterised by time needs its empty states parameterised too.**
- **A `Number()` in a UI component is fine when it produces a CSS width.** The money-at-the-edge rule is about _rendered_ values; a bar width is never read as a figure. Said so at the call site so the next reader doesn't "fix" it. The genuinely risky version — client-side money arithmetic — was avoided by returning `available` (`ceiling + carriedIn`) from the domain layer as an exact string rather than adding two Money values in the component.
- **`{"Total budgeted "}` survived Prettier.** The 2026-07-26 Turbopack space-eating trap did not recur, because every mixed text/expression line here is written as its own string expression from the start. Worth keeping as the default habit rather than a fix applied after seeing the bug.
- **Named a state variable `chosenWindow`, not `window`** — the 2026-07-29 note, applied preemptively.
- **Verification needed data the seed doesn't have.** The demo seed's newest entry is July while "today" is August, so every current-month figure is ₪0 and the interesting states (over budget, carried deficit, pace) are unreachable from a fresh seed. Backdating ceilings to May via `fetch` from the page console — the session cookie is already there — put real spend under real ceilings without touching the seed script. **When a feature's interesting states depend on the current month, expect the seed to be the blocker and drive the API from the page rather than editing fixtures.**

### 2026-08-03 (later) — the history graph (issue #37): a share of a portfolio is not a portfolio's worth

- **"How did my money change" is a money axis, not a percentage axis.** The graph was a 0–100%
  stacked composition and the owner called it _"completely wrong"_. A 100%-stacked chart has a flat
  top edge by construction, so the one question the screen exists to answer — what is this worth,
  and is it going up — was the one thing it could not show. Plotting the ILS value instead keeps
  every other affordance (the Holding/Account switch, the stack, the brush, the tooltip) and simply
  makes the stack's top edge the portfolio's worth. **When a chart is "wrong" but the numbers are
  right, suspect the axis before the data.**
- **The y-axis label and the tooltip are different jobs.** An axis has room for `₪800K`, not for
  `₪689,366` — `Intl.NumberFormat` with `notation: "compact"` on the ticks, exact strings in the
  tooltip and the summary. The `width={64}` on `<YAxis>` is needed or the ticks clip.
- **A week before the first snapshot is not a week worth ₪0.** As percentages, the year of empty
  weeks ahead of the first sync was invisible; as money it drew a flat line along zero and made
  "valuation change" read `+₪689,366 · 0%` — the whole portfolio appearing from nothing.
  `getPortfolioHistory` now skips leading weeks with no evidence at all. **Changing how a value is
  drawn can expose a data-shape bug that the old encoding was hiding.**
- **Re-screenshot a Recharts area before believing it.** Twice this session the first frame showed a
  sliver at the left edge that looks exactly like a broken dataset; it is the grow animation. Same
  note as the donut on 2026-08-01.

### 2026-08-03 — accounts & investments follow-ups (issue #37): a pipe is not a brokerage

- **Never show the user a connector id.** The Accounts page rendered "snaptrade (EE23)" and
  "ibkr_flex (3443)" because `resolveAccount` named the account `${source} (${last4})` and set
  `institution` to the source id. The user's words: _"A user doesn't need to see 'Snaptrade' in his
  accounts — he should see 'Schwab'."_ Two halves to the fix: `ConnectorDefinition.institutionLabel`
  for direct connectors (ibkr_flex → "Interactive Brokers"), and the payload's own
  `institution_name` for an **aggregator**, which by definition can reach many brokerages and so
  cannot be named from the registry. `institutionDisplayName(institution, connectorId)` in
  `lib/connectors/registry.ts` treats any stored value that `isConnectorId()` recognises as unset —
  that's what corrects rows written before the fix **without waiting for a sync**.
- **"Connection" and "account" are different nouns and the card has to say so.** The account is the
  title ("Interactive Brokers"); how Moni reaches it is a muted provenance line ("via Interactive
  Brokers Flex · •••• 3443"). Suppress the provenance when it would repeat the title — an
  un-synced SnapTrade account has nothing but the connector name, and "SnapTrade / via SnapTrade"
  says one thing twice.
- **"Balance unavailable" was structural, not missing data.** An investment account has no
  `current_balance_ct` — its worth is derived from holdings — so the card had nothing to read.
  `listInvestmentAccountValues` gives one ILS figure per account, deliberately narrower than
  `getPortfolioOverview`. Base currency wins over native: the number has to tie out against the
  dashboard.
- **The hover glow was reused exactly as documented** — `.card-link` wrapper + `.card-glow` +
  `.card-glow-top`, and **only** on investment cards, because they're the only ones with a detail
  view. `h-full` on the Card, or a linked card in a grid row is shorter than its unlinked neighbour.
- **A single-select `expanded` state cannot express "Expand all".** It was `useState<string | null>`;
  the button is only expressible once it's a `Set`. The button also flips to "Collapse all" when
  everything is open, and hides entirely below two connections.
- **A hero figure and its own components must not read as siblings.** `Cash ₪1,343 · US$437.54 USD ·
₪6 ILS` was correct arithmetic (the ₪1,343 is the ILS conversion of the other two) and still read
  as three cash piles. Dropping the converted total fixed it — the portfolio total above already
  carries that number. **When a line lists parts, don't lead it with the whole.**
- **Don't offer a control whose dialog would be empty.** "Import statement" showed with no
  `user_mediated_import` connection configured.
- **Diagnostics were the actual deliverable.** Three independent silencers hid every provider call:
  worker stderr was `"ignore"`, the BOI grandchild was `stdio: [...,"ignore","ignore"]`
  unconditionally, and every worker ended in `main().catch(() => {})` which discarded the error
  object. `src/lib/sync-log.ts` is on by default in dev, opt-in in production
  (`MONI_SYNC_DIAGNOSTIC=1`) because the lines name instrument symbols — holdings data this app
  otherwise encrypts. Reconciliation deltas are logged in **basis points, never shekels**, which
  distinguishes an FX spread from a missing component without putting the portfolio's value in a log.
- **Name the reason a rule rejected something, not just that it did.** `selectCurrentComponent`
  returned a bare `fallback: boolean`; it now returns the first failing rule
  (`broker_value_is_newer`, `exchange_not_eligible`, …), and `listTiingoQuoteTargets` logs a reason
  on every `continue`. That is what makes the "quote fallback" badge traceable.
- **Verification hit a real wall: a sync needs a passkey ceremony I cannot perform.** The 423 →
  "Unlock with your passkey" path is owner-only, so anything that only takes effect on the next sync
  (here: the stored account name and the IBKR venue backfill) has to be verified by the owner or
  designed to correct itself at the display edge. Prefer the latter where the stored value is one
  Moni derived itself.

### 2026-08-01 — the investments screen (issue #37): a ticker is the name, and an opaque code is not an error message

- **A holding is identified by its ticker, not its legal name.** The table and the hero donut both
  rendered "VANGUARD MORNINGSTAR TOTAL STOCK MARKET ETF". The fix was in the **domain layer**, not
  the components: `PortfolioHolding` now carries `symbol` and `name` separately and `label` is
  `symbol ?? name`. Because the donut, the history legend, and the table all read `row.label`, one
  change fixed all three — worth checking for that shared-field leverage before editing three
  components. The long name survives as a muted `truncate` second line with a `title`.
- **`capitalize` turns an initialism into a typo.** `instrumentKind` "etf" rendered as "Etf". CSS
  `capitalize` cannot know; it needs a real mapping function. Assume this recurs for any enum shown
  to a user (ISIN, CUSIP, ILS, ETF).
- **A symbol should be a link out.** Tickers now link to `finance.yahoo.com/quote/<symbol>/` with
  `target="_blank" rel="noreferrer noopener"`.
- **The timeframe control belongs under the chart as a draggable window.** Two `<input type="range">`
  labelled Start and End were the wrong instrument — Recharts' own `<Brush>` (as the prototype in
  commit `f57b0fd` already had it) is one control that shows the window _and_ the dates it covers.
  Consequence worth knowing: with a Brush you must pass the chart the **full** data array and let
  `startIndex`/`endIndex` window it. Pre-slicing the array _and_ brushing it feeds the brush its own
  output. Reset the indices to `null` whenever new history loads, since indices into a new range are
  meaningless.
- **A worker's safe failure code is not a user-facing message.** "Last sync failed,
  provider_rejected" told the owner nothing. Workers deliberately emit opaque codes so a provider's
  error text can never carry credentials into a log, which leaves the mapping to advice as a UI
  concern — now `src/lib/sync-error-message.ts`, a dependency-free module so both the connections
  list and the investments screen say the same thing. It decodes IBKR's numeric Flex codes
  (`send_flex_1012` → "Your Flex token has expired. Create a new token…"). **Any new worker error
  code needs an entry there or it surfaces raw.**
- **A button that un-presses while the work continues is worse than no feedback.** The import dialog
  called `setBusy(false)` right after the POST returned 202 — but the POST only _starts_ a worker,
  and the real wait is `waitForSyncRun`. The busy flag has to span the whole promise (`try/finally`),
  and the dialog swaps its whole body for a spinner rather than only disabling the button.
- **Style `<input type="file">` with the `file:` variants.** The native "Choose File" button is
  unstyled and reads as plain text on a dark card; `file:rounded-[var(--radius)] file:border
file:border-border file:bg-muted file:px-3 file:py-1.5` makes it a button.
- **Don't name a shared surface after one provider.** "Import Schwab statement" and a hardcoded
  `?? "Schwab"` fallback assumed the only importer there will ever be. Fall back to
  `getConnectorDefinition(connectorId)?.label` instead.
- **Verifying a busy state without writing data:** stub `window.fetch` in the page so the POST
  returns a fake `syncRunId` and the sync-run poll stays `"running"`. The dialog holds its busy
  branch indefinitely and nothing reaches the database — much better than importing a fixture into
  the owner's dev portfolio just to see a spinner.
- **A Recharts series with its own `data` prop poisons the shared category axis.** The owner reported
  a tooltip showing a date that "doesn't even change when you move the mouse". The cause was an
  `<Area>`-stacked chart carrying one `<Line data={[...]} dataKey={() => 0}>` for "Estimated now":
  a second, 2-point dataset whose categories get concatenated onto the x-axis (Recharts'
  `allowDuplicatedCategory` defaults to `true`), which desynchronizes the tooltip's active index
  from the main series. **The tell is a tick label that isn't in your data** — the axis literally
  rendered "Estimated now" as its last tick. Fix is one dataset for the whole chart; put extra
  series in the shared array as extra keys (the prototype in `f57b0fd` does exactly that with
  `snapshotTotal`/`estimatedTotal`). That phantom line also encoded nothing — a constant `0` on a
  0–100% composition axis — so it was removed rather than restructured.
- **My first diagnosis was wrong and the owner's second report corrected it.** I read "tooltip
  doesn't match the graph" as a date-convention mismatch (the axis showed week _start_ dates while
  the tooltip said "Week ending"), which was real and worth fixing, but it was not what they were
  seeing. **A constant offset and a stuck value are different symptoms — establish which one before
  fixing.** Hovering two known x positions and comparing the tooltip against the tick under the
  cursor settles it in two screenshots.
- **`weekEnding` threw on the estimate label.** Adding a `tickFormatter` to the axis made every x
  value flow through `weekEnding`, including the non-date "Estimated now", so
  `new Date("Estimated nowT00:00:00Z").toISOString()` crashed the page with a `RangeError`. The
  guard now lives in `weekEnding` itself, since the tooltip could have hit it too. **A formatter
  runs over every category, not only the ones you were thinking about.**
- **A first paint of a Recharts `<Pie>` can be a degenerate sliver.** The donut rendered as a flat
  sliver with correct radii but ~6° of sweep, which looks exactly like a data bug. It resolves
  itself; the owner confirmed it renders correctly. **Re-screenshot before investigating a chart
  that looks wrong immediately after load.**

### 2026-07-30 (later) — delete account (issue #31): the confirm flow the Remove button was waiting for

- **The 2026-07-30 rule below was a "not yet", not a "never".** "Don't offer a destructive control with no undo" ended with _"until there's a confirm flow that can say what is lost"_. This is that flow, so the copy enumerates the loss ("your transactions and their history, your accounts and balances, your categories, rules and merchants, and every bank connection along with its encrypted login") instead of asking "are you sure?". The owner chose **password re-entry** over a type-your-email confirmation when asked: a typed email stops a misclick, a password also stops a borrowed session.
- **A destructive control needed a `Button` variant, not utilities through `className`.** First instinct was `variant="outline"` plus `bg-negative/10 text-negative` — which is exactly the 2026-07-28 `cn`-is-a-plain-join trap, since the variant's own `bg-transparent` wins by stylesheet order, not class order. Added `variant="destructive"` (coral outline, hover-fill) to `src/components/ui/button.tsx` and documented the pattern in `ui-and-feel.md` §6. **When a new state needs conflicting utilities, extend the primitive.**
- **Coral has a second meaning now.** §3 says coral = negative amount. `variant="destructive"` makes it also mean "this destroys something". Worth watching: a destructive button next to a coral money value in the same view has not happened yet and would read ambiguously.
- **A destructive control goes in its own card, last.** Putting "Delete account" inside the same Card as the name field would mean the form you use to change your name is also the form that erases you. Two Cards in a `flex-col gap-8`, delete last.
- **`window.location.assign`, not `router.replace`, after destroying the session.** The client router's cached RSC payloads all belong to a user that no longer exists; a soft navigation can render them. A full load is the correct instrument.
- **Verified in the browser, both branches, without harming the dev seed.** Wrong-password error was exercised on `dana@moni.demo` (it refuses, nothing is deleted). The success path used a throwaway user created via `POST /api/auth/signup` with `signupToken: dev-signup-token`, then confirmed at the DB that the throwaway was gone, `dana@moni.demo` still had its 26 entries / 3 accounts, and no owner-scoped table held an orphan row. **When verifying a destructive flow, sign up a throwaway rather than clicking it on the seed account.**
- **The dialog primitive already anticipated this.** `dialog.tsx`'s open-focus fallback comments mention "a delete confirmation" and skipping the Close button — it landed focus on the password field with no changes needed.

### 2026-07-30 — passkey unlock (issue #7): a password field became a button, and a config throw broke the build

- **Removing an input can remove a whole step.** The Moni-password field disappeared from the connect form, the connection-edit form, and the arm prompt — bank credentials are now unlocked by a passkey, so there is nothing to type. The arm prompt went from a `<form>` with an `Input` to a single outline `Button` with a `KeyRound` icon and a spinner while the ceremony is open. The 423 handling that used to surface as "Wrong password" now shows the ceremony's own message, which is the only thing that distinguishes "you cancelled" from "this deployment moved and your passkey is bound to the old domain".
- **A prerequisite goes above the thing it gates, not below it.** `PasskeyManager` sits above `ConnectionsList` on Settings › Connections: with no passkey there is no key to encrypt a bank login under, so it is the precondition, not a footnote. It owns that view's amber **only while nothing is enrolled** (`variant={none ? "primary" : "outline"}`) — once a passkey exists, "Add connection" is the primary action again, so the amber moves rather than duplicating. Per the per-view accent rule, "Add connection" was demoted to `variant="outline"` because the empty-state passkey CTA outranks it.
- **Don't offer a destructive control with no undo.** `PasskeyManager` deliberately has no "Remove". With no recovery path for CK, a Remove button beside the last passkey is a one-click way to destroy every stored bank login. Listing without removing is the honest shape until there's a confirm flow that can say what is lost.
- **`throw` at module load in a `lib/` file fails `next build`, not just a bad request.** `webauthn-config.ts` validated `MONI_WEBAUTHN_RP_ID` at import — correct-looking, and it broke the build: "Collecting page data" imports every route module in an environment that legitimately has no runtime env, so the build failed instead of the misconfiguration. Fixed by validating on first _use_ and memoizing (`relyingParty()`), which keeps the loud failure exactly where it matters (first passkey request) without making a build depend on deployment config. **Any env validation that throws must be lazy if a route module imports it.**
- **The gates all passed with the build broken.** typecheck, lint, format and 386 tests were green while `npm run build` failed outright. CI runs `build` as a fifth step for exactly this reason — run it locally too whenever a change adds module-level side effects.
- **Not visually verified by me.** The owner took the browser pass this session. Worth checking specifically: the onboarding passkey step (first screen a new user sees now), the Settings › Connections stack order and where the amber lands with 0 vs 1 passkeys, and the arm button's spinner state while a biometric prompt is open.

### 2026-07-29 (later) — the recurring tab (issue #15): icon toggles over Switches, and a disable comment that disabled nothing

- **A per-row boolean is an icon toggle, not a `Switch`.** The recurring flag needed a control on every
  category _and_ every subcategory — the shipped set puts Salary under Income, so a group-level flag
  would drag refunds and dividends in with it. `Switch` is amber "on", and a two-column grid of ~20
  groups would have put dozens of amber tracks in one view. A `Repeat` icon that goes `text-primary`
  when set is the same signal at a fraction of the weight, matching the category picker's
  `text-primary` check. **The per-view accent rule scales with row count — check how many instances a
  control will have before reaching for an amber primitive.**
- **`// eslint-disable-next-line` with a wrapped description disables nothing.** The waiver for
  `@next/next/no-img-element` in `merchant-icon.tsx` had its justification spilling onto a second
  comment line, so "next line" pointed at the comment rather than the `<img>`. Lint still reported the
  warning and it read as a phantom. Put the reason on the lines _above_ and the bare disable directive
  immediately before the element.
- **Don't name a state variable `window`.** `const [window, setWindow]` in a row component sat a few
  lines from a `window.location.search` read in the same file. Renamed to `paymentWindow`.
- **A raw domain string is not a rendered money value.** The average rendered as `avg 51` because the
  JSX interpolated `row.averageOfLast3.amount` directly instead of passing the `Money` value to
  `<Money>`. The domain layer hands over exact decimal strings precisely so the edge formats them —
  interpolating one into JSX silently skips the currency symbol and grouping.
- **Verification fell back to curl.** The Chrome extension wasn't connected this session, so the visual
  pass didn't happen. `curl` with a cookie jar from `POST /api/auth/login` still catches the class of
  bug the gates miss — it renders the page server-side, so a client component importing a runtime value
  from `@/domain/**` would 500 exactly as it would in the browser. It does **not** catch layout, bidi
  or hover problems. `/transactions/recurring` and both new endpoints were exercised this way;
  **the tab has never been looked at.**
- **Fixture notes, again the same two.** `seed-demo.ts` still creates no `connections` rows, so
  `requireOnboarded()` bounces `/transactions/*` → `/onboarding`; one throwaway row fixes it, and
  `connections` has **no `label` column** — it is `display_name`. Also `npm run db:migrate` printed a
  spinner and appeared to finish while having applied nothing; the seed then failed on the missing
  column. Re-running it applied cleanly. **Check a migration landed by querying for the column, not by
  reading the spinner.**

### 2026-07-29 — the transactions table (issue #14): sticky headers, and a client import that shipped Postgres

- **A runtime value imported from `@/domain/**` into a `"use client"` component pulls `pg` into the
  browser bundle.** The toolbar imported one constant (`NO_CATEGORY`) from `@/domain/transactions`;
  Turbopack followed it to `src/db/client.ts` and the page died on `Can't resolve 'dns'/'net'/'tls'`,
  white screen, six module-not-found errors. **Types are erased and safe to import from the domain
  layer; constants are not.** The fix is a `lib` module both sides can import
  (`src/lib/transactions/filters.ts`). Typecheck, lint and the test suite were all green with this
  bug in place — only loading the page found it. Assume this recurs the next time a client component
  needs a shared enum or sentinel.
- **A sticky `<th>` loses its bottom border under `border-collapse: collapse`.** A cell's border
  belongs to the collapsed border grid, not the cell, so it does not travel with the sticky element:
  the header floats over the rows with no rule under it the moment you scroll. Fix is
  `border-separate border-spacing-0` on the `<table>` — at which point a border on a `<tr>` renders
  nowhere, so `divide-y` on `<tbody>` stops working and the row rules have to move onto the `<td>`s
  (`[&>tr:last-child>td]:border-b-0` drops the last one). Verified by toggling `borderCollapse` live
  in the console and re-zooming.
- **Diagnose sticky-header artifacts with `elementFromPoint`, not with your eyes.** The half-scrolled
  row peeking below a sticky header looks exactly like a background-painting bug and is not one — it
  is just the part of the row below the header's bottom edge, which is correct. One
  `document.elementFromPoint(x, th.bottom - 6)` returning the `TH` settled it and stopped a wrong fix.
- **Six filter controls do not fit on one line.** A single `flex-wrap` row orphaned "Max amount" onto
  a row of its own with a wide gap beside it. Two deliberate rows read better than one wrapping one:
  search + category (what to look for), then from/to/min/max (how far to look), with "Clear" pushed to
  `ml-auto` on the first row. Also **cap the search field's wrapper** (`max-w-sm` on the flex child,
  not on the `Input` — `cn` is a plain join and the primitive's own `w-full` would win) — `flex-1`
  stretched it to ~860px, the same empty-measure problem as the 2026-07-26 helper-text note.
- **A scoped filter has to admit its scope.** Payee and amount are ciphertext, so search and
  amount-range only cover the rows already fetched. The table prints "Search and amount filters cover
  only the N most recent transactions in this range" **whenever the window is full**, and stays quiet
  when it isn't — a caveat that is always on is noise, and one that never appears is a lie.
- **An `<option>`'s leading plain whitespace is collapsed**, so a flat 100+ category list cannot show
  nesting that way. Non-breaking spaces work and now carry a comment saying why, since they look like
  a typo.
- **Fixture notes that cost time again**: the dev DB was empty (`db:migrate` + `seed:demo` needed),
  and `seed-demo.ts` creates **no `connections` rows**, so `requireOnboarded()` bounces
  `/transactions` → `/onboarding`. One throwaway `connections` row fixes it — superuser is
  `postgresql://postgres:postgres@localhost:5432/moni` (`DATABASE_URL_MIGRATE`'s role is RLS-bound and
  silently returns zero rows), `status` must be one of `active|error|disconnected`. And re-seeding
  mid-session invalidates the browser session, which presents as a redirect to `/login`.

### 2026-07-28 (later) — suggestion chips (issue #2): dashed vs solid, and a money column that drifted

- **A proposal and a fact must not look alike.** The suggestion chip reuses `Badge`'s shape but with
  `border-dashed` and no fill, so "Groceries ✓ ✗" (proposed) reads differently from "Groceries"
  (assigned) at a glance. Verified by zooming a table with both states adjacent — they are
  distinguishable, and the ✓/✗ carry most of the signal.
- **Amber yields again, this time to the money colors.** A table of N rows would otherwise carry N
  amber accents (same rule as the Rules tab's toggles). Accept/reject are muted icon buttons that go
  `hover:text-positive` / `hover:text-negative` — teal already reads as affirmative in this UI, so
  the money palette does the work with no new token.
- **A fixed-width slot is what keeps a money column straight.** On the "Needs categorizing" card the
  row button is `flex-1` and the chip sat beside it at auto width, so a wider category name pushed
  that row's amount left and the amounts stopped lining up between rows. Rows with no suggestion
  were worse — nothing rendered at all, so their amount ran to the full width. Fix: always render
  the slot (`w-44 shrink-0 justify-end`), chip or not. **Whenever a variable-width element sits
  beside a `flex-1` sibling, every number inside that sibling moves.**
- **A chip with its own buttons cannot live inside a row button.** The card's rows were a single
  `<button>`; nesting the accept/reject buttons inside is invalid HTML and swallows the inner click.
  Restructured the `<li>` into a flex row — button for the clickable area, chip as a sibling — and
  moved `hover:bg-muted` up to the `<li>` so the whole row still highlights as one.
- **`stopPropagation` on both click and keydown.** The transactions table's rows are
  `role="button"` with Enter/Space handling, so a chip button inside a cell fires the row handler
  too and opens the dialog behind the action you just took.
- **Bidi in a `title` attribute needs the FSI/PDI characters, not `<bdi>`.** The evidence tooltip
  embeds a scraped Hebrew payee inside an LTR sentence; an attribute cannot hold JSX, so it is
  `⁨`/`⁩` there while the visible chip text uses the element.
- **A dev server was already running on :3000.** `npm run dev` refuses with "Another next dev server
  is already running" and exits 1 — check before assuming a port conflict is yours. Also: the
  browser session survived a re-seed, so `/login` redirected to `/onboarding` for a user that no
  longer had connections. `POST /api/auth/logout` via `javascript_tool` clears it.

### 2026-07-28 — connections UX (issue #4): backfill picker, dashboard sync, honest labels

- **`cn` is a plain join, not tailwind-merge.** Passing `w-auto` to a primitive whose base is `w-full`
  puts both classes on the element and the base wins — the backfill date field rendered full-width.
  Use a `max-w-*` (which beats `width` outright) whenever you need to shrink a primitive, or add the
  size to the primitive itself. This will bite again on `Input` and `Button`.
- **A primary action goes top-right of the page heading row.** "Sync all" on the dashboard sits
  opposite the `<h1>`, `variant="outline"` — the amber stays with the reminder card's own call to
  action when it's showing (one accent per view). The heading row becomes
  `flex flex-wrap items-start justify-between`, so the button wraps under the title on narrow
  viewports rather than crushing it.
- **A setting's label must describe what it does.** "Automatically sync connections on login?" never
  synced anything — it shows an offer after an 8-hour gap, because Moni cannot use a stored bank
  login without the password. Renamed to "Remind me to sync when I sign in", with `CONTEXT.md`
  pinning "sync reminder" as the term. The column is still `auto_sync_on_login`; the comment there
  reconciles the two.
- **Selected-state styling for a pill group:** `border-primary/60 bg-primary/10 text-foreground`,
  unselected `border-border bg-card text-muted-foreground hover:border-primary/50 hover:bg-muted`.
  A 10% amber tint on a small pill is an accent, not a fill — consistent with the Switch and the
  category-picker's `text-primary` check.
- **Ref-clicking a button can focus without activating.** `computer{ref}` on an institution tile
  drew the focus ring but never fired `onClick`; a coordinate click on the same tile worked. When a
  click appears to do nothing, re-click by coordinate before assuming the handler is broken. (Same
  family as the 2026-07-26 note about coordinate-clicking into inputs.)
- **"Nothing for now" belongs in the answer row, not beside it.** The owner asked for a way to add a
  connection without pulling history. It became the first pill under "How far back should we pull?" —
  a legitimate answer to the question — rather than a separate checkbox. Selecting it disables the
  date field (dimmed, `value=""` kept so React stays controlled) and swaps both the step subtitle and
  the helper line. Verified at the DB: the connection lands with `last_sync_at` NULL and **zero**
  `sync_runs` rows, so nothing is scraped.
- **A re-seed mid-session looks exactly like a wrong password.** `POST /api/connections` returned
  "invalid password" for the correct demo password for several attempts. Cause: the DB had been
  re-seeded (new user UUIDs) while the RAM session still held the old `userId`, so
  `unlockCredentialKey`'s RLS-scoped lookup found no unlock method and returned null — the same
  answer as a bad password, by design. Log out and back in before believing an auth failure in dev.
- **Fixture rows again.** The demo account has zero connections, so it redirects to `/onboarding` and
  the dashboard never renders. Two throwaway `connections` rows (superuser SQL, junk `credentials_ct`)
  are enough to render the populated dashboard and exercise the 423 → password-prompt path, since the
  423 is returned before anything is decrypted. Deleted afterwards.

### 2026-07-26 (later) — settings, toggles, and "verify in the browser" means it

**A settings screen means TABS, not one long page of sections.** The first build stacked Profile
and Connections as `<section>`s on `/settings`; the owner meant separate tabs. Now route-based:
`/settings/layout.tsx` holds the heading + `settings-tabs.tsx`, with `/settings/profile` and
`/settings/connections` as siblings and `/settings` redirecting to the first. Route-based beats
client state here — each tab stays a server component reading through the domain layer, and every
tab is deep-linkable (the login sync offer jumps straight to `/settings/connections`).

**A boolean preference is a toggle, not a checkbox.** Added `src/components/ui/switch.tsx` — a
`role="switch"` button, not a restyled `<input type=checkbox>` (which can't become a track-and-knob
without `appearance-none` hacks and loses announced state). Amber track when on, per the
sole-brand-accent rule.

**Put a setting where the thing it governs lives, not where its column lives.** "Automatically sync
connections on login?" was filed under Profile because it's a `users` column. That's the schema's
mental model, not the user's — it governs _these connections_, so it belongs on the Connections tab.

**Cap paragraph measure on full-width cards.** The toggle's helper text ran ~1350px across on a wide
viewport. Only visible in the browser; `max-w-2xl` on the text column fixes it while the toggle
stays right-aligned.

**Don't put a page-level redirect in the shared `(app)` layout.** The zero-connections →
`/onboarding` redirect lived there, which silently locked a new user out of Settings once Profile
moved in. A layout can't reliably know its own pathname in the App Router (`x-invoke-path` is not a
thing to reach for). Each page that truly needs a connection now calls `requireOnboarded()`
(`src/domain/onboarding.ts`).

**Never render a date in a client component.** `new Date(iso).toLocaleString()` inside `"use client"`
is a hydration error: SSR formats with the server's locale/timezone, the browser re-formats with its
own, React sees two strings and throws. The owner hit this on the connections row. Fix: format on
the **server** with an explicit locale (`Intl.DateTimeFormat("en-GB", {dateStyle:"medium"})`) and
pass a finished string across the boundary — the client component then holds no date logic at all.
Numbers are fine (`value.toLocaleString("en-US", …)`) _because_ the locale is pinned; it's the
implicit-locale calls that break. `new Date()` in a server component is fine too.

**Test with a row present, not just the empty state.** This bug was invisible because the account
used for verification had zero connections, so the row never rendered. When a list has an empty
state, insert a throwaway fixture row (superuser SQL) so the populated branch actually renders —
then delete it.

**Browser-verification technique that actually works.** Coordinate-clicking into an input silently
did nothing — the typed name went nowhere and Save wrote an empty value, which _looked_ like a
working save. Use `read_page{filter:"interactive"}` to get a ref, then `form_input` on that ref, and
**confirm the write in Postgres** rather than trusting the UI's own "Saved". Also: after moving or
deleting a route, `.next` type validators go stale and `npm run typecheck` reports phantom errors
about the old path — `rm -rf .next && npm run build` before believing them.

### 2026-07-26 — signup/onboarding/connections build

**Turbopack silently eats a space between JSX and adjacent text on the same line.** When an element
or an expression is immediately followed by plain JSX text on the _same source line_, the separating
space is trimmed away at build time: `<strong>…reset.</strong> If you forget` rendered as
`reset.If you forget`, and `{def.label} login.` rendered as `Bank Hapoalimlogin.`. It does **not**
show up in the diff — only in the browser. Two traps make it easy to reintroduce:

- A bare `{" "}` separator works, but **Prettier re-collapses it back into plain text** when it fits
  on one line, silently restoring the bug on the next `npm run format`. It only survives when
  Prettier already wanted a line break there (e.g. end-of-line, as in `signup/page.tsx`).
- The reliable fix is to make the text **its own JS string expression** — `{"If you forget…"}` or a
  template literal like ``{`Enter your ${def.label} login.`}`` — which no formatter can collapse.
  See `signup-form.tsx` and `connect-form.tsx`, both commented at the site.

**Every login/auth page needs its counterpart link.** `/signup` linked to `/login` but not the
reverse, so a new user landing on `/login` had no way to reach signup. The owner caught it in the
browser, not in review. When you add an auth page, wire the link in _both_ directions.

### 2026-07-25 — dashboard & accounts cards; sparkline hover; clickable stat cards

The owner reviewed the first dashboard/accounts build and gave four notes (all now fixed):

- **Headroom:** cards were cramped — the top border sat too close to the label/icon. Fix: card top
  padding is `pt-6` (`pt-7` on the larger hero card), not a uniform `p-5`/`p-6`. A flush-to-top label
  reads as cramped. **Apply to _every_ card on a view, hero included** — the first pass fixed the
  stat/account cards but missed the Total Net Worth hero card, and the owner caught it. When a
  headroom note lands, sweep all cards, not just the obvious grid ones. (`stat-card.tsx`,
  `account-card.tsx`, dashboard hero in `dashboard/page.tsx`.)
- **Sparklines had no hover values and clipped the hover circle.** Fix: the `Sparkline` component now
  carries a `Tooltip` (month label + `.tabular-nums` value) and an `activeDot`, and uses a non-zero
  `margin` on _every_ side (~6px) so the active-dot ring isn't cut off at the plot edge. Pass
  `labels` + `currency` so the tooltip can format at the chart edge. (`sparkline.tsx`.)
- **Stat cards should feel interactive.** The dashboard Net/Income/Expense cards now: (a) **glow on
  hover** — a subtle violet `box-shadow` + a blue→violet→pink gradient hairline on the top edge — and
  (b) are **clickable links** (Net Worth → `/accounts`; Income & Expenses → `/transactions`). The
  glow is a _documented exception_ to the "no shadows" rule and **means "clickable"** — only put it on
  cards that are links. Styles: `.card-link` / `.card-glow` / `.card-glow-top` in `globals.css`.
- **Positive:** the owner explicitly likes the overall visual language and feel, and confirmed the
  Income-vs-Expenses area chart (which already had a tooltip) works well — keep that direction.

**Taste distilled from this round (apply going forward):**

- Give cards real top breathing room; never let a label/icon touch the top border.
- Any trend line the user can point at should reveal its value on hover, with the active dot fully
  visible (margins!), not clipped.
- A card that navigates should _look_ clickable — reach for the interactive-card glow, and wire the
  link to the matching detail view.

### 2026-07-26 — categorization: first Dialog/Select primitives, and Hebrew bidi

Built the categorize dialog, category picker, "Needs categorizing" card, and the Rules tab. Four
things worth keeping:

- **Hebrew values must be bidi-isolated.** A merchant name rendered inside an LTR technical string
  (`description contains "רמי לוי"`) or beside an LTR badge reorders the surrounding quotes,
  operator, and badge — the line renders visibly wrong while the stored data is perfectly correct.
  Wrap the _value_, not the whole line: `⁨`/`⁩` (FSI/PDI) in a plain string built on the
  server, `<bdi>` in JSX. **No test catches this** — the DB round-trip passes. It only shows up in a
  browser, so zoom in on any view that renders a scraped description. This will recur on every
  Israeli-data surface; assume it, don't rediscover it.
- **A dialog must not open with focus on "dismiss".** The first focusable element in DOM order is the
  header's Close button, so a naive "focus the first control" lands there. `dialog.tsx` prefers the
  first text input, then any control, then the panel.
- **Amber is per _view_, not per component.** The Switch primitive is amber "on" and the Button
  primitive is amber "primary" — fine while they live on separate route tabs (settings does exactly
  that), but the Rules table puts N amber toggles in one view, so "New rule" is `variant="outline"`.
  When you introduce a screen that combines two already-amber primitives, one of them has to yield.
- **Reset-on-prop-change belongs in a `key`, not an effect.** `CategorizeDialog` initializes state
  straight from props and the parent passes `key={selected?.id}`; the `useEffect` version tripped
  `react-hooks/set-state-in-effect`.

Also confirmed in this round: `dateLabel` is now precomputed server-side on `EntryView`
(`Intl.DateTimeFormat("en-GB", { dateStyle: "medium" })`), so `transactions-table.tsx` could become
a client component without the date turning into a hydration error. Any list you make interactive
needs its dates pre-formatted _first_.

### 2026-07-27 (later) — the Categories tab: bidi alignment, dismiss-focus, filtered counts

- **Never put `flex-1` on a `<bdi>`.** Stretching the isolate makes it its own paragraph, so a
  Hebrew name resolves to RTL and aligns to the _far_ edge — stranded across the row from its own
  icon, while the English rows beside it stay left. Isolation was working (the count and buttons
  after it never reordered); only alignment was wrong. Fix: wrap, don't stretch —
  `<span className="min-w-0 flex-1 truncate"><bdi>{name}</bdi></span>`. The isolate sits at the
  start of an LTR box, the Hebrew still orders correctly inside it. Caught only by renaming a
  category to Hebrew in the browser; no test sees it.
- **The dialog's open-focus fallback landed on Close.** `dialog.tsx` prefers a text input, but a
  delete confirmation has none, so the first control in DOM order was the header's Close — exactly
  the "focus on dismiss" the 2026-07-26 entry warned about, resurfacing through the branch that
  entry didn't cover. The Close button now carries `data-dialog-close` and the fallback selector
  excludes it, so a confirm dialog opens on **Cancel** — the safe default for a destructive prompt.
  Tab order is unchanged.
- **A filtered list must not restate its counts.** Searching narrowed "Healthcare — 4
  subcategories" to "1 subcategory", because the header read the _filtered_ array. The header
  states a fact about the category, not about the search. Carry the real count separately
  (`totalChildren`). The same bug had teeth: the delete button was gated on the filtered count, so
  a search that hid every child made a group look deletable when the server would refuse it.
  **When you filter a collection for display, audit every derived number and every enabled/disabled
  state that reads from it.**
- Also worth knowing: `react-hooks/static-components` fires on `const Icon = lookup(name)` — it
  reads any capitalized binding assigned from a call as a component built during render. For an
  icon-map lookup that is a false positive (the components are module-level imports, identity is
  stable); the disable comment has to sit on the **JSX line**, not the assignment.

### 2026-07-27 — a third money color, and the transfer signal

- **`--color-transfer` (blue) is the only sanctioned third money color.** A transfer-classified
  entry (credit-card settlement, internal move) has a minus sign that says _which side of the move
  you're looking at_, not that money was spent — so teal/coral would assert a judgement the figure
  doesn't carry. `<Money transfer>` overrides `signColor`. The domain layer decides
  (`EntryView.isTransfer` ← `src/domain/flows.ts`); a component must never infer it from the
  category name.
- **Verified against real Hebrew scraper data, not the demo seed.** The blue reads clearly beside
  coral rows at normal zoom. Worth repeating: this row is `-₪3,008.98` with an RTL payee, and it
  renders correctly only because the payee is already `<bdi>`-wrapped.
- **A category picker with 61 entries needs its filter.** The unfiltered dropdown is tall enough to
  cover the "Also categorize…" checkbox below it. Typing collapses it immediately, so it isn't
  worth a scroll-container change — but don't add a picker to a _short_ dialog without checking
  what the open list occludes.
