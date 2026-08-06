// Domain read: a user's accounts, decrypted. Goes through withUser (RLS) and
// decrypts Tier-1 fields with the session's in-RAM data key. Returns money as
// exact decimal strings (Money) — never formatted, never a float.
import Decimal from "decimal.js";
import { and, eq } from "drizzle-orm";
import { withUser } from "@/db/client";
import { accounts, connections } from "@/db/schema";
import type { Money } from "@/lib/money";
import type { Session } from "@/lib/auth/session-store";
import { decText } from "./fields";
import { usableIlsRate } from "./ils-rate";
import { israelDate } from "./investment-valuation";
import { listInvestmentAccountValues } from "./investments";

export interface AccountView {
  id: string;
  accountType: string;
  classification: "asset" | "liability";
  institution: string | null;
  name: string;
  last4: string | null;
  currency: string;
  /**
   * The connector this account arrives through, if any. The UI shows it as
   * provenance ("via SnapTrade") — the connection is how Moni reaches the
   * account, not the account itself, and conflating the two is what made an
   * account read as "snaptrade".
   */
  connectorId: string | null;
  /** Latest known native balance (from the cached snapshot). Null if unknown. */
  balance: Money | null;
  status: string;
}

/** Archives an account without deleting its historical observations. */
export async function archiveAccount(userId: string, accountId: string): Promise<boolean> {
  return withUser(userId, async (tx) => {
    const updated = await tx
      .update(accounts)
      .set({ status: "archived", archivedAt: new Date() })
      .where(
        and(
          eq(accounts.id, accountId),
          eq(accounts.accountType, "investment"),
          eq(accounts.status, "active"),
        ),
      )
      .returning({ id: accounts.id });
    return updated.length > 0;
  });
}

export async function listAccounts(session: Session): Promise<AccountView[]> {
  const { userId, dataKey } = session;
  return withUser(userId, async (tx) => {
    const rows = await tx
      .select({ account: accounts, connectorId: connections.connectorId })
      .from(accounts)
      .leftJoin(connections, eq(connections.id, accounts.connectionId))
      .orderBy(accounts.createdAt);
    return rows.map(({ account: a, connectorId }): AccountView => {
      const balance = decText(dataKey, a.currentBalanceCt, a.id, "current_balance_ct", a.version);
      return {
        id: a.id,
        connectorId,
        accountType: a.accountType,
        classification: a.classification,
        institution: a.institution,
        name: decText(dataKey, a.nameCt, a.id, "name_ct", a.version) ?? "",
        last4: decText(dataKey, a.accountNumberLast4Ct, a.id, "account_number_last4_ct", a.version),
        currency: a.currency,
        balance: balance == null ? null : { amount: balance, currency: a.currency },
        status: a.status,
      };
    });
  });
}

/**
 * Assets grouped by how soon the money can be reached, most-accessible first
 * (#77 §1). `checking` and `savings` merge on purpose: both are money you can
 * move today, and the distinction that would matter — a פק"מ locked for a term
 * — isn't in the enum anyway.
 */
export type AccountGroupKey = "cash" | "investments" | "long_term_savings" | "other";

const GROUP_ORDER: AccountGroupKey[] = ["cash", "investments", "long_term_savings", "other"];

function groupOf(accountType: string): AccountGroupKey {
  if (accountType === "checking" || accountType === "savings") return "cash";
  if (accountType === "investment") return "investments";
  if (accountType === "long_term_savings") return "long_term_savings";
  return "other";
}

export interface AccountGroupView {
  key: AccountGroupKey;
  accounts: AccountView[];
  /**
   * The group's worth in ILS. Base currency, not native: a group can hold
   * accounts in several currencies, and one comparable figure is the only kind
   * that can be a subtotal.
   */
  subtotal: Money;
  /**
   * Accounts the subtotal leaves out — no stored balance, or no
   * Bank-of-Israel rate recent enough to value one (see `ils-rate.ts`). Shown
   * so a subtotal that is smaller than the cards above it says why.
   */
  unvaluedCount: number;
}

export interface GroupedAccounts {
  /** In `GROUP_ORDER`; empty groups are dropped rather than rendered. */
  assetGroups: AccountGroupView[];
  /** Flat — most households have one or two, and a heading per type would
   * outnumber the cards beneath it. */
  liabilities: AccountView[];
  /** ILS per investment account; their worth comes from holdings, not a balance. */
  investmentValues: Map<string, string>;
}

export async function listAccountsGrouped(session: Session): Promise<GroupedAccounts> {
  const [all, investmentValues] = await Promise.all([
    listAccounts(session),
    listInvestmentAccountValues(session),
  ]);
  const today = israelDate(new Date());

  const totals = await withUser(session.userId, async (tx) => {
    const sums = new Map<AccountGroupKey, { total: Decimal; unvalued: number }>();
    for (const account of all) {
      if (account.classification !== "asset") continue;
      const key = groupOf(account.accountType);
      const bucket = sums.get(key) ?? { total: new Decimal(0), unvalued: 0 };
      const ils = investmentValues.get(account.id);
      if (account.status !== "active") {
        // Same exclusion the dashboard's net worth applies, so the two agree —
        // counted rather than skipped, because the card still renders and an
        // unexplained gap between it and the subtotal reads as a bug.
        bucket.unvalued += 1;
      } else if (ils !== undefined) {
        bucket.total = bucket.total.plus(ils);
      } else if (account.balance === null) {
        bucket.unvalued += 1;
      } else {
        const rate = await usableIlsRate(tx, account.balance.currency, today);
        if (rate)
          bucket.total = bucket.total.plus(new Decimal(account.balance.amount).mul(rate.rate));
        else bucket.unvalued += 1;
      }
      sums.set(key, bucket);
    }
    return sums;
  });

  const assetGroups = GROUP_ORDER.flatMap((key): AccountGroupView[] => {
    const members = all.filter(
      (account) => account.classification === "asset" && groupOf(account.accountType) === key,
    );
    if (members.length === 0) return [];
    const sum = totals.get(key);
    return [
      {
        key,
        accounts: members,
        subtotal: { amount: (sum?.total ?? new Decimal(0)).toFixed(), currency: "ILS" },
        unvaluedCount: sum?.unvalued ?? 0,
      },
    ];
  });

  return {
    assetGroups,
    liabilities: all.filter((account) => account.classification === "liability"),
    investmentValues,
  };
}
