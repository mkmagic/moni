/**
 * Promotion for an Agam Liderim portfolio import: one uploaded Excel becomes
 * many long-term-savings accounts, each with a current balance.
 *
 * This is the multi-account counterpart to `long-term-savings-promotion.ts`.
 * That path is one connection, one account, one statement with movements and a
 * self-balancing equation. This one is one connection, many accounts, each a
 * balance snapshot and nothing more — the shape SnapTrade's promotion has, not
 * Harel's. So it matches accounts by a decrypt-and-match on
 * `external_account_ref_ct`, scoped to this connection, as the scrape path
 * does — but the ref is provider + product type + policy number (normalised,
 * see `pairAccounts` for the looser fallbacks), not the number alone: pension funds use the member's ID as the "account number", so
 * one file routinely holds several accounts with the same number. It writes only `accounts` + `long_term_savings_details` +
 * `account_balance_snapshots`.
 *
 * It writes no `long_term_savings_snapshots` row on purpose: that table's
 * movement columns are non-null and the file carries no movements, so the only
 * way to populate it would be to fabricate zeros — which would both invent an
 * opening balance and fail the balance-equation check. The balance lives in
 * `account_balance_snapshots`, its canonical home (data-model.md §1/§5), and
 * the read layer surfaces it from there for accounts that have no report.
 *
 * Everything runs inside one `withUser()` transaction; a throw rolls the whole
 * import back and `markSyncRunFailed` records the failure separately, the same
 * atomic-failure contract every other promotion keeps.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { withUser, type UserTransaction as Tx } from "@/db/client";
import { accountBalanceSnapshots, accounts, longTermSavingsDetails, syncRuns } from "@/db/schema";
import type { AgamLiderimAccount } from "@/lib/connectors/agam-liderim";
import { errorLabel, syncLog } from "@/lib/sync-log";
import { decText, encText } from "./fields";
import { LIQUIDITY_BY_PRODUCT } from "./long-term-savings-promotion";
import { markSyncRunFailed } from "./sync-promotion";

/** The export is denominated in shekels; there is no currency on the page. */
const CURRENCY = "ILS";
/** Every Agam balance snapshot is a long-term-savings balance. */
const SNAPSHOT_SOURCE = "long_term_savings";

export type AgamLiderimPromotionErrorCode =
  "invalid_sync" | "account_type_mismatch" | "empty_portfolio" | "promotion_failed";

export class AgamLiderimPromotionError extends Error {
  constructor(readonly code: AgamLiderimPromotionErrorCode) {
    super(code);
    this.name = "AgamLiderimPromotionError";
  }
}

function fail(code: AgamLiderimPromotionErrorCode): never {
  throw new AgamLiderimPromotionError(code);
}

export interface AgamLiderimPromotionInput {
  userId: string;
  connectionId: string;
  syncRunId: string;
  /** Tier-0 — caller owns wiping it. */
  dataKey: Uint8Array;
  parserId: string;
  parserVersion: number;
  accounts: AgamLiderimAccount[];
}

export interface AgamLiderimPromotionResult {
  accountsProcessed: number;
  accountsCreated: number;
  balanceSnapshots: number;
}

/**
 * The account's display name: the specific product name when the file gives
 * one ("הראל פנסיה"), else the provider and the Hebrew product type. Never the
 * policy number.
 */
function accountName(acct: AgamLiderimAccount): string {
  return acct.productName ?? `${acct.provider} ${acct.productType}`;
}

/**
 * A workbook label reduced to what identifies it: quotes, punctuation,
 * whitespace and the legal-entity suffix (בע"מ) dropped, so a later export
 * that re-spells a provider or product type still matches the same account.
 */
