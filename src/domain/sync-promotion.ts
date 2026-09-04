// Sync promotion — turns one scrape's validated output into ledger rows
// (docs plan §D "Reconciliation"). This is the domain layer's first write
// path for scraped data: account resolution (decrypt-and-match), the raw
// staging log, and the three reconciliation branches (new / matched-
// unchanged / matched-pending→posted) all happen here, atomically.
//
// Everything for one scrape — staging inserts, entry promotion, balance
// snapshots, and the final `sync_runs` -> 'succeeded' — runs inside ONE
// `withUser()` transaction (docs plan §D). If anything throws partway,
// Postgres rolls the whole thing back, so a failed run never partial-writes
// and `sync_runs` never shows 'succeeded' for it. `markSyncRunFailed()`
// below is deliberately a SEPARATE transaction, written from the caller's
// outer catch after the attempt above has already rolled back.
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { withUser } from "@/db/client";
import {
  accountBalanceSnapshots,
  accounts,
  connections,
  entries,
  entryTransactions,
  fxRates,
  syncRuns,
  syncStaging,
  users,
} from "@/db/schema";
import { decimalStringFromScraperNumber } from "@/lib/money";
import {
  computeImportKey,
  getConnectorDefinition,
  type ConnectorId,
  type ScraperAccount,
  type ScraperTransaction,
} from "@/lib/connectors";
import { decText, encText } from "./fields";
import { categorizeEntries } from "./categorization";
import { resolveMerchants } from "./merchants";
import { israelDate } from "./investment-valuation";
import { isFieldLocked } from "./attribute-locks";

type Tx = Parameters<Parameters<typeof withUser>[1]>[0];

/** The scrapers build `date`/`processedDate` by parsing a local date and
 * calling `moment(...).toISOString()`, so a value-date of 2026-09-01 in Israel
 * arrives as the instant 2026-08-31T21:00:00Z. Storing that straight into the
 * `date` column (a Postgres DATE) truncated it to 2026-08-31, a day early —
 * the salary-on-the-wrong-day bug. Normalize to the Asia/Jerusalem calendar
 * day, the day the user actually saw the money move. */
