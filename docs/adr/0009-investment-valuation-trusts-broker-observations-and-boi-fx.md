# Investment valuation trusts broker observations and Bank of Israel FX

Moni 1.1 adds no independent securities market-data feed. A position uses its
broker-reported market value when present and otherwise uses its exact quantity
multiplied by the broker-reported price. An account valuation is the sum of those
position values and its cash, converted to ILS; the broker's account total remains
separate source evidence. This makes holdings, allocations, account totals, the
portfolio, and net worth reconcile without adding the licensing, identity mapping,
and timestamp conflicts of a second price authority.

## Consequences

- A nonzero position without a broker market value or usable broker price rejects
  the complete connection refresh. A broker account total cannot conceal an
  unvalued component.
- A broker account total that differs from Moni's component sum after ILS display
  rounding produces a non-blocking reconciliation-mismatch quality state.
- `account_balance_snapshots` remains the dated account-observation parent and the
  net-worth domain-service seam, but an investment row has no persisted canonical
  balance. Its otherwise-required `native_balance_ct` is null for this subtype, and
  the service derives the ILS value from positions, cash, and shared FX. This avoids
  rewriting encrypted rollups whenever current FX or a historical correction changes.
- Source valuation timestamps remain authoritative. A position inherits the
  account source time only when it has no more specific source time; import time is
  never substituted. Any component older than seven calendar days makes the account
  and consolidated value visibly stale, but the last accepted value remains in
  current totals until the account is archived.
- Native amounts and currencies remain visible. Consolidated investment and
  net-worth reporting is ILS-only in 1.1.
- Bank of Israel representative rates are the sole 1.1 investment FX authority.
  Moni reads bounded SDMX CSV responses, normalizes every published currency and
  unit multiplier, and performs exact-decimal multiplication without a JavaScript
  float.
- A valuation uses the latest BOI observation on or before its relevant date. An
  observation more than seven calendar days old is unavailable and rejects the new
  snapshot; Moni never substitutes a later date, broker FX, or `1:1`.
- User-triggered refreshes fetch and cache BOI observations; portfolio and dashboard
  reads perform no external I/O. Current values use the newest accepted local BOI
  observation, while weekly history uses each snapshot's real date.
- BOI corrections replace the shared cached observation and may correct derived
  value history. Investment snapshots do not copy or lock FX rates. Future tax-lot
  FX evidence requires its own locking policy.
