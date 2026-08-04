import { pgTable, uuid, date, boolean, integer, foreignKey, unique } from "drizzle-orm/pg-core";
import { bytea, timestamps } from "./shared";
import { users } from "./identity";
import { categories } from "./classification";

/**
 * A monthly ceiling for one category — a target to stay under, not an
 * envelope to fill (issue #69). Overspending is a red bar, never a forced
 * reallocation.
 *
 * **Effective-dated, like `rules.effective_date`.** Editing a ceiling writes
 * a NEW row effective from that month; the old row stays. March therefore
 * keeps the number that was actually in force in March, so looking back at a
 * finished month tells the truth rather than restating history against
 * today's target. A one-off ("December, Gifts is ₪2,000") is an ordinary row
 * that the next one supersedes.
 *
 * `amount_ct` is Tier-1 and encrypted. `category_id`, `effective_from` and
 * `rollover` stay plaintext so SQL can narrow before anything is decrypted
 * (data-model.md §6 tension 1).
 *
 * There is no per-branch uniqueness constraint here: "a user budgets a parent
 * OR its children, never both" spans rows the database cannot compare, and
 * the effective-dated history means several rows per category are correct by
 * design. The domain layer enforces it (src/domain/budget.ts).
 */
export const budgetCeilings = pgTable(
  "budget_ceilings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    /**
     * NULL is the **residual** ceiling: "everything else", covering all
     * spending no other ceiling reaches that month.
     *
     * It is a budget concept, not a category — a `Miscellaneous` category
     * would only be accurate if the user recategorized transactions into it,
     * and "Miscellaneous ₪600" says less than "Pharmacy ₪600, unbudgeted".
     * Which categories fall inside it is derived per month from the ceilings
     * in force then, so budgeting Pharmacy today never rewrites what March's
     * residual contained.
     */
    categoryId: uuid("category_id"),
    /** Tier-1. AAD-bound to this row's own id/column/version. */
    amountCt: bytea("amount_ct").notNull(),
    /** First day of the month this ceiling takes effect, as "YYYY-MM-01". */
    effectiveFrom: date("effective_from").notNull(),
    /**
     * Carry both surplus and deficit into the next month. Off by default;
     * on, it is how non-monthly Israeli spending stops reading as noise —
     * ארנונה every two months, insurance and טסט annually. Accrual starts at
     * this row's `effective_from`; flipping it on never replays the past.
     */
    rollover: boolean("rollover").notNull().default(false),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (table) => [
    unique("budget_ceilings_owner_id_id_unique").on(table.ownerId, table.id),
    // One ceiling per category per month — a second edit in the same month
    // replaces the row rather than stacking an ambiguous duplicate.
    //
    // `nullsNotDistinct` is load-bearing, not tidiness: Postgres treats NULLs
    // as distinct by default, so without it the residual ceiling (category_id
    // IS NULL) could stack any number of rows in one month and "everything
    // else" would have several rival numbers.
    unique("budget_ceilings_owner_category_effective_unique")
      .on(table.ownerId, table.categoryId, table.effectiveFrom)
      .nullsNotDistinct(),
    foreignKey({
      columns: [table.ownerId, table.categoryId],
      foreignColumns: [categories.ownerId, categories.id],
    }),
  ],
);

/**
 * Planned monthly income — one effective-dated figure per user, the same
 * shape as a ceiling and for the same reason. There are deliberately no
 * per-category income ceilings: the budget states one savings intent, and
 * splitting planned income across categories would invite a second, rival
 * answer to "what did we plan to save".
 */
export const budgetIncomes = pgTable(
  "budget_incomes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    /** Tier-1. AAD-bound to this row's own id/column/version. */
    amountCt: bytea("amount_ct").notNull(),
    effectiveFrom: date("effective_from").notNull(),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (table) => [
    unique("budget_incomes_owner_id_id_unique").on(table.ownerId, table.id),
    unique("budget_incomes_owner_effective_unique").on(table.ownerId, table.effectiveFrom),
  ],
);
