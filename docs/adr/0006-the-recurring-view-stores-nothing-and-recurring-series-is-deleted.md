# The recurring view stores nothing, and `recurring_series` is deleted

`recurring_series` was scaffolded to hold detection state — `cadence`,
`expected_amount_ct`, `next_expected_date`, `status` — for a detector that would
find recurring payments by their spacing and their amount, running as a
background job (`data-model.md` §91). No detector was ever built, no scheduler
exists, and the only reference to the table nulls its `category_id` when a
category is deleted (`categorization.ts:1188`). `entries.recurring_series_id` is
likewise never set.

The recurring view (#15) does not need it, because it does not detect anything.
A merchant is in the view because the user **flagged its category as recurring**,
and everything else on the row — the latest amount, the average of the last
three, the cadence, the payment count, the first-seen date, the category sums —
is a read over `entries` that already exist. The only new stored state in the
whole feature is `categories.is_recurring` and `merchants.cadence_override`.

So the table and the column are dropped. This follows the rule ADR 0003 wrote
down — *"an empty table with no writer and no consumer is where subtle design
errors hide"* — and the precedent ADR 0002 set when it deleted
`category_suggestions` rather than keeping it for a future external path.

## Why keeping it dormant would have been worse than useless

`recurring_series` is not merely empty, it is **shaped wrong for what we
decided**. It carries a single `expected_amount_ct`, and the premise of #15 is
that the amount varies — *"the amount of the recurring transaction isn't always
the same, so we can't find recurring transactions solely based off the amount."*
It carries `next_expected_date` and `status`, which are predictions no part of
this feature makes. A future detector inheriting that schema would inherit a
model we have already rejected in writing.

## Consequences

- **Cadence is derived, not stored — but is overridable.** The median gap
  between a merchant's transaction dates gives monthly / bi-monthly / quarterly
  / yearly / irregular. Unknown at one transaction, a guess from a single gap at
  two, solid from three. `merchants.cadence_override` exists precisely because
  an annual subscription with one payment so far cannot be inferred at all, and
  the user knows the answer.
- **Irregular is a real answer.** A payee with unstable spacing is labelled
  irregular and left out of any per-month normalisation rather than being
  assigned a cadence it does not have.
- **One-off charges are disclosed, not hidden.** Since the category flag is the
  only gate, a stray purchase filed under Subscriptions does appear — as
  *"1 payment, Mar 2026"*, next to *"14 payments since Aug 2025"*. Suppressing
  it would have meant a minimum-occurrence threshold, which also hides a genuine
  new subscription for its first two months — the moment the user most wants to
  see it.
- **Everything costs a decrypt-per-render.** Amounts are Tier-1, so sums and
  averages decrypt the recurring categories' entries on each page load. Same
  cost class as `dashboard.ts`, which already decrypts every entry in a period.
- **FX-pending entries are skipped**, following `dashboard.ts:96` — never fake a
  rate, in an average any more than in a total.
- **`lib/money` gains `divide`.** It had `add`, `multiply`, `isZero` and
  `negate`, and an average needs division — the one operation where exact
  decimal stops being exact. It rounds to 2dp, half-up, and that policy lives in
  one function rather than at each call site.
- **If cadence detection is ever built, it adds a table designed for it.** That
  is the intended outcome, not a regret.
