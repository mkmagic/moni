# UI Developer Skill

Build and refine Moni's user interface so it stays visually consistent and matches the
owner's taste. **Authoritative design spec:** @../../../docs/design/ui-and-feel.md (the palette,
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
  is allowed *only* inside a Recharts data array or a chart-tooltip formatter. Never format/round in
  the domain layer, never render a JS float for money.

## Workflow for any UI task
1. Read @../../../docs/design/ui-and-feel.md and the **Feedback log** below.
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

### 2026-07-25 — dashboard & accounts cards; sparkline hover; clickable stat cards
The owner reviewed the first dashboard/accounts build and gave four notes (all now fixed):
- **Headroom:** cards were cramped — the top border sat too close to the label/icon. Fix: card top
  padding is `pt-6` (`pt-7` on the larger hero card), not a uniform `p-5`/`p-6`. A flush-to-top label
  reads as cramped. **Apply to *every* card on a view, hero included** — the first pass fixed the
  stat/account cards but missed the Total Net Worth hero card, and the owner caught it. When a
  headroom note lands, sweep all cards, not just the obvious grid ones. (`stat-card.tsx`,
  `account-card.tsx`, dashboard hero in `dashboard/page.tsx`.)
- **Sparklines had no hover values and clipped the hover circle.** Fix: the `Sparkline` component now
  carries a `Tooltip` (month label + `.tabular-nums` value) and an `activeDot`, and uses a non-zero
  `margin` on *every* side (~6px) so the active-dot ring isn't cut off at the plot edge. Pass
  `labels` + `currency` so the tooltip can format at the chart edge. (`sparkline.tsx`.)
- **Stat cards should feel interactive.** The dashboard Net/Income/Expense cards now: (a) **glow on
  hover** — a subtle violet `box-shadow` + a blue→violet→pink gradient hairline on the top edge — and
  (b) are **clickable links** (Net Worth → `/accounts`; Income & Expenses → `/transactions`). The
  glow is a *documented exception* to the "no shadows" rule and **means "clickable"** — only put it on
  cards that are links. Styles: `.card-link` / `.card-glow` / `.card-glow-top` in `globals.css`.
- **Positive:** the owner explicitly likes the overall visual language and feel, and confirmed the
  Income-vs-Expenses area chart (which already had a tooltip) works well — keep that direction.

**Taste distilled from this round (apply going forward):**
- Give cards real top breathing room; never let a label/icon touch the top border.
- Any trend line the user can point at should reveal its value on hover, with the active dot fully
  visible (margins!), not clipped.
- A card that navigates should *look* clickable — reach for the interactive-card glow, and wire the
  link to the matching detail view.
