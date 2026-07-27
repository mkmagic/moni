import {
  pgTable,
  pgEnum,
  uuid,
  text,
  date,
  boolean,
  integer,
  numeric,
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
export const categorySuggestionStatusEnum = pgEnum("category_suggestion_status", [
  "pending",
  "accepted",
  "rejected",
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
 * A model's proposed category for one entry, awaiting user approval. Never
 * written to `entries.category_id` directly — v1.0 has no AI write path
 * (AGENTS.md). One row per entry (unique on `(owner_id, entry_id)`) is what
 * freezes the result, so the same input never re-categorizes differently
 * (vision.md §"deterministic-first, model-as-fallback"); a row with a null
 * `category_id` records "the model looked and had no answer", which is what
 * stops a later pass from asking again.
 */
export const categorySuggestions = pgTable(
  "category_suggestions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    entryId: uuid("entry_id").notNull(),
    categoryId: uuid("category_id"),
    confidence: numeric("confidence"),
    model: text("model").notNull(),
    status: categorySuggestionStatusEnum("status").notNull().default("pending"),
    /** The model's rationale — untrusted generated text about a Tier-1 description. */
    reasonCt: bytea("reason_ct"),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (table) => [
    unique("category_suggestions_owner_id_id_unique").on(table.ownerId, table.id),
    unique("category_suggestions_owner_id_entry_id_unique").on(table.ownerId, table.entryId),
    foreignKey({
      columns: [table.ownerId, table.entryId],
      foreignColumns: [entries.ownerId, entries.id],
    }).onDelete("cascade"),
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
