// Zod at the trust boundary (docs/design/conventions.md — Validation),
// shared by the budget routes.
//
// Money arrives as a canonical decimal STRING, never a JS number — a float
// crossing this boundary is the one thing the money invariant forbids
// outright, so the schema refuses it rather than coercing.
import { z } from "zod";
import { DECIMAL_STRING_PATTERN } from "@/lib/money";

/** A positive decimal string. A ceiling of zero is expressed by removing the
 * ceiling, not by setting it to nothing. */
const PositiveAmount = z
  .string()
  .regex(DECIMAL_STRING_PATTERN, "not a decimal string")
  .refine((value) => !value.startsWith("-") && Number.parseFloat(value) > 0, "must be positive");

/** "YYYY-MM". */
const Month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "not a YYYY-MM month");

export const CeilingBodySchema = z.object({
  /** Null is the residual ceiling — "everything else", the one budget line
   * that is not a category (src/domain/budget.ts `RESIDUAL_KEY`). */
  categoryId: z.uuid().nullable(),
  amount: PositiveAmount,
  effectiveFrom: Month,
  rollover: z.boolean(),
});

export const CeilingBatchSchema = z.object({
  ceilings: z.array(CeilingBodySchema).min(1).max(100),
});

export const PlannedIncomeBodySchema = z.object({
  amount: PositiveAmount,
  effectiveFrom: Month,
});

export const MonthQuerySchema = Month;
