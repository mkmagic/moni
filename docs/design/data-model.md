# Moni — Data Model

**Purpose:** The core schema — the unified flow ledger, account-value snapshots, and
the Moni 1.1 investment snapshot extension — and how everything else hangs off it.
This is a *design* document: it specifies tables, columns, and the rules that govern
them, not migration SQL.

**Testing & seeding.** See `../../.agents/skills/db-schema/SKILL.md` for the table map, invariant checklist, and the migrate/seed/test workflow.

**Reference lineage.** The shape is adapted from three of the `repos_eval/` projects:
- **Maybe** — the unified ledger idea (one `entries` table with a typed subtype delegate), account subtyping + asset/liability classification, attribute-locking with a source-logged change history, and a one-level-nested rules engine. *Primary architectural model.*
- **Finlynq** — the entered/account/reporting currency trilogy and the `*_ct` ciphertext-column convention. We adopt the trilogy but **reject Finlynq's float money** (exact decimal only) and **refine the reporting leg** (see §4).
- **Securo** — per-transaction installment metadata and credit-card billing-cycle fields (`statement_close_day` / `payment_due_day`). Directly relevant to Israeli תשלומים.

---

## 1. Overview
Moni's ledger is a **pure flow ledger**: every row in `entries` is a *delta* — money moving (income, an expense, later a trade). **Absolute account state is never stored in the ledger**; it lives in the separate `account_balance_snapshots` aggregate and its subtype children. Keeping flows and snapshots physically apart is deliberate — mixing a "this is a −₪120 expense" delta and a "this account is worth ₪43,000 right now" absolute in one summable column is a corruption waiting to happen, and doubly so in an AI-native app where a model may write aggregation queries.
Five rules cut across every table below; each entity section assumes them rather than repeating them:
1. **Ownership + isolation.** Every user-owned table has an `owner_id` and is protected by Postgres Row-Level Security, **plus** a composite `(owner_id, id)` foreign-key backstop so cross-tenant linkage is impossible even if RLS is bypassed (§2).
2. **Encryption split.** Tier-1 sensitive values (amounts, descriptions, counterparties, account numbers, notes, credentials) are stored encrypted as `*_ct` columns; structural columns (ids, owner_id`, currency codes, dates, `category_id`, account type`) stay plaintext so SQL can still filter and group (§2, cross-ref `encryption.md`).
3. **Rate locked, reporting derived.** The FX *rate* for a flow is locked at its transaction date and stored; the *reporting amount* is **derived on read** (`entered × locked_rate`), not persisted (§4).
4. **Flow vs. snapshot separation.** `entries` = deltas;
   `account_balance_snapshots` plus subtype children = absolute account state. Never
   mix the two in one summable column (§1 above, §4).
5. **Aggregate in the app tier.** You cannot `SUM`/`GROUP BY` ciphertext, so dashboards narrow on plaintext structural columns, decrypt the narrowed set, and aggregate in memory with `decimal.js`. **v1.0 persists no rollups** (§4, §6).
---
## 2. Conventions (apply to every table unless stated otherwise)
- **Identity.** `uuid` primary keys, `gen_random_uuid()` default.
- **Ownership / RLS.** `owner_id uuid not null` references `users(id)`. An RLS policy enforces `owner_id = current_setting('app.user_id')::uuid`; the app connects as a role that is *subject* to RLS. The domain layer sets `SET LOCAL app.user_id` per request/transaction. Public market-reference tables such as `fx_rates` are the only exceptions — no `owner_id`, readable by all, and written only through the domain layer. Instruments are user-owned rather than global because a plaintext user→security relationship would disclose a holding.
- **Composite tenant-FK backstop.** Every user-owned parent table carries a `UNIQUE (owner_id, id)` constraint. Every child foreign key is **composite and includes `owner_id`** — e.g. `entries (owner_id, account_id)` references `accounts (owner_id, id)`. This makes "User A's entry points at User B's account" a constraint violation at the database, independent of RLS. Applies to all parent→child links below.
- **Encryption columns.** Tier-1 values are stored as `*_ct` (ciphertext) beside their plaintext structural neighbors. Every table that holds ciphertext carries `version int not null default 1`, bumped on every update; it is the `row_version` in the AEAD **AAD = `id ‖ column_name ‖ version`** (cross-ref `encryption.md` §3). The external-anchoring of the *expected* version against an active DB-write attacker is an open question (threat-model §7.4/§13), not resolved here.
- **Timestamps.** `created_at`, `updated_at` on every table.
- **Attribute locking.** Auto-fillable rows carry `locked_attributes jsonb` — a map of per-field "was this human-set?" booleans (plaintext; it holds field *names*, not values). Rules and the model skip locked fields. The *provenance and prior values* of changes live in a dedicated changelog table (§5), not in this jsonb.
- **Money.** Any monetary value is an exact decimal carried as a string, encrypted (`*_ct`) when Tier-1. Never a float, never a plaintext `NUMERIC` for a user's amount. Plaintext `NUMERIC` applies only to non-sensitive reference data (`fx_rates.rate`). Cross-ref `money-and-currency.md`.

