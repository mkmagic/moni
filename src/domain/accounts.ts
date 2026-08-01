// Domain read: a user's accounts, decrypted. Goes through withUser (RLS) and
// decrypts Tier-1 fields with the session's in-RAM data key. Returns money as
// exact decimal strings (Money) — never formatted, never a float.
import { and, eq } from "drizzle-orm";
import { withUser } from "@/db/client";
import { accounts } from "@/db/schema";
import type { Money } from "@/lib/money";
import type { Session } from "@/lib/auth/session-store";
import { decText } from "./fields";

export interface AccountView {
  id: string;
  accountType: string;
  classification: "asset" | "liability";
  institution: string | null;
  name: string;
  last4: string | null;
  currency: string;
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
    const rows = await tx.select().from(accounts).orderBy(accounts.createdAt);
    return rows.map((a): AccountView => {
      const balance = decText(dataKey, a.currentBalanceCt, a.id, "current_balance_ct", a.version);
      return {
        id: a.id,
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
