# The backfill window is a one-time, twelve-month-capped, user-chosen start date

When a user adds a connection they pick how far back to pull. That date applies to
that connection's **first** sync run only; every run after it uses the server-computed
sync window (`computeSyncStartDate`, `min(today − 30d, lastSyncAt − 7d)`), which is
unchanged. The choice is capped at twelve months, enforced both in the picker and by
`SyncBodySchema` in `POST /api/connections/[id]/sync`, which returns 400 for a date
outside `[today − 12 months, today]`.

## Why

A scrape runs as a child process the API route kills after five minutes
(`CHILD_TIMEOUT_MS`), and fetch time grows with the window. An uncapped picker would
let a user ask for something that reliably times out — and because a failed run
writes nothing, they'd get no data *and* lose their choice. Twelve months is roughly
what the banks expose anyway.

Making the choice persistent was the alternative, and it's worse: reconciliation is
idempotent, so a stored "pull three years" would re-scrape three years on **every**
sync forever, for data already in the ledger. One-time also means no schema change —
the date travels in the `startDate` body field the sync route already accepted.

The window is also declinable: "Nothing for now" links the connection and starts
no sync run at all, for someone who wants an account tracked going forward and
has no interest in its history.

## Consequences

- An explicit `startDate` **bypasses** the sync window entirely, including its 30-day
  floor and 7-day overlap. That is intended: the floor exists to close gaps between
  recurring syncs, and a first sync has no gap to close.
- The date lives only in the connect wizard's React state. If the first sync fails and
  the user navigates away, a later sync from the connections list gets the ordinary
  30-day window. The wizard's own retry and "fix credentials" paths keep it.
- A future explicit backfill feature (re-pulling an old period on demand) has to raise
  or bypass the twelve-month refine deliberately, rather than inheriting it by accident.
