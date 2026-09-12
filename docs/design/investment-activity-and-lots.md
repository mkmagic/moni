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

IBKR is implemented first. SnapTrade follows only after the IBKR path works end to
end. Corporate-action evidence is retained but is deliberately not applied in v1,
and no path renders tax advice or permits AI writes.