function ledgerDate(scraperDate: string): string {
  return israelDate(new Date(scraperDate));
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

interface ResolvedAccount {
  id: string;
  currency: string;
  isNew: boolean;
}

/**
 * Resolves the scraper's `accountNumber` to an internal Moni account by
 * decrypt-and-match against `accounts.external_account_ref_ct` — never a
 * blind index (docs plan §"Files", "Reuse" section: a family has ~10
 * accounts, decrypting and comparing is trivially cheap). Creates a new
 * account row when no match exists.
 */
async function resolveAccount(
  tx: Tx,
  ownerId: string,
  dataKey: Buffer,
  connectionId: string,
  connectorId: ConnectorId,
  scraperAccount: ScraperAccount,
): Promise<ResolvedAccount> {
  const existingRows = await tx.select().from(accounts);
  for (const row of existingRows) {
    if (!row.externalAccountRefCt) continue;
    const ref = decText(
      dataKey,
      row.externalAccountRefCt,
      row.id,
      "external_account_ref_ct",
      row.version,
    );
    if (ref === scraperAccount.accountNumber) {
      return { id: row.id, currency: row.currency, isNew: false };
    }
  }

  // Registry-validated by the caller (promoteScrapeResult's ConnectorId
  // param type) — a lookup miss here would mean a caller bug, not bad input.
  const def = getConnectorDefinition(connectorId);
  if (!def) throw new Error(`Unknown connector id "${connectorId}"`);

  const accountType = scraperAccount.savingsAccount
    ? "savings"
    : def.kind === "credit_card"
      ? "credit_card"
      : "checking";
  const classification = accountType === "credit_card" ? "liability" : "asset";
  const currency = scraperAccount.currency ?? "ILS";
  const last4 = scraperAccount.accountNumber.slice(-4);

  // AAD needs the row id before the INSERT (trap #1, docs plan §E.1) —
  // generate it first, never `defaultRandom()` for a row carrying ciphertext.
  const id = randomUUID();
  const name = `${def.label} (${last4})`;

  const insertValues: typeof accounts.$inferInsert = {
    id,
    ownerId,
    accountType,
    classification,
    connectionId,
    nameCt: encText(dataKey, name, id, "name_ct", 1),
    institution: def.label,
    accountNumberLast4Ct: encText(dataKey, last4, id, "account_number_last4_ct", 1),
    externalAccountRefCt: encText(
      dataKey,
      scraperAccount.accountNumber,
      id,
      "external_account_ref_ct",
      1,
    ),
    currency,
    status: "active",
    currentBalanceCt:
      scraperAccount.balance !== undefined
        ? encText(
            dataKey,
            decimalStringFromScraperNumber(scraperAccount.balance),
            id,
            "current_balance_ct",
            1,
          )
        : null,
  };
  await tx.insert(accounts).values(insertValues);

  return { id, currency, isNew: true };
}

/**
 * Re-encrypts EVERY ciphertext column on the `accounts` row under a bumped
 * version — `version` is one column shared by every ciphertext column on
 * the row (trap #3, docs plan §E.2): touching only `current_balance_ct`
 * while bumping `version` would leave `name_ct`/`account_number_last4_ct`/
 * `external_account_ref_ct` silently undecryptable on the next read.
 */
async function refreshAccountCachedBalance(
  tx: Tx,
  dataKey: Buffer,
  accountId: string,
  newBalance: string,
): Promise<void> {
  const rows = await tx.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
  const row = rows[0];
  if (!row) return;

  const newVersion = row.version + 1;
  const name = decText(dataKey, row.nameCt, row.id, "name_ct", row.version) ?? "";
  const last4 = decText(
    dataKey,
    row.accountNumberLast4Ct,
    row.id,
    "account_number_last4_ct",
    row.version,
  );
  const externalRef = decText(
    dataKey,
    row.externalAccountRefCt,
    row.id,
    "external_account_ref_ct",
    row.version,
  );

  await tx
    .update(accounts)
    .set({
      nameCt: encText(dataKey, name, row.id, "name_ct", newVersion),
      accountNumberLast4Ct:
        last4 != null
          ? encText(dataKey, last4, row.id, "account_number_last4_ct", newVersion)
          : null,
      externalAccountRefCt:
        externalRef != null
          ? encText(dataKey, externalRef, row.id, "external_account_ref_ct", newVersion)
          : null,
      currentBalanceCt: encText(dataKey, newBalance, row.id, "current_balance_ct", newVersion),
      version: newVersion,
    })
    .where(eq(accounts.id, accountId));
}

/** Inserts a balance snapshot when the scraper reported one (data-model.md
 * §1: absolute balances live only here, never in `entries`). Also refreshes
 * `accounts.current_balance_ct`, the cached-for-cheap-reads column
 * (data-model.md §5) — skipped for a brand-new account, which already got
 * its balance at insert. Returns true if a snapshot was written. */
async function recordBalanceSnapshotIfPresent(
  tx: Tx,
  ownerId: string,
  dataKey: Buffer,
  resolved: ResolvedAccount,
  scraperAccount: ScraperAccount,
): Promise<boolean> {
  if (scraperAccount.balance === undefined) return false;

  const currency = scraperAccount.currency ?? resolved.currency;
  const balanceStr = decimalStringFromScraperNumber(scraperAccount.balance);
  const date = scraperAccount.balanceDate ?? todayIso();

  const snapshotId = randomUUID();
  await tx.insert(accountBalanceSnapshots).values({
    id: snapshotId,
    ownerId,
    accountId: resolved.id,
    date,
    nativeBalanceCt: encText(dataKey, balanceStr, snapshotId, "native_balance_ct", 1),
    currency,
    source: "scrape",
  });

  if (!resolved.isNew) {
    await refreshAccountCachedBalance(tx, dataKey, resolved.id, balanceStr);
  }
  return true;
}

/** `entered -> reporting` FX rate, locked at the transaction date
 * (money-and-currency.md §2/§4). Same-currency is always `1`/"identity" —
 * never looked up. A missing rate is never faked to 1:1: callers get `null`
 * and must flag the entry `fx_status = 'pending'`. */
async function resolveFx(
  tx: Tx,
  fromCurrency: string,
  toCurrency: string,
  date: string,
): Promise<{ rate: string; source: string } | null> {
  if (fromCurrency === toCurrency) {
    return { rate: "1", source: "identity" };
  }
  const rows = await tx
    .select()
    .from(fxRates)
    .where(
      and(
        eq(fxRates.fromCurrency, fromCurrency),
        eq(fxRates.toCurrency, toCurrency),
        eq(fxRates.date, date),
      ),
    )
    .limit(1);
  const row = rows[0];
  return row ? { rate: row.rate, source: row.source } : null;
}

type TxnBranch = "new" | "matchedUnchanged" | "updatedPendingToPosted";

/** The branch taken, plus the entry it landed on — the caller collects the
 * ids so categorization can run once over the whole batch. */
interface TxnOutcome {
  branch: TxnBranch;
  entryId: string;
}

/**
 * Reconciles one scraped transaction against `entries.import_key`
 * (data-model.md §5/§6.4, docs plan §D). Always logs the raw payload to
 * `sync_staging`; the three branches below are exactly the ones the plan
 * specifies.
 */
async function promoteTransaction(
  tx: Tx,
  ownerId: string,
  dataKey: Buffer,
  connectorId: string,
  syncRunId: string,
  resolved: ResolvedAccount,
  reportingCurrency: string,
  txn: ScraperTransaction,
): Promise<TxnOutcome> {
  // An installment slice is described by the Israeli card scrapers as an
  // independent charge that repeats the WHOLE deal's figures: `originalAmount`
  // is the deal sum rather than the payment (max.js:192,
  // base-isracard-amex.js:108) and `date` is the purchase date on every slice
  // (max.js:184). Taking those verbatim valued a ₪12,000 purchase at ₪12,000
  // twelve times over, all inside the purchase month. The only per-slice
  // figures the source gives are `chargedAmount` and `processedDate`, so
  // those are what the entry is built from.
  const slice = txn.installments ?? null;
  const dealAmount = decimalStringFromScraperNumber(txn.originalAmount);
  const accountAmount = decimalStringFromScraperNumber(txn.chargedAmount);
  const accountCurrency = txn.chargedCurrency ?? resolved.currency;
  const enteredAmount = slice ? accountAmount : dealAmount;
  const enteredCurrency = slice ? accountCurrency : txn.originalCurrency;
  const entryDate = ledgerDate(slice ? txn.processedDate : txn.date);

  // Keyed on the deal's stable figures — the purchase date and the deal sum,
  // neither of which moves — plus the slice number, because Isracard gives
  // every slice one identifier and without it all twelve collapse onto one
  // entry. `processedDate` is deliberately still not an input: it mutates on
  // pending -> posted, and a key that moved with it would fork the row.
  const importKey = computeImportKey({
    connectorId,
    accountId: resolved.id,
    identifier: txn.identifier,
    originalAmount: dealAmount,
    originalCurrency: txn.originalCurrency,
    date: txn.date,
    installmentNumber: slice?.number ?? null,
  });

  const newStatus: "posted" | "pending" = txn.status === "completed" ? "posted" : "pending";

  const existingRows = await tx
    .select()
    .from(entries)
    .where(and(eq(entries.ownerId, ownerId), eq(entries.importKey, importKey)))
    .limit(1);
  const existing = existingRows[0];

  const stagingId = randomUUID();
  const rawPayloadCt = encText(dataKey, JSON.stringify(txn), stagingId, "raw_payload_ct", 1);

  if (!existing) {
    // --- New: insert sync_staging -> insert entries + entry_transactions ---
    const entryId = randomUUID();
    const fx = await resolveFx(tx, enteredCurrency, reportingCurrency, entryDate);

    await tx.insert(entries).values({
      id: entryId,
      ownerId,
      accountId: resolved.id,
      entryType: "transaction",
      date: entryDate,
      descriptionCt: encText(dataKey, txn.description, entryId, "description_ct", 1),
      notesCt: txn.memo ? encText(dataKey, txn.memo, entryId, "notes_ct", 1) : null,
      status: newStatus,
      excluded: false,
      enteredAmountCt: encText(dataKey, enteredAmount, entryId, "entered_amount_ct", 1),
      enteredCurrency,
      accountAmountCt: encText(dataKey, accountAmount, entryId, "account_amount_ct", 1),
      accountCurrency,
      reportingCurrency,
      fxRate: fx?.rate ?? null,
      fxRateDate: entryDate,
      fxSource: fx?.source ?? null,
      fxStatus: fx ? "locked" : "pending",
      importKey,
      externalId: txn.identifier != null ? String(txn.identifier) : null,
      source: "scrape",
    });

    await tx.insert(entryTransactions).values({
      entryId,
      ownerId,
      kind: "standard",
      installmentNumber: slice?.number ?? null,
      totalInstallments: slice?.total ?? null,
      // The deal sum the entry no longer carries, kept so the UI can say
      // "payment 3 of 12 on a ₪12,000 purchase". `installment_group_id`
      // stays null: the scraper gives no group id, and stitching slices
      // together needs a background job that doesn't exist yet.
      installmentTotalAmountCt: slice
        ? encText(dataKey, dealAmount, entryId, "installment_total_amount_ct", 1)
        : null,
      installmentTotalCurrency: slice ? txn.originalCurrency : null,
      installmentPurchaseDate: slice ? ledgerDate(txn.date) : null,
    });

    await tx.insert(syncStaging).values({
      id: stagingId,
      ownerId,
      syncRunId,
      accountId: resolved.id,
      rawPayloadCt,
      importKey,
      scraperStatus: txn.status,
      reconcileState: "promoted",
      promotedEntryId: entryId,
    });

    return { branch: "new", entryId };
  }

  if (existing.status === "pending" && newStatus === "posted") {
    // --- Matched, pending -> posted: UPDATE the existing entry in place,
    // never a second row. `version` is one column shared by every
    // ciphertext column on this row (trap #3, docs plan §E.2) — re-encrypt
    // entered_amount_ct too, even though import_key guarantees its value is
    // unchanged, or it would silently fail to decrypt against the bumped
    // version.
    const newVersion = existing.version + 1;
    // An installment slice that had not been charged yet reported its charge
    // date as the purchase date (max.js:183); the real one arrives with this
    // scrape. Re-date the row and re-resolve FX against the new date rather
    // than leaving a slice parked in the purchase month.
    // A date the user fixed by hand is locked and authoritative — the scrape
    // re-dates only what it still owns (attribute-locks.ts, same rule as
    // category).
    const redate = !isFieldLocked(existing.lockedAttributes, "date") && entryDate !== existing.date;
    const fx = redate ? await resolveFx(tx, enteredCurrency, reportingCurrency, entryDate) : null;
    await tx
      .update(entries)
      .set({
        status: "posted",
        // Only when the date really moved — an ordinary charge keeps the
        // rate it locked at import, and re-resolving could only lose it.
        ...(redate
          ? {
              date: entryDate,
              fxRate: fx?.rate ?? null,
              fxRateDate: entryDate,
              fxSource: fx?.source ?? null,
              fxStatus: fx ? ("locked" as const) : ("pending" as const),
            }
          : {}),
        descriptionCt: encText(dataKey, txn.description, existing.id, "description_ct", newVersion),
        notesCt: txn.memo ? encText(dataKey, txn.memo, existing.id, "notes_ct", newVersion) : null,
        enteredAmountCt: encText(
          dataKey,
          enteredAmount,
          existing.id,
          "entered_amount_ct",
          newVersion,
        ),
        accountAmountCt: encText(
          dataKey,
          accountAmount,
          existing.id,
          "account_amount_ct",
          newVersion,
        ),
        version: newVersion,
      })
      .where(eq(entries.id, existing.id));

    await tx.insert(syncStaging).values({
      id: stagingId,
      ownerId,
      syncRunId,
      accountId: resolved.id,
      rawPayloadCt,
      importKey,
      scraperStatus: txn.status,
      reconcileState: "promoted",
      promotedEntryId: existing.id,
    });

    return { branch: "updatedPendingToPosted", entryId: existing.id };
  }

  // --- Matched, unchanged: staging row logged, nothing else touched. This
  // is what makes re-running a scrape idempotent (docs plan §D).
  await tx.insert(syncStaging).values({
    id: stagingId,
    ownerId,
    syncRunId,
    accountId: resolved.id,
    rawPayloadCt,
    importKey,
    scraperStatus: txn.status,
    reconcileState: "matched",
    promotedEntryId: existing.id,
  });

  return { branch: "matchedUnchanged", entryId: existing.id };
}

export interface PromoteScrapeResultInput {
  userId: string;
  /** Tier-0 — caller owns wiping it; never wiped here (aead.ts convention). */
  dataKey: Buffer;
  connectionId: string;
  connectorId: ConnectorId;
  /** An already-`running` sync_runs row (see startSyncRun below); this call
   * flips it to 'succeeded' as its last statement. */
  syncRunId: string;
  /** Already Zod-validated by the caller (scrape-worker.mts, the real
   * untrusted-input boundary — src/lib/connectors/scraper-output.schema.ts). */
  accounts: ScraperAccount[];
}

export interface PromoteScrapeResultSummary {
  accountsProcessed: number;
  accountsCreated: number;
  newEntries: number;
  matchedUnchanged: number;
  updatedPendingToPosted: number;
  balanceSnapshots: number;
  /** How many of this run's entries the categorization engine resolved. */
  categorized: number;
  /** New payees this run put a `merchants` row behind (docs/adr/0005-*). */
  merchantsCreated: number;
}

/**
 * Promotes one scrape's accounts/transactions into the ledger, atomically.
 * Everything — account resolution, staging log, entries, balance snapshots,
 * and the final `sync_runs` -> 'succeeded' — runs inside this single
 * `withUser()` transaction (docs plan §D). If anything throws, Postgres
 * rolls the whole thing back and `sync_runs` is left exactly as the caller
 * set it before calling this (typically 'running') — never 'succeeded' for
 * a partial write.
 */
export async function promoteScrapeResult(
  input: PromoteScrapeResultInput,
): Promise<PromoteScrapeResultSummary> {
  const { userId, dataKey, connectionId, connectorId, syncRunId } = input;

  return withUser(userId, async (tx) => {
    const userRows = await tx.select({ baseCurrency: users.baseCurrency }).from(users).limit(1);
    const reportingCurrency = userRows[0]?.baseCurrency ?? "ILS";

    const summary: PromoteScrapeResultSummary = {
      accountsProcessed: 0,
      accountsCreated: 0,
      newEntries: 0,
      matchedUnchanged: 0,
      updatedPendingToPosted: 0,
      balanceSnapshots: 0,
      categorized: 0,
      merchantsCreated: 0,
    };

    // Entries worth running the categorizer over: the ones just created,
    // plus the ones whose description a pending->posted update just changed
    // (a new description can match a rule the old one didn't). Already
    // categorized or user-locked entries are filtered out downstream.
    const touchedEntryIds: string[] = [];

    for (const scraperAccount of input.accounts) {
      const resolved = await resolveAccount(
        tx,
        userId,
        dataKey,
        connectionId,
        connectorId,
        scraperAccount,
      );
      summary.accountsProcessed++;
      if (resolved.isNew) summary.accountsCreated++;

      const gotSnapshot = await recordBalanceSnapshotIfPresent(
        tx,
        userId,
        dataKey,
        resolved,
        scraperAccount,
      );
      if (gotSnapshot) summary.balanceSnapshots++;

      for (const txn of scraperAccount.txns) {
        const { branch, entryId } = await promoteTransaction(
          tx,
          userId,
          dataKey,
          connectorId,
          syncRunId,
          resolved,
          reportingCurrency,
          txn,
        );
        if (branch === "new") {
          summary.newEntries++;
          touchedEntryIds.push(entryId);
        } else if (branch === "matchedUnchanged") {
          summary.matchedUnchanged++;
        } else {
          summary.updatedPendingToPosted++;
          touchedEntryIds.push(entryId);
        }
      }
    }

    // Categorization runs once for the whole batch, not per transaction:
    // rule conditions are encrypted, so the ruleset has to be decrypted and
    // compiled, and doing that per row would be wasteful
    // (docs/design/categorization.md). Inside this same transaction, so a
    // rolled-back scrape leaves no categories behind either.
    summary.categorized = await categorizeEntries(tx, userId, dataKey, touchedEntryIds);

    // Merchant resolution, for the same reason and in the same place: the
    // catalog and the existing merchant set are decrypted once for the batch
    // rather than once per row (docs/adr/0005-*). Inside this transaction
    // too, so a rolled-back scrape leaves no merchants behind.
    const merchantResult = await resolveMerchants(tx, userId, dataKey, touchedEntryIds);
    summary.merchantsCreated = merchantResult.merchantsCreated;

    // Last statement in the transaction on purpose (docs plan §D) — a
    // throw anywhere above means this line never runs and the whole
    // transaction rolls back, so a failed/partial promotion never shows
    // 'succeeded'.
    await tx
      .update(syncRuns)
      .set({ status: "succeeded", windowEnd: new Date() })
      .where(eq(syncRuns.id, syncRunId));
    await tx
      .update(connections)
      .set({ lastSyncAt: new Date(), status: "active" })
      .where(eq(connections.id, connectionId));

    return summary;
  });
}

/** Creates a `sync_runs` row with status 'running', to be passed into
 * `promoteScrapeResult`. Callers that spawn the child (docs plan §C) create
 * this BEFORE spawning — "the parent sets status='running' itself right
 * after spawn." */
export async function startSyncRun(userId: string, connectionId: string): Promise<string> {
  const id = randomUUID();
  await withUser(userId, async (tx) => {
    await tx.insert(syncRuns).values({
      id,
      ownerId: userId,
      connectionId,
      status: "running",
      windowStart: new Date(),
    });
  });
  return id;
}

/** Creates a run only while the source remains active, serializing with disconnect. */
export async function startActiveConnectionSyncRun(
  userId: string,
  connectionId: string,
): Promise<string | null> {
  const id = randomUUID();
  return withUser(userId, async (tx) => {
    const connection = (
      await tx
        .select({ id: connections.id, status: connections.status })
        .from(connections)
        .where(eq(connections.id, connectionId))
        .for("update")
        .limit(1)
    )[0];
    if (!connection || connection.status !== "active") return null;
    await tx.insert(syncRuns).values({
      id,
      ownerId: userId,
      connectionId,
      status: "running",
      windowStart: new Date(),
    });
    return id;
  });
}

/**
 * Writes the terminal 'failed' state for a sync run. Deliberately its OWN
 * transaction, separate from whatever `promoteScrapeResult` attempted and
 * already rolled back (docs plan §D: "the failed write happens in a
 * separate transaction from the outer catch").
 *
 * Guarded by `WHERE status='running'` (task 14) — the sync route's child
 * `exit` handler calls this unconditionally as a safety net (SIGKILL after
 * the 5-min/5s timeout, an ENOENT spawn failure, or any crash before the
 * child's own catch runs), and the guard makes that call a no-op when the
 * run already reached a terminal state (its own catch already marked it
 * failed, or `promoteScrapeResult` already marked it succeeded) — never
 * clobbers a resolved run.
 */
export async function markSyncRunFailed(
  userId: string,
  syncRunId: string,
  error: string,
): Promise<void> {
  await withUser(userId, async (tx) => {
    await tx
      .update(syncRuns)
      .set({ status: "failed", error, windowEnd: new Date() })
      .where(and(eq(syncRuns.id, syncRunId), eq(syncRuns.status, "running")));
  });
}

export interface SyncRunView {
  id: string;
  connectionId: string;
  status: string;
  windowStart: Date | null;
  windowEnd: Date | null;
  error: string | null;
}

function toSyncRunView(row: typeof syncRuns.$inferSelect): SyncRunView {
  return {
    id: row.id,
    connectionId: row.connectionId,
    status: row.status,
    windowStart: row.windowStart,
    windowEnd: row.windowEnd,
    error: row.error,
  };
}

/** A `running` row older than this is presumed orphaned — its parent process
 * died mid-scrape without ever reaching a terminal write. A clean run always
 * resolves well inside the child's 5-minute SIGTERM budget, so 15 minutes is
 * a comfortable margin, not a race (task 19, docs plan §C). */
const STALE_RUNNING_MS = 15 * 60 * 1000;

/**
 * Reads one `sync_runs` row — the UI's poll target (task 15). Also carries
 * the lazy orphaned-run self-heal (task 19): a `running` row older than
 * `STALE_RUNNING_MS` is flipped to `failed` right here, on read — no cron,
 * no scheduler, exactly the plan's "lazy on-read only." The update is
 * guarded by `WHERE status='running'` the same way `markSyncRunFailed` is,
 * so a concurrent reader (or a real update from the scrape itself landing
 * at the same moment) can't be clobbered. Returns null if the run doesn't
 * exist for this user (RLS-filtered cross-tenant id, same as the rest of
 * this module).
 */
export async function getSyncRun(userId: string, syncRunId: string): Promise<SyncRunView | null> {
  return withUser(userId, async (tx) => {
    const rows = await tx.select().from(syncRuns).where(eq(syncRuns.id, syncRunId)).limit(1);
    const row = rows[0];
    if (!row) return null;

    if (
      row.status === "running" &&
      row.windowStart &&
      Date.now() - row.windowStart.getTime() > STALE_RUNNING_MS
    ) {
      const windowEnd = new Date();
      const error = "orphaned run: no update within 15 minutes";
      await tx
        .update(syncRuns)
        .set({ status: "failed", error, windowEnd })
        .where(and(eq(syncRuns.id, syncRunId), eq(syncRuns.status, "running")));
      return {
        id: row.id,
        connectionId: row.connectionId,
        status: "failed",
        windowStart: row.windowStart,
        windowEnd,
        error,
      };
    }

    return toSyncRunView(row);
  });
}

/**
 * The most recent `sync_runs` row per connection, keyed by connection id.
 *
 * The connections page needs this because a failure otherwise leaves no
 * trace the user can see: `connections.status` is never set to `error` by
 * the sync path, and the polling client's in-memory error state dies on the
 * next full page load. Without it "the sync failed" is unactionable — the
 * owner hit exactly that with a Leumi navigation timeout.
 *
 * Deliberately does NOT run the orphaned-run self-heal that `getSyncRun`
 * carries: this is a list read, and a stale `running` row here resolves on
 * the next poll of that specific run. Keeping the write out of the list
 * path avoids an UPDATE on every page render.
 */
export async function getLatestSyncRunByConnection(
  userId: string,
): Promise<Record<string, SyncRunView>> {
  return withUser(userId, async (tx) => {
    const rows = await tx
      .selectDistinctOn([syncRuns.connectionId])
      .from(syncRuns)
      .orderBy(syncRuns.connectionId, desc(syncRuns.createdAt));
    return Object.fromEntries(rows.map((row) => [row.connectionId, toSyncRunView(row)]));
  });
}

/** Minimum days back the scrape window always covers (decision #7, docs plan
 * §Decisions row 7) — keeps the onboarding scrape inside the child's 5-
 * minute SIGTERM budget. */
const MIN_WINDOW_DAYS = 30;
/** Extra days back from `lastSyncAt` the window reaches, closing the gap a
 * user who skips syncing for a while would otherwise permanently lose —
 * free because reconciliation is idempotent (task 13's three-run proof). */
const LAST_SYNC_OVERLAP_DAYS = 7;

function daysBefore(from: Date, days: number): Date {
  const d = new Date(from);
  d.setDate(d.getDate() - days);
  return d;
}

/**
 * `startDate = min(today - 30d, lastSyncAt - 7d)` (decision #7) — computed
 * server-side, never chosen by the user. `lastSyncAt: null` (a brand-new
 * connection, onboarding) collapses to exactly 30 days, since there's no
 * earlier date to compare against. `min` here means chronologically
 * earlier — going further back is what closes the gap. Returns a
 * `YYYY-MM-DD` string, the shape `scrape-worker.mts`'s
 * `new Date(payload.startDate)` expects.
 */
export function computeSyncStartDate(lastSyncAt: Date | null, now: Date = new Date()): string {
  const floor = daysBefore(now, MIN_WINDOW_DAYS);
  if (!lastSyncAt) return floor.toISOString().slice(0, 10);

  const overlapFloor = daysBefore(lastSyncAt, LAST_SYNC_OVERLAP_DAYS);
  const earliest = overlapFloor < floor ? overlapFloor : floor;
  return earliest.toISOString().slice(0, 10);
}
