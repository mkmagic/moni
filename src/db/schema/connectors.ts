import {
  pgTable,
  pgEnum,
  uuid,
  text,
  timestamp,
  integer,
  foreignKey,
  unique,
} from "drizzle-orm/pg-core";
import { bytea, timestamps } from "./shared";
import { users } from "./identity";
import { accounts } from "./accounts";
import { entries } from "./ledger";

export const connectionStatusEnum = pgEnum("connection_status", [
  "active",
  "error",
  "disconnected",
]);
export const connectionModeEnum = pgEnum("connection_mode", [
  "credentialed_fetch",
  "user_mediated_import",
]);
export const syncRunStatusEnum = pgEnum("sync_run_status", [
  "pending",
  "running",
  "succeeded",
  "failed",
]);
export const syncStagingScraperStatusEnum = pgEnum("sync_staging_scraper_status", [
  "pending",
  "completed",
]);
export const reconcileStateEnum = pgEnum("reconcile_state", [
  "new",
  "matched",
  "promoted",
  "superseded",
]);

/** One per linked institution login. */
export const connections = pgTable(
  "connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    connectorId: text("connector_id").notNull(),
    // User-chosen label (e.g. "Dana's Leumi checking") — plaintext, not
    // sensitive; distinguishes multiple connections to the same connector.
    displayName: text("display_name"),
    // Tier-0: wrapped by the user's unlock secret, never the data key
    // (threat-model.md §5 — a scrape must be able to decrypt this without
    // the data-key/unlock-window machinery gating ordinary Tier-1 reads).
    credentialsCt: bytea("credentials_ct"),
    mode: connectionModeEnum("mode").notNull().default("credentialed_fetch"),
    status: connectionStatusEnum("status").notNull(),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (table) => [unique("connections_owner_id_id_unique").on(table.ownerId, table.id)],
);

/** One per scrape attempt. Atomic-failure contract: a failed run never partial-writes. */
export const syncRuns = pgTable(
  "sync_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    connectionId: uuid("connection_id").notNull(),
    status: syncRunStatusEnum("status").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }),
    windowEnd: timestamp("window_end", { withTimezone: true }),
    error: text("error"),
    investmentSource: text("investment_source"),
    declaredAccountCount: integer("declared_account_count"),
    promotedAccountCount: integer("promoted_account_count"),
    promotedPositionCount: integer("promoted_position_count"),
    promotedCashBalanceCount: integer("promoted_cash_balance_count"),
    ...timestamps,
  },
  (table) => [
    // Referenced compositely by sync_staging.sync_run_id below — the
    // constraint Postgres requires to allow that composite FK to exist.
    unique("sync_runs_owner_id_id_unique").on(table.ownerId, table.id),
    foreignKey({
      columns: [table.ownerId, table.connectionId],
      foreignColumns: [connections.ownerId, connections.id],
    }),
  ],
);

/**
 * Raw ingestion buffer — exactly what the scraper returned, out of the
 * canonical ledger, so pending↔posted churn never touches `entries`
 * directly (data-model.md §5).
 */
export const syncStaging = pgTable(
  "sync_staging",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    syncRunId: uuid("sync_run_id").notNull(),
    accountId: uuid("account_id"),
    rawPayloadCt: bytea("raw_payload_ct").notNull(),
    importKey: text("import_key").notNull(),
    scraperStatus: syncStagingScraperStatusEnum("scraper_status").notNull(),
    reconcileState: reconcileStateEnum("reconcile_state").notNull().default("new"),
    promotedEntryId: uuid("promoted_entry_id"),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      columns: [table.ownerId, table.syncRunId],
      foreignColumns: [syncRuns.ownerId, syncRuns.id],
    }),
    foreignKey({
      columns: [table.ownerId, table.accountId],
      foreignColumns: [accounts.ownerId, accounts.id],
    }),
    foreignKey({
      columns: [table.ownerId, table.promotedEntryId],
      foreignColumns: [entries.ownerId, entries.id],
    }),
  ],
);
