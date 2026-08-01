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
import { accountBalanceSnapshots, accounts, entries, fxRates } from "@/db/schema";
import { multiply, type Money } from "@/lib/money";
import type { Session } from "@/lib/auth/session-store";
import { decText } from "./fields";
import { countsAsFlow, loadTransferCategoryIds } from "./flows";
import {
  israelDate,
  valueInvestmentNetWorth,
  type ValuationMetadata,
} from "./investment-valuation";

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
  netWorthHistory: Array<{ month: string; amount: string; metadata: ValuationMetadata }>;
  netWorthMetadata: ValuationMetadata;
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

function monthEnd(month: string): string {
  const [year, number] = month.split("-").map(Number);
  return new Date(Date.UTC(year, number, 0)).toISOString().slice(0, 10);
}

function mergeMetadata(values: ValuationMetadata[]): ValuationMetadata {
  const components = values.filter(
    (value) =>
      value.sourceAsOf !== null ||
      value.quoteAsOf !== null ||
      value.fxAsOf !== null ||
      value.affectedComponentCount > 0,
  );
  if (components.length === 0) return values[0];
  const dates = (
    key: keyof Pick<
      ValuationMetadata,
      "sourceAsOf" | "quoteAsOf" | "fxAsOf" | "oldestComponentDate"
    >,
  ) =>
    components
      .map((value) => value[key])
      .filter((value): value is string => value !== null)
      .sort();
  const freshnesses = components.map((value) => value.freshness);
  return {
    basis: components.every((value) => value.basis === "broker_source")
      ? "broker_source"
      : components.every((value) => value.basis === "tiingo_estimate")
        ? "tiingo_estimate"
        : "mixed",
    freshness:
      freshnesses.includes("mixed_age") ||
      (freshnesses.includes("current") && freshnesses.includes("stale"))
        ? "mixed_age"
        : freshnesses.includes("stale")
          ? "stale"
          : "current",
    sourceAsOf: dates("sourceAsOf").at(-1) ?? null,
    quoteAsOf: dates("quoteAsOf").at(-1) ?? null,
    fxAsOf: dates("fxAsOf").at(-1) ?? null,
    oldestComponentDate: dates("oldestComponentDate")[0] ?? null,
    affectedComponentCount: components.reduce(
      (sum, value) => sum + value.affectedComponentCount,
      0,
    ),
    qualityFlags: [...new Set(components.flatMap((value) => value.qualityFlags))].sort(),
  };
}

