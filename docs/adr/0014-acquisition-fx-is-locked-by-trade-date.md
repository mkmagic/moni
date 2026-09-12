# Acquisition FX is locked by trade date

Tax-lot acquisition FX locks the Bank of Israel observation on the trade date, or
the latest observation on or before it within seven calendar days. The record keeps
the trade and settlement dates, actual observation date, decimal rate, convention,
provenance, and policy version. Unlike the revisable snapshot conversion in
[ADR 0009](0009-investment-valuation-trusts-broker-observations-and-boi-fx.md), this
rate is historical evidence: an unresolved lookup does not block ingest, and an
opening lot may carry a user-entered override with explicit provenance.

## Consequences

- ILS is the primary aggregate reporting currency, while native-currency facts and
  each return basis remain visible.
- Moni records cost-basis and gain data, not a tax verdict. The convention requires
  professional confirmation before any authoritative tax figure is presented.
