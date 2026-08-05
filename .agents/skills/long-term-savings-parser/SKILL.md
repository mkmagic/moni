---
name: long-term-savings-parser
description: Add a parser for another Israeli long-term-savings report (קרן השתלמות, קופת גמל, another provider's pension) — the file-by-file recipe, the RTL geometry rules, and the seams a new parser plugs into.
---

# Adding a Long-term Savings Parser

The first parser (Harel quarterly pension, issue #76) built the whole path: geometry
helpers → parser → promotion → schema → worker → UI, all of it hardcoded to one
connector. The second (Harel קרן השתלמות, quarterly and annual) opened the seams that
made it plural: a parser lookup, and a normalised report shape the domain layer stores.

A third parser should be **additive** — write the parser, map it to the normalised
shape, add one registry entry. If you find yourself editing the worker or promotion to
accommodate a document, stop and read §7: either the normalised shape genuinely needs a
field, or you are about to re-narrow a seam.

Read alongside: `../../../docs/design/connector-interface.md`, and `../db-schema/SKILL.md`
if the report carries a field the schema has no column for.

## 1. What exists already

| Layer | File | Reusable? |
|---|---|---|
| RTL geometry | `src/lib/connectors/documents/pdf-text.ts` | yes, layout-agnostic |
| PDF → items | `src/lib/connectors/documents/pdf-load.ts` | yes — **the only module that imports `pdfjs-dist`** |
| Parser contract | `src/lib/connectors/documents/types.ts` | yes |
| Reference parsers | `harel/pension-quarterly.ts`, `harel/hishtalmut.ts` | copy their shape, not their labels |
| Normalised report + checks | `src/lib/connectors/documents/long-term-savings-report.ts` | yes — map your parser onto it |
| Parser lookup | `src/lib/connectors/documents/registry.ts` | yes — add one entry |
| Fixture dumper | `scripts/dump-pdf-items.mts` | yes |
| Schema | `src/db/schema/long-term-savings.ts` | yes — one product enum, four tables |
| Promotion | `src/domain/long-term-savings-promotion.ts` | yes — typed to the normalised report |
| Worker | `scripts/long-term-savings-import-worker.mts` | yes — reads the lookup |
| Read layer | `src/domain/long-term-savings.ts` | yes |
| UI | `/long-term-savings`, account cards, import dialog | yes, nothing to do |

**Prefer `harel/hishtalmut.ts` as the model.** It is the parser written *after* the seams
opened, so it shows the shape a third one should take; `pension-quarterly.ts` still
carries the single-connector habits it was written with.

## 2. Start from the fixture, not the code

Get a real report, dump it, redact it, commit only the JSON:

```bash
npx tsx scripts/dump-pdf-items.mts ~/Downloads/report.pdf \
  --redact 'ישראל ישראלי=מיכל כהן' --redact '212159024=000000018' \
  --out tests/fixtures/long-term-savings/<provider>-<product>-<year>-q<n>.json
```

**Never commit the PDF.** This repo is public; a real statement publishes a ת.ז., name,
balance, salary and employer into git history permanently. The dumper throws if a
redaction target survives — trust that, but read the JSON once anyway.

**Get two fixtures if you can.** On Harel the second one (a different quarter) is what
caught a table that spans two pages and a report with no employer column. One fixture
teaches you one layout.

## 3. How the geometry works

Hebrew arrives from `pdfjs` in **logical** order and numbers are ASCII, so there are no
bidi fixups anywhere in the parser. Two rules carry almost everything:

- **A value sits to the LEFT of its Hebrew label, on the same baseline.** That is
  `numberLeftOf(items, label)`. `sameRow` allows ±2.5 units of drift.
- **Table columns are derived at runtime**, never hardcoded: merge the stacked header
  fragments by x-overlap, then assign each cell to the nearest header centre. Column
  order and count differ between providers and even between quarters.

  **Nearest is not sufficient on its own — bound it.** Without a maximum distance, any
  stray glyph on the row (a footnote marker, half a split thousands group) snaps to
  whichever column happens to be closest and is stored as that column's figure.

  **Derive that bound per column, not once for the table.** The pension parser takes
  half the *tightest* pitch anywhere in the table and applies it everywhere. That is
  safe only when the columns are evenly spaced, and the קרן השתלמות deposits table is
  not: its tightest pitch is 57pt, between two wide date columns whose cells are
  near-perfectly centred, while the money columns run up to 79pt apart and print
  right-aligned figures that drift far off centre when the figure is short. A
  single-digit "0" in תגמולי עובד/ת sits 30pt from that column's centre, so the
  tightest-pitch bound rejects a real cell, it arrives `null`, and Zod refuses the whole
  document. Take half the pitch to *that column's own* nearest neighbour instead — same
  meaning ("no further than halfway to the next column"), no flattening. Evidence:
  `tests/fixtures/long-term-savings/harel-hishtalmut-2025-q3.json`, whose derived column
  centres are 483.85 / 426.8 / 368.8 / 303.15 / 226.8 / 147.4.

  **"Derived at runtime" also rules out a page coordinate for the table's edges.** The
  first version filtered the left margin with `item.x >= 100`, which only worked because
  Harel's advice box happens to end at x=80. Bound the body by the leftmost column and the
  derived pitch instead.

  **Not every derived group is a column.** Harel's left-margin advice box has a line
  inside the header band, so it comes back looking like an extra column. Identify the real
  ones by the titles the parser already depends on, and take the pitch from those.

Both live in `pdf-text.ts` and are free of `pdfjs` on purpose — importing them must never
drag the PDF library into a bundle.

## 4. Write the parser

Mirror `harel/hishtalmut.ts`:

- A **Zod schema** per section plus one for the whole report. Zod is the trust boundary:
  let a missing cell arrive as `null` and let Zod reject it. **Never default a missing
  money cell to `"0"`** — a fabricated zero passes every arithmetic check and silently
  understates the member's balance.
- A `DocumentParser<TReport>` export with a stable `id` and an integer `version`. Bump
  `version` whenever output for the same input changes; it is stored per snapshot.
- `recognises(items)` is a **guard, not a router**. The connection already chose the
  parser, so a mismatch means the user uploaded the wrong document — return false and let
  the worker raise `unrecognised_document`.
- A `normalise…(report)` export mapping it to `LongTermSavingsReport`. The checks are
  shared and run off that shape — you do **not** write a check function (§7.2).

  **A check that is recorded but never gates protects nothing.** Promotion gates on the
  balance equation *and* the deposit column totals, at ±₪50 each. The balance equation is
  section ב's own arithmetic and says nothing about the deposits table — for a while the
  table had no gate at all, and a misread cell was stored as fact. Ask of every table you
  parse: which gating check would notice if this were wrong? If the answer is none, the
  table is unguarded however many checks you compute.

  The two mechanisms are not interchangeable. A tolerance catches a *gross* misread (a page
  of rows dropped, a column shifted); a single cell off by a shekel hides under any
  tolerance loose enough not to trip on rounding, and is prevented in the parser by the
  distance bound in §3. Per-row checks stay recorded and non-blocking — that is exactly
  where shekel rounding produces harmless drift.
- **Do not parse the member's name or ת.ז.** They are not stored (#76 D10), and the
  surest way to keep them out of the database is never to produce them.

**Multi-page sections:** iterate *every* occurrence of the section heading and
concatenate, re-deriving columns per page. A totals row usually prints only on the last
page. Reading page one alone truncated Harel's 21-row deposit table to 10 and lost its
totals entirely — and the check that would have caught it never ran, because it needs
the totals.

**A page you cannot read must fail the document, not be skipped.** The same bug came back
one level up: a page whose column header did not match was `continue`d, silently dropping
its rows, and again the only check that could have noticed needed the totals row from the
last page. If the section heading is there, its header must be too.

## 5. Register the connector

`src/lib/connectors/types.ts` — add the id to `ConnectorId`.
`src/lib/connectors/registry.ts` — add the entry:

```ts
harel_gemel: {
  id: "harel_gemel",
  label: "קופת גמל Report",     // the DOCUMENT, not the provider
  institutionLabel: "Harel",    // the provider
  kind: "long_term_savings",
  product: "gemel",
  mode: "user_mediated_import",
  loginFields: [],
},
```

`tests/unit/connector-registry.test.ts` asserts the long-term-savings entries exactly —
add yours there or the suite fails.

**One entry per LAYOUT, not per reporting period.** The instinct is one connector per
document ("quarterly", "annual"), but Harel's quarterly and annual קרן השתלמות reports
are the same layout with sections dropped, so one parser reads both and the user is not
asked to classify the file they are holding. Split only when the geometry actually
differs.

`product` is what decides liquidity, via `LIQUIDITY_BY_PRODUCT` in the promotion module.
That map is **exhaustive over the product enum on purpose**: liquidity varies *within* a
product name (קופת גמל להשקעה is liquid today, קופת גמל לתגמולים is locked to
retirement), so a new product must be a decision someone makes.

The institution picker, connect flow and import dialog all read the registry — a new
entry appears in all three with no UI change. `institutionLabel` is load-bearing in the
picker: long-term savings groups by provider, and the reports live one screen in.

## 6. Make the failure legible

An import has exactly **one** failure path (#76 D9): the run fails, nothing is written,
the user sees a message. That message is the whole feature when something goes wrong, and
it is the part most easily left half-built.

**Every code you can fail with must be in `CODES` in `src/lib/sync-error-message.ts`.**
The fallback there is `CODES[code] ?? code`, so a missing entry does not degrade — it
renders the raw symbol. All five document codes were missing for a while, and a failed
import told the user `balance_check_failed: balance_equation`. `tests/unit/sync-error.test.ts`
now asserts the whole vocabulary maps; extend it rather than adding a code quietly.

Watch the shape of what you write, too. Promotion appends the failing check name
(`balance_check_failed: column_total:severance`), so the lookup falls back to the code in
front of the colon. A new code carrying its own detail needs to keep that shape.

**Name only checks in `sync_runs.error` — never a figure.** It is a plaintext column, and
a drift is a difference of amounts, which is why `balance_drift_ct` is encrypted. D9 asked
for full check detail here; the Tier-1 rule wins, and that deviation is deliberate.

**Reject a file that is not your format at the edge.** The sync route checks the `%PDF-`
magic bytes for `kind === "long_term_savings"` before spawning anything — the browser's
Content-Type is the uploader's claim, not the file's. A non-PDF that reaches the worker is
an opaque crash instead of a sentence.

## 7. The seams — now open, and how to use them

The first two were widened when the קרן השתלמות parser landed. The third is permanent.

1. **The parser lookup exists.** `src/lib/connectors/documents/registry.ts` maps
   `ConnectorId → LongTermSavingsImporter` (`parserId`, `parserVersion`, `recognises`,
   `read`). Add one entry; the worker needs no change. Keep this module out of the Next
   server's import graph — it reaches every parser, and a parser reaches `pdf-load.ts`.

2. **Promotion takes a normalised report.** Write your parser faithful to its own page,
   then export a `normalise…` that maps it to `LongTermSavingsReport` in
   `documents/long-term-savings-report.ts`. Promotion never sees a provider's own shape.

   **Null means two different things, and the boundary is that mapping.** Inside a
   parser's raw shape, `null` means "a cell that should have been read was not" and Zod
   rejects it. In the normalised shape, `null` means "this document has no such concept".
   Never widen a parser's schema to reach the normalised one.

   The checks are shared (`checkLongTermSavingsReport`), not per-parser: the equations are
   identical across products and an absent term is a genuine zero. **That has a cost you
   must pay elsewhere** — on a product with no severance column, `column_total:severance`
   compares 0 against 0 and gates nothing. See §4's rule: a check that cannot fail is not
   a guard. The hishtalmut parser answers this with `UNSUPPORTED_COLUMN_TITLES`, refusing
   a document that grows a column it has no field for.

3. **Columns your document doesn't have.** The schema's deposit row assumes
   employee/employer/severance. A קרן השתלמות report has no severance column and no
   employer column; a self-employed גמל has neither employer nor salary. Prefer a `null`
   in the normalised shape over a new column. When the figure is genuinely new
   information — the annual קרן השתלמות report's `הוצאות ניהול השקעות` rate was, and
   D10 makes an unstored field unrecoverable — that is a migration. A plain nullable
   column on an already-RLS'd table needs no policy change and `drizzle-kit generate`
   handles it (`0027`); use `--custom` only when RLS is involved, following `0026`.

4. **A liquidity date has to come from the document.** `liquid_after` means "liquid from a
   date" and `long_term_savings_details.liquid_from` was never populated until a report
   printed one — the קרן השתלמות section א does (`החל מ- dd/mm/yyyy`). The read layer and
   `src/lib/long-term-savings/labels.ts` already render it. If your product is
   `liquid_after`, parse that date and make it required; the PDF is discarded after
   parsing, so a silently missing one is gone for good.

## 8. Verify

- Unit tests over the fixture: one per section, plus the refusals — a blanked cell throws
  rather than defaulting, a stray number outside the columns is ignored, a page whose
  header did not match fails the document, a date the calendar does not have is rejected.
- A DB test through `promoteLongTermSavingsSnapshot`: end-to-end import, idempotent
  re-import, backfilling an older report leaves the cached balance alone, a corrupted
  balance fails at ±₪50 having written nothing, and rows that no longer sum to the printed
  column totals fail the same way.
- **Mutation-check any test you add for a guard.** Revert the guard and confirm the test
  goes red. A guard test that never fails is worse than none, because it reads as
  coverage. Two real cases, both of which passed against the unfixed parser:

  - The stray-number test: the stray was last in the item array and `row.find` took the
    real cell first.
  - The unsupported-column test, which injects a `פיצויים` header to prove the parser
    refuses a column it has no field for. Placed where a severance column would really
    sit, the injected header *steals cells from its neighbours* — so the document was
    refused for a missing total whether or not the guard existed. **When a guard test
    injects geometry, check that the injection itself is not what causes the refusal.**
    Put the injected column somewhere it captures no cells (outside the table's own
    columns) so the refusal can only come from the guard.

  Scripting this pays for itself: apply each mutation to the parser in turn, run the one
  test file, assert it goes red, restore. Eight guards took one pass and found two dud
  tests.
- Gates: `npm run typecheck && npm run lint && npm run format:check && npm run test`,
  plus `npm run build`.
- **Check the build for the PDF library by SYMBOL, not by the word "pdfjs".**
  `grep -rl "pdfjs" .next/server/` does not come back empty on a clean build and never
  did: `src/app/api/connections/[id]/sync/route.ts` has the word in a comment, and Next
  embeds that comment in a source map's `sourcesContent`. A check that cries wolf on a
  clean tree gets ignored. Use

  ```bash
  grep -rl "pdfjs-dist\|GlobalWorkerOptions\|getDocument" .next/server/   # must be empty
  ```

  Not asserted in CI; `pdf-load.ts` is the structural guarantee and this is the check
  that it held. Worth confirming separately that nothing under `src/` imports
  `documents/registry.ts` — that module reaches every parser, so the day a server route
  imports it is the day containment silently ends.
- Then import a real PDF in the browser via `/long-term-savings` → Import document, and
  confirm the figures against the page.

## 9. Traps already paid for

- `tests/db/setup-test-db.ts` carries a **hardcoded** `MIGRATION_FILES` array. A new
  migration must be added there or DB tests fail with "relation does not exist".
- `tests/db/migrations.test.ts` counts tables and RLS policies; `account-deletion.test.ts`
  demands a fixture row in every owner-scoped table. Both are drift gates — update them.
- A `"use client"` component may import **types** from `@/domain`, never runtime values;
  a constant pulls `pg` into the browser bundle. Display helpers go in `src/lib/`, like
  `src/lib/long-term-savings/labels.ts`.
- Money is exact-decimal strings end to end. Percentages are plaintext `numeric`;
  everything derived from an amount — including the balance drift — is encrypted.
- Anything written to `sync_runs.error` is **plaintext**. Check names only, never a
  figure or a drift.
- Report money is ILS on the page: the sync route skips `valuationCurrency` for
  `kind === "long_term_savings"`, and the import dialog hides the field.
- **A Zod `regex` on a date is a shape check, not a calendar check.** `"31/13/2026"`
  satisfies `/^\d{4}-\d{2}-\d{2}$/` and then fails at the Postgres `date` column, turning
  a misread into a promotion failure. Validate in the parser's `isoDate`/`isoMonth`.
- **`pdfjs-dist` 5.x has no `isEvalSupported` option** — it was removed, and there is no
  `new Function` path left in the worker build. Do not spend a review cycle "hardening" it;
  `enableXfa` already defaults false. Verify against `node_modules/pdfjs-dist/types/` if a
  future review claims otherwise.
- **`decText` returns `null` only when the column is `null`.** A wrong key or drifted AAD
  makes `decryptField` *throw* — it never returns a wrong-but-plausible value. So `?? "0"`
  on a `.notNull()` ciphertext column is unreachable, not a fabricated-zero risk. Worth
  knowing before rewriting read paths to "fix" it.
