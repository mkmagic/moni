# Investment valuation separates broker evidence, market estimates, and BOI FX

Moni 1.1 preserves a source-date valuation from each accepted broker or statement
snapshot and may also calculate a newer current estimate. Source-date positions use
the broker-reported market value when present and otherwise exact quantity × the
broker-reported price. For supported active USD ETFs and common stocks on the major
US venues, the current estimate uses the last accepted quantity × the latest usable
Tiingo end-of-day close, plus last-known cash. Other instruments, missing or stale
quotes, and unsafe post-corporate-action observations fall back to the broker value
and remain visibly stale. Bank of Israel observations convert both bases to ILS.

## Supported venues

The estimate is limited to instruments whose provider-reported venue is NYSE or
Nasdaq. "NYSE" here means the NYSE group as an issuer venue, not the NYSE order
book alone: NYSE Arca and Cboe BZX are included, because most US-listed ETFs are
listed there and a literal reading would leave the ETF case matching almost
nothing. Providers that report ISO 10383 MIC codes translate them at the adapter
boundary (`XNYS`, `XNAS`, `ARCX`, `BATS`), and an unrecognized venue passes through
untranslated so it stays ineligible rather than being guessed at. The venue is read
from the instrument's per-provider source mapping, which is refreshed when the
provider reports different descriptive metadata; a mapping written before a
translation existed must not pin an instrument to the wrong venue forever.

## Consequences

- A nonzero position without a broker market value or usable broker price rejects
  the complete connection refresh. A broker account total cannot conceal an
  unvalued component.
- A broker account total that differs from Moni's component sum after ILS display
  rounding produces a non-blocking reconciliation-mismatch quality state. Where a
  position's value was derived as quantity × price rather than reported directly,
  the comparison allows what the reported price's own rounding can conceal —
  quantity × half of the price's last reported digit, plus the same allowance on
  the broker total. That allowance is zero whenever every position carried a
  reported market value, so a directly-valued source is still compared exactly. It
  is bounded by the provider's stated precision and cannot absorb a missing
  holding.
- Where a holding is denominated in a currency other than the one the broker
  stated its account total in, the comparison additionally allows 0.5% of the
  converted amount. This is not slack for imprecision: the broker converted that
  holding with its own rate at its own mark time, Moni converts it with BOI's
  representative rate, and BOI fixes one rate per day in the early afternoon
  Israel time. Requiring exact agreement asks two independent FX authorities to
  publish the same number, so a USD holding inside an ILS-denominated total would
  report a mismatch on every sync forever — observed live at 6.2 bps apart with a
  rounding allowance of exactly zero. The allowance is proportional to the
  cross-currency portion only; an account whose holdings and total share a
  currency is still compared as exactly as before, and a genuinely missing
  position lands orders of magnitude outside it.
- `reconciliation_state` is a cached judgement rather than an observation, so
  `investment_snapshot_details.validation_version` records which revision of
  these rules produced it. A source that re-serves a byte-identical statement is
  normally promoted as `unchanged`, which would strand a corrected rule until the
  provider happened to publish something new — over a weekend, that is never.
  Bumping the constant makes the next sync recompute instead of taking the
  fingerprint-match fast path.
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
  substituted. Broker evidence is current in the present or immediately preceding
  Israeli Sunday–Saturday week; older source evidence remains in current totals
  until the account is archived, visibly stale.
- Tiingo closes arrive as exact CSV decimal text with explicit price currency and
  source date. A quote older than seven calendar days is unusable. Quote refresh is
  best-effort and separate from atomic broker/import promotion: quote failure never
  rejects a valid source snapshot.
- An estimate never replaces broker evidence that is already newer than the quote:
  a close is usable only when the broker observation is no more than one day past
  the close's date. A source reporting an intraday timestamp is therefore
  ineligible until that day's close is published, which is the intended outcome —
  substituting a previous-day close for a same-day broker price would make the
  valuation worse. Sources reporting a plain date sit at midnight and clear this
  boundary a day earlier than sources reporting a timestamp.
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
  short-lived market-data worker that receives no broker credentials. It is enabled
  only when `MONI_TIINGO_MULTI_USER_AUTHORIZED=true` explicitly attests that the
  deployment has provider permission for shared multi-user use; otherwise refresh is
  a local no-op and broker fallback applies. Both that flag and the token are
  required together, including for a single-user deployment.
- The token is supplied in the Authorization header. Its mutable byte copy is wiped,
  while the HTTP client's unavoidable immutable header string is confined to the
  worker lifetime and never logged. There is no scheduler: refresh is
  user-triggered, at most once per day for a given current-estimate action.
- The quote worker reports how many instruments it attempted and how many quotes it
  replaced, and nothing else, on the one channel the request path reads. Callers can
  distinguish an unconfigured refresh, a refresh with no eligible holdings, and a
  refresh that wrote quotes; a fallback to broker values is not by itself evidence
  that the estimate path failed.
