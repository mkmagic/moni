/**
 * Long-term savings: Israeli pension funds, קרן השתלמות and קופת גמל, populated
 * by importing a provider's official quarterly report.
 *
 * One account type carries all of them, with the product and its liquidity as
 * attributes rather than as separate `account_type` values (D1). Liquidity
 * varies *within* a product name — קופת גמל להשקעה is liquid today while קופת
 * גמל לתגמולים is locked to retirement — so the attribute is needed either way
 * and extra enum values would buy nothing.
 *
 * A report import writes one dated snapshot and no `entries` (D3). The deposit
 * table looks like a transaction feed but is not one: employee and employer
 * contributions never touch the member's bank account, while a self-employed
 * (עצמאי) contribution does — booking them as entries would double-count that
 * row against the bank scrape and book the rest as phantom income.
 *
 * The source PDF is discarded after parsing (D10), so an unstored field is
 * permanently unrecoverable. Everything the parser extracts is persisted here
 * whether or not v1 displays it; the member's name and ת.ז. are never parsed.
 */
import {
  date,
  foreignKey,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { accounts } from "./accounts";
import { connections, syncRuns } from "./connectors";
import { accountBalanceSnapshots } from "./dashboard";
import { users } from "./identity";
import { bytea, timestamps } from "./shared";

export const longTermSavingsProductEnum = pgEnum("long_term_savings_product", [
  "pension",
  "hishtalmut",
  "gemel",
  "gemel_investment",
  "managers_insurance",
]);

/**
 * When the member can actually reach the money. Governs presentation only —
 * every balance counts fully toward net worth, with no exclusions and no
 * toggle (D2).
 */
export const longTermSavingsLiquidityEnum = pgEnum("long_term_savings_liquidity", [
  "locked_retirement",
  /** Liquid from a specific date, held in `liquid_from`. */
  "liquid_after",
  "liquid",
]);

export const longTermSavingsDetails = pgTable(
  "long_term_savings_details",
  {
    accountId: uuid("account_id").primaryKey(),
    ownerId: uuid("owner_id").notNull(),
    product: longTermSavingsProductEnum("product").notNull(),
    liquidity: longTermSavingsLiquidityEnum("liquidity").notNull(),
    /** Set only when `liquidity` is `liquid_after`. */
    liquidFrom: date("liquid_from"),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      columns: [table.ownerId, table.accountId],
      foreignColumns: [accounts.ownerId, accounts.id],
    }).onDelete("cascade"),
  ],
);

/**
 * One row per imported report.
 *
 * Keyed on `(owner_id, account_id, as_of)` where `as_of` is the report's own
 * `תאריך הדוח`, so re-importing the same report replaces its snapshot in place
 * and the import is idempotent (D5).
 *
 * The flow columns hold exactly what the document asserts, for the period it
 * asserts it over — Israeli quarterly reports state flows year-to-date, so a Q3
 * report's `contributions_ct` covers January–September (D6). Nothing here is
 * derived; per-quarter figures are computed by differencing consecutive
 * snapshots at read time.
 *
 * The closing balance itself lives in `account_balance_snapshots`, which
 * data-model.md §1/§5 makes the sole home for absolute balances — this table is
 * the report detail hanging off it, the same relationship
 * `investment_snapshot_details` has. Keeping it there is what puts a pension
 * balance into net-worth *history* and not just today's figure (D2).
 */
