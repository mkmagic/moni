# Activity reconciles to authoritative snapshots

Investment snapshots remain authoritative for current holdings; replayed activity
is a projection that must reconcile to them. Moni records mismatches by dimension
and prompts the user to close history gaps with opening-lot evidence, never with an
automatically synthesized plug lot. This extends the evidence-versus-calculation
boundary established by [ADR 0008](0008-investments-use-weekly-account-state-snapshots.md)
and [ADR 0009](0009-investment-valuation-trusts-broker-observations-and-boi-fx.md).

## Consequences

- Quantity gaps are scoped by account and instrument; cash gaps by account and
  currency. Coverage, unexplained opening quantity, unsupported corporate actions,
  and pending activity remain explicit quality dimensions.
- Coverage records distinguish provider-declared starts from earliest-observed
  starts. An affected metric or instrument becomes partial or unknown without
  hiding unrelated complete results.
