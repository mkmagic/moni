import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { fxRates } from "@/db/schema";

export interface RequiredFxPair {
  currency: string;
  date: string;
}

/** Returns only pairs that lack a BOI observation no more than seven days old. */
export async function missingBoiFxPairs(required: RequiredFxPair[]): Promise<RequiredFxPair[]> {
  const rows = await db.select().from(fxRates);
  return required.filter(({ currency, date }) => {
    if (currency === "ILS") return false;
    const latest = rows
      .filter(
        (row) =>
          row.fromCurrency === currency &&
          row.toCurrency === "ILS" &&
          row.source === "boi" &&
          row.date <= date,
      )
      .sort((a, b) => b.date.localeCompare(a.date))[0];
    if (!latest) return true;
    return (
      (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${latest.date}T00:00:00Z`)) / 86_400_000 > 7
    );
  });
}

/** The sole write path for public BOI observations. Corrections replace rate. */
export async function upsertBoiFxRate(input: {
  fromCurrency: string;
  date: string;
  rate: string;
}): Promise<void> {
  await db.execute(
    sql`select public.upsert_boi_fx_rate(${input.fromCurrency}, ${input.date}::date, ${input.rate}::numeric)`,
  );
}
