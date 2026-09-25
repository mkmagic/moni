# Investment activity identity preserves ambiguity

Moni identifies investment activity with a provider identifier first, a documented
provider-specific composite second, and a keyed fingerprint only as an edge-case
fallback. Overlapping sync windows may revise an existing event, but an ambiguous
fingerprint match is queued for review rather than silently merged, because two
otherwise identical fills can both be genuine. IBKR `ibExecID` is the first
implementation; SnapTrade follows with account plus activity ID and overlap
handling for provider reprocessing.

## Consequences

- Activity and corporate-action evidence remains durable and revision-aware.
- Provider identifiers, fallback fingerprints, financial values, and descriptions
  are encrypted before their first database write.
- Raw provider payloads remain short-lived and are not retained.
