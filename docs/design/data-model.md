# Moni — Data Model

**Purpose:** The core schema — the unified ledger that puts expenses (and, later, investments) on one timeline — and how everything else hangs off it. This is the design the first Moni migrations and the domain layer are built from. It is a *design* document: it specifies tables, columns, and the rules that govern them, not migration SQL.

**Testing & seeding.** See `../../.agents/skills/db-schema/SKILL.md` for the table map, invariant checklist, and the migrate/seed/test workflow.

**Reference lineage.** The shape is adapted from three of the `repos_eval/` projects:
- **Maybe** — the unified ledger idea (one `entries` table with a typed subtype delegate), account subtyping + asset/liability classification, attribute-locking with a source-logged change history, and a one-level-nested rules engine. *Primary architectural model.*
- **Finlynq** — the entered/account/reporting currency trilogy and the `*_ct` ciphertext-column convention. We adopt the trilogy but **reject Finlynq's float money** (exact decimal only) and **refine the reporting leg** (see §4).
- **Securo** — per-transaction installment metadata and credit-card billing-cycle fields (`statement_close_day` / `payment_due_day`). Directly relevant to Israeli תשלומים.

---

## 1. Overview
Moni's ledger is a **pure flow ledger**: every row in `entries` is a *delta* — money moving (income, an expense, later a trade). **Absolute balances are never stored in the ledger**; they live in a separate `account_balance_snapshots` table. Keeping flows and snapshots physically apart is deliberate — mixing a "this is a −₪120 expense" delta and a "this account is worth ₪43,000 right now" absolute in one summable column is a corruption waiting to happen, and doubly so in an AI-native app where a model may write aggregation queries.
Five rules cut across every table below; each entity section assumes them rather than repeating them:
1. **Ownership + isolation.** Every user-owned table has an `owner_id` and is protected by Postgres Row-Level Security, **plus** a composite `(owner_id, id)` foreign-key backstop so cross-tenant linkage is impossible even if RLS is bypassed (§2).
2. **Encryption split.** Tier-1 sensitive values (amounts, descriptions, counterparties, account numbers, notes, credentials) are stored encrypted as `*_ct` columns; structural columns (ids, owner_id`, currency codes, dates, `category_id`, account type`) stay plaintext so SQL can still filter and group (§2, cross-ref `encryption.md`).
3. **Rate locked, reporting derived.** The FX *rate* for a flow is locked at its transaction date and stored; the *reporting amount* is **derived on read** (`entered × locked_rate`), not persisted (§4).
4. **Flow vs. snapshot separation.** `entries` = deltas; `account_balance_snapshots` = absolutes. Never the same column (§1 above, §4).
5. **Aggregate in the app tier.** You cannot `SUM`/`GROUP BY` ciphertext, so dashboards narrow on plaintext structural columns, decrypt the narrowed set, and aggregate in memory with `decimal.js`. **v1.0 persists no rollups** (§4, §6).
---
## 2. Conventions (apply to every table unless stated otherwise)
- **Identity.** `uuid` primary keys, `gen_random_uuid()` default.
- **Ownership / RLS.** `owner_id uuid not null` references `users(id)`. An RLS policy enforces `owner_id = current_setting('app.user_id')::uuid`; the app connects as a role that is *subject* to RLS. The domain layer sets `SET LOCAL app.user_id` per request/transaction. Global reference tables (`fx_rates`, and the deferred `securities`) are the only exceptions — no `owner_id`, readable by all, written only by system jobs.
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
If no rate exists for the transaction date at ingest, `fx_status = 'pending'` and `fx_rate` is null. The entered/account legs still persist (they are ground truth). A background job backfills the rate later. Aggregations must **surface or exclude** pending entries — never silently treat a missing rate as `1:1` or as today's rate.

### 4.3 Reporting amount is derived on read, not stored
There is **no `reporting_amount_ct`**. The reporting value is computed in the domain layer as `entered_amount × fx_rate`, at the moment of the decrypt pass that reads the entry anyway.

