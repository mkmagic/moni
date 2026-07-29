# Moni — Categorization

**Purpose:** The deterministic-first, suggestion-as-fallback pipeline that assigns a category to a ledger entry, and how it interacts with attribute-locking.

**Related:** `../../vision.md` · `conventions.md` · `data-model.md` · `domain-layer.md`

---

## 1. Resolution order

Every entry runs through these layers in order. The first one to produce a category wins; nothing downstream is consulted.

| # | Layer | Source | Where |
|---|---|---|---|
| 0 | **Attribute lock** — a human already set this field, so the entry is skipped entirely | — | `src/domain/attribute-locks.ts` |
| 1 | **User rules**, including learned ones, ranked by specificity | `rules` + `rule_conditions` + `rule_actions` | `src/lib/categorization/matcher.ts` |
| 2 | **Built-in rules** — the shipped Israeli merchant keyword table | code constants | `src/lib/categorization/builtin-rules.ts` |
| 3 | **Suggestion** — *proposed* to a person, never written | derived on render | `src/lib/categorization/similarity.ts` |
| 4 | Otherwise the entry stays uncategorized and appears in the review queue | — | dashboard "Needs categorizing" |

There is deliberately **no separate "learned from history" layer**. Learning writes a real user rule, so it resolves at layer 1 — one mechanism, and one the user can see, disable, and delete on `/transactions/rules`.

## 2. Where it runs

Batched, once per sync run, inside the promotion transaction:

```
promoteScrapeResult()                       src/domain/sync-promotion.ts
  └─ categorizeEntries(tx, ownerId, dataKey, touchedEntryIds)
```

`categorizeEntries` takes the caller's `tx`, so a rolled-back scrape leaves no categories behind. `recategorizeUncategorized(session)` is the same engine wrapped in its own transaction, over the entries that still have no category.

**A rule change re-derives; it does not only fill blanks.** Every path that writes a rule — the dialog's "Create a rule", the Rules tab, re-activating a rule — runs the engine over `ruleCandidateEntryIds`: every non-excluded entry whose `category_id` is **not locked**. That is wider than "uncategorized", deliberately.

A category assigned by a rule or the built-in table is *derived*: the ruleset is its only justification, so when the ruleset changes it has to be recomputed. A category a person set by hand is locked (§4) and is never a candidate. **Locked is authoritative, unlocked is derived** — that one line is the whole policy.

Without it, layer 1's precedence over layer 2 held only for transactions that had not arrived yet. A café called `יאלנס רכבת` is claimed at ingest by the built-in `רכבת` (train) rule; a user rule saying otherwise would fix the entry they were looking at and silently leave its siblings filed as Public Transport, because a blanks-only backfill can never revisit them.

The pass does **not** clear a category when nothing matches. Deleting a rule deliberately leaves behind what it filed (§3), so blanking unjustified categories here would quietly undo that. It re-files, it never un-files.

**Why matching happens in memory rather than in SQL.** `rule_conditions.value_ct` is encrypted, so a condition cannot become a `WHERE` clause. The ruleset is decrypted **once per batch** into a compiled form (`loadContext`) and the batch is evaluated against it — the same decrypt-then-compute trade-off already accepted by `transactions.ts` and `dashboard.ts`. Doing it per row would re-decrypt every rule for every transaction.

**Consequence:** the "this rule will affect N transactions" preview that a plaintext rules engine gets for free would cost a full decrypt pass here. Deferred.

## 3. Rule vocabulary (v1.0)

| Column | Values |
|---|---|
| `rules.resource_type` | `entry` |
| `rule_conditions.condition_type` | `description`, `amount`, `account`, `group` |
| `rule_conditions.operator` | `contains`, `starts_with`, `equals` (description) · `gt`, `lt`, `eq` (amount) · `eq` (account) · `all`, `any` (group) |
| `rule_actions.action_type` | `set_category` (`value` = category uuid — the column is plaintext `text`) |

**No regex operator.** Rule values are user-authored, but the descriptions they run against are untrusted scraper output; a regex engine on that path is a ReDoS surface for no real gain.

**Nesting is capped at one level** — a top-level `group` whose children are leaves. The rule form can express exactly this and no more, so the UI cannot produce something the matcher can't evaluate.

### Conflict resolution: specificity, not priority

There is no `priority` column and no `stop_processing` flag. Every matching rule is scored by how *specific* its conditions are, and the most specific wins, with the rule id as a deterministic tiebreak:

```
equals / eq  10     starts_with / gt / lt  5     contains  0
× 2 when EVERY condition is exact
```

