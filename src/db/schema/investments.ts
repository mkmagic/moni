import {
  foreignKey,
  integer,
  date,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { accounts } from "./accounts";
import { connections, syncRuns } from "./connectors";
import { accountBalanceSnapshots } from "./dashboard";
import { users } from "./identity";
import { bytea, timestamps } from "./shared";

export const instrumentKindEnum = pgEnum("instrument_kind", [
  "stock",
  "etf",
  "mutual_fund",
  "generic",
]);
export const investmentSourceEnum = pgEnum("investment_source", [
  "ibkr_flex",
  "schwab_positions_csv",
  "snaptrade",
]);
export const investmentProviderEnum = pgEnum("investment_provider", [
  "ibkr_flex",
  "schwab_positions_csv",
  "snaptrade",
  "tiingo",
]);
export const sourceAsOfPrecisionEnum = pgEnum("source_as_of_precision", ["date", "timestamp"]);
export const reconciliationStateEnum = pgEnum("investment_reconciliation_state", [
  "matched",
  "mismatch",
]);
export const brokerValuationBasisEnum = pgEnum("broker_valuation_basis", [
  "market_value",
  "quantity_times_price",
]);
export const quoteSplitStateEnum = pgEnum("investment_quote_split_state", [
  "safe",
  "post_split",
  "unknown",
]);
export const quoteQualityStateEnum = pgEnum("investment_quote_quality_state", [
  "accepted",
  "stale",
]);

export const instruments = pgTable(
  "instruments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    kind: instrumentKindEnum("kind").notNull(),
    canonicalNameCt: bytea("canonical_name_ct"),
    canonicalSymbolCt: bytea("canonical_symbol_ct"),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (table) => [unique("instruments_owner_id_id_unique").on(table.ownerId, table.id)],
);

export const instrumentSourceMappings = pgTable(
  "instrument_source_mappings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    instrumentId: uuid("instrument_id").notNull(),
    provider: investmentProviderEnum("provider").notNull(),
    identifierKind: text("identifier_kind").notNull(),
    providerIdentifierCt: bytea("provider_identifier_ct").notNull(),
    providerSymbolCt: bytea("provider_symbol_ct"),
    providerNameCt: bytea("provider_name_ct"),
    exchangeCt: bytea("exchange_ct"),
    currency: text("currency").notNull(),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (table) => [
    unique("instrument_source_mappings_owner_id_id_unique").on(table.ownerId, table.id),
    unique("instrument_source_mappings_owner_id_id_instrument_id_unique").on(
      table.ownerId,
      table.id,
      table.instrumentId,
    ),
    foreignKey({
      columns: [table.ownerId, table.instrumentId],
      foreignColumns: [instruments.ownerId, instruments.id],
    }),
  ],
);

export const investmentSnapshotDetails = pgTable(
  "investment_snapshot_details",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    accountBalanceSnapshotId: uuid("account_balance_snapshot_id").notNull(),
    accountId: uuid("account_id").notNull(),
    connectionId: uuid("connection_id").notNull(),
    syncRunId: uuid("sync_run_id").notNull(),
    weekStart: date("week_start").notNull(),
    source: investmentSourceEnum("source").notNull(),
    sourceAsOf: timestamp("source_as_of", { withTimezone: true }).notNull(),
    sourceAsOfPrecision: sourceAsOfPrecisionEnum("source_as_of_precision").notNull(),
    brokerTotalCt: bytea("broker_total_ct").notNull(),
    brokerTotalCurrency: text("broker_total_currency").notNull(),
    reconciliationState: reconciliationStateEnum("reconciliation_state").notNull(),
    validationVersion: integer("validation_version").notNull(),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (table) => [
    unique("investment_snapshot_details_owner_id_id_unique").on(table.ownerId, table.id),
    unique("investment_snapshot_details_owner_id_snapshot_unique").on(
      table.ownerId,
      table.accountBalanceSnapshotId,
    ),
    unique("investment_snapshot_details_owner_id_account_week_unique").on(
      table.ownerId,
      table.accountId,
      table.weekStart,
    ),
    foreignKey({
      columns: [table.ownerId, table.accountBalanceSnapshotId],
      foreignColumns: [accountBalanceSnapshots.ownerId, accountBalanceSnapshots.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.ownerId, table.accountId],
      foreignColumns: [accounts.ownerId, accounts.id],
    }),
    foreignKey({
      columns: [table.ownerId, table.connectionId],
      foreignColumns: [connections.ownerId, connections.id],
    }),
    foreignKey({
      columns: [table.ownerId, table.syncRunId],
      foreignColumns: [syncRuns.ownerId, syncRuns.id],
    }),
  ],
);

export const investmentSnapshotPositions = pgTable(
  "investment_snapshot_positions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    snapshotId: uuid("snapshot_id").notNull(),
    instrumentId: uuid("instrument_id").notNull(),
    quantityCt: bytea("quantity_ct").notNull(),
    quantityUnit: text("quantity_unit").notNull(),
    currency: text("currency").notNull(),
    sourcePriceCt: bytea("source_price_ct"),
    sourcePriceCurrency: text("source_price_currency"),
    sourceValueCt: bytea("source_value_ct"),
    sourceValueCurrency: text("source_value_currency"),
    sourceAsOf: timestamp("source_as_of", { withTimezone: true }),
    brokerValuationBasis: brokerValuationBasisEnum("broker_valuation_basis").notNull(),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (table) => [
    unique("investment_snapshot_positions_owner_id_id_unique").on(table.ownerId, table.id),
    unique("investment_snapshot_positions_owner_snapshot_instrument_unique").on(
      table.ownerId,
      table.snapshotId,
      table.instrumentId,
    ),
    foreignKey({
      columns: [table.ownerId, table.snapshotId],
      foreignColumns: [investmentSnapshotDetails.ownerId, investmentSnapshotDetails.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.ownerId, table.instrumentId],
      foreignColumns: [instruments.ownerId, instruments.id],
    }),
  ],
);

export const investmentSnapshotCashBalances = pgTable(
  "investment_snapshot_cash_balances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    snapshotId: uuid("snapshot_id").notNull(),
    currency: text("currency").notNull(),
    amountCt: bytea("amount_ct").notNull(),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (table) => [
    unique("investment_snapshot_cash_balances_owner_id_id_unique").on(table.ownerId, table.id),
    unique("investment_snapshot_cash_balances_owner_snapshot_currency_unique").on(
      table.ownerId,
      table.snapshotId,
      table.currency,
    ),
    foreignKey({
      columns: [table.ownerId, table.snapshotId],
      foreignColumns: [investmentSnapshotDetails.ownerId, investmentSnapshotDetails.id],
    }).onDelete("cascade"),
  ],
);

export const investmentSourceEvidence = pgTable(
  "investment_source_evidence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    connectionId: uuid("connection_id").notNull(),
    syncRunId: uuid("sync_run_id").notNull(),
    accountId: uuid("account_id").notNull(),
    source: investmentSourceEnum("source").notNull(),
    sourcePeriodStart: timestamp("source_period_start", { withTimezone: true }),
    sourcePeriodEnd: timestamp("source_period_end", { withTimezone: true }),
    sourceAsOf: timestamp("source_as_of", { withTimezone: true }).notNull(),
    sourceAsOfPrecision: sourceAsOfPrecisionEnum("source_as_of_precision").notNull(),
    validationVersion: integer("validation_version").notNull(),
    positionRowCount: integer("position_row_count").notNull(),
    cashRowCount: integer("cash_row_count").notNull(),
    qualityCodes: text("quality_codes").array().notNull(),
    normalizedFingerprint: bytea("normalized_fingerprint").notNull(),
    ...timestamps,
  },
  (table) => [
    unique("investment_source_evidence_owner_id_id_unique").on(table.ownerId, table.id),
    unique("investment_source_evidence_owner_sync_account_unique").on(
      table.ownerId,
      table.syncRunId,
      table.accountId,
    ),
    foreignKey({
      columns: [table.ownerId, table.connectionId],
      foreignColumns: [connections.ownerId, connections.id],
    }),
    foreignKey({
      columns: [table.ownerId, table.syncRunId],
      foreignColumns: [syncRuns.ownerId, syncRuns.id],
    }),
    foreignKey({
      columns: [table.ownerId, table.accountId],
      foreignColumns: [accounts.ownerId, accounts.id],
    }),
  ],
);

