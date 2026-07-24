import { pgTable, uuid, text, date, numeric, unique } from "drizzle-orm/pg-core";
import { timestamps } from "./shared";

/**
 * Global reference data — no `owner_id`, no RLS (data-model.md §2/§5): FX
 * rates are public market data, readable by all users and written only by
 * the FX background job. `rate` is the one legitimate plaintext money
 * column in the schema (money-and-currency.md §1).
 */
export const fxRates = pgTable(
  "fx_rates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fromCurrency: text("from_currency").notNull(),
    toCurrency: text("to_currency").notNull(),
    date: date("date").notNull(),
    rate: numeric("rate").notNull(),
    source: text("source").notNull(),
    ...timestamps,
  },
  (table) => [
    unique("fx_rates_from_to_date_source_unique").on(
      table.fromCurrency,
      table.toCurrency,
      table.date,
      table.source,
    ),
  ],
);
