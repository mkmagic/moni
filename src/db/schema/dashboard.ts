import {
  pgTable,
  pgEnum,
  uuid,
  text,
  date,
  integer,
  foreignKey,
  unique,
} from "drizzle-orm/pg-core";
import { bytea, timestamps } from "./shared";
import { users } from "./identity";
import { accounts } from "./accounts";

export const accountBalanceSnapshotSourceEnum = pgEnum("account_balance_snapshot_source", [
  "scrape",
  "manual",
  "investment",
  "long_term_savings",
]);

/**
 * The sole home for absolute balances (the stock series) — flows never
 * live here, deltas live in `entries` (data-model.md §1/§5). No
 * `period_rollups` table in v1.0: flow totals are computed on the fly by
 * the domain layer (data-model.md §5/§6 tension 1).
 */
export const accountBalanceSnapshots = pgTable(
  "account_balance_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    accountId: uuid("account_id").notNull(),
    date: date("date").notNull(),
    nativeBalanceCt: bytea("native_balance_ct"),
    currency: text("currency"),
    source: accountBalanceSnapshotSourceEnum("source").notNull(),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (table) => [
    unique("account_balance_snapshots_owner_id_id_unique").on(table.ownerId, table.id),
    foreignKey({
      columns: [table.ownerId, table.accountId],
      foreignColumns: [accounts.ownerId, accounts.id],
    }),
  ],
);
