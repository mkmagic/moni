# 0010 — A budget is a ceiling, and a ceiling is effective-dated

**Status:** accepted · **Date:** 2026-08-04 · **Issue:** [#69](https://github.com/mkmagic/moni/issues/69)

## Context

Moni needed budgeting. The obvious prior art — YNAB, Actual — is **zero-based
envelope budgeting**: every shekel is assigned to an envelope, and spending past
one forces you to move money out of another.

That model assumes a trustworthy **current cash position**, and Moni's is
structurally unavailable:

- Scrapes are user-triggered. There is no scheduler (`pg-boss` is not
  installed), so between two syncs Moni's idea of "what's in the account" is
  simply out of date, and it cannot know by how much.
- An Israeli credit card charges one lump sum roughly a month after the
  purchases it covers. Moni dates each purchase when it happened, which is the
  right ledger answer and the wrong cash answer.

An envelope that reallocates against a cash position Moni cannot vouch for
would be confidently wrong.

## Decision

**A budget is a set of monthly ceilings — a target to stay under, per
category.** Overspending is a red bar and a count on the dashboard. Nothing is
reallocated, and nothing is forced.

**A ceiling is effective-dated.** Editing writes a new
`(owner_id, category_id, amount_ct, effective_from, rollover)` row from that
month forward; the old row stays. A one-off ("December, Gifts is ₪2,000") is an
ordinary row the next one supersedes. Planned monthly income is one
effective-dated figure per user, the same shape.

**One ceiling per branch.** A user budgets a parent group as a single number
**or** its subcategories individually, never both. Enforced in
`src/domain/budget.ts`, not in the schema: the rule spans rows the database
cannot compare, and the effective-dating means several rows per category are
correct by design.

**Rollover is recommended, never defaulted on.** It is per category, off
unless chosen, and carries both surplus and deficit. The planner switches it on
only for a category whose own months show gaps — a bill that lands every second
month is simply zero in the months between, and that is a better signal than any
payee's cadence, because a category collects several payees and it is the
*category* that carries the ceiling. Groceries never look like that, which is
the point: carrying a grocery deficit forward makes one bad week punish the next
good one. Rollover carries surplus and deficit from that ceiling's `effective_from`. Only months whose ceiling
actually had rollover on contribute, so turning it on today never hands back
history the user did not budget for.

**"Everything else" is a budget line, not a category.** One ceiling per user
per month with `category_id IS NULL` covers all spending no other ceiling
reaches. A `Miscellaneous` *category* was rejected: it is only accurate if the
user recategorizes transactions into it, and "Miscellaneous ₪600" says less
than "Pharmacy ₪600, unbudgeted". Categories describe what money was **for**;
the budget decides what is **governed**. Which categories fall inside the
residual is derived per month from the ceilings in force then, so giving
Pharmacy its own ceiling today never rewrites what March's residual contained.
It carries no branch or classification check — it is not in the tree — and its
uniqueness rests on a `NULLS NOT DISTINCT` index, because Postgres otherwise
treats every NULL as distinct and would let "everything else" hold several
rival numbers in one month.

## Consequences

- **A finished month tells the truth.** March keeps the number that was in
  force in March instead of being restated against today's target. This is the
  whole reason a retrospective view needs no separate screen — a past month is
  the same page with the pace marker dropped.
- **Planned savings finally reconciles.** Before the residual, `income −
  ceilings` excluded every shekel the user had not itemized, so the budget
  claimed more savings than the plan implied. Money can still go unbudgeted —
  the residual is optional — but there is now a way to say so.
- **"Over budget" has exactly one answer per shekel**, because one-ceiling-per-
  branch guarantees one authority. This matches the deliberate one-level caps
  already made for categories and rule conditions.
- **Non-monthly Israeli spending stops reading as noise.** ארנונה every two
  months, insurance and טסט annually: without rollover a ₪6,000 March charge
  reads as 1200% and the other eleven months read 0%. With it, ₪500/month
  accrues quietly and March absorbs it.
- **"Available this month" is a running balance**, not a single-month
  subtraction — it replays from the ceiling's `effective_from`. Acceptable at
  family scale (`data-model.md` §5); the replay is skipped entirely when no
  rollover ceiling exists.
- **Envelope mode remains addable.** A ceiling is a degenerate envelope, so it
  can be built on these tables later. The reverse is not true, which is why
  this ordering was chosen.
- **Projection is already seeded.** Effective-dated `(category, amount,
  effective_from)` ceilings plus planned income *are* the forward-extensible
  plan. A future projector reads those rows and extends them past today. No
  speculative `savings_goals` table exists, and none should before the feature
  that would consume it is designed.

## Known limitation, accepted

Entries with `fx_status = 'pending'` are skipped, matching `dashboard.ts`. A
category can therefore read under-budget while foreign-currency spending is
invisible. `data-model.md` §6 tension 7 asks aggregates to surface or exclude
pending rows and never under-count; budgets is where this starts to bite, but
fixing it here would have made the budget disagree with every other aggregate
in the app. It needs one change across all of them, not a local exception.
