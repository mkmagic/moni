import Decimal from "decimal.js";

import { InvestmentNormalizationError } from "./types";

Decimal.set({ precision: 80 });

const DECIMAL_TEXT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

export function decimalText(value: string): string {
  const trimmed = value.trim();
  if (!DECIMAL_TEXT.test(trimmed)) throw new InvestmentNormalizationError("invalid_decimal");
  try {
    const decimal = new Decimal(trimmed);
    if (!decimal.isFinite()) throw new InvestmentNormalizationError("invalid_decimal");
    return decimal.toFixed();
  } catch (error) {
    if (error instanceof InvestmentNormalizationError) throw error;
    throw new InvestmentNormalizationError("invalid_decimal");
  }
}

export function addDecimal(left: string, right: string): string {
  return new Decimal(left).plus(right).toFixed();
}

export function isZero(value: string): boolean {
  return new Decimal(value).isZero();
}
