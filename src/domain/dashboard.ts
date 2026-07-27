// Domain read: the overview dashboard aggregates. Pure decrypt-then-aggregate
// in the app tier (data-model.md §4.3/§6, domain-layer.md §3.3) — SQL never
// sums ciphertext. All arithmetic is decimal.js; values are returned as exact
// strings. Two distinct rate rules:
//   * Flows (income/expenses) use each entry's OWN locked reporting amount.
//   * Net worth (a stock) values each account's current balance at TODAY's
//     latest rate (money-and-currency.md §5).
import Decimal from "decimal.js";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import { withUser } from "@/db/client";
import { accounts, entries, fxRates } from "@/db/schema";
import { multiply, type Money } from "@/lib/money";
import type { Session } from "@/lib/auth/session-store";
import { decText } from "./fields";
import { countsAsFlow, loadTransferCategoryIds } from "./flows";

export interface MonthPoint {
  month: string; // "YYYY-MM"
  income: string;
  expenses: string; // positive magnitude
  net: string;
}

export interface Overview {
  baseCurrency: string;
  currentMonth: string;
  netWorth: Money;
  assetsTotal: Money;
  monthlyIncome: Money;
  monthlyExpenses: Money; // positive magnitude
  months: MonthPoint[];
}

function monthKey(isoDate: string): string {
  return isoDate.slice(0, 7);
}

/** First day of the month N months before `from` (a "YYYY-MM-DD"), as ISO date. */
function monthsBefore(from: string, n: number): string {
  const d = new Date(`${from.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - n);
  return d.toISOString().slice(0, 10);
}

export async function getOverview(session: Session): Promise<Overview> {
  const { userId, dataKey, baseCurrency } = session;
  const today = new Date().toISOString().slice(0, 10);
  const currentMonth = monthKey(today);
  const windowStart = monthsBefore(today, 5); // current + 5 prior months

  return withUser(userId, async (tx) => {
    // --- Net worth (stock): current balances valued at today's latest rate ---
    const acctRows = await tx.select().from(accounts);
    // Latest USD->base rate for valuing a foreign-currency account.
    const [usdRate] = await tx
      .select({ rate: fxRates.rate })
      .from(fxRates)
      .where(and(eq(fxRates.fromCurrency, "USD"), eq(fxRates.toCurrency, baseCurrency)))
      .orderBy(desc(fxRates.date))
      .limit(1);

    let netWorth = new Decimal(0);
    let assets = new Decimal(0);
    for (const a of acctRows) {
      const raw = decText(dataKey, a.currentBalanceCt, a.id, "current_balance_ct", a.version);
      if (raw == null) continue;
      let valued = new Decimal(raw);
      if (a.currency !== baseCurrency) {
        if (a.currency === "USD" && usdRate) valued = valued.times(new Decimal(usdRate.rate));
        // else: no rate to value this currency — best-effort, left in native units.
      }
      netWorth = netWorth.plus(valued);
      if (a.classification === "asset") assets = assets.plus(valued);
    }

    // --- Flows (income/expenses): each entry's own locked reporting amount ---
    const entryRows = await tx
      .select()
      .from(entries)
      .where(and(gte(entries.date, windowStart), lte(entries.date, today)));

    const transferCategoryIds = await loadTransferCategoryIds(tx);

    const buckets = new Map<string, { income: Decimal; expenses: Decimal }>();
    for (const e of entryRows) {
      // Excluded legs and transfer-classified categories are neither income
      // nor expense — see flows.ts for why, and use it for any new aggregate.
      if (!countsAsFlow(e, transferCategoryIds)) continue;
      if (e.fxStatus === "pending" || !e.fxRate) continue; // never fake a rate
      const entered = decText(dataKey, e.enteredAmountCt, e.id, "entered_amount_ct", e.version);
      if (entered == null) continue;
      const reporting = new Decimal(
        multiply({ amount: entered, currency: e.enteredCurrency }, e.fxRate).amount,
      );
      const key = monthKey(e.date);
      const b = buckets.get(key) ?? { income: new Decimal(0), expenses: new Decimal(0) };
      if (reporting.isPositive()) b.income = b.income.plus(reporting);
      else b.expenses = b.expenses.plus(reporting.abs());
      buckets.set(key, b);
    }

    // Ordered month series across the window (fill gaps with zeros).
    const months: MonthPoint[] = [];
    for (let i = 5; i >= 0; i--) {
      const key = monthKey(monthsBefore(today, i));
      const b = buckets.get(key) ?? { income: new Decimal(0), expenses: new Decimal(0) };
      months.push({
        month: key,
        income: b.income.toString(),
        expenses: b.expenses.toString(),
        net: b.income.minus(b.expenses).toString(),
      });
    }
    const current = buckets.get(currentMonth) ?? {
      income: new Decimal(0),
      expenses: new Decimal(0),
    };

    return {
      baseCurrency,
      currentMonth,
      netWorth: { amount: netWorth.toString(), currency: baseCurrency },
      assetsTotal: { amount: assets.toString(), currency: baseCurrency },
      monthlyIncome: { amount: current.income.toString(), currency: baseCurrency },
      monthlyExpenses: { amount: current.expenses.toString(), currency: baseCurrency },
      months,
    };
  });
}
