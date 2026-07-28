import {
  pgTable,
  pgEnum,
  uuid,
  text,
  date,
  boolean,
  integer,
  foreignKey,
  unique,
} from "drizzle-orm/pg-core";
import { bytea, timestamps } from "./shared";
import { users } from "./identity";
import { entries } from "./ledger";

export const categoryClassificationEnum = pgEnum("category_classification", [
  "income",
  "expense",
  "transfer",
]);
export const entryFieldChangeSourceEnum = pgEnum("entry_field_change_source", [
  "bank",
  "rule",
  "model",
  "user",
]);

/** Tier-2, plaintext label — not sensitive (data-model.md §5). */
export const categories = pgTable(
  "categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    // Self-reference, one nesting level. The depth-1 cap is enforced by the
    // domain layer, not the schema (data-model.md §5).
    parentId: uuid("parent_id"),
    classification: categoryClassificationEnum("classification").notNull(),
    color: text("color"),
    icon: text("icon"),
    // Stable identity for a category seeded from the shipped default set, so
    // a built-in rule still resolves to the right row after the user renames
    // it. Null for user-created categories.
    builtinKey: text("builtin_key"),
    ...timestamps,
  },
  (table) => [
    unique("categories_owner_id_id_unique").on(table.ownerId, table.id),
    unique("categories_owner_id_builtin_key_unique").on(table.ownerId, table.builtinKey),
    foreignKey({
      columns: [table.ownerId, table.parentId],
      foreignColumns: [table.ownerId, table.id],
    }),
  ],
);

export const merchants = pgTable(
  "merchants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    nameCt: bytea("name_ct").notNull(),
    logoUrl: text("logo_url"),
    websiteUrl: text("website_url"),
    source: text("source"),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (table) => [unique("merchants_owner_id_id_unique").on(table.ownerId, table.id)],
);

/** Attribute-lock provenance, append-only — no `updated_at` (rows are immutable). */
export const entryFieldChangelog = pgTable(
  "entry_field_changelog",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    entryId: uuid("entry_id").notNull(),
    fieldName: text("field_name").notNull(),
    source: entryFieldChangeSourceEnum("source").notNull(),
    valueCt: bytea("value_ct").notNull(),
    version: integer("version").notNull().default(1),
    createdAt: timestamps.createdAt,
  },
  (table) => [
    foreignKey({
      columns: [table.ownerId, table.entryId],
      foreignColumns: [entries.ownerId, entries.id],
    }).onDelete("cascade"),
  ],
);

/**
 * A person's ruling that a category is wrong for a **match text** — the only
 * thing the suggestion engine persists (docs/adr/0002-*).
 *
 * Suggestions themselves are derived on render and never stored: the engine
 * is local and free, so re-asking costs nothing and its answer *should*
 * improve as history grows. An accepted suggestion is likewise not recorded
 * here — it becomes an ordinary categorization, leaving the category, the
 * attribute lock and a changelog row behind it.
 *
 * Keyed on the match text rather than on an entry, so one thumbs-down clears
 * a wrong guess from every transaction sharing that text, past and future.
 *
 * `match_text_ct` is a normalized counterparty string — Tier-1
 * (security-design-principles.md §13), hence encrypted. The consequence is
 * that there is no unique constraint to dedupe on: ciphertext is randomized,
 * so two rows for the same pairing look different to Postgres. The domain
 * layer decrypts the set and dedupes in memory, exactly as it already does
 * for `rule_conditions.value_ct`.
 */
export const categoryRejections = pgTable(
  "category_rejections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    /** Tier-1. AAD-bound to this row's own id/column/version (encryption.md §3). */
    matchTextCt: bytea("match_text_ct").notNull(),
    categoryId: uuid("category_id").notNull(),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (table) => [
    unique("category_rejections_owner_id_id_unique").on(table.ownerId, table.id),
    foreignKey({
      columns: [table.ownerId, table.categoryId],
      foreignColumns: [categories.ownerId, categories.id],
    }),
  ],
);

export const rules = pgTable(
  "rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    resourceType: text("resource_type").notNull(),
    active: boolean("active").notNull().default(true),
    effectiveDate: date("effective_date"),
    ...timestamps,
  },
  (table) => [unique("rules_owner_id_id_unique").on(table.ownerId, table.id)],
);

/** Self-reference, one nesting level, capped on purpose (data-model.md §5). */
export const ruleConditions = pgTable(
  "rule_conditions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id").notNull(),
    ruleId: uuid("rule_id").notNull(),
    parentId: uuid("parent_id"),
    conditionType: text("condition_type").notNull(),
    operator: text("operator").notNull(),
    valueCt: bytea("value_ct"),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (table) => [
    // Self-referenced by parent_id below — required for that composite FK.
    unique("rule_conditions_owner_id_id_unique").on(table.ownerId, table.id),
    foreignKey({
      columns: [table.ownerId, table.ruleId],
      foreignColumns: [rules.ownerId, rules.id],
    }),
    foreignKey({
      columns: [table.ownerId, table.parentId],
      foreignColumns: [table.ownerId, table.id],
    }),
  ],
);

export const ruleActions = pgTable(
  "rule_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id").notNull(),
    ruleId: uuid("rule_id").notNull(),
    actionType: text("action_type").notNull(),
    value: text("value"),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      columns: [table.ownerId, table.ruleId],
      foreignColumns: [rules.ownerId, rules.id],
    }),
  ],
);

export const recurringSeries = pgTable(
  "recurring_series",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    merchantId: uuid("merchant_id"),
    categoryId: uuid("category_id"),
    cadence: text("cadence").notNull(),
    expectedAmountCt: bytea("expected_amount_ct").notNull(),
    nextExpectedDate: date("next_expected_date"),
    isSubscription: boolean("is_subscription").notNull().default(false),
    status: text("status").notNull(),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (table) => [
    unique("recurring_series_owner_id_id_unique").on(table.ownerId, table.id),
    foreignKey({
      columns: [table.ownerId, table.merchantId],
      foreignColumns: [merchants.ownerId, merchants.id],
    }),
    foreignKey({
      columns: [table.ownerId, table.categoryId],
      foreignColumns: [categories.ownerId, categories.id],
    }),
  ],
);

/** Pairs the two legs of an internal move; paired legs also carry `excluded = true`. */
export const transfers = pgTable(
  "transfers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    inflowEntryId: uuid("inflow_entry_id").notNull(),
    outflowEntryId: uuid("outflow_entry_id").notNull(),
    status: text("status").notNull(),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      columns: [table.ownerId, table.inflowEntryId],
      foreignColumns: [entries.ownerId, entries.id],
    }),
    foreignKey({
      columns: [table.ownerId, table.outflowEntryId],
      foreignColumns: [entries.ownerId, entries.id],
    }),
  ],
);
