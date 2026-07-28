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

### Getting started

**Onboarded**:
Having at least one connection. There is no separate flag — the presence of a
connection _is_ the signal.
_Avoid_: Setup complete, activated.
