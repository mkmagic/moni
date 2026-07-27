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
