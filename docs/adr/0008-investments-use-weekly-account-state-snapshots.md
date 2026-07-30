# Investments use weekly account-state snapshots

Moni 1.1 represents an investment account as complete, source-dated snapshots
containing positions and per-currency cash balances. The latest snapshot is current
state, one Sunday-through-Saturday snapshot per account is retained indefinitely,
and consolidated portfolio values are derived rather than stored. This uses more
rows than retaining account totals alone, but gives current and historical reads one
model without prematurely introducing Ghostfolio-style activities, trades, or tax
lots.

## Consequences

- A per-user canonical instrument may unite broker records only when durable
  identifiers match without type or currency conflict. Tickers and names never
  establish identity; ambiguous records remain separate.
- `account_balance_snapshots` remains the sole absolute-value and net-worth seam.
  An investment-specific 1:1 detail row supplies snapshot metadata and owns the
  position and cash children.
- A later accepted observation replaces the active normalized snapshot for the same
  account and week atomically. Repeated source rows for one instrument aggregate
  into one exact signed-decimal position.
- Broker source values remain separate from Moni valuations. Unsupported instruments
  participate through clearly labeled broker values but receive no specialized
  analytics.
- Missing account weeks are carried forward only while calculating a read and make
  the resulting portfolio point explicitly stale; Moni writes no synthetic snapshot
  or portfolio rollup.
- Historical display converts through shared local FX history populated on demand by
  user-triggered refreshes. FX rates are not copied onto investment snapshots, and
  1.1 adds no scheduler.
- API connections retain only their latest accepted raw payload; every accepted
  user-uploaded source file is retained. Failed refreshes retain sanitized error
  metadata only.
- Closing an account archives it through explicit user action and preserves history.
  Disconnect and permanent deletion remain separate operations.
- Trades, lots, returns, corporate actions, tax calculations, and user identity
  overrides remain deferred; snapshots do not pretend to provide their event
  lineage.
