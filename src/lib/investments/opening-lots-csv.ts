import Decimal from "decimal.js";
import { parse } from "csv-parse/sync";

import { decimalText } from "./decimal";

export const OPENING_LOT_CSV_COLUMNS = [
  "account",
  "isin",
  "symbol",
  "exchange",
  "trade_date",
  "quantity",
  "remaining_quantity",
  "unit_cost",
  "total_cost",
  "currency",
  "fee",
  "ils_fx_rate",
  "broker_lot_id",
] as const;

export const OPENING_LOT_AI_CONVERSION_PROMPT = `Convert my brokerage or spreadsheet export into a CSV containing opening investment lots.

Output only CSV, with this exact header and column order:
account,isin,symbol,exchange,trade_date,quantity,remaining_quantity,unit_cost,total_cost,currency,fee,ils_fx_rate,broker_lot_id

Use one row per lot. Keep all quantities, costs, fees, and FX rates as exact decimal text without currency symbols or thousands separators. Use YYYY-MM-DD for trade_date and a three-letter uppercase currency code. account must contain the broker account reference used in Moni. quantity is the original lot quantity; leave remaining_quantity blank to make it equal quantity. At least one of unit_cost or total_cost is required. fee and broker_lot_id are optional. At least one of isin or symbol+exchange is required; a symbol without exchange is invalid. If the source has an ILS exchange rate for the acquisition, place it in ils_fx_rate verbatim. Leave ils_fx_rate blank if your export has no ILS rate. Do not invent missing values, combine lots, or add commentary.`;

export interface OpeningLotImportRow {
  account: string;
  isin?: string;
  symbol?: string;
  exchange?: string;
  tradeDate: string;
  quantity: string;
  remainingQuantity: string;
  unitCost?: string;
  totalCost: string;
  currency: string;
  fee?: string;
  ilsFxRate?: string;
  brokerLotId?: string;
}

export class OpeningLotCsvError extends Error {
  constructor(
    readonly code: "invalid_header" | "invalid_row" | "source_too_large",
    readonly row?: number,
  ) {
    super(row ? `${code}:${row}` : code);
    this.name = "OpeningLotCsvError";
  }
}

const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const currencyPattern = /^[A-Z]{3}$/;

function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function decimal(value: string | undefined): string | undefined {
  return value === undefined ? undefined : decimalText(value);
}

/** Parses and validates the locked opening-lot CSV contract, then wipes the caller's buffer. */
export function parseOpeningLotsCsv(source: Buffer): OpeningLotImportRow[] {
  try {
    if (source.length > MAX_SOURCE_BYTES) throw new OpeningLotCsvError("source_too_large");
    const records = parse(source.toString("utf8"), {
      bom: true,
      skip_empty_lines: true,
      relax_column_count: false,
      trim: true,
    }) as string[][];
    const header = records[0];
    if (
      !header ||
      header.length !== OPENING_LOT_CSV_COLUMNS.length ||
      header.some((column, index) => column !== OPENING_LOT_CSV_COLUMNS[index])
    )
      throw new OpeningLotCsvError("invalid_header");

    return records.slice(1).map((values, index) => {
      const rowNumber = index + 2;
      try {
        const row = Object.fromEntries(
          OPENING_LOT_CSV_COLUMNS.map((column, columnIndex) => [
            column,
            present(values[columnIndex]),
          ]),
        ) as Record<(typeof OPENING_LOT_CSV_COLUMNS)[number], string | undefined>;
        const account = row.account;
        const isin = row.isin?.toUpperCase();
        const symbol = row.symbol?.toUpperCase();
        const exchange = row.exchange?.toUpperCase();
        const tradeDate = row.trade_date;
        const quantity = decimal(row.quantity);
        const remainingQuantity = decimal(row.remaining_quantity) ?? quantity;
        const unitCost = decimal(row.unit_cost);
        const suppliedTotalCost = decimal(row.total_cost);
        const currency = row.currency?.toUpperCase();
        // Quantities must be positive and remaining cannot exceed the original
        // lot; otherwise derivation would .abs() a negative into a phantom
        // holding or prorate basis above the recorded cost.
        const quantityValid = quantity !== undefined && new Decimal(quantity).gt(0);
        const remainingValid =
          remainingQuantity !== undefined &&
          new Decimal(remainingQuantity).gt(0) &&
          quantity !== undefined &&
          new Decimal(remainingQuantity).lte(quantity);
        if (
          !account ||
          !tradeDate ||
          !datePattern.test(tradeDate) ||
          new Date(`${tradeDate}T00:00:00Z`).toISOString().slice(0, 10) !== tradeDate ||
          !quantityValid ||
          !remainingValid ||
          !currency ||
          !currencyPattern.test(currency) ||
          (!unitCost && !suppliedTotalCost) ||
          (!isin && !(symbol && exchange))
        )
          throw new OpeningLotCsvError("invalid_row", rowNumber);
        return {
          account,
          isin,
          symbol,
          exchange,
          tradeDate,
          quantity,
          remainingQuantity,
          unitCost,
          totalCost: suppliedTotalCost ?? new Decimal(unitCost!).mul(quantity).toFixed(),
          currency,
          fee: decimal(row.fee),
          ilsFxRate: decimal(row.ils_fx_rate),
          brokerLotId: row.broker_lot_id,
        };
      } catch (error) {
        if (error instanceof OpeningLotCsvError) throw error;
        throw new OpeningLotCsvError("invalid_row", rowNumber);
      }
    });
  } catch (error) {
    if (error instanceof OpeningLotCsvError) throw error;
    throw new OpeningLotCsvError("invalid_row");
  } finally {
    source.fill(0);
  }
}
