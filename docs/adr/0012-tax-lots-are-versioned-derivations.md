# Tax lots are versioned derivations

Moni keeps activity and opening lots as durable evidence and treats tax lots as a
recomputable cache produced by a named, versioned policy. A disposal uses a
broker-reported lot allocation when one exists; otherwise the user must select the
relieved lots, with no silent FIFO default. This costs more storage than persisting
only current lots, but lets policy changes and bug fixes rebuild results without
mutating the only surviving financial record.

## Consequences

- Completeness is reported independently for dividends, TWR, MWR, and realized
  gain, and per instrument for cost basis.
- Every corporate action is retained as unsupported evidence in v1, but no
  corporate-action math changes lots. A future policy can replay that evidence.
- The model is instrument-general, while v1 exposure is limited to fixture-proven
  IBKR and then SnapTrade data plus the dedicated opening-lot importer.