---

## 4. Money, currency & FX on an entry
Every flow in `entries` carries two ground-truth amount legs plus the FX needed to report it:
| Leg | Columns | Meaning |
|---|---|---|
| **entered** | `entered_amount_ct` (enc), `entered_currency` (plain) | What originated — the statement line / what the user typed. Ground truth, verbatim. |
| **account** | `account_amount_ct` (enc), `account_currency` (plain) | The amount in the holding account's own currency. Ground truth. |
| **reporting** | *(derived, not stored)* `reporting_currency` (plain) + `fx_rate` + `fx_rate_date` + `fx_source` (plain) | The value in the user's base currency. See §4.3. |
Where entered = account = reporting currency, both amount legs hold the same value and `fx_rate` is `1` — the triple is uniform, never special-cased away.

### 4.1 The rate is locked at the transaction date
`fx_rate` is the provider rate for `entered → reporting` **as of `fx_rate_date` (the transaction date)** — not ingest date, not "now". Stored plaintext because an FX rate is public market data; it is *not* Tier-1. `fx_source` records which provider/fixing it came from.

### 4.2 Missing rates → pending, never faked
If no rate exists for the transaction date at ingest, `fx_status = 'pending'` and `fx_rate` is null. The entered/account legs still persist (they are ground truth). A later user-triggered operation may fill the rate. Aggregations must **surface or exclude** pending entries — never silently treat a missing rate as `1:1` or as today's rate.

### 4.3 Reporting amount is derived on read, not stored
There is **no `reporting_amount_ct`**. The reporting value is computed in the domain layer as `entered_amount × fx_rate`, at the moment of the decrypt pass that reads the entry anyway.

Why derive rather than store (a deliberate refinement of `money-and-currency.md` §2):
- **The rate is locked, so the result is stable.** `entered × fx_rate` with the *transaction-date* rate gives the same, unchanging number every read. This still avoids the Finlynq bug (Finlynq recomputes at *today's* rate, so history drifts) — the fix was never "store it," it was "use the locked rate, not the live one."
- **Encryption already forfeits the benefit of storing it.** The reason to persist a reporting leg is exact in-database `SUM`. But once amounts are encrypted, the database cannot sum them at all — the domain layer decrypts and sums either way. Persisting the leg buys nothing on the read path while adding a redundant ciphertext column.
- **It removes a re-encryption nightmare.** With the leg stored, changing a user's base currency means decrypt → recompute → re-encrypt every entry ever recorded. Derived, a base-currency change is just a different historical `fx_rates` lookup per bucket at read time — **no ciphertext is touched.** (v1.0 renders only in the base currency; the display-currency toggle is deferred, but the derived model already accommodates it — cross-ref `money-and-currency.md` §5/§7.)

### 4.4 Stock vs. flow (unchanged rule, restated for the schema)
- **Flows** (income/expense/category totals over a period) = sum of each entry's `entered × its locked rate`. A period total must never move as rates move.
- **Stocks** ("net worth now", "balance as of a date") come through the
  `account_balance_snapshots` aggregate. Ordinary accounts value the stored native
  balance at *today's* (or the as-of-date's) latest rate; investment accounts derive
  value from their position/cash children and the applicable shared FX observations.
  Stocks *should* move with the market — that is correct valuation, not drift.

