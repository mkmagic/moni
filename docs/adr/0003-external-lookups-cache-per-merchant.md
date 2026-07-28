# External categorization caches per merchant, and only the match text may leave

When Moni eventually categorizes via an external source (place search, Maps, or an LLM — see issue #12, blocked on #3), the result is cached against the **match text**, never against an entry. And of everything Moni holds, **only the match text may be sent**: never the amount, date, account, balance, or any user identifier. Tier-0 secrets never leave under any circumstance. The feature is per-user opt-in and off by default.

No code implements this yet. It is recorded now because the decision was made while designing the local suggester (issue #2) and it is the reason `category_suggestions` was deleted rather than kept for the external path — that table was keyed per entry, which is the wrong unit.

An external lookup answers a question about the merchant string, not about one transaction. `שופרסל דיל רמת גן` is a supermarket regardless of which of forty entries triggered the lookup, and it stays one next year. Per-entry lookups would spend forty calls and freeze forty rows; cached per match text it is one call, for all time, reused by every past and future entry sharing the text — including transactions not yet scraped.

The same mechanism is the privacy control, and that is the part worth not losing. Encrypting the cache protects the stored copy against a database dump; it does nothing about egress, and was never meant to. What actually limits egress is sending each distinct merchant string once instead of once per transaction — roughly a 40× reduction in what a third party observes, for free.

## On the constraint this narrows

Issue #2 originally said "no secrets (Tier-1 as well) should leak to 3rd party providers for categorization". Read literally that forbids every external method, since a match text *is* a Tier-1 counterparty string and no lookup can work without it. The rule above is the honest version: a third party learns that someone asked about `שופרסל דיל`, with no person, no sum and no timeline attached to it.

## Consequences

- Rules-only mode and the local suggester must keep working with this disabled. That is a hard invariant (`AGENTS.md`), not a courtesy — and it is why the local engine shipped first, as the permanent default rather than a stepping stone.
- The cache table is deliberately **not** created until a source writes to it. An empty table with no writer and no consumer is where subtle design errors hide.
- The cache key is Tier-1 and therefore encrypted, with the same decrypt-once-per-batch lookup as `category_rejections` (see ADR 0002).
