# A merchant is a match text that got promoted, and it is written in three layers

`merchants` has existed since the first migration and has never held a row.
Nothing writes it, `entries.merchant_id` is never set, and the one read
(`transactions.ts:154`) resolves a column that is always null. The recurring
view (#15) is the first feature that needs a payee to have a *name* and an
*icon*, which is the first thing a match text cannot carry — so this is where
the table finally gets a writer.

The identity is not new. `normalizeDescription`'s own first line is "The single
definition of 'the same merchant text'", and both ADR 0002 and ADR 0003 already
key on it in preference to the per-entry alternative. A merchant is therefore
**one row per distinct match text**, not a separately-discovered entity: the
match text remains the identity, and the merchant row is where the display name,
the icon and the cadence override hang off it.

## Written in three layers, mirroring categorization

1. **A shipped catalog.** Patterns matched against the match text resolve known
   payees — Netflix, Spotify, Cellcom, Partner, Bezeq, HOT — to a real name and
   a bundled icon. Matching is *contains*, not equality, because Israeli card
   descriptions arrive as `PAYPAL *NETFLIX`, which normalizes to
   `paypal netflix` and would miss an exact-match catalog entirely.
2. **Auto-created from the match text.** Every payee the catalog does not know
   still gets a row, named after its own bank string. Ugly, and renameable.
3. **External lookup, if and when #12 ships.** Cached per match text under
   ADR 0003, per-user opt-in, off by default.

Layer 2 is the load-bearing one. It means the recurring view is complete on day
one with no catalog coverage and no external source — the same reason the local
suggester shipped before any model integration.

## Consequences

- **`merchants.match_text_ct` is encrypted, so there is no unique constraint.**
  A match text is a Tier-1 counterparty string (`security-design-principles.md`
  §13) and ciphertext is randomized, so two rows for one payee look different to
  Postgres. Deduplication happens in the domain layer against a decrypted set,
  exactly as `category_rejections` and `rule_conditions.value_ct` already do.
- **`merchants.cadence_override` is plaintext.** It is an enum string with no
  user-specific content — Tier-2, like `categories.name`.
- **The recurring view does not read `entries.merchant_id`.** It re-derives the
  identity from each entry's description, and looks a merchant row up by that
  identity only for the display name, the icon and the cadence override. So the
  view is complete for history scraped long before merchant resolution existed,
  and correct on the very first render after this ships.
- **There is deliberately no backfill of `entries.merchant_id`.** Resolution
  runs during sync promotion, so the column fills in going forward and stays
  null for older rows. A one-off pass was written and then deleted: nothing
  needed it (the view derives its own identity, and the cadence override
  creates a merchant on demand), and it could not have run outside a request
  anyway — a data key lives in RAM only, so no CLI or migration can decrypt a
  description to resolve one. The visible cost is that the transactions table's
  merchant column stays empty for entries scraped before this change.
- **Renaming a merchant renames it everywhere, forever.** That is the point —
  one rename fixes every past and future transaction sharing the text — but it
  also means a rename applied to an over-broad match text (a bare `PAYPAL`)
  mislabels everything underneath it. The mitigation is that
  `normalizeDescription` keeps the suffix, so `paypal netflix` and
  `paypal spotify` stay distinct; only a payee whose bank string is genuinely
  identical can collide.
- **A merchant belongs to one category at a time** — the one its most recent
  entry carries. A payee split across two recurring categories (Google One under
  Subscriptions, Google Workspace under Business) appears once. Keying rows on
  the (merchant, category) pair would fix it and costs a table; the case is rare
  enough that it was not worth one.