function normaliseLabel(label: string): string {
  return label
    .replace(/["'׳״.,()\-–]/g, "")
    .replace(/\s+/g, "")
    .replace(/בעמ$/, "");
}

/**
 * The stored match key. The policy number alone is not unique — pension funds
 * reuse the member's ID — so it is qualified by the provider and the product
 * type (a comprehensive and a supplementary pension at one provider share it).
 */
function accountRef(acct: AgamLiderimAccount): string {
  return JSON.stringify([
    normaliseLabel(acct.provider),
    normaliseLabel(acct.productType),
    acct.policyNumber,
  ]);
}

type AccountRow = typeof accounts.$inferSelect;

interface Held {
  row: AccountRow;
  ref: string | null;
  provider: string;
  /** Null for an account stored under the old bare-policy-number ref. */
  productType: string | null;
  policyNumber: string | null;
}

/** This connection's accounts, with their decrypted refs split back into parts. */
async function loadHeld(tx: Tx, input: AgamLiderimPromotionInput): Promise<Held[]> {
  const rows = await tx
    .select()
    .from(accounts)
    .where(eq(accounts.connectionId, input.connectionId));
  return rows.map((row) => {
    const ref = row.externalAccountRefCt
      ? decText(
          input.dataKey,
          row.externalAccountRefCt,
          row.id,
          "external_account_ref_ct",
          row.version,
        )
      : null;
    const parts = ref?.startsWith("[") ? (JSON.parse(ref) as string[]) : null;
    return {
      row,
      ref,
      provider: parts ? parts[0] : normaliseLabel(row.institution ?? ""),
      productType: parts ? parts[1] : null,
      policyNumber: parts ? parts[2] : ref,
    };
  });
}

/**
 * Pairs each parsed row (by index) with the held account it updates. Each held
 * account is claimed at most once, so two rows can never collapse into one, and
 * the tiers run loosest-last so an exact match is never stolen by a fuzzy one:
 *
 * 1. the exact {@link accountRef};
 * 2. the same policy number at the same provider — an account stored under the
 *    old bare-number ref, or a product type the file relabelled;
 * 3. the same policy number and product type under a renamed provider, only
 *    when exactly one held account and one row fit — a rebrand, not a guess.
 *
 * Anything left unpaired is a new account.
 */
function pairAccounts(held: Held[], rows: AgamLiderimAccount[]): Map<number, Held> {
  const paired = new Map<number, Held>();
  const claimed = new Set<Held>();
  const open = () => rows.flatMap((_, i) => (paired.has(i) ? [] : [i]));
  const tier = (fits: (h: Held, acct: AgamLiderimAccount) => boolean, oneToOne = false) => {
    for (const i of open()) {
      const candidates = held.filter((h) => !claimed.has(h) && fits(h, rows[i]));
      if (candidates.length === 0) continue;
      if (oneToOne) {
        const rivals = open().filter((j) => held.some((h) => fits(h, rows[j]) && fits(h, rows[i])));
        if (candidates.length !== 1 || rivals.length !== 1) continue;
      }
      paired.set(i, candidates[0]);
      claimed.add(candidates[0]);
    }
  };
  tier((h, acct) => h.ref === accountRef(acct));
  tier(
    (h, acct) =>
      h.policyNumber === acct.policyNumber && h.provider === normaliseLabel(acct.provider),
  );
  tier(
    (h, acct) =>
      h.policyNumber === acct.policyNumber && h.productType === normaliseLabel(acct.productType),
    true,
  );
  return paired;
}

/**
 * Resolves one parsed account to its paired held account, scoped to this
 * connection so two Agam connections never merge, upgrading the held ref (and
 * the provider name, on a rebrand) when it was matched by a looser tier. Creates
 * the account and its details row when nothing was paired.
 */
async function resolveAccount(
  tx: Tx,
  input: AgamLiderimPromotionInput,
  acct: AgamLiderimAccount,
  match: Held | undefined,
): Promise<{ id: string; version: number; isNew: boolean }> {
  const { userId, dataKey } = input;
  const ref = accountRef(acct);
  if (match) {
    const { row } = match;
    // The connection is a long-term-savings aggregator; a row of another type
    // under it would mean corrupted state, not a normal re-import.
    if (row.accountType !== "long_term_savings") fail("account_type_mismatch");
    if (match.ref !== ref)
      await tx
        .update(accounts)
        .set({
          externalAccountRefCt: encText(
            dataKey,
            ref,
            row.id,
            "external_account_ref_ct",
            row.version,
          ),
          institution: acct.provider,
        })
        .where(eq(accounts.id, row.id));
    return { id: row.id, version: row.version, isNew: false };
  }

  const id = randomUUID();
  await tx.insert(accounts).values({
    id,
    ownerId: userId,
    accountType: "long_term_savings",
    // Always an asset; liquidity governs presentation, never whether the
    // balance counts toward net worth.
    classification: "asset",
    connectionId: input.connectionId,
    nameCt: encText(dataKey, accountName(acct), id, "name_ct", 1),
    // The real provider holding the money, per account — the agency is only the
    // source. This is why the connector carries no single institution label.
    institution: acct.provider,
    accountNumberLast4Ct: encText(
      dataKey,
      acct.policyNumber.slice(-4),
      id,
      "account_number_last4_ct",
      1,
    ),
    externalAccountRefCt: encText(dataKey, ref, id, "external_account_ref_ct", 1),
    currency: CURRENCY,
    status: "active",
    currentBalanceCt: encText(dataKey, acct.balance, id, "current_balance_ct", 1),
  });
  await tx.insert(longTermSavingsDetails).values({
    accountId: id,
    ownerId: userId,
    product: acct.product,
    liquidity: LIQUIDITY_BY_PRODUCT[acct.product],
    // The xlsx carries no liquidity date, unlike a קרן השתלמות PDF's section א,
    // so a `liquid_after` account here shows a generic "after a qualifying
    // period" badge rather than a year.
    liquidFrom: null,
  });
  return { id, version: 1, isNew: true };
}

/**
 * Re-encrypts every ciphertext column on the account row under a bumped
 * version — `version` is shared by all of them, so touching one while bumping
 * the version would leave the rest undecryptable (the trap the scrape path
 * documents).
 */
async function refreshCachedBalance(
  tx: Tx,
  dataKey: Uint8Array,
  accountId: string,
  balance: string,
): Promise<void> {
  const [row] = await tx.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
  if (!row) return;
  const version = row.version + 1;
  const name = decText(dataKey, row.nameCt, row.id, "name_ct", row.version) ?? "";
  const last4 = decText(
    dataKey,
    row.accountNumberLast4Ct,
    row.id,
    "account_number_last4_ct",
    row.version,
  );
  const ref = decText(
    dataKey,
    row.externalAccountRefCt,
    row.id,
    "external_account_ref_ct",
    row.version,
  );
  await tx
    .update(accounts)
    .set({
      nameCt: encText(dataKey, name, row.id, "name_ct", version),
      accountNumberLast4Ct:
        last4 != null ? encText(dataKey, last4, row.id, "account_number_last4_ct", version) : null,
      externalAccountRefCt:
        ref != null ? encText(dataKey, ref, row.id, "external_account_ref_ct", version) : null,
      currentBalanceCt: encText(dataKey, balance, row.id, "current_balance_ct", version),
      version,
    })
    .where(eq(accounts.id, accountId));
}

async function promote(
  tx: Tx,
  input: AgamLiderimPromotionInput,
): Promise<AgamLiderimPromotionResult> {
  const { userId, dataKey } = input;
  if (input.accounts.length === 0) fail("empty_portfolio");

  const run = await tx
    .select()
    .from(syncRuns)
    .where(and(eq(syncRuns.id, input.syncRunId), eq(syncRuns.status, "running")));
  if (run.length !== 1 || run[0].connectionId !== input.connectionId) fail("invalid_sync");

  const result: AgamLiderimPromotionResult = {
    accountsProcessed: 0,
    accountsCreated: 0,
    balanceSnapshots: 0,
  };

  const paired = pairAccounts(await loadHeld(tx, input), input.accounts);
  for (const [i, acct] of input.accounts.entries()) {
    const resolved = await resolveAccount(tx, input, acct, paired.get(i));
    result.accountsProcessed++;
    if (resolved.isNew) result.accountsCreated++;

    // Idempotent re-import: replace any snapshot already held for this account
    // on this as-of date rather than stacking a duplicate — there is no unique
    // key on (account, date) to lean on.
    await tx
      .delete(accountBalanceSnapshots)
      .where(
        and(
          eq(accountBalanceSnapshots.accountId, resolved.id),
          eq(accountBalanceSnapshots.date, acct.asOf),
          eq(accountBalanceSnapshots.source, SNAPSHOT_SOURCE),
        ),
      );

    const snapshotId = randomUUID();
    await tx.insert(accountBalanceSnapshots).values({
      id: snapshotId,
      ownerId: userId,
      accountId: resolved.id,
      date: acct.asOf,
      nativeBalanceCt: encText(dataKey, acct.balance, snapshotId, "native_balance_ct", 1),
      currency: CURRENCY,
      source: SNAPSHOT_SOURCE,
    });
    result.balanceSnapshots++;

    // The cached balance moves only when this import is the newest figure held
    // for the account, so re-importing an older export never disturbs net
    // worth. A brand-new account already carries this balance from its insert.
    if (!resolved.isNew) {
      const held = await tx
        .select({ date: accountBalanceSnapshots.date })
        .from(accountBalanceSnapshots)
        .where(eq(accountBalanceSnapshots.accountId, resolved.id));
      if (held.every((row) => row.date <= acct.asOf))
        await refreshCachedBalance(tx, dataKey, resolved.id, acct.balance);
    }
  }

  const transitioned = await tx
    .update(syncRuns)
    .set({
      status: "succeeded",
      windowEnd: new Date(),
      promotedAccountCount: result.accountsProcessed,
    })
    .where(and(eq(syncRuns.id, input.syncRunId), eq(syncRuns.status, "running")))
    .returning({ id: syncRuns.id });
  if (transitioned.length !== 1) fail("invalid_sync");

  return result;
}

export async function promoteAgamLiderimPortfolio(
  input: AgamLiderimPromotionInput,
): Promise<AgamLiderimPromotionResult> {
  try {
    return await withUser(input.userId, (tx) => promote(tx, input));
  } catch (error) {
    const promotion = error instanceof AgamLiderimPromotionError;
    syncLog("promotion.failed", {
      source: input.parserId,
      code: promotion ? error.code : "promotion_failed",
      error: promotion ? undefined : errorLabel(error),
    });
    const code = promotion ? error.code : "promotion_failed";
    // The whole write is one transaction, already rolled back on any throw —
    // record the failure in its own transaction so it survives that rollback.
    await markSyncRunFailed(input.userId, input.syncRunId, code);
    throw promotion ? error : new AgamLiderimPromotionError("promotion_failed");
  }
}
