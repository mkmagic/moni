---
name: long-term-savings-parser
description: Add a parser for another Israeli long-term-savings report (קרן השתלמות, קופת גמל, another provider's pension) — the file-by-file recipe, the RTL geometry rules, and the seams the second parser has to widen.
---

# Adding a Long-term Savings Parser

The first parser (Harel quarterly pension, issue #76) built the whole path: geometry
helpers → parser → promotion → schema → worker → UI. A second parser reuses all of it
**except** three seams that were deliberately written for exactly one connector and now
have to become lookups. Those are called out in §7; do not treat them as accidents to
work around.

Read alongside: `../../../docs/design/connector-interface.md`, and `../db-schema/SKILL.md`
if the report carries a field the schema has no column for.

## 1. What exists already

| Layer | File | Reusable? |
|---|---|---|
| RTL geometry | `src/lib/connectors/documents/pdf-text.ts` | yes, layout-agnostic |
| PDF → items | `src/lib/connectors/documents/pdf-load.ts` | yes — **the only module that imports `pdfjs-dist`** |
| Parser contract | `src/lib/connectors/documents/types.ts` | yes |
| Reference parser | `src/lib/connectors/documents/harel/pension-quarterly.ts` | copy its shape, not its labels |
| Fixture dumper | `scripts/dump-pdf-items.mts` | yes |
| Schema | `src/db/schema/long-term-savings.ts` | yes — one product enum, four tables |
| Promotion | `src/domain/long-term-savings-promotion.ts` | **widen** (§7) |
| Worker | `scripts/long-term-savings-import-worker.mts` | **widen** (§7) |
| Read layer | `src/domain/long-term-savings.ts` | yes |
| UI | `/long-term-savings`, account cards, import dialog | yes, nothing to do |

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
  whichever column happens to be closest and is stored as that column's figure. Harel's
  parser derives the bound as half the tightest pitch between the table's own columns.

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

Mirror `harel/pension-quarterly.ts`:

- A **Zod schema** per section plus one for the whole report. Zod is the trust boundary:
  let a missing cell arrive as `null` and let Zod reject it. **Never default a missing
  money cell to `"0"`** — a fabricated zero passes every arithmetic check and silently
  understates the member's balance.
- A `DocumentParser<TReport>` export with a stable `id` and an integer `version`. Bump
  `version` whenever output for the same input changes; it is stored per snapshot.
- `recognises(items)` is a **guard, not a router**. The connection already chose the
  parser, so a mismatch means the user uploaded the wrong document — return false and let
  the worker raise `unrecognised_document`.
- A `check…Report(report)` function returning `{ balanceDrift, checks }`.

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
harel_hishtalmut_quarterly: {
  id: "harel_hishtalmut_quarterly",
  label: "Quarterly קרן השתלמות Report",  // the DOCUMENT, not the provider
  institutionLabel: "Harel",              // the provider
  kind: "long_term_savings",
  product: "hishtalmut",
  mode: "user_mediated_import",
  loginFields: [],
},
```

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

## 7. The three seams to widen

These were written for one connector and are the actual work of adding a second.

1. **The worker hardcodes both the id and the parser.**
   `scripts/long-term-savings-import-worker.mts` has
   `connectorId !== "harel_pension_quarterly"` and imports one parser module. Replace with
   a `connectorId → DocumentParser` map (a `documents/registry.ts`). Keep the map in a
   module the worker imports, **not** one the Next server imports, or `pdf-load.ts`'s
   containment leaks.

2. **Promotion is typed to the Harel report.**
   `LongTermSavingsPromotionInput.report` is `HarelPensionQuarterlyReport` and it calls
   `checkHarelPensionReport` directly. The right shape is a normalised report interface
   that each parser maps to, with the check function travelling alongside the parser. Do
   that refactor **when the second parser lands**, not before.

3. **Columns your document doesn't have.** The schema's deposit row assumes
   employee/employer/severance. A קרן השתלמות report has no severance column and a
   self-employed גמל has neither employer column. Nullable columns already exist for
   `employer_ct` and `salary_ct`; if you need another, that is a migration
   (`drizzle-kit generate --custom` for anything with RLS, following `0026`).

## 8. Verify

- Unit tests over the fixture: one per section, plus the refusals — a blanked cell throws
  rather than defaulting, a stray number outside the columns is ignored, a page whose
  header did not match fails the document, a date the calendar does not have is rejected.
- A DB test through `promoteLongTermSavingsSnapshot`: end-to-end import, idempotent
  re-import, backfilling an older report leaves the cached balance alone, a corrupted
  balance fails at ±₪50 having written nothing, and rows that no longer sum to the printed
  column totals fail the same way.
- **Mutation-check any test you add for a guard.** Revert the guard and confirm the test
  goes red. The first version of the stray-number test passed against the unfixed parser —
  the stray was last in the item array and `row.find` took the real cell first. A guard
  test that never fails is worse than none, because it reads as coverage.
- Gates: `npm run typecheck && npm run lint && npm run format:check && npm run test`,
  plus `npm run build`.
- **`grep -rl "pdfjs" .next/server/` after the build must find nothing.** Not asserted in
  CI; `pdf-load.ts` is the structural guarantee, this is the check that it held.
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
