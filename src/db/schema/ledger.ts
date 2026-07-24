import {
  pgTable,
  pgEnum,
  uuid,
  text,
  date,
  boolean,
  numeric,
  integer,
  jsonb,
  foreignKey,
  unique,
  index,
} from "drizzle-orm/pg-core";
import { bytea, timestamps } from "./shared";
import { users } from "./identity";
import { accounts } from "./accounts";
import { categories, merchants, recurringSeries } from "./classification";

// `trade` is reserved for the deferred investments module; only
// `transaction` is used in v1.0 (data-model.md §5).
export const entryTypeEnum = pgEnum("entry_type", ["transaction", "trade"]);
export const entryStatusEnum = pgEnum("entry_status", ["posted", "pending"]);
export const entrySourceEnum = pgEnum("entry_source", ["scrape", "manual", "rule", "model"]);
export const fxStatusEnum = pgEnum("fx_status", ["locked", "pending"]);
export const entryTransactionKindEnum = pgEnum("entry_transaction_kind", [
  "standard",
  "transfer",
  "fee",
  "refund",
]);

/**
 * The unified ledger, flows only (data-model.md §1/§5). No
 * `reporting_amount_ct` — the reporting leg is derived on read from
 * `entered_amount_ct × fx_rate` (data-model.md §4.3), never stored.
 */
export const entries = pgTable(
  "entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    accountId: uuid("account_id").notNull(),
    entryType: entryTypeEnum("entry_type").notNull(),
    date: date("date").notNull(),
    descriptionCt: bytea("description_ct").notNull(),
    notesCt: bytea("notes_ct"),
    categoryId: uuid("category_id"),
    merchantId: uuid("merchant_id"),
    recurringSeriesId: uuid("recurring_series_id"),
    status: entryStatusEnum("status").notNull(),
    excluded: boolean("excluded").notNull().default(false),
    // entered leg — ground truth, verbatim from the source.
    enteredAmountCt: bytea("entered_amount_ct").notNull(),
    enteredCurrency: text("entered_currency").notNull(),
    // account leg — ground truth, in the holding account's currency.
    accountAmountCt: bytea("account_amount_ct").notNull(),
    accountCurrency: text("account_currency").notNull(),
    // reporting leg — currency + locked rate only; amount is derived on read.
    reportingCurrency: text("reporting_currency").notNull(),
    fxRate: numeric("fx_rate"),
    fxRateDate: date("fx_rate_date"),
    fxSource: text("fx_source"),
    fxStatus: fxStatusEnum("fx_status").notNull(),
    importKey: text("import_key"),
    externalId: text("external_id"),
    source: entrySourceEnum("source").notNull(),
    lockedAttributes: jsonb("locked_attributes"),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (table) => [
    unique("entries_owner_id_id_unique").on(table.ownerId, table.id),
    foreignKey({
      columns: [table.ownerId, table.accountId],
      foreignColumns: [accounts.ownerId, accounts.id],
    }),
    foreignKey({
      columns: [table.ownerId, table.categoryId],
      foreignColumns: [categories.ownerId, categories.id],
    }),
    foreignKey({
      columns: [table.ownerId, table.merchantId],
      foreignColumns: [merchants.ownerId, merchants.id],
    }),
    foreignKey({
      columns: [table.ownerId, table.recurringSeriesId],
      foreignColumns: [recurringSeries.ownerId, recurringSeries.id],
    }),
    index("entries_owner_account_date_idx").on(table.ownerId, table.accountId, table.date),
    index("entries_owner_category_date_idx").on(table.ownerId, table.categoryId, table.date),
  ],
);

/**
 * 1:1 `entries` subtype for `entry_type = 'transaction'`. Installment
 * metadata is denormalized per slice (data-model.md §5/§6 tension 5) — the
 * Israeli scrapers emit each installment as an independent charge with no
 * stable group id. `installment_group_id` is a bare correlation key, not
 * yet a real FK since `installment_groups` isn't built in v1.0.
 */
export const entryTransactions = pgTable(
  "entry_transactions",
  {
    entryId: uuid("entry_id").primaryKey(),
    ownerId: uuid("owner_id").notNull(),
    kind: entryTransactionKindEnum("kind").notNull(),
    installmentNumber: integer("installment_number"),
    totalInstallments: integer("total_installments"),
    installmentTotalAmountCt: bytea("installment_total_amount_ct"),
    installmentPurchaseDate: date("installment_purchase_date"),
    installmentGroupId: uuid("installment_group_id"),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      columns: [table.ownerId, table.entryId],
      foreignColumns: [entries.ownerId, entries.id],
    }),
  ],
);