Why derive rather than store (a deliberate refinement of `money-and-currency.md` §2):
- **The rate is locked, so the result is stable.** `entered × fx_rate` with the *transaction-date* rate gives the same, unchanging number every read. This still avoids the Finlynq bug (Finlynq recomputes at *today's* rate, so history drifts) — the fix was never "store it," it was "use the locked rate, not the live one."
- **Encryption already forfeits the benefit of storing it.** The reason to persist a reporting leg is exact in-database `SUM`. But once amounts are encrypted, the database cannot sum them at all — the domain layer decrypts and sums either way. Persisting the leg buys nothing on the read path while adding a redundant ciphertext column.
- **It removes a re-encryption nightmare.** With the leg stored, changing a user's base currency means decrypt → recompute → re-encrypt every entry ever recorded. Derived, a base-currency change is just a different historical `fx_rates` lookup per bucket at read time — **no ciphertext is touched.** (v1.0 renders only in the base currency; the display-currency toggle is deferred, but the derived model already accommodates it — cross-ref `money-and-currency.md` §5/§7.)

### 4.4 Stock vs. flow (unchanged rule, restated for the schema)
- **Flows** (income/expense/category totals over a period) = sum of each entry's `entered × its locked rate`. A period total must never move as rates move.
- **Stocks** ("net worth now", "balance as of a date") come from `account_balance_snapshots`, each account's native balance valued at *today's* (or the as-of-date's) latest rate. Stocks *should* move with the market — that is correct valuation, not drift.

---

## 5. Entities (the concrete build list for v1.0)
### Identity & keys
- **`users`** — `id`, `email`, `base_currency` (default `ILS`), and per-user key-custody material (wrapped data key, unlock/WebAuthn references, recovery-code hashes). The key hierarchy and custody columns are specified by `encryption.md` / `threat-model.md` §5 and not redefined here. Auth-adjacent tables (`sessions`, `api_keys`, WebAuthn credentials) exist but are owned by the domain-layer / MCP designs — named here, detailed there.

### Connectors & ingestion
- **`connections`** — one per linked institution login. `owner_id`, `connector_id` (e.g. `israeli-bank-scrapers:leumi`), `credentials_ct` (**Tier-0**, wrapped by the user's unlock secret per the key hierarchy — *never* the data key, never plaintext at rest), `status`, `last_sync_at`.
- **`sync_runs`** — one per scrape attempt. `owner_id`, `connection_id`, `status` (`pending`/`running`/`succeeded`/`failed`), `window_start`/`window_end`, `error`, timestamps. The atomic-failure contract lives here: a failed run never partial-writes balances or entries.
- **`sync_staging`** — the **raw ingestion buffer**. Holds exactly what the scraper returned, out of the canonical ledger, so pending↔posted churn never touches `entries` directly. Columns: `owner_id`, `sync_run_id`, `account_id` (nullable until mapped), `raw_payload_ct` (the scraper row verbatim, encrypted), `import_key`, `scraper_status` (`pending`/`completed`), `reconcile_state` (`new`/`matched`/`promoted`/`superseded`), `promoted_entry_id` (nullable FK to `entries`), timestamps.
  - **`import_key`** is built from **stable fields only** — provider `identifier` + account + original amount/currency + purchase/original date. It **excludes** description and posting date, which banks mutate when a charge moves pending → posted. This is what makes re-scrape idempotent without generating duplicates (see §6, tension 4).
  - A reconciler matches `pending` staging rows to their later `completed` form here, then promotes to `entries` through the domain layer.

### Accounts
- **`accounts`** — `owner_id`, `account_type` (`checking` | `savings` | `credit_card` | `investment` | `loan` | `other_asset` | `other_liability`; the enum is meant to grow), `classification` (`asset`/`liability`, derivable from type), `connection_id` (nullable — manual accounts are allowed), `name_ct`, `institution` (plaintext label), `account_number_last4_ct`, `currency` (plaintext), `current_balance_ct` (latest known native balance, cached from the most recent snapshot for cheap reads), `status` (`active`/`archived`), `locked_attributes`, `version`.
- **`credit_card_details`** — `account_id` (PK = FK to `accounts`, composite with `owner_id`), `statement_close_day`, `payment_due_day`, `credit_limit_ct`. The only account-subtype extension table in v1.0. The same base-row-plus-`*_details` pattern is documented for future `loan_details` and `investment_details`; investment/savings accounts in v1.0 need no extra columns — they are a base `accounts` row whose balance is tracked via snapshots.

### The unified ledger (flows only)
- **`entries`** (base) — `owner_id`, `account_id` (composite FK), `entry_type` (`transaction` in v1.0; `trade` reserved), `date` (plaintext, structural), `description_ct`, `notes_ct`, `category_id` (nullable FK), `merchant_id` (nullable FK), `recurring_series_id` (nullable), `status` (`posted`/`pending`), `excluded` (bool — kept out of totals, e.g. one leg of an internal transfer), the **currency legs** and **FX columns** from §4 (`entered_*`, `account_*`, `reporting_currency`, `fx_rate`, `fx_rate_date`, `fx_source`, `fx_status` — **no `reporting_amount_ct`**), `import_key` (mirrored from staging) + provider `external_id`, `source` (`scrape`/`manual`/`rule`/`model`), `locked_attributes`, `version`. Indexes: `(owner_id, account_id, date)`, `(owner_id, category_id, date)`.
- **`entry_transactions`** — 1:1 subtype, `entry_id` (PK = FK, composite with `owner_id`). `kind` (`standard`/`transfer`/`fee`/`refund`) and installment metadata, denormalized per slice: `installment_number`, `total_installments`, `installment_total_amount_ct`, `installment_purchase_date`, plus a nullable `installment_group_id` correlation key that a background job fills once it confidently stitches a purchase's slices. (Denormalized because the Israeli scrapers emit each installment as an independent charge with no stable group id, and the metadata is an immutable, attribute-locked bank fact re-reported on every slice — so drift risk is low. See §6, tension 5.)

> **No `entry_valuations`.** Asserted/scraped *absolute* balances live only in `account_balance_snapshots` (below). The ledger stays deltas-only.

### Classification, enrichment & automation
- **`categories`** — `owner_id`, `name` (plaintext — an ordinary Tier-2 label like "Groceries"; not encrypted), `parent_id` (self-reference, **one nesting level**), `classification` (`income`/`expense`/`transfer`), `color`, `icon`.
- **`merchants`** — `owner_id`, `name_ct` (a counterparty → encrypted; grouping is done by `merchant_id`, names decrypted only for display), `logo_url`/`website_url` (plaintext, optional), `source`.
- **`entry_field_changelog`** — attribute-lock provenance, append-only. `owner_id`, `entry_id` (**real FK**, `ON DELETE CASCADE`, composite with `owner_id`), `field_name`, `source` (`bank`/`rule`/`model`/`user`), `value_ct` (the applied value — encrypted when the field is Tier-1; AAD bound to *this* changelog row's id/column/version), `created_at`. A parallel `account_field_changelog` is the documented pattern for locked account fields (deferred).
- **`rules`** — `owner_id`, `name`, `resource_type`, `active`, `effective_date`.
  - **`rule_conditions`** — `rule_id`, `parent_id` (self-reference, **one nesting level**, capped on purpose to stay comprehensible), `condition_type`, `operator`, `value_ct` (may embed a counterparty → encrypted).
  - **`rule_actions`** — `rule_id`, `action_type`, `value`.
- **`recurring_series`** — `owner_id`, `merchant_id`/`category_id`, `cadence`, `expected_amount_ct`, `next_expected_date`, `is_subscription` (bool), `status`. Entries link back via `recurring_series_id`. Detection runs as a background job.
- **`transfers`** — `owner_id`, `inflow_entry_id`, `outflow_entry_id`, `status`. Pairs the two legs of an internal move (between the user's own accounts) so it is not counted as income or expense; paired legs also carry `excluded = true`.

### Dashboard / graph helpers
- **`account_balance_snapshots`** — the **sole home for absolute balances** (the stock series). `owner_id`, `account_id` (composite FK), `date`, `native_balance_ct`, `currency`, `source` (`scrape`/`manual`). This is where investment/savings "balance-only" accounts and any manual balance mark land — it replaces the dropped valuation subtype. Net-worth-over-time is these snapshots valued at the as-of-date/today rate (§4.4).
- **No `period_rollups` in v1.0.** Flow totals are computed on-the-fly: filter on plaintext structural columns → decrypt the narrowed set → aggregate with `decimal.js`. At family scale (~10⁴–10⁵ rows lifetime) this is milliseconds. A persisted rollup cache — maintained by a *single serialized worker off the ingest path*, never an inline read-modify-write — is documented as the scale-up path, added only if measured slow (see §6, tension 1).

### Global reference (no owner, no user-RLS)
- **`fx_rates`** — `from_currency`, `to_currency`, `date`, `rate` (plaintext `NUMERIC` — public data), `source`. Unique `(from_currency, to_currency, date, source)`. Populated by the pg-boss FX job. Cross-ref `money-and-currency.md` §4.

### Designed but NOT built in v1.0 (documented extension points)
Column lists are given in this doc as the forward plan; no migration ships them in v1.0:
- **`entry_trades`** (entry subtype: `security_id`, `qty`, `price`), **`securities`**, **`holdings`** (daily per-security snapshot) — the deferred investments module.
- **`installment_groups`** — normalized parent for installment slices, adopted once cross-slice grouping proves reliable.
- **`account_field_changelog`** — the accounts-side analogue of `entry_field_changelog`.

---

## 6. Points of tension & key decisions

1. **Encrypted amounts vs. SQL aggregation.** The biggest schema-shaping constraint: no `SUM` / `GROUP BY` on ciphertext. Resolved for v1.0 by decrypt-then-aggregate in the domain layer, with structural columns kept plaintext to narrow the decrypt set first. *No persisted rollups* — see the reasoning in §4.3 (the same encryption fact undercuts storing the reporting leg).
2. **Concurrency on any derived ciphertext.** A rollup update is a read-decrypt-add-reencrypt-write cycle; under a concurrent scrape + manual entry it is a lost-update race that would need `SELECT FOR UPDATE` (bulk-sync contention). Not persisting rollups sidesteps this entirely; if one is ever added it must be owned by a single serialized worker, never updated inline.
3. **Flow vs. snapshot separation.** Deltas (`entries`) and absolutes (`account_balance_snapshots`) live in different tables so nothing can accidentally `SUM` a balance as if it were a flow — a real hazard when a model writes the query.
4. **Pending → posted reconciliation.** Banks mutate description/date/amount when a charge posts, so the dedup `import_key` uses stable fields only and the unstable bank state is held in `sync_staging`, out of the canonical ledger. Residual risk: a mis-reconciliation yields a duplicate or a missed update; the staging buffer is where that is caught and corrected.
5. **Installments & billing-cycle bucketing.** Metadata is denormalized per slice + an inferred `installment_group_id` (the scraper gives no stable group id). **Open decision:** which date — the charge date or the statement-close date (`credit_card_details.statement_close_day`) — drives "this month's card bill." (Securo shipped a migration to *re-bucket* transactions around the statement close day after getting this wrong; we should decide it up front.)
6. **Reporting leg derived, not stored** (§4.3) — `money-and-currency.md` §2/§7 has been reconciled to match. Stability is preserved because the *rate* is locked at the transaction date.
7. **Pending FX** — `fx_status = 'pending'` + null `fx_rate` until backfilled; on-the-fly aggregation must surface or exclude pending rows, never under-count.
8. **Strict per-user isolation vs. household sharing.** `owner_id = user_id` everywhere, plus the composite tenant-FK backstop. Moni diverges from Maybe's family-shared model: there is **no** shared/household view in v1.0. A future shared or read-only-grant feature is a new sharing layer on top, not a rewrite of `owner_id`.
9. **Class-table subtyping.** Base `entries` + `entry_transactions` (and `entry_trades` later) costs a join but buys typed subtype fields and real FKs; chosen over a discriminator + wide nullable/JSONB row.
10. **Row-version rollback anchoring.** The AAD `version` blocks casual ciphertext rollback, but against an *active* DB-write attacker the *expected* version must be anchored outside the DB (per-user counter / signed head) — an open question inherited from `threat-model.md` §7.4/§13, not resolved here.
11. **Transfer-detection false pairs.** Internal-transfer pairing is a background heuristic (`transfers` + `excluded`/`kind`); a mispair double-counts or hides a real flow, so pairing is reversible and surfaced to the user.
12. **Retention.** Raw entries are kept forever — never compacted into monthly aggregates. Because every aggregate is derived (no persisted rollups, no stored reporting leg), the raw ledger is the *sole* source of truth; discarding it to save space (trivial at family scale) would forfeit re-categorization, attribute-lock audit, and dedup. Compaction is explicitly a non-goal.
