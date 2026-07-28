# Suggestions are derived; only rejections are stored, keyed by match text

Layer 3 of the categorization pipeline was scaffolded as `category_suggestions`: one row per entry, unique on `(owner_id, entry_id)`, written by a model pass and frozen forever — a null `category_id` meaning "asked, got nothing, never ask again". We deleted that table and replaced it with `category_rejections`, keyed on the **match text**. Suggestions are now computed on render and never stored at all.

The freeze existed for a source that costs money per call. The source we shipped is local IDF-weighted similarity over the user's own history, which costs nothing to re-ask and whose answer *should* change: a transaction with no lookalike in January may have three by March. Freezing a free suggestion is not caution, it is a guarantee of staleness. And an accepted suggestion needs no row either — it becomes an ordinary categorization, leaving a category, an attribute lock and a changelog row behind it. Rejection is the only verdict with no other home.

Keying the rejection on the match text rather than on the entry is what makes the feature answer the complaint that opened it. The issue was "the user has to do this for many transactions"; a per-entry rejection reproduces it exactly, asking for forty thumbs-down on forty transactions of the same shop.

## Consequences

- **A rejection suppresses suggestions only.** Rules may still assign that category, the learner may still write one, and manual categorization is untouched. That is what keeps the blast radius of a merchant-wide suppression small enough to accept.
- **The key column is encrypted.** A match text is a normalized counterparty string — Tier-1 under `security-design-principles.md` §13. A blind index (HMAC) would have bought SQL equality at the price of an equality-and-frequency oracle over payee strings, which `threat-model.md` §133 already rejects for searchable encryption. So `match_text_ct` is decrypted once per batch and matched in memory, exactly as `rule_conditions.value_ct` is.
- **No unique constraint is possible.** Ciphertext is randomized, so two rows for the same pairing look different to Postgres. Deduplication happens in the domain layer, which was already decrypting the set.
- **Suggestion cost is paid per render**, not per pass: one corpus build (decrypting every categorized entry) per page. Measured against `dashboard.ts`, which already decrypts every entry in a period, this is the same cost class. If it ever stops being, the fix is a bound on the corpus, not a stored suggestion.