An exact `equals` therefore beats a loose `contains`, which is what users expect, and it means the learner can write a `contains` rule without ever shadowing a hand-authored `equals` one. (Firefly III's `order` plus per-rule/per-trigger/per-action `stop_processing` was considered and rejected — its semantics contradict themselves, and a bare rule's flag is silently ignored.)

`effective_date` gates a rule to entries on or after it, so creating a rule never rewrites history.

## 4. Attribute locking

`entries.locked_attributes` is a plaintext JSONB map of **field name → `true`**. Names only, never values:

```json
{ "category_id": true }
```

The applied value and its provenance live in `entry_field_changelog` (`field_name`, `source` ∈ `bank|rule|model|user`, `value_ct` AAD-bound to the changelog row's own id/column/version), which is append-only. Storing a timestamp in the lock map instead would just duplicate `entry_field_changelog.created_at`.

The rule the pipeline rests on: **once a user sets a field, every later rule and model pass skips that field and lets the rest of the payload through** (`domain-layer.md` §3.2). Only the user can clear the lock, by clearing the category.

### Two things categorization must never touch

- **`entries.version`** — one version is shared by *every* ciphertext column on the row (`sync-promotion.ts` trap #3). Categorization writes only plaintext columns, so bumping it would make every `*_ct` column on that entry fail to decrypt.
- **`entries.source`** — that records where the *entry* came from (`scrape`), not who set one of its fields. Field-level provenance is the changelog's job.

## 5. Categories

Two levels, enforced by the domain layer (the schema permits deeper — `data-model.md` §5). A subcategory inherits its parent's `classification` and `color`.

The shipped default set (`src/lib/categorization/default-categories.ts`) is 11 parents / 50 children, seeded per user at `createUser`. Parent names follow the Plaid personal-finance-category taxonomy because that is what a model matches against most reliably; the children carry the Israeli specifics — Arnona, Vaad Bayit, Bituach Leumi, Health Fund (Kupat Holim), Car Insurance & Test, Cellular, Internet & TV.

`categories.builtin_key` is the stable identity a built-in rule resolves through, so a rule still finds the right row after the user renames it. **Never change a shipped `key`.**

Adding to the shipped set only reaches accounts created afterwards, so `seedDefaultCategories` is idempotent (it skips keys that already exist, preserving user renames) and `npm run categories:sync` is the upgrade path. It needs no password — categories are plaintext Tier-2 labels.

### 5a. Managing categories (the Categories tab)

`listCategoryTree` / `createCategory` / `updateCategory` / `deleteCategory`, behind `/transactions/categories`.

Two invariants the schema cannot express are enforced in `resolveCategoryInput`:

- **One nesting level.** A parent must itself be top-level, and a group that still has children cannot become a subcategory.
- **Inheritance, not declaration.** A subcategory takes its parent's `classification` and `color`; the caller's values for those are ignored, and editing a group pushes both down to its children. A child whose classification disagreed with its parent would sit on the wrong side of every income/expense total while still displaying under that parent.

`icon` and `color` are checked against closed allowlists (`category-icons.ts`, `CATEGORY_COLORS`) rather than free text, so a typo can't silently render a blank tile and a raw color value can't bypass the token rule (`ui-and-feel.md`).

**A built-in category can be renamed but not deleted.** `categories:sync` re-adds the shipped set on upgrade, so a delete would appear to work and then quietly undo itself. Renaming is safe and is the intended customization — identity lives in `builtin_key`, not the name.

Deleting a user-created category:

- refuses while it still has children (`CategoryHasChildrenError`) — no silent cascade over a subtree;
- sets its entries back to `category_id = null` **and clears the `category_id` attribute lock**, because the lock records "a human chose this" and the thing they chose is gone; leaving it set would freeze those entries out of categorization permanently;
- deletes any rule whose `set_category` action targeted it. A `set_category` naming a row that no longer exists would fail the `entries` composite FK on the next scrape, and the rule's whole purpose was to assign that category. The confirmation dialog states both counts before the user commits.

## 6. Built-in rules

Code constants, not DB rows: no `owner_id`, no RLS question, and they improve with an app upgrade instead of being frozen into every account at signup. They are evaluated *after* the user's own rules, so a user rule always wins.

Each `match` string is tested as a substring of `normalizeDescription(description)`, so entries must be written the way that function emits — lowercase, no punctuation, no runs of 4+ digits. **The longest matching keyword wins**, so `רמי לוי תקשורת` (cellular) beats `רמי לוי` (groceries) without the table needing an explicit order.

Editing `src/lib/categorization/builtin-rules.ts` is the intended way to improve coverage — no migration, no seed, no backfill. Keep match strings long enough to be unambiguous: matching is substring-based with **no word boundary**, so a short token collides. The bare `כאל` is deliberately absent from the card-settlement rule because it is inside `למיכאל` — paying a person named מיכאל would be swallowed.

A rule may declare `onlyOn: "asset" | "liability"` to restrict itself to entries held on an account of that classification. Exactly one rule needs it today, and it is the reason the next section works.

## 6a. Credit-card settlements, and the double count they cause

A shekel spent on a credit card reaches the ledger twice:

1. as a purchase on the **card** account, dated when it was made;
2. inside the aggregate monthly debit the issuer takes from the **bank** account.

Counting both is double-counting every card purchase. The fix is to classify the settlement as a **transfer**, not an expense:

- `transfers-card-payment` ("Credit Card Payment") ships under the Transfers parent, which is `classification: "transfer"`.
- The `card-settlement` built-in rule points at it and carries `onlyOn: "asset"`.
- **`src/domain/flows.ts` is the single definition of what counts as income or an expense**, and it drops transfer-classified entries. Every aggregate goes through it. `dashboard.ts` is the only caller today; budgeting and category breakdowns must use it too, or they will disagree with the dashboard.

`onlyOn: "asset"` is load-bearing in the other direction: the issuer's name on the **card** account is a genuine charge (annual fee, foreign-transaction fee), and must stay in Credit Card Fees rather than vanishing from expenses.

Two things this deliberately does **not** do. It does not set `excluded` — that flag greys the row out and drops it from the ledger view, and a settlement should stay visible and labeled. And it does not write a `transfers` row: that table needs both legs, and an Israeli card scrape produces no "payment received" entry on the card side to pair with.

Net worth is unaffected either way — it sums account balances, not entries (`money-and-currency.md` §5).

## 7. Match text

`normalizeDescription` (`src/lib/categorization/normalize.ts`) is the single definition of "the same payee text", and its output is called the **match text** (`CONTEXT.md`; `EntryView.matchText`). It is shared by built-in rules, the learner, rule creation from the dialog, the suggestion corpus, and rejections. It applies NFKC, lowercases, strips Hebrew niqqud and geresh variants, drops runs of 4+ digits (card suffixes and reference numbers), strips punctuation, collapses whitespace, and removes at most one leading bank prefix.

That is what collapses `שופרסל דיל 1234` and `שופרסל  דיל-5678` to one key.

**A match text is Tier-1.** It is a normalized counterparty string, so `security-design-principles.md` §13 applies to it exactly as it does to the description it came from. Every table keyed by one stores it encrypted (`rule_conditions.value_ct`, `category_rejections.match_text_ct`) and looks it up by decrypting the set once per batch — never as a SQL predicate, and never as a hash that would restore equality lookup at the cost of an equality-and-frequency oracle over payee names (ADR 0002).

## 8. Learning from corrections

Actual Budget's `getProbableCategory`, materialized as a rule. When a user sets a category, the domain layer looks at the most recent **5** entries sharing that match text within **180 days**; if at least **3** agree, it writes (or retargets) a rule named `Learned: <text>`.

Writing a visible rule rather than hidden state is the point: the user can see *why* a transaction was categorized and delete the reason. The Rules tab is therefore not optional — it is what makes silent rule creation acceptable.

The explicit path is the **"Create a rule"** section of the categorize dialog, which writes the same rule shape immediately. It is **on by default**, prefilled with `description contains <match text>`, and both the operator (`contains` / `starts with` / `is exactly`) and the text are editable before saving — the same vocabulary as the Rules tab, so a rule written here and a rule edited there read identically.

Default-on is deliberate. Its predecessor was an off-by-default checkbox hard-wired to the entire match text, which made it doubly useless: nobody enabled it, and when they did it produced a rule that only ever fired on that exact payee string. A condition you can *see and widen before saving* is worth defaulting to; a fixed exact match is not. Editing the text down to the discriminating part (`שופרסל` rather than `שופרסל דיל רמת גן`) is the user's call in v1.0. *Proposing* that narrowing — picking the discriminating token by IDF and proving it safe against already-categorized history before offering it — is deliberately out of scope here and tracked separately.

Both paths retarget an existing rule for the same *(operator, text)* pairing instead of duplicating it. Narrowing `contains X` to `is exactly X` therefore writes a second, more specific rule rather than rewriting the broad one, which someone else's transactions may still depend on; specificity scoring (§3) settles which one wins. Neither path sets `effective_date` — the engine never touches a locked category, so a rule cannot overwrite a human decision at any date, and dating it today would only stop it from reaching the transactions it was created for.

## 9. Rules-only mode

Layer 3 reaches no network and needs no configuration: it reads only what is already in this user's database. **A Moni with no model configured is a fully working Moni** — a hard invariant (`AGENTS.md`; `../security/security-design-principles.md` §22), and now a trivially satisfied one. When an external source arrives (issue #12) it must be opt-in and off by default, and everything here must keep working with it disabled (ADR 0003).

## 10. Suggestions (layer 3)

A suggestion is a category **proposed** for an entry no rule could place. It is derived on render and never stored — there is no AI write path and no automatic write of any kind (`AGENTS.md`). Only a person turns a suggestion into a category.

### The signal

`src/lib/categorization/similarity.ts` is a pure scorer: cosine similarity over IDF-weighted token vectors, run against a corpus of every labeled `(match text → category)` pair Moni knows.

Israeli descriptions are overwhelmingly `BRAND · BRANCH · CITY`. The brand decides the category and the rest is noise, but *which* words are noise depends on the household — `רמת גן` is meaningless for someone who shops there daily and informative for someone who passed through once. IDF reads that off the user's own corpus, so there is **no hand-maintained Hebrew stopword list** to fall out of date. Document frequency counts distinct match texts rather than examples, so a merchant visited weekly cannot drive its own brand token's frequency up until the token looks like noise.

Cosine rather than coverage: dividing by the query's weight alone never charges for the brand an example *failed* to explain, which would let `רמי לוי רמת גן` score well against `שופרסל דיל רמת גן`. Cosine also tolerates the length mismatch that a Jaccard union over-punishes — `שופרסל דיל סניף חולון` and `שופרסל דיל אונליין` are the same shop.

### The corpus

Three feeders, each there for a reason:

| Feeder | Why |
|---|---|
| Categorized entries, **all** of them | The learner (§8) forgets past 180 days on purpose. Forgetting is wrong here: arnona, car test and insurance recur yearly, and they are exactly what nobody remembers filing. |
| The user's own rules | The strongest statement of intent in the system. A rule that *almost* fires — `equals "שופרסל דיל"` against `שופרסל אונליין` — contributes nothing at layer 1 and everything here. |
| The built-in table (§6) | Cold start. A day-one user has the largest backlog they will ever have and zero history. Rules carrying `onlyOn` are skipped — that gate exists because the same text means opposite things on a card and on the bank account settling it (§6a), and similarity has no account to gate on. |

**The learner's discarded evidence is the whole point.** §8 fires only when 3 of 5 entries share an *exactly* equal match text; every manual categorization below that bar is thrown away. Layer 3 spends it.

### Accept and reject

**Accept is an ordinary categorization.** It routes through `setEntryCategory`: sets the category, **locks** the field, logs `source: 'user'`, and lets the learner fire if history supports it. A human clicking ✓ is a human decision, and it deserves the same protection from later rules as one they typed. It deliberately does *not* auto-write a rule — one accept is one data point, and the dialog's "Create a rule" section (§8) is where someone who wants one goes, with the condition in front of them.

**Reject is scoped to the match text, not the entry.** One ✗ clears a wrong guess from every transaction sharing that text, past and future, which is the only version that scales with a backlog. It suppresses *suggestions only*: a rule may still assign that category and the learner may still write one, which is what keeps the blast radius small. Rejections live in `category_rejections` — see §7 on why the key is encrypted, and ADR 0002 for why suggestions themselves are not stored.

### What the user sees

One candidate or none. A suggestion below `MIN_SUGGESTION_SCORE` is not shown at all — ✓ is a one-click **locking** write, so a weak suggestion is worse than no suggestion. The chip carries its evidence (*"filed this way 4× for ⁨שופרסל דיל⁩"*) rather than a confidence number, which is false precision a human cannot calibrate.

**The threshold is measured, not chosen.** `npm run suggestions:eval` holds out a fifth of the user's categorized transactions, rebuilds the corpus from the rest, and reports coverage and precision across thresholds — including an "unseen" column restricted to texts the corpus has never observed, which is where similarity either earns its keep or does not. A fixture written alongside the algorithm would only prove the scorer agrees with itself.

## 11. Review queue

The dashboard's "Needs categorizing" card is `category_id IS NULL AND excluded = false`, newest first. `excluded` rows — one leg of an internal transfer — are left out: they are not awaiting review, they are deliberately out of the totals.

Suggestion chips render on this card and in the transactions table — the same `suggestion-chip.tsx` in both, and no third surface. There is no separate review route: the table already *is* the bulk-triage UI, and splitting categorization across two places would only make the second one stale.

## 12. Bidi

Merchant names are routinely Hebrew and get rendered inside LTR technical strings (`description contains "…"`) and beside LTR badges. Any such value must be **bidi-isolated** — `⁨`/`⁩` in a plain string, `<bdi>` in JSX — or the surrounding quotes, operator, and badges reorder around it. This is a display bug that no test catches; it has to be looked at in a browser.
