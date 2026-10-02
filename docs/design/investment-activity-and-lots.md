# Investment activity and lots wayfinder

Issue [#135](https://github.com/mkmagic/moni/issues/135) layers durable investment
activity evidence and reproducible tax lots beside the existing weekly snapshot
model. Snapshots continue to answer what the user owns; this feature explains how
the position arose and whether cost-basis and return figures are complete.

## Decisions

- [Activity identity](../adr/0011-investment-activity-identity-preserves-ambiguity.md)
- [Versioned lot derivation](../adr/0012-tax-lots-are-versioned-derivations.md)
- [Snapshot reconciliation](../adr/0013-activity-reconciles-to-authoritative-snapshots.md)
- [Locked acquisition FX](../adr/0014-acquisition-fx-is-locked-by-trade-date.md)

## Code seams

- `src/db/schema/investments.ts` — durable evidence, derivation cache, coverage,
  reconciliation, and resolution records.
- `src/lib/investments/evidence.ts` — provider-neutral activity and opening-lot
  contracts.
- `src/domain/investment-lots.ts` — later-wave deterministic derivation seam.
- `src/domain/investment-valuation.ts` — later-wave snapshot reconciliation seam.

IBKR and SnapTrade (Schwab) both feed activity through the same seam: the worker
passes parsed activity to snapshot promotion, which ingests it in the same
transaction, so a connection's first sync already brings lots and dividends.
SnapTrade reports no lots and its Schwab history stops about two years back, so
holdings older than that arrive as opening lots, and cash held before it as
opening cash (`investment_opening_cash_evidence`, entered from the cash gap's
resolution screen). Opening cash only seeds cash reconciliation; it is never an
external flow. Corporate-action evidence is retained but is deliberately not applied in v1,
and no path renders tax advice or permits AI writes.
