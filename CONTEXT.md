# Moni

Moni is a self-hosted, multi-user personal finance app for Israeli households. This
file is the project's glossary — the words we use for domain concepts, and the ones
we deliberately don't. It holds no implementation detail; see `docs/design/` for that.

## Language

### Connecting and syncing

**Connection**:
One stored login at one financial institution, owned by exactly one user.
_Avoid_: Account (that's the thing a connection discovers), integration, link.

**Sync run**:
A single scrape attempt against one connection. Either it fully succeeds or it
records a failure and writes nothing.
_Avoid_: Job, import, refresh.

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

### Getting started

**Onboarded**:
Having at least one connection. There is no separate flag — the presence of a
connection _is_ the signal.
_Avoid_: Setup complete, activated.