---

## 5. Entities (the v1.0 foundation plus Moni 1.1 investments)
### Identity & keys
- **`users`** — `id`, `email`, `base_currency` (default `ILS`), and per-user key-custody material (wrapped data key, unlock/WebAuthn references, recovery-code hashes). The key hierarchy and custody columns are specified by `encryption.md` / `threat-model.md` §5 and not redefined here. Auth-adjacent tables (`sessions`, `api_keys`, WebAuthn credentials) exist but are owned by the domain-layer / MCP designs — named here, detailed there.

### Connectors & ingestion
- **`connections`** — one configured source at one institution. `owner_id`,
  `connector_id` (for example `israeli-bank-scrapers:leumi`), mechanism-specific
  authorization encrypted as Tier-0 when present, `status`, and `last_sync_at`.
  User-mediated import connections have no institution credential.
- **`sync_runs`** — one source retrieval attempt. `owner_id`, `connection_id`,
  `status` (`pending`/`running`/`succeeded`/`failed`),
  `window_start`/`window_end`, `error`, timestamps. The atomic-failure contract
  lives here: a failed run never partial-writes balances, entries, or investment
  snapshots.
- **`sync_staging`** — the **raw ingestion buffer**. Holds exactly what the scraper returned, out of the canonical ledger, so pending↔posted churn never touches `entries` directly. Columns: `owner_id`, `sync_run_id`, `account_id` (nullable until mapped), `raw_payload_ct` (the scraper row verbatim, encrypted), `import_key`, `scraper_status` (`pending`/`completed`), `reconcile_state` (`new`/`matched`/`promoted`/`superseded`), `promoted_entry_id` (nullable FK to `entries`), timestamps.
  - **`import_key`** is built from **stable fields only** — provider `identifier` + account + original amount/currency + purchase/original date. It **excludes** description and posting date, which banks mutate when a charge moves pending → posted. This is what makes re-scrape idempotent without generating duplicates (see §6, tension 4).
  - A reconciler matches `pending` staging rows to their later `completed` form here, then promotes to `entries` through the domain layer.

### Accounts
- **`accounts`** — `owner_id`, `account_type` (`checking` | `savings` | `credit_card` | `investment` | `loan` | `other_asset` | `other_liability`; the enum is meant to grow), `classification` (`asset`/`liability`, derivable from type), `connection_id` (nullable — manual accounts are allowed), `name_ct`, `institution` (plaintext label), `account_number_last4_ct`, `currency` (plaintext), `current_balance_ct` (latest known native balance cached for non-investment accounts; null for investments whose current value is derived), `status` (`active`/`archived`), `locked_attributes`, `version`.
- **`credit_card_details`** — `account_id` (PK = FK to `accounts`, composite with `owner_id`), `statement_close_day`, `payment_due_day`, `credit_limit_ct`. The only account-subtype extension table in v1.0. The same base-row-plus-`*_details` pattern is documented for future `loan_details` and `investment_details`; investment/savings accounts in v1.0 need no extra columns — they are a base `accounts` row whose balance is tracked via snapshots.

### The unified ledger (flows only)
- **`entries`** (base) — `owner_id`, `account_id` (composite FK), `entry_type` (`transaction` in v1.0; `trade` reserved), `date` (plaintext, structural), `description_ct`, `notes_ct`, `category_id` (nullable FK), `merchant_id` (nullable FK), `status` (`posted`/`pending`), `excluded` (bool — kept out of totals, e.g. one leg of an internal transfer), the **currency legs** and **FX columns** from §4 (`entered_*`, `account_*`, `reporting_currency`, `fx_rate`, `fx_rate_date`, `fx_source`, `fx_status` — **no `reporting_amount_ct`**), `import_key` (mirrored from staging) + provider `external_id`, `source` (`scrape`/`manual`/`rule`/`model`), `locked_attributes`, `version`. Indexes: `(owner_id, account_id, date)`, `(owner_id, category_id, date)`.
- **`entry_transactions`** — 1:1 subtype, `entry_id` (PK = FK, composite with `owner_id`). `kind` (`standard`/`transfer`/`fee`/`refund`) and installment metadata, denormalized per slice: `installment_number`, `total_installments`, `installment_total_amount_ct`, `installment_total_currency`, `installment_purchase_date`, plus a nullable `installment_group_id` correlation key that a background job fills once it confidently stitches a purchase's slices. (Denormalized because the Israeli scrapers emit each installment as an independent charge with no stable group id, and the metadata is an immutable, attribute-locked bank fact re-reported on every slice — so drift risk is low. See §6, tension 5.)

