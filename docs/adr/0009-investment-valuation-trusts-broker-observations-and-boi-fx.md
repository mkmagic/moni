# Investment valuation separates broker evidence, market estimates, and BOI FX

Moni 1.1 preserves a source-date valuation from each accepted broker or statement
snapshot and may also calculate a newer current estimate. Source-date positions use
the broker-reported market value when present and otherwise exact quantity × the
broker-reported price. For supported active USD ETFs and common stocks on NYSE or
Nasdaq, the current estimate uses the last accepted quantity × the latest usable
Tiingo end-of-day close, plus last-known cash. Other instruments, missing or stale
quotes, and unsafe post-corporate-action observations fall back to the broker value
and remain visibly stale. Bank of Israel observations convert both bases to ILS.

## Consequences

- A nonzero position without a broker market value or usable broker price rejects
  the complete connection refresh. A broker account total cannot conceal an
  unvalued component.
- A broker account total that differs from Moni's component sum after ILS display
  rounding produces a non-blocking reconciliation-mismatch quality state.
- Reconciliation compares the broker total with the source-date component
  valuation. A newer market estimate never creates or clears a reconciliation
  mismatch.
- `account_balance_snapshots` remains the dated account-observation parent and the
  net-worth domain-service seam, but an investment row has no persisted canonical
  balance. Its otherwise-required `native_balance_ct` is null for this subtype, and
  the service derives the ILS value from positions, cash, and shared FX. This avoids
  rewriting encrypted rollups whenever current FX or a historical correction changes.
- Source valuation timestamps remain authoritative. A position inherits the account
  source time only when it has no more specific source time; import time is never
  substituted. Old source evidence remains in current totals until the account is
  archived, even when it is stale.
- Tiingo closes arrive as exact CSV decimal text with explicit price currency and
  source date. A quote older than seven calendar days is unusable. Quote refresh is
  best-effort and separate from atomic broker/import promotion: quote failure never
  rejects a valid source snapshot.
- A non-1 split factor dated after the accepted quantity makes that quote unusable
  until a new broker or statement snapshot establishes a post-action quantity. Moni
  1.1 does not synthesize corporate-action adjustments.
- Weekly history remains source-date broker evidence. Tiingo updates only the current
  estimate in 1.1, so it does not rewrite historical snapshots.
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
- One instance-wide Tiingo token is configured outside the database and used by a
  short-lived market-data worker that receives no broker credentials. The current
  deployment is single-user. Enabling this shared feed for more than one user is
  gated on written provider permission for that use; Moni does not silently broaden
  a personal internal-use license.
- The token is supplied in the Authorization header. Its mutable byte copy is wiped,
  while the HTTP client's unavoidable immutable header string is confined to the
  worker lifetime and never logged. There is no scheduler: refresh is
  user-triggered, at most once per day for a given current-estimate action.
