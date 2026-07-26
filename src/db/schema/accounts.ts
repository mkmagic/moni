import {
  pgTable,
  pgEnum,
  uuid,
  text,
  integer,
  jsonb,
  foreignKey,
  unique,
} from "drizzle-orm/pg-core";
import { bytea, timestamps } from "./shared";
import { users } from "./identity";
import { connections } from "./connectors";

// Meant to grow (data-model.md §5): new account types land via
// `ALTER TYPE account_type ADD VALUE ...` migrations, not a schema rewrite.
export const accountTypeEnum = pgEnum("account_type", [
  "checking",
  "savings",
  "credit_card",
  "investment",
  "loan",
  "other_asset",
  "other_liability",
]);
export const accountClassificationEnum = pgEnum("account_classification", ["asset", "liability"]);
export const accountStatusEnum = pgEnum("account_status", ["active", "archived"]);

export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    accountType: accountTypeEnum("account_type").notNull(),
    classification: accountClassificationEnum("classification").notNull(),
    connectionId: uuid("connection_id"),
    nameCt: bytea("name_ct").notNull(),
    institution: text("institution"),
    accountNumberLast4Ct: bytea("account_number_last4_ct"),
    // Encrypted provider account number/reference — used for scraper->account
    // mapping by decrypt-and-match (docs plan: no plaintext or hashed index).
    externalAccountRefCt: bytea("external_account_ref_ct"),
    currency: text("currency").notNull(),
    // Cached from the most recent balance snapshot for cheap reads
    // (data-model.md §5) — the snapshot table remains the source of truth.
    currentBalanceCt: bytea("current_balance_ct"),
    status: accountStatusEnum("status").notNull().default("active"),
    lockedAttributes: jsonb("locked_attributes"),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (table) => [
    unique("accounts_owner_id_id_unique").on(table.ownerId, table.id),
    foreignKey({
      columns: [table.ownerId, table.connectionId],
      foreignColumns: [connections.ownerId, connections.id],
    }),
  ],
);

/**
 * The only account-subtype extension table in v1.0 (data-model.md §5).
 * `loan_details` / `investment_details` follow the same base-row-plus-
 * `*_details` pattern later; investment/savings accounts need no extra
 * columns today — balance comes from `account_balance_snapshots`.
 */
export const creditCardDetails = pgTable(
  "credit_card_details",
  {
    accountId: uuid("account_id").primaryKey(),
    ownerId: uuid("owner_id").notNull(),
    statementCloseDay: integer("statement_close_day").notNull(),
    paymentDueDay: integer("payment_due_day").notNull(),
    creditLimitCt: bytea("credit_limit_ct"),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      columns: [table.ownerId, table.accountId],
      foreignColumns: [accounts.ownerId, accounts.id],
    }),
  ],
);
