# External categorization caches per merchant, and only a merchant match text may leave

When Moni categorizes via an external source (an LLM — see issue #12, blocked on #3), the result is cached against the **match text**, never against an entry. And of everything Moni holds, **only a match text that names a merchant may be sent**: never the amount, date, account, balance, or any user identifier. Tier-0 secrets never leave under any circumstance. The feature is per-user opt-in and off by default.

No code implements this yet. It is recorded now because the decision was made while designing the local suggester (issue #2) and it is the reason `category_suggestions` was deleted rather than kept for the external path — that table was keyed per entry, which is the wrong unit.

The source is settled: **an LLM, not place search.** Measured on `feature/llm-transaction-categorization` (54 labeled Israeli strings, free-tier Gemini Flash-Lite): 28/28 on known chains, 11/11 on obscure single-branch merchants, zero fabrications on unplaceable strings. A place-search API covers a strict subset of the same work — it knows nothing about insurers, arnona, Bituach Leumi or standing-order debits — and its terms cap content caching at around 30 days, which contradicts the permanent cache this ADR is built on.

An external lookup answers a question about the merchant string, not about one transaction. `שופרסל דיל רמת גן` is a supermarket regardless of which of forty entries triggered the lookup, and it stays one next year. Per-entry lookups would spend forty calls and freeze forty rows; cached per match text it is one call, for all time, reused by every past and future entry sharing the text — including transactions not yet scraped.

The same mechanism is the privacy control, and that is the part worth not losing. Encrypting the cache protects the stored copy against a database dump; it does nothing about egress, and was never meant to. What actually limits egress is sending each distinct merchant string once instead of once per transaction — roughly a 40× reduction in what a third party observes, for free.

## Some match texts are people, and those never leave

`ביט העברה מישראל כהן` normalizes to a person's name. So do Paybox transfers and anything shaped `העברה ל…`. "Only the match text may leave" read literally permits these, and it must not: leaking an individual who never agreed to anything is categorically worse than leaking `שופרסל`, and unlike a merchant they cannot be looked up anyway.

So the rule is **merchant match texts only**. A deny-list of P2P and transfer keywords runs before egress, in the domain layer, matched as substrings of the normalized text exactly as the built-in rule table is (`categorization.md` §6). A text it catches is never sent and never cached.

This is a filter on a Tier-1 string, so it fails closed: an unrecognized text is sent only because no deny pattern matched it, and adding a pattern is the cheap fix when one is missed.

## On the constraint this narrows

Issue #2 originally said "no secrets (Tier-1 as well) should leak to 3rd party providers for categorization". Read literally that forbids every external method, since a match text *is* a Tier-1 counterparty string and no lookup can work without it. The rule above is the honest version: a third party learns that someone asked about `שופרסל דיל`, with no sum and no timeline attached to it.

**Pseudonymous, not unlinkable** — this ADR previously claimed "no person", and that was too strong. The API key is a stable identifier, and under #3 it is configured per user, so the provider sees one person's merchant stream under one long-lived pseudonym. Not a name, not an amount, not a date, and not linkable to a Moni account by anyone but the key's owner. But a provider can accumulate "this key shops at these merchants" over time, and the honest version of the guarantee says so.

## Consequences

- Rules-only mode and the local suggester must keep working with this disabled. That is a hard invariant (`AGENTS.md`), not a courtesy — and it is why the local engine shipped first, as the permanent default rather than a stepping stone.
- The cache table is deliberately **not** created until a source writes to it. An empty table with no writer and no consumer is where subtle design errors hide.
- The cache key is Tier-1 and therefore encrypted, with the same decrypt-once-per-batch lookup as `category_rejections` (see ADR 0002).
- **One lookup per text is not one request per text.** Distinct texts are batched into a single call, which is what makes a cold start — the largest backlog a user will ever have — a handful of requests inside a free tier. The per-text cap in this ADR governs what is *asked*, not how many round trips ask it.
- **But the batch size is a correctness parameter, not a cost knob.** At 25 texts per request, three real restaurants came back as groceries with high confidence and the correct brand named; isolated, the same three texts are right every time. A numbered list is one completion and per-item attention degrades as it grows, and instructing the model that the items are independent does not fix it (measured — no change). Ten is where accuracy and the free tier's **15 requests per minute** meet. Anyone raising it to save calls is trading away answers, silently.
- **A suggestion whose classification contradicts the entry's direction is dropped locally.** `ביטוח לאומי גביה` is income when Bituach Leumi pays and a levy when it collects, and the only disambiguator is the amount's sign — which never leaves. It does not have to: Moni knows the direction, and `flows.ts` knows each category's `classification`. This costs nothing and removes the whole class of error that withholding the amount would otherwise cause.
