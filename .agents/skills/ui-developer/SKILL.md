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

### 2026-07-30 — passkey unlock (issue #7): a password field became a button, and a config throw broke the build

- **Removing an input can remove a whole step.** The Moni-password field disappeared from the connect form, the connection-edit form, and the arm prompt — bank credentials are now unlocked by a passkey, so there is nothing to type. The arm prompt went from a `<form>` with an `Input` to a single outline `Button` with a `KeyRound` icon and a spinner while the ceremony is open. The 423 handling that used to surface as "Wrong password" now shows the ceremony's own message, which is the only thing that distinguishes "you cancelled" from "this deployment moved and your passkey is bound to the old domain".
- **A prerequisite goes above the thing it gates, not below it.** `PasskeyManager` sits above `ConnectionsList` on Settings › Connections: with no passkey there is no key to encrypt a bank login under, so it is the precondition, not a footnote. It owns that view's amber **only while nothing is enrolled** (`variant={none ? "primary" : "outline"}`) — once a passkey exists, "Add connection" is the primary action again, so the amber moves rather than duplicating. Per the per-view accent rule, "Add connection" was demoted to `variant="outline"` because the empty-state passkey CTA outranks it.
- **Don't offer a destructive control with no undo.** `PasskeyManager` deliberately has no "Remove". With no recovery path for CK, a Remove button beside the last passkey is a one-click way to destroy every stored bank login. Listing without removing is the honest shape until there's a confirm flow that can say what is lost.
- **`throw` at module load in a `lib/` file fails `next build`, not just a bad request.** `webauthn-config.ts` validated `MONI_WEBAUTHN_RP_ID` at import — correct-looking, and it broke the build: "Collecting page data" imports every route module in an environment that legitimately has no runtime env, so the build failed instead of the misconfiguration. Fixed by validating on first *use* and memoizing (`relyingParty()`), which keeps the loud failure exactly where it matters (first passkey request) without making a build depend on deployment config. **Any env validation that throws must be lazy if a route module imports it.**
- **The gates all passed with the build broken.** typecheck, lint, format and 386 tests were green while `npm run build` failed outright. CI runs `build` as a fifth step for exactly this reason — run it locally too whenever a change adds module-level side effects.
- **Not visually verified by me.** The owner took the browser pass this session. Worth checking specifically: the onboarding passkey step (first screen a new user sees now), the Settings › Connections stack order and where the amber lands with 0 vs 1 passkeys, and the arm button's spinner state while a biometric prompt is open.

### 2026-07-29 (later) — the recurring tab (issue #15): icon toggles over Switches, and a disable comment that disabled nothing

- **A per-row boolean is an icon toggle, not a `Switch`.** The recurring flag needed a control on every
  category *and* every subcategory — the shipped set puts Salary under Income, so a group-level flag
  would drag refunds and dividends in with it. `Switch` is amber "on", and a two-column grid of ~20
  groups would have put dozens of amber tracks in one view. A `Repeat` icon that goes `text-primary`
  when set is the same signal at a fraction of the weight, matching the category picker's
  `text-primary` check. **The per-view accent rule scales with row count — check how many instances a
  control will have before reaching for an amber primitive.**
- **`// eslint-disable-next-line` with a wrapped description disables nothing.** The waiver for
  `@next/next/no-img-element` in `merchant-icon.tsx` had its justification spilling onto a second
  comment line, so "next line" pointed at the comment rather than the `<img>`. Lint still reported the
  warning and it read as a phantom. Put the reason on the lines *above* and the bare disable directive
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