export const longTermSavingsSnapshots = pgTable(
  "long_term_savings_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    accountBalanceSnapshotId: uuid("account_balance_snapshot_id").notNull(),
    accountId: uuid("account_id").notNull(),
    connectionId: uuid("connection_id").notNull(),
    syncRunId: uuid("sync_run_id").notNull(),
    /** The report's stated date — the snapshot's identity. */
    asOf: date("as_of").notNull(),
    statedPeriodStart: date("stated_period_start").notNull(),
    statedPeriodEnd: date("stated_period_end").notNull(),
    /** As printed ("לסוף הרבעון ה-3 לשנת 2025"); null when the report omits it. */
    quarter: integer("quarter"),
    fiscalYear: integer("fiscal_year"),

    currency: text("currency").notNull(),
    /** Also written to `account_balance_snapshots.native_balance_ct`. */
    closingBalanceCt: bytea("closing_balance_ct").notNull(),
    openingBalanceCt: bytea("opening_balance_ct").notNull(),
    contributionsCt: bytea("contributions_ct").notNull(),
    /** Signed: gains in a good quarter, losses in a bad one. */
    investmentResultCt: bytea("investment_result_ct").notNull(),
    feesChargedCt: bytea("fees_charged_ct").notNull(),
    insuranceDisabilityCt: bytea("insurance_disability_ct").notNull(),
    insuranceDeathCt: bytea("insurance_death_ct").notNull(),

    // Percentages, not money: fund-wide averages are public, and the member's
    // own rates are not a balance. Exact-decimal all the same.
    feeRateDeposit: numeric("fee_rate_deposit"),
    feeRateSavings: numeric("fee_rate_savings"),
    fundAvgFeeDeposit: numeric("fund_avg_fee_deposit"),
    fundAvgFeeSavings: numeric("fund_avg_fee_savings"),

    /**
     * The report's own projection, computed from the CURRENT balance assuming
     * no future contributions. Stored, never displayed in v1 (D8) — shown as a
     * retirement forecast it would be wrong by an order of magnitude.
     */
    projectionRetirementAge: integer("projection_retirement_age"),
    projectionMonthlyPensionCt: bytea("projection_monthly_pension_ct"),
    projectionSurvivorPensionCt: bytea("projection_survivor_pension_ct"),
    projectionOrphanPensionCt: bytea("projection_orphan_pension_ct"),
    projectionDependentParentPensionCt: bytea("projection_dependent_parent_pension_ct"),
    projectionDisabilityPensionCt: bytea("projection_disability_pension_ct"),
    projectionContributionWaiverCt: bytea("projection_contribution_waiver_ct"),

    /**
     * Residual of the balance equation on this import, recorded even when it
     * passes so the ±₪50 gate can be tuned against real documents (D9).
     * Encrypted: it is a difference of amounts.
     */
    balanceDriftCt: bytea("balance_drift_ct").notNull(),
    /**
     * Every non-gating check and its drift, as JSON. Encrypted because the
     * detail strings quote the figures they compared.
     */
    checkResultsCt: bytea("check_results_ct").notNull(),

    /** Which parser produced this row, and at what revision (A4). */
    parserId: text("parser_id").notNull(),
    parserVersion: integer("parser_version").notNull(),

    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (table) => [
    unique("long_term_savings_snapshots_owner_id_id_unique").on(table.ownerId, table.id),
    unique("long_term_savings_snapshots_owner_account_as_of_unique").on(
      table.ownerId,
      table.accountId,
      table.asOf,
    ),
    unique("long_term_savings_snapshots_owner_balance_snapshot_unique").on(
      table.ownerId,
      table.accountBalanceSnapshotId,
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

/**
 * The report's deposit table, verbatim. Detail of the snapshot, never ledger
 * entries (D3).
 */
export const longTermSavingsSnapshotDeposits = pgTable(
  "long_term_savings_snapshot_deposits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    snapshotId: uuid("snapshot_id").notNull(),
    /** Position in the printed table — the rows have no other unique key. */
    rowIndex: integer("row_index").notNull(),
    /** Null when the report omits the employer column entirely. */
    employerCt: bytea("employer_ct"),
    depositDate: date("deposit_date").notNull(),
    /** The salary month the deposit is for, as `YYYY-MM` exactly as printed. */
    forMonth: text("for_month").notNull(),
    salaryCt: bytea("salary_ct"),
    employeeCt: bytea("employee_ct").notNull(),
    employerContributionCt: bytea("employer_contribution_ct").notNull(),
    severanceCt: bytea("severance_ct").notNull(),
    totalCt: bytea("total_ct").notNull(),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (table) => [
    unique("long_term_savings_snapshot_deposits_owner_snapshot_row_unique").on(
      table.ownerId,
      table.snapshotId,
      table.rowIndex,
    ),
    foreignKey({
      columns: [table.ownerId, table.snapshotId],
      foreignColumns: [longTermSavingsSnapshots.ownerId, longTermSavingsSnapshots.id],
    }).onDelete("cascade"),
  ],
);

/** The report's investment-track table (section ד), verbatim. */
export const longTermSavingsSnapshotTracks = pgTable(
  "long_term_savings_snapshot_tracks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    snapshotId: uuid("snapshot_id").notNull(),
    rowIndex: integer("row_index").notNull(),
    /** Which track the member's money sits in — a holding, so encrypted. */
    nameCt: bytea("name_ct").notNull(),
    returnPct: numeric("return_pct"),
    annualCostPct: numeric("annual_cost_pct"),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (table) => [
    unique("long_term_savings_snapshot_tracks_owner_snapshot_row_unique").on(
      table.ownerId,
      table.snapshotId,
      table.rowIndex,
    ),
    foreignKey({
      columns: [table.ownerId, table.snapshotId],
      foreignColumns: [longTermSavingsSnapshots.ownerId, longTermSavingsSnapshots.id],
    }).onDelete("cascade"),
  ],
);
