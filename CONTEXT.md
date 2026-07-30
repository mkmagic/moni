# Moni

Moni is a self-hosted, multi-user personal finance app for Israeli households. This
file is the project's glossary — the words we use for domain concepts, and the ones
we deliberately don't. It holds no implementation detail; see `docs/design/` for that.

## Language

### Connecting and syncing

**Connection**:
One configured data source at one financial institution, owned by exactly one
user. It discovers accounts through delegated access or a user-mediated import.
_Avoid_: Account (that's the thing a connection discovers), integration, link.

**Sync run**:
A single attempt to retrieve and promote data from one connection. Either it fully
succeeds or it records a failure and writes no new financial data.
_Avoid_: Job, import, refresh.

**User-mediated import connection**:
A connection whose sync run starts when the user uploads an official structured
export in an explicitly supported institution-specific format.
_Avoid_: Manual broker, manual positions, generic CSV import.

**Sync window**:
The date range a recurring sync run covers. Always computed by the server from the
connection's last successful sync; never chosen by a person.
_Avoid_: Date range, scrape period.

**Backfill window**:
The start date a user picks when they add a connection, applied to that connection's
**first** sync run only. Every later run uses the sync window instead. Capped at
twelve months, and optional — a user may link a connection without fetching
anything, in which case no sync run happens at all.
_Avoid_: History range, initial sync window, lookback.

**Sync reminder**:
A per-user preference that makes Moni **offer** a sync when the user signs in after
a long absence. It never syncs on its own — Moni cannot use a stored bank login
without the user's password, by design.
_Avoid_: Auto-sync, automatic sync on login (the `auto_sync_on_login` column keeps
that name for historical reasons; the concept is a reminder).

### Categorizing

**Match text**:
The normalized form of a transaction's description — Moni's single definition of
"the same payee text". Two transactions share a match text or they don't; there is
no partial identity.
_Avoid_: Normalized description, merchant key, payee string.

**Merchant**:
The payee behind a **match text**, given a row so a name and an icon have
somewhere to live. One per user, per match text — a merchant is a match text
that got promoted, not a separately-discovered thing.
_Avoid_: Payee, vendor, biller, counterparty.

**Suggestion**:
A proposed category for a transaction no rule could place. Derived on demand, never
authoritative, and never a category until a person accepts it — at which point it
becomes an ordinary human categorization with no lingering trace of having been
suggested.
_Avoid_: Prediction, guess, auto-category, AI category.

**Rejection**:
A person's ruling that a category is wrong for a **match text**, not for one
transaction. It suppresses that pairing from every future suggestion; it does not
stop a rule from assigning the same category.
_Avoid_: Thumbs-down, dismissal, veto, negative feedback.

### Recurring

**Recurring category**:
A category the user has flagged as one whose spending repeats — subscriptions,
utilities, rent, salary. The flag is the **only** thing that admits a merchant
to the recurring view; Moni never decides on its own that something recurs. A
flag on a parent covers its children.
_Avoid_: Subscription category, fixed expense, standing category.

**Cadence**:
How often a merchant charges — monthly, bi-monthly, quarterly, yearly, or
**irregular**. Read from the gaps between that merchant's transaction dates,
never stored, and never guessed: a payee with unstable spacing is irregular and
says so. The user may override it when the dates are not yet enough to tell.
_Avoid_: Frequency, interval, period, schedule.

### Getting started

**Onboarded**:
Having at least one connection. There is no separate flag — the presence of a
connection _is_ the signal.
_Avoid_: Setup complete, activated.

### Investments

**Instrument**:
A user-owned canonical identity for one investable asset across connections and
accounts. Source records unite only when strong evidence identifies the same asset.
_Avoid_: Ticker, symbol, or name as identity; global security.

**Position**:
The source-observed signed quantity of one instrument in one investment snapshot.
It is an account state observation, not a trade or tax lot.
_Avoid_: Activity, transaction, lot.

**Cash balance**:
A source-observed signed amount in one currency held within an investment snapshot.
It appears beside positions but is not an instrument or position.
_Avoid_: Cash instrument, cash position.

**Investment snapshot**:
The complete observed state of one investment account at a stated time, including
its positions, cash balances, source value, and valuation quality. The latest
snapshot is current state; at most one snapshot per week remains in history.
_Avoid_: Portfolio snapshot, lot history, activity ledger.

**Archived investment account**:
An investment account excluded from the current portfolio after it closes or its
assets move elsewhere, while its snapshots remain part of history.
_Avoid_: Deleted account, removed history.

**Source value**:
A financial institution's monetary assertion for a position or account at a stated
time. It is retained as evidence and does not overwrite Moni's valuation.
_Avoid_: Canonical value, calculated value.

**Valuation**:
The exact monetary value of a position from its broker observation, or of an account
or portfolio from its valued positions and cash. It carries explicit as-of,
currency, freshness, completeness, and valuation-basis context.
_Avoid_: Source value, balance, performance.

**Reconciliation mismatch**:
A quality state where a broker's account source value and Moni's summed account
valuation differ after both are rounded for ILS display. It does not replace or
invalidate Moni's valuation.
_Avoid_: Balance error, rejected snapshot.

**Portfolio**:
The consolidated calculated view of a user's investment accounts. A portfolio is
not a separately stored container; users can drill down from it by connection and
account.
_Avoid_: A user-created or broker-owned grouping.

**Portfolio value history**:
The calculated weekly series of a portfolio's total market value, including the
effect of deposits and withdrawals. A missing account snapshot may be carried
forward only in the view and makes that point explicitly stale; reporting
conversion uses the shared historical FX rate for each snapshot's real date. It
is not an investment-return measure.
_Avoid_: Performance, return, gain.
