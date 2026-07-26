# Moni — Money & Multi-Currency

**Purpose:** Exact-decimal money handling and the multi-currency model, pinned unambiguously enough that no code ever reaches for a float. This is a load-bearing invariant, not a preference — see `conventions.md` (Money/Currency) and the Non-Negotiable Invariants in `CLAUDE.md`.

The governing rule: **a monetary value is an exact decimal from ingest to storage, and is converted to display units only at the very edge.** Finlynq — our main reference — got this wrong twice: it stores amounts as JS `number` (float), and it values *everything*, including historical flows, *live on read at today's rate* — so a past month's spending total shifts as the market moves. Moni stores exact decimals and applies today's rate only where it is correct (current balances — a *stock*), never to historical flows (§5).

## 1. Representation

- **Canonical form is an exact decimal, carried as a string.** Postgres `NUMERIC` is the storage type for any plaintext money column; Drizzle maps `NUMERIC` to a JS `string` to preserve precision. A money value is **never** a JS `number`/float, not even transiently — not in a variable, an intermediate, a JSON round-trip, or a test fixture.
- **Arithmetic goes through `decimal.js`.** Construct `Decimal` from the string, compute, serialize back to a string. Never native `+`/`-`/`*`/`/` on a monetary value. `decimal.js` (not `dinero.js`) because our values live as arbitrary-precision `NUMERIC` strings and FX conversion needs high-precision multiplication across differing minor-unit scales; `decimal.js` is the arithmetic layer, with a thin `{ amount: string, currency: string }` money type on top.
- **Encryption interaction.** Sensitive Tier-1 amounts are encrypted at rest (`../security/threat-model.md` §7.4), so those columns are ciphertext, not a queryable `NUMERIC`. The exact-decimal contract still governs: the plaintext *inside* the ciphertext is the canonical decimal string, and it is decrypted, computed on with `decimal.js`, and re-encrypted — never widened to a float in between. `NUMERIC` as a physical column type therefore applies only to money that is **not** encrypted (e.g. reference/aggregate data that isn't user-sensitive). Dashboards **decrypt a narrowed set of rows and aggregate in the domain layer** — v1.0 persists no rollups — see `encryption.md` and `data-model.md` §4.3/§6.

## 2. The currency triple

Every monetary entry stores three amount/currency pairs plus a locked rate. This is Finlynq's one good money idea, adopted as-is:

| Leg | What it is | Example |
|---|---|---|
| **entered** | The amount/currency as it originated (what the user typed or the statement line showed). | 100 USD |
| **account** | The amount/currency the holding account is denominated in. | 370 ILS |
| **reporting** | The value in the user's **base currency** (§5), **for aggregation and dashboards** — *derived on read*, not stored (see rules below). | 370 ILS (or 100 USD if base = USD) |

Plus, stored on the entry:
- **`fxRate`** — the rate used to reach the reporting amount, and
- **`fxRateDate`** — the date that rate applies to (the transaction date).

Rules:
- **The reporting amount is derived on read — `reporting = entered × fxRate` — not stored. What is stored and *locked* is the `fxRate`.** Because the rate is locked at the transaction date, the derived result is identical on every read and independent of any live rate. This is the correct behaviour for **flows** (income/expenses): a $100 purchase when USD=3.70 is ₪370 of spending forever, and last March's total must not move because the rate moved in July. The Finlynq bug — recomputing on every read at *today's* rate, so an unchanged history shows a different total each day — is avoided by locking the *rate*, **not** by persisting the *amount*. We deliberately do **not** store a `reporting_amount_ct`: once amounts are encrypted the database cannot `SUM` them anyway (the domain layer decrypts and sums either way), so persisting the reporting leg buys nothing on the read path while adding a redundant ciphertext column and forcing a **ledger-wide re-encryption on any base-currency change** (§7). This reverses an earlier version of this doc; the full reasoning is traced in `data-model.md` §4.3, now the authority on the schema. The stock-vs-flow distinction and *viewing* in a currency other than the base are handled in §5.
- **The rate is locked at the transaction date**, not the ingest date and not "now". A transaction dated 2026-03-01 scraped on 2026-03-05 uses the 2026-03-01 rate.
- entered and account amounts are **ground truth** and are stored verbatim from the source. Where entered currency == account currency == reporting currency, the entered and account legs hold the same value, the derived reporting value equals them, and `fxRate` is `1` — the triple is uniform, not special-cased away.

## 3. Rounding

- **Never round intermediate arithmetic.** Compute at full `decimal.js` precision.
- **Never round a *stored* value.** Persist entered/account amounts at their source scale. The reporting amount is not stored; it is derived from `entered × fxRate` at full `decimal.js` precision on read, then summed. Because the inputs are exact and the rate is locked, the derived sum is exact and stable — there is no "1 cent drift between two endpoints" class of bug (a real Finlynq defect its own code documents).
- **Round only at the display edge** (UI / serialization), to the displayed currency's minor unit, using `ROUND_HALF_UP`. Rounding **never** happens in the domain/service layer.

## 4. FX sourcing & missing rates

- **Rates come from an FX/market-data provider behind the generic provider interface** (shape adapted from Ghostfolio's market-data provider), fetched by the pg-boss worker as a background job and cached outside the request cycle. v1.0 ships one provider.
- The rate for an entry is the provider's rate for `entered → reporting` **as of the transaction date**. Store the rate, its date, and its source alongside the entry.
- **A missing rate never blocks ingest and is never faked.** entered and account amounts are ground truth and persist regardless. If no rate is available for the transaction date at ingest, `fxRate` is left null and the entry is flagged `fx_status = 'pending'`; its reporting value is simply unavailable (nothing is stored to backfill) until a background job locks the rate once it exists. Never substitute a silent `1:1`, never fall back to today's rate to "fill the gap." On-the-fly aggregation surfaces or excludes pending entries rather than silently under/over-counting.

## 5. Base currency vs. display currency (stock vs. flow)

"Show me my totals in ILS (or USD)" is **two operations with two different rates**, and using one rate for both is the classic multi-currency bug. Moni separates two concepts:

- **Base currency** — one per user, the currency in which flow history is *stored and exactly summed*, locked at transaction date (§2). Default **ILS** (Israeli-first), user-configurable. This is the fast, exact, canonical path.
- **Display currency** — a view-time *toggle* that reconverts for reading only and never touches stored data.

Which rate a total uses depends on whether it is a **stock** or a **flow**:

| Total | Kind | Rate to use |
|---|---|---|
| Income / expenses / category spend over a period | **flow** | Each transaction at **its own transaction-date rate**, then summed. A period total must not move as rates move. |
| "Net worth / balances **right now**" | **stock** | Each account's **current native balance at today's latest rate**. This *should* move with the market — that is correct valuation, not drift. |
| "Net worth **as of** a past date" | **stock** | Native balance at that date × the rate **on that date**. |

So a flow total is a sum of historically-locked amounts; a current-balance total is a live conversion off the latest rate. Never value flows at today's rate, and never value "current net worth" at historical per-transaction rates.

**Base currency (stored, expensive to change)** vs. **display currency (read-time, free to toggle):**
- Viewing in the **base currency** derives each entry's reporting value from its locked `fxRate` during the decrypt pass the read already performs, then aggregates in the domain layer — exact, no live-rate lookups. (v1.0 persists no rollups; see `data-model.md` §6.)
- Viewing in **another** currency reconverts on read: stocks at today's rate, flows at each period's historical rate (period close/average) — *not* today's rate, so history stays honest under the toggle. This costs a rate lookup per bucket, never a re-lock or backfill. It is the same decrypt-then-derive path used for the base currency, just against a different rate series.

**v1.0 scope.** The base-currency model and the stock-vs-flow rule are committed **now** so nothing bakes in a single-rate assumption. The **display-currency toggle itself is deferred past v1.0** — v1.0 renders everything in the user's base currency. What v1.0 must still get right regardless of the toggle: current balances of a foreign-currency account are a *stock* and are shown at the latest rate, not the rate locked on each historical movement.

## 6. Display formatting

- **Formatting lives at the edge only** — never in the domain layer, which deals exclusively in exact values. The domain layer returns `{ amount: string, currency }`; the UI/serialization layer applies locale, symbol, and minor-unit rounding.
- Symbol/locale handling (e.g. `Intl.NumberFormat`, custom symbols for same-symbol currencies, graceful fallback for non-ISO-4217 codes) is a presentation concern and may borrow Finlynq's `formatCurrency` approach — but it operates on a value already converted from the canonical string at the boundary.

## 7. Changing the base currency

Because reporting amounts are **derived, not stored**, changing the base currency touches **no ciphertext** — there is no stored reporting leg to re-encrypt, and no rollups to recompute. Each entry's reporting value is re-derived on read from *that entry's transaction-date rate* looked up in the **new** base currency (`fx_rates`), exactly as the display-currency path does (§5). The base currency remains a stored per-user setting (`users.base_currency`); an entry's cached plaintext `fxRate`/`reporting_currency` reflect the base *at write*, and a background job may refresh those plaintext caches for the fast path, but **no amount ciphertext is ever rewritten**. Avoiding that ledger-wide re-encryption on every base-currency change is the concrete payoff of deriving rather than storing the reporting leg (traced in `data-model.md` §4.3). Any transaction-date rate missing in the new base is backfilled by the FX job like any other pending rate (§4).

## Open questions
- `NUMERIC` scale policy for the (few) plaintext money columns, and the internal precision cap for `decimal.js` intermediate FX products.
- Exact FX provider(s) for v1.0 and the rate convention (daily close vs. mid vs. a specific published fixing), plus whether ILS↔USD gets a preferred source given the Israeli-first focus.
- Backfill/consistency for late-arriving FX rates (locking a previously pending `fxRate`, and refreshing any cached plaintext `fxRate`/`reporting_currency` after a base-currency change) — shares the open question in `encryption.md` and `../security/threat-model.md` §13.
- For the deferred display-currency toggle (§5): whether flow periods reconvert at period **close** or period **average**, and the historical-rate coverage the FX provider must guarantee for any currency a user might view in.

**Related:** `conventions.md` · `data-model.md` · `encryption.md` · `../../vision.md`