export const investmentMarketQuotes = pgTable(
  "investment_market_quotes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    instrumentId: uuid("instrument_id").notNull(),
    instrumentSourceMappingId: uuid("instrument_source_mapping_id").notNull(),
    provider: investmentProviderEnum("provider").notNull(),
    providerSymbolCt: bytea("provider_symbol_ct").notNull(),
    priceCt: bytea("price_ct").notNull(),
    currency: text("currency").notNull(),
    sourceDate: date("source_date").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    splitState: quoteSplitStateEnum("split_state").notNull(),
    qualityState: quoteQualityStateEnum("quality_state").notNull(),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (table) => [
    unique("investment_market_quotes_owner_id_id_unique").on(table.ownerId, table.id),
    unique("investment_market_quotes_owner_instrument_provider_unique").on(
      table.ownerId,
      table.instrumentId,
      table.provider,
    ),
    foreignKey({
      columns: [table.ownerId, table.instrumentId],
      foreignColumns: [instruments.ownerId, instruments.id],
    }),
    foreignKey({
      columns: [table.ownerId, table.instrumentSourceMappingId, table.instrumentId],
      foreignColumns: [
        instrumentSourceMappings.ownerId,
        instrumentSourceMappings.id,
        instrumentSourceMappings.instrumentId,
      ],
    }).onDelete("cascade"),
  ],
);
