import { z } from "zod";

import { InvestmentNormalizationError } from "./types";

export const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
export const MAX_ACCOUNTS = 100;
export const MAX_POSITION_ROWS = 10_000;
export const MAX_CASH_ROWS = 1_000;

export const currencySchema = z.string().regex(/^[A-Z]{3}$/);
export const nonblankSchema = z.string().trim().min(1);

export function sourceText(input: string): void {
  if (!input.trim()) throw new InvestmentNormalizationError("blank_input");
  if (Buffer.byteLength(input, "utf8") > MAX_SOURCE_BYTES) {
    throw new InvestmentNormalizationError("source_too_large");
  }
}

export function checked<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new InvestmentNormalizationError("unsupported_source_shape");
  return parsed.data;
}

export function requireLimit(value: number, limit: number): void {
  if (value > limit) throw new InvestmentNormalizationError("source_too_large");
}

export function asOf(value: string): { value: string; precision: "date" | "timestamp" } {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
    value,
  );
  if (!date && !timestamp) throw new InvestmentNormalizationError("incomplete_snapshot");
  return { value, precision: date ? "date" : "timestamp" };
}

export function code(error: unknown): InvestmentNormalizationError {
  return error instanceof InvestmentNormalizationError
    ? error
    : new InvestmentNormalizationError("unsupported_source_shape");
}
