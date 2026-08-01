import { sql } from "drizzle-orm";
import { db } from "@/db/client";

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