> **No `entry_valuations`.** Absolute account observations are rooted only in
> `account_balance_snapshots` (below), with subtype children where required. The
> ledger stays deltas-only.

### Classification, enrichment & automation
- **`categories`** — `owner_id`, `name` (plaintext — an ordinary Tier-2 label like "Groceries"; not encrypted), `parent_id` (self-reference, **one nesting level**), `classification` (`income`/`expense`/`transfer`), `color`, `icon`.
- **`merchants`** — `owner_id`, `name_ct` (a counterparty → encrypted; grouping is done by `merchant_id`, names decrypted only for display), `match_text_ct` (**the identity** — one merchant per distinct match text; Tier-1, so no unique constraint is possible and dedupe happens in the domain layer), `logo_url` (**origin-local path only** — [ADR 0007](../adr/0007-merchant-icons-never-leave-the-origin.md)) / `website_url` (plaintext, optional), `cadence_override` (plaintext enum), `source`. Written in three layers — catalog, auto-from-match-text, external — see [ADR 0005](../adr/0005-a-merchant-is-a-match-text-that-got-promoted.md).
- **`entry_field_changelog`** — attribute-lock provenance, append-only. `owner_id`, `entry_id` (**real FK**, `ON DELETE CASCADE`, composite with `owner_id`), `field_name`, `source` (`bank`/`rule`/`model`/`user`), `value_ct` (the applied value — encrypted when the field is Tier-1; AAD bound to *this* changelog row's id/column/version), `created_at`. A parallel `account_field_changelog` is the documented pattern for locked account fields (deferred).
- **`rules`** — `owner_id`, `name`, `resource_type`, `active`, `effective_date`.
  - **`rule_conditions`** — `rule_id`, `parent_id` (self-reference, **one nesting level**, capped on purpose to stay comprehensible), `condition_type`, `operator`, `value_ct` (may embed a counterparty → encrypted).
  - **`rule_actions`** — `rule_id`, `action_type`, `value`.
- **Recurring** — no table. A merchant is recurring because the user flagged its category (`categories.is_recurring`); cadence, averages, payment counts and category sums are all derived on read from `entries`. `recurring_series` was dropped along with `entries.recurring_series_id` — see [ADR 0006](../adr/0006-the-recurring-view-stores-nothing-and-recurring-series-is-deleted.md). `merchants.cadence_override` holds the one thing that cannot be derived.
- **`transfers`** — `owner_id`, `inflow_entry_id`, `outflow_entry_id`, `status`. Pairs the two legs of an internal move (between the user's own accounts) so it is not counted as income or expense; paired legs also carry `excluded = true`.

### Dashboard / graph helpers
- **`account_balance_snapshots`** — the single dated account-observation parent and
  net-worth domain-service seam (the stock series). `owner_id`, `account_id`
  (composite FK), `date`, nullable `native_balance_ct`, nullable `currency`, and
  `source`. Ordinary account snapshots require the native balance and currency. An
  investment snapshot leaves both null because its canonical ILS value is derived
  from its encrypted position/cash children and shared FX; persisting that rollup
  would require ciphertext rewrites whenever current FX or an official historical
  correction changes. A 1:1 `investment_snapshot_details` row supplies the subtype
  and richer observation state below. Every account type still enters net worth
  through the same domain service and dated parent rather than a second dashboard
  query path.
- **No `period_rollups` in v1.0.** Flow totals are computed on-the-fly: filter on plaintext structural columns → decrypt the narrowed set → aggregate with `decimal.js`. At family scale (~10⁴–10⁵ rows lifetime) this is milliseconds. A persisted rollup cache — maintained by a *single serialized worker off the ingest path*, never an inline read-modify-write — is documented as the scale-up path, added only if measured slow (see §6, tension 1).

### Investments (Moni 1.1)

Investment state is snapshot-based, not an activity or lot ledger. [ADR
0008](../adr/0008-investments-use-weekly-account-state-snapshots.md) records why.

- **`instruments`** — a user-owned canonical identity for an investable asset.
  Structural fields are `owner_id`, `instrument_kind`
  (`stock`/`etf`/`mutual_fund`/`generic`), and version/timestamps. Names, symbols,
  exchange/venue, ISIN/CUSIP/FIGI, and other identifying labels are Tier-1
  ciphertext. Instruments never live in a global reference table.
- **`instrument_source_mappings`** — maps one canonical instrument to a
  provider-qualified source identity. `owner_id`, `instrument_id` (composite FK),
  provider and identifier kind are structural; provider identifiers and labels are
  encrypted. Across providers, the domain layer auto-merges only equal durable
  identifiers with no kind/currency conflict. A provider-native id matches only
  inside that provider. Ticker/name similarity never merges records, and ambiguous
  records stay separate.
- **`investment_snapshot_details`** — 1:1 extension of an
  `account_balance_snapshots` row for an investment account. It carries the account
  and Sunday-based `week_start` needed for one-active-snapshot-per-account-per-week
  uniqueness, the exact source as-of date/time and its precision, optional
  `source_value_ct`/currency, valuation basis, freshness/completeness and
  reconciliation quality, source connection/sync provenance, and version/timestamps.
  The broker account total remains separate evidence; the domain service derives
  Moni's exact ILS sum from the position/cash children and shared FX. A later
  accepted observation for the same source week atomically replaces the normalized
  snapshot; corrections may replace a closed week too.
- **`investment_snapshot_positions`** — one row per snapshot and canonical
  instrument after source rows are aggregated. `owner_id`, snapshot/instrument
  composite FKs, signed `quantity_ct`, explicit quantity unit, optional exact
  source price/value ciphertext and currencies, and source valuation as-of
  metadata. A position uses the broker market value when present and otherwise
  derives its value from exact quantity × broker price. A position is state, not a
  trade or lot.
- **`investment_snapshot_cash_balances`** — one signed exact `amount_ct` per
  snapshot and currency. Cash is displayed beside positions but is not represented
  as a synthetic instrument.
- **`investment_source_evidence`** — structural audit and idempotency evidence for
  an accepted normalized refresh: owner/connection/sync/account provenance, real
  source period/as-of metadata, validation version, row counts, quality, and a keyed
  normalized fingerprint. It contains no raw response, uploaded file, filename,
  path, or financial field value. Raw XML/CSV exists only in the short-lived worker;
  failed refreshes write no evidence row and retain only a sanitized
  `sync_runs.error`.
- **`investment_market_quotes`** — the latest accepted user-owned quote for an
  instrument/provider mapping: `owner_id`, `instrument_id`, provider, encrypted
  provider symbol and exact `price_ct`, plaintext currency/source date/fetched-at,
  quality, and version/timestamps. Quote rows are RLS-protected because their
  instrument relationship reveals a user's holdings. Weekly quote history is not
  retained in 1.1.

Every quantity, price, value, and cash amount is a signed exact decimal string
inside ciphertext and preserves source scale; arithmetic uses `decimal.js` and
rounding occurs only for display. Instrument kind, quantity unit, currency, source,
week/as-of fields, and valuation-quality enums remain plaintext structural
metadata. Every investment table is user-owned, RLS-protected, versioned when it
contains ciphertext, and uses composite owner foreign keys.

The latest accepted snapshot is current state. At most one normalized snapshot per
account per Sunday-through-Saturday week remains in history indefinitely, chosen by
source as-of time rather than ingestion time. Repeated refreshes within a week and
late corrections replace that week's normalized children in one transaction. The
normalized keyed fingerprint makes an exact repeat a no-op. A newer source time
wins; for changed content at the same source time, the later accepted import is a
correction; an older source time is rejected as `stale_source`.

Every sync declares its exact account coverage before promotion. An IBKR Flex query
covers every account configured into that query; a Schwab Positions CSV covers only
its previously bound account. Every covered account promotes in one transaction or
none does, while accounts outside the declaration remain untouched. A previously
known covered account disappearing from the source fails the refresh. A covered
account may become an accepted zero state only when the source explicitly supplies
its stable identity, authoritative as-of, complete position and cash sections, and
an exact zero broker total. Blank input, zero discovered accounts, or omission never
means closure; archival is explicit.

IBKR may discover an account by its stable broker account identifier. A Schwab CSV
connection binds its first accepted masked account reference and user-confirmed
valuation currency; later mismatches reject the file, and another Schwab account
requires another connection. Aliases and display names never establish account
identity. Repeated position rows aggregate only when source identity, asset kind,
quantity unit, currency, valuation basis, and source time agree; repeated compatible
cash rows aggregate by currency. A conflict rejects the complete declared coverage.

Portfolio and account reads derive totals, holding/account/currency allocations, and
weekly history through the domain layer. A missing account week may reuse its latest
prior observation only in the read result and must mark the portfolio point
mixed-age/stale; no synthetic snapshot or persisted portfolio rollup is written.
Generic instruments contribute through clearly labeled broker source values and get
no specialized analytics. A missing required identity, quantity, currency, as-of
time, cash amount, or usable valuation input rejects the complete refresh. A broker
account total cannot rescue a nonzero position that has neither a source market
value nor a usable source price.

For the current estimate, active USD ETFs and common stocks on NYSE or Nasdaq may
use the latest usable Tiingo EOD close with the last accepted exact quantity;
last-known cash remains at its source amount. Quote refresh is a separate
best-effort operation and cannot accept, reject, or mutate a broker/import snapshot.
Tiingo requires both an instance token and explicit multi-user provider
authorization; missing either is a local no-op. A missing, unresolved,
more-than-seven-day-old, or post-split quote falls back to the position's
broker-observed value and makes the returned basis/freshness explicit. Historical
weekly values always use source-date broker observations.

Every source valuation keeps its real as-of time and precision. A position-specific
valuation time wins; otherwise the position inherits the account source time, never
the ingestion time. Broker evidence is current only in the present or immediately
preceding Israeli Sunday–Saturday week; older evidence remains included but stale.
Tiingo quotes and BOI observations retain their separate seven-calendar-day limits.
A broker account total that differs from Moni's component sum after both are rounded
to ILS display precision adds a non-blocking reconciliation-mismatch quality state.

Historical reporting-currency conversion batch-reads the shared local `fx_rates`
cache for each snapshot's actual date. Missing rates are fetched and cached during a
user-triggered refresh; reads make no external request, 1.1 has no scheduler, and
snapshot rows do not duplicate or lock an FX rate. Current investment values use the
newest accepted local BOI observation, while weekly values use the latest observation
on or before the snapshot date. A BOI observation is unusable after seven calendar
days; an unavailable required rate rejects the new connection refresh atomically.
An official correction replaces the shared observation and may correct derived
history.

Disconnecting a connection preserves its accounts and snapshots. Closing or moving
assets out of an account archives it only through explicit user action, excluding
it from current portfolio reads while preserving history. Permanent deletion is a
separate destructive operation. Disconnect is disabled while that connection has a
running sync; 1.1 exposes no user cancellation action.

### Global reference (no owner, no user-RLS)
- **`fx_rates`** — `from_currency`, `to_currency`, observation `date`, normalized
  per-unit `rate` (plaintext `NUMERIC` — public data), source unit/provenance, and
  fetch/update timestamps. Unique `(from_currency, to_currency, date, source)`.
  Investment 1.1 stores BOI-published foreign→ILS observations, normalized from the
  exact CSV decimal and `UNIT_MULT`; official corrections update the shared row.
  Missing rows are fetched only during user-triggered operations and are shared
  across users. Cross-ref `money-and-currency.md` §4.

### Designed but NOT built in Moni 1.1 (documented extension points)
Column lists are given in this doc as the forward plan; no Moni 1.1 migration ships
them:
- **`entry_trades`**, acquisition/disposal lots, corporate actions, income/withholding evidence, and tax-FX records — future event/accounting extensions. Moni 1.1 investment snapshots deliberately do not pretend to provide this lineage.
- **`installment_groups`** — normalized parent for installment slices, adopted once cross-slice grouping proves reliable.
- **`account_field_changelog`** — the accounts-side analogue of `entry_field_changelog`.

---

## 6. Points of tension & key decisions

1. **Encrypted amounts vs. SQL aggregation.** The biggest schema-shaping constraint: no `SUM` / `GROUP BY` on ciphertext. Resolved for v1.0 by decrypt-then-aggregate in the domain layer, with structural columns kept plaintext to narrow the decrypt set first. *No persisted rollups* — see the reasoning in §4.3 (the same encryption fact undercuts storing the reporting leg).
2. **Concurrency on any derived ciphertext.** A rollup update is a read-decrypt-add-reencrypt-write cycle; under a concurrent scrape + manual entry it is a lost-update race that would need `SELECT FOR UPDATE` (bulk-sync contention). Not persisting rollups sidesteps this entirely; if one is ever added it must be owned by a single serialized worker, never updated inline.
3. **Flow vs. snapshot separation.** Deltas (`entries`) and absolutes (`account_balance_snapshots`) live in different tables so nothing can accidentally `SUM` a balance as if it were a flow — a real hazard when a model writes the query.
4. **Pending → posted reconciliation.** Banks mutate description/date/amount when a charge posts, so the dedup `import_key` uses stable fields only and the unstable bank state is held in `sync_staging`, out of the canonical ledger. Residual risk: a mis-reconciliation yields a duplicate or a missed update; the staging buffer is where that is caught and corrected.
5. **Installments & billing-cycle bucketing.** Metadata is denormalized per slice + an inferred `installment_group_id` (the scraper gives no stable group id). **Decided (issue #69):** an installment slice is dated by **its own charge date** (`processedDate`), and its `entries` amount is **that payment alone** (`chargedAmount`) — because the scrapers repeat the whole deal on every slice, putting the purchase date and the deal sum on all twelve. The deal sum survives in `installment_total_amount_ct` (with `installment_total_currency`, which is not always the entry's `entered_currency` — a foreign purchase states the deal in one currency and charges each payment in another), and the purchase date in `installment_purchase_date`. The statement-close date drives nothing: re-bucketing around it would install a permanent gap between the date the ledger displays and the date every aggregate believes. `import_key` still keys on the *stable* purchase date and deal sum, never `processedDate`, plus the slice number — without which Isracard's shared identifier collapses all twelve payments onto one entry.
6. **Reporting leg derived, not stored** (§4.3) — `money-and-currency.md` §2/§7 has been reconciled to match. Stability is preserved because the *rate* is locked at the transaction date.
7. **Pending FX** — `fx_status = 'pending'` + null `fx_rate` until backfilled; on-the-fly aggregation must surface or exclude pending rows, never under-count.
8. **Strict per-user isolation vs. household sharing.** `owner_id = user_id` everywhere, plus the composite tenant-FK backstop. Moni diverges from Maybe's family-shared model: there is **no** shared/household view in v1.0. A future shared or read-only-grant feature is a new sharing layer on top, not a rewrite of `owner_id`.
9. **Class-table subtyping.** Base `entries` + `entry_transactions` (and `entry_trades` later) costs a join but buys typed subtype fields and real FKs; chosen over a discriminator + wide nullable/JSONB row.
10. **Row-version rollback anchoring.** The AAD `version` blocks casual ciphertext rollback, but against an *active* DB-write attacker the *expected* version must be anchored outside the DB (per-user counter / signed head) — an open question inherited from `threat-model.md` §7.4/§13, not resolved here.
11. **Transfer-detection false pairs.** Internal-transfer pairing is a background heuristic (`transfers` + `excluded`/`kind`); a mispair double-counts or hides a real flow, so pairing is reversible and surfaced to the user.
12. **Retention.** Raw entries are kept forever — never compacted into monthly aggregates. Because every aggregate is derived (no persisted rollups, no stored reporting leg), the raw ledger is the *sole* source of truth; discarding it to save space (trivial at family scale) would forfeit re-categorization, attribute-lock audit, and dedup. Compaction is explicitly a non-goal.
