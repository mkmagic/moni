# Moni — UI & Feel

**Purpose:** The visual language of Moni, pinned to the actual tokens committed in `src/app/globals.css` so every future coding agent styles new UI consistently instead of improvising a palette. This is the human-readable companion to that file — if the two ever disagree, `globals.css` is the source of truth and this doc should be corrected to match it, never the other way around.

## 1. Feel in one paragraph

Moni reads as a very dark navy, near-black surface — not pure black (a deliberate vision tweak, see `globals.css`'s header comment) — with a single warm amber used sparingly as the brand accent (logo, active nav state, primary buttons) and never as a large fill. Money gets its own signal color, teal for positive/inflow/asset and coral for negative/outflow/liability, independent of the amber accent. Structure comes from hairline 1px low-contrast borders, not drop shadows — cards sit flush against the dark background, separated by a line, not a shadow. Text is Geist; every number (money, dates, quantities) renders in Geist Mono with tabular numerals so columns of figures align. The layout is a fixed left sidebar plus a scrollable card-grid main area — no top bar. **v1.0 is dark-only.** No light mode, no theme toggle; do not build one speculatively.

## 2. Palette

All values below are transcribed verbatim from the `@theme` block in `src/app/globals.css`. Do not invent new tokens or hand-pick new oklch/hex values outside this table — extend the palette only by adding a token to `globals.css` first, then documenting it here.

### Surfaces

| Token | oklch | Hex approx. | Use for |
|---|---|---|---|
| `--color-background` | `oklch(0.145 0.018 265)` | `#0c0e14` | Page background — the very dark navy, not pure black. |
| `--color-card` | `oklch(0.185 0.02 265)` | `#14171f` | Elevated surface: cards, panels. |
| `--color-popover` | `oklch(0.215 0.021 265)` | `#1a1e28` | Popovers, dropdowns, menus — one step brighter than a card. |
| `--color-muted` | `oklch(0.235 0.02 265)` | (no hex given) | Subtle fills: hover states, disabled backgrounds, skeleton blocks. |

### Text

| Token | oklch | Hex approx. | Use for |
|---|---|---|---|
| `--color-foreground` | `oklch(0.93 0.008 260)` | `#e8eaef` | Primary text. |
| `--color-muted-foreground` | `oklch(0.68 0.014 260)` | `#98a0b0` | Secondary text, micro-labels, captions. |

### Lines

| Token | oklch | Hex approx. | Use for |
|---|---|---|---|
| `--color-border` | `oklch(0.28 0.016 265)` | `#252a36` | Hairline borders — cards, table row separators, dividers. |
| `--color-input` | `oklch(0.28 0.016 265)` | `#252a36` | Input field borders (same hairline value as `--color-border`). |
| `--color-ring` | `oklch(0.78 0.15 75)` | (amber, see below) | Focus ring — reuses the amber accent value. |

### Brand accent

| Token | oklch | Hex approx. | Use for |
|---|---|---|---|
| `--color-primary` | `oklch(0.78 0.15 75)` | `#f5a623` | The one amber accent: logo, active nav indicator, primary button. **Used sparingly — never as a large fill.** |
| `--color-primary-foreground` | `oklch(0.2 0.04 75)` | (dark ink) | Text/icon color on top of an amber-filled element (e.g. primary button label). |

### Money signal

| Token | oklch | Hex approx. | Use for |
|---|---|---|---|
| `--color-positive` | `oklch(0.74 0.13 172)` | (teal/green) | Positive amounts: inflow, income, asset value. |
| `--color-negative` | `oklch(0.66 0.19 20)` | (coral/rose) | Negative amounts: outflow, expense, liability. |
| `--color-transfer` | `oklch(0.68 0.12 264)` | (blue) | Amounts that only *moved*: transfer-classified entries, e.g. a credit-card settlement. |

### Charts

| Token | oklch | Hex approx. | Use for |
|---|---|---|---|
| `--color-chart-1` | `oklch(0.78 0.15 75)` | amber | Series 1 — reuses the brand accent. |
| `--color-chart-2` | `oklch(0.74 0.12 172)` | teal | Series 2 — close to `--color-positive`. |
| `--color-chart-3` | `oklch(0.66 0.19 20)` | coral | Series 3 — close to `--color-negative`. |
| `--color-chart-4` | `oklch(0.68 0.12 264)` | blue | Series 4. |
| `--color-chart-5` | `oklch(0.66 0.13 305)` | violet | Series 5. |

Amber is a brand **accent**, not a UI color: reach for it to draw the eye to one thing (the active sidebar item, a primary CTA, the logo) — never to color a card, a table row, or a large surface. If a screen has more than one amber-colored element competing for attention, that's a sign the design misused the token.

## 3. Money color semantics

- **Positive** (inflow, income, asset value) → `text-positive` (teal). **Negative** (outflow, expense, liability) → `text-negative` (coral). **Neutral** (no direction implied — a category label, a non-monetary count) → `text-foreground`.
- **Transfer** (money moved, not earned or spent — the entry's category is classified `transfer`) → `text-transfer` (blue), overriding the sign color. A transfer's minus sign says which side of the move you're looking at, not that anything was spent; teal/coral would assert a judgement the figure doesn't carry. Pass `transfer` to `<Money>`; the domain layer decides via `EntryView.isTransfer` (`src/domain/flows.ts`). This is the **only** sanctioned third money color — it is not a license to add more.
- Every rendered amount carries `.tabular-nums`, which switches the figure to Geist Mono with `font-variant-numeric: tabular-nums` (defined in `globals.css`) so columns of money align regardless of digit width.
- **Formatting and rounding happen only at the display edge, never in the domain layer** — cross-ref `money-and-currency.md` §3/§6. A component receives a value the domain layer already produced as an exact decimal string; it is not the component's job to compute, only to format and color it.
- Money values arriving in a component are always `{ amount: string, currency }`. **Never render a JS `number`/float for money** — if a value shows up as a `number`, that's a bug upstream, not something to `.toFixed()` around in the UI.

## 4. Typography

- **Geist** (`--font-sans`, wired via `next/font`'s `geist/font/sans` in `layout.tsx` as the `--font-geist-sans` CSS variable) is the UI typeface — labels, body text, headings.
- **Geist Mono** (`--font-mono`, `geist/font/mono` → `--font-geist-mono`) renders **all numerals**: money, dates, quantities, percentages — anywhere a column of numbers needs to line up. Apply via `.tabular-nums`.
- Hero numbers (dashboard totals, stat-card headlines) are large, bold, and tight-tracked — the single most prominent element on a card, set in Geist Mono via `.tabular-nums`.
- Stat-card headers and other micro-labels are uppercase, small, and set in `text-muted-foreground` — a quiet caption above a loud number, never competing with it.

## 5. Layout

- **Fixed left sidebar**, colored near-`--color-background` (not a card surface — it recedes rather than floats), holding primary navigation. The active nav item is marked with the amber accent plus a subtle indicator (e.g. a left-edge bar or dot) — not a full amber background fill.
- **No top bar.** Page-level actions and context live in the main content area, not in a persistent header strip.
- **Main area** is a scrollable grid of cards (`--color-card` surfaces, hairline borders) — the dashboard and most feature views are compositions of cards in a grid, not full-bleed custom layouts.
- **Responsive:** the card grid collapses to a single stacked column on narrow screens; the sidebar is expected to collapse/overlay on mobile widths (exact breakpoint behavior is an implementation detail, not pinned here — the invariant is "cards stack, they don't shrink into unreadable columns").

## 6. Component patterns

- **Card** — `bg-card`, `border border-border` (1px hairline), rounded via `--radius` (`0.625rem`). No `box-shadow` for *static* elevation, ever — depth comes from the border and the surface-color step (`background` → `card` → `popover`), not elevation shadows. Card top padding is `pt-6` (not `p-5`) so the label/icon has headroom from the top edge — a flush label reads as cramped.
- **Interactive (clickable) card** — the one sanctioned shadow: a card that is itself a link earns, **on hover only**, a subtle violet glow (`box-shadow`) plus a blue→violet→pink gradient hairline along its top edge, to signal it navigates. Implemented with the `.card-link` / `.card-glow` / `.card-glow-top` rules in `globals.css` (wrap the Card in a `<Link className="card-link">`; give the Card `card-glow relative overflow-hidden` and a `card-glow-top` span pinned to `top-0`). Do **not** apply this to non-interactive cards — the glow *means* "clickable".
- **StatCard** — a Card containing: a small icon tile, an uppercase `text-muted-foreground` micro-label, a large bold `.tabular-nums` number (money or count), and an optional sparkline beneath it. The number is the focal point; everything else is quiet. On the dashboard each StatCard is an interactive card (above) linking to its detail view (Net Worth → Accounts; Income/Expenses → Transactions).
- **Table (dense)** — hairline row separators (`border-border`, not full-cell borders), money columns right-aligned and `.tabular-nums`, negative amounts in `text-negative`. Rows are compact — this is a ledger, not a spreadsheet with generous padding.
- **Recharts style** — area fills use a gradient that fades to transparent (never a flat opaque fill); axes render with `axisLine={false}` and `tickLine={false}`; tick labels use the muted-foreground color; static lines are thin strokes with **no resting dots** on data points; series colors come from `--color-chart-1..5` in table order above.
- **Sparkline** — a trend line *is* interactive: it carries a hover `Tooltip` (label + `.tabular-nums` value, formatted at the chart edge) and an `activeDot` that appears only under the cursor. Give the chart a non-zero `margin` on **every** side (~6px) so the active-dot ring is never clipped by the plot bounds — a zero-margin sparkline cuts the circle off at the edge.
- **Budget bar** (`budget-bar.tsx`) — a 1.5px-tall `bg-muted` track with a fill coloured by state: teal within the ceiling, amber when spending is ahead of the month's pace, coral once it is over. A **pace marker** — a 1px `bg-foreground/60` rule at the fraction of the month elapsed — is drawn on Everyday rows in the current month only; Rent is 100% spent on day one by design, and a marker there reads as alarm rather than information. `Number()` inside this component is display geometry (a CSS width), never a figure anyone reads — every amount around it still goes through `<Money>`. Over-budget is decided on the amounts, not on the drawn ratio: a rolled-over deficit can put the available figure at or below zero, where a ratio says the opposite of the truth.
- **Destructive action** — `Button variant="destructive"`: a coral outline (`border-negative/40`) over a transparent fill, filling to `bg-negative/10` only on hover. Coral here is the one place it does **not** mean "negative amount" (§3) — it means "this destroys something", and the outline-not-fill keeps it from competing with the view's amber primary action. Rules: the trigger lives in its **own Card, last on the page** (never inside the form it would destroy); it opens a confirm `Dialog` that **enumerates what is lost** rather than asking "are you sure?"; and if there is no undo, the dialog also re-asks for the login password. First used by `settings/delete-account.tsx` (#31) — and the reason `PasskeyManager` still has no Remove is that it has no such flow.

## 7. Do / Don't

**Do:**
- Use amber sparingly — one accent per view, reserved for the active/primary element.
- Right-align money in tables and lists; always `.tabular-nums`.
- Use 1px hairline borders (`border-border`) to separate surfaces.
- Color money by direction: teal for positive, coral for negative, foreground for neutral.

**Don't:**
- Format or round money in the domain layer — formatting is a display-edge concern only (`money-and-currency.md`).
- Render a JS float for a monetary value, anywhere in the UI.
- Add drop shadows for *static* elevation — depth is a border + surface-color step, not a shadow. (The one exception is the **hover glow on a clickable card**, above — a signal that it's a link, not resting elevation.)
- Use amber as a large fill (a card background, a full-width banner) — it's an accent, not a surface color.
- Introduce a second brand color — teal and coral are money signal, not alternate accents; amber stays the only brand color.

## Related

`conventions.md` · `money-and-currency.md` · `../../vision.md`