export async function getOverview(session: Session): Promise<Overview> {
  const { userId, dataKey, baseCurrency } = session;
  const today = israelDate(new Date());
  const currentMonth = monthKey(today);
  const windowStart = monthsBefore(today, 5); // current + 5 prior months

  return withUser(userId, async (tx) => {
    // --- Net worth (stock): current balances valued at today's latest rate ---
    const [acctRows, snapshotRows] = await Promise.all([
      tx.select().from(accounts),
      tx.select().from(accountBalanceSnapshots),
    ]);
    async function usableIlsRate(
      currency: string,
      at: string,
    ): Promise<{ rate: Decimal; date: string } | null> {
      if (currency === "ILS") return { rate: new Decimal(1), date: at };
      const [row] = await tx
        .select()
        .from(fxRates)
        .where(
          and(
            eq(fxRates.fromCurrency, currency),
            eq(fxRates.toCurrency, "ILS"),
            lte(fxRates.date, at),
          ),
        )
        .orderBy(desc(fxRates.date))
        .limit(1);
      if (!row || row.source !== "boi") return null;
      const age =
        (new Date(`${at}T00:00:00Z`).getTime() - new Date(`${row.date}T00:00:00Z`).getTime()) /
        86_400_000;
      return age >= 0 && age <= 7 ? { rate: new Decimal(row.rate), date: row.date } : null;
    }
    const ordinaryMetadata = (
      sourceDates: string[],
      fxDates: string[],
      incomplete: number,
      carried = 0,
    ): ValuationMetadata => ({
      basis: "broker_source",
      freshness: carried ? "stale" : "current",
      sourceAsOf: sourceDates.sort().at(-1) ?? null,
      quoteAsOf: null,
      fxAsOf: fxDates.sort().at(-1) ?? null,
      oldestComponentDate: sourceDates.sort()[0] ?? null,
      affectedComponentCount: incomplete + carried,
      qualityFlags: [
        ...(carried ? ["carried_forward" as const] : []),
        ...(incomplete ? ["incomplete_fx" as const] : []),
      ],
    });

    let netWorth = new Decimal(0);
    let assets = new Decimal(0);
    const currentSources: string[] = [];
    const currentFx: string[] = [];
    let currentMissingFx = 0;
    for (const a of acctRows) {
      if (
        a.accountType === "investment" ||
        a.status !== "active" ||
        (a.archivedAt && israelDate(a.archivedAt) <= today)
      )
        continue;
      const raw = decText(dataKey, a.currentBalanceCt, a.id, "current_balance_ct", a.version);
      if (raw == null) continue;
      const rate = await usableIlsRate(a.currency, today);
      if (!rate) {
        currentMissingFx += 1;
        continue;
      }
      const valued = new Decimal(raw).mul(rate.rate);
      netWorth = netWorth.plus(valued);
      if (a.classification === "asset") assets = assets.plus(valued);
      currentSources.push(today);
      currentFx.push(rate.date);
    }
    const investmentCurrent = await valueInvestmentNetWorth(tx, dataKey, { now: new Date() });
    netWorth = netWorth.plus(investmentCurrent.ilsValue);
    assets = assets.plus(investmentCurrent.ilsValue);
    const netWorthMetadata = mergeMetadata([
      ordinaryMetadata(currentSources, currentFx, currentMissingFx),
      investmentCurrent.metadata,
    ]);

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

    const netWorthHistory = [];
    for (let i = 6; i >= 1; i--) {
      const month = monthKey(monthsBefore(today, i));
      const cutoff = monthEnd(month);
      let ordinary = new Decimal(0);
      const sourceDates: string[] = [];
      const fxDates: string[] = [];
      let incomplete = 0;
      let carried = 0;
      for (const account of acctRows) {
        if (
          account.accountType === "investment" ||
          (account.archivedAt && israelDate(account.archivedAt) <= cutoff)
        )
          continue;
        const candidates = snapshotRows.filter(
          (snapshot) =>
            snapshot.accountId === account.id &&
            snapshot.source !== "investment" &&
            snapshot.date <= cutoff,
        );
        const snapshot = candidates.sort((a, b) => b.date.localeCompare(a.date))[0];
        if (!snapshot || !snapshot.nativeBalanceCt || !snapshot.currency) continue;
        const sourceDate = snapshot.date;
        const rate = await usableIlsRate(snapshot.currency, sourceDate);
        if (!rate) {
          incomplete += 1;
          continue;
        }
        ordinary = ordinary.plus(
          new Decimal(
            decText(
              dataKey,
              snapshot.nativeBalanceCt,
              snapshot.id,
              "native_balance_ct",
              snapshot.version,
            )!,
          ).mul(rate.rate),
        );
        sourceDates.push(sourceDate);
        fxDates.push(rate.date);
        if (sourceDate < cutoff) carried += 1;
      }
      const investments = await valueInvestmentNetWorth(tx, dataKey, {
        now: new Date(`${cutoff}T12:00:00Z`),
        cutoff,
      });
      const metadata = mergeMetadata([
        ordinaryMetadata(sourceDates, fxDates, incomplete, carried),
        investments.metadata,
      ]);
      netWorthHistory.push({
        month,
        amount: ordinary.plus(investments.ilsValue).toFixed(),
        metadata,
      });
    }

    return {
      baseCurrency: "ILS",
      currentMonth,
      netWorth: { amount: netWorth.toFixed(), currency: "ILS" },
      assetsTotal: { amount: assets.toFixed(), currency: "ILS" },
      monthlyIncome: { amount: current.income.toString(), currency: baseCurrency },
      monthlyExpenses: { amount: current.expenses.toString(), currency: baseCurrency },
      months,
      netWorthHistory,
      netWorthMetadata,
    };
  });
}
