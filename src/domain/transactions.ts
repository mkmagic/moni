// Domain read: ledger entries (transactions), decrypted and reporting-valued.
// Filters on plaintext structural columns (date, account), decrypts the
// narrowed set, and derives the reporting amount = entered × locked fx_rate
// (data-model.md §4.3). Pending-FX entries are flagged, never faked to 1:1
// (money-and-currency.md §4).
import { and, desc, eq, gte, lte } from "drizzle-orm";
import { withUser } from "@/db/client";
import { accounts, categories, entries, merchants } from "@/db/schema";
import { multiply, type Money } from "@/lib/money";
import type { Session } from "@/lib/auth/session-store";
import { decText } from "./fields";

export interface EntryView {
  id: string;
  date: string;
  description: string;
  accountName: string;
  categoryName: string | null;
  merchantName: string | null;
  /** Reporting (base-currency) amount when the rate is locked; the entered leg when pending. Sign carried. */
  amount: Money;
  /** True when no locked FX rate exists yet — amount is the entered leg, not reporting. */
  fxPending: boolean;
  excluded: boolean;
  status: string;
}

export interface EntryFilters {
  from?: string;
  to?: string;
  accountId?: string;
  limit?: number;
}

export async function listEntries(
  session: Session,
  filters: EntryFilters = {},
): Promise<EntryView[]> {
  const { userId, dataKey } = session;
  return withUser(userId, async (tx) => {
    const conds = [];
    if (filters.from) conds.push(gte(entries.date, filters.from));
    if (filters.to) conds.push(lte(entries.date, filters.to));
    if (filters.accountId) conds.push(eq(entries.accountId, filters.accountId));

    const rows = await tx
      .select()
      .from(entries)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(entries.date))
      .limit(filters.limit ?? 200);

    // Name lookups (small per-user tables; decrypt once, map by id).
    const acctRows = await tx
      .select({ id: accounts.id, nameCt: accounts.nameCt, version: accounts.version })
      .from(accounts);
    const acctName = new Map(
      acctRows.map((a) => [a.id, decText(dataKey, a.nameCt, a.id, "name_ct", a.version) ?? ""]),
    );

    const catRows = await tx.select({ id: categories.id, name: categories.name }).from(categories);
    const catName = new Map(catRows.map((c) => [c.id, c.name]));

    const merRows = await tx
      .select({ id: merchants.id, nameCt: merchants.nameCt, version: merchants.version })
      .from(merchants);
    const merName = new Map(
      merRows.map((m) => [m.id, decText(dataKey, m.nameCt, m.id, "name_ct", m.version) ?? ""]),
    );

    return rows.map((e): EntryView => {
      const description =
        decText(dataKey, e.descriptionCt, e.id, "description_ct", e.version) ?? "";
      const entered =
        decText(dataKey, e.enteredAmountCt, e.id, "entered_amount_ct", e.version) ?? "0";
      const fxPending = e.fxStatus === "pending" || !e.fxRate;
      const amount: Money = fxPending
        ? { amount: entered, currency: e.enteredCurrency }
        : {
            amount: multiply({ amount: entered, currency: e.enteredCurrency }, e.fxRate as string)
              .amount,
            currency: e.reportingCurrency,
          };
      return {
        id: e.id,
        date: e.date,
        description,
        accountName: acctName.get(e.accountId) ?? "—",
        categoryName: e.categoryId ? (catName.get(e.categoryId) ?? null) : null,
        merchantName: e.merchantId ? (merName.get(e.merchantId) ?? null) : null,
        amount,
        fxPending,
        excluded: e.excluded,
        status: e.status,
      };
    });
  });
}
