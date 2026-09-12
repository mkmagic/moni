import { z } from "zod";

import { decimalText } from "./decimal";
import { checked, currencySchema, nonblankSchema } from "./shared";

export type InvestmentActivityType =
  | "buy"
  | "sell"
  | "dividend"
  | "interest"
  | "fee"
  | "tax"
  | "deposit"
  | "withdrawal"
  | "transfer"
  | "other";

export type InvestmentEvidenceProvenance = "broker_reported" | "user_entered" | "imported";

export interface InvestmentActivityEvidence {
  source: "ibkr_flex" | "snaptrade";
  sourceAccountRef: string;
  idempotencyKey: string;
  sourceActivityId?: string;
  sourceExecutionId?: string;
  sourceTradeId?: string;
  sourceRevisionOfId?: string;
  sourceSecurityId?: string;
  sourceSecurityIdKind?: string;
  activityType: InvestmentActivityType;
  tradeDate: string;
  settlementDate?: string;
  quantity?: string;
  quantityUnit?: string;
  price?: string;
  grossAmount?: string;
  feeAmount?: string;
  taxAmount?: string;
  netCashAmount?: string;
  currency?: string;
  rawType: string;
  rawCode?: string;
  rawDescription?: string;
  provenance: InvestmentEvidenceProvenance;
}

export interface OpenLotEvidence {
  source: "ibkr_flex" | "snaptrade" | "opening_lot_import";
  sourceAccountRef: string;
  idempotencyKey: string;
  sourceLotId?: string;
  sourceSecurityId: string;
  sourceSecurityIdKind: string;
  tradeDate: string;
  settlementDate?: string;
  originalQuantity: string;
  remainingQuantity: string;
  quantityUnit: string;
  unitCost?: string;
  totalCost: string;
  fees?: string;
  currency: string;
  provenance: InvestmentEvidenceProvenance;
}

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const decimalSchema = z.string().transform(decimalText);
const optionalNonblankSchema = nonblankSchema.optional();

const activitySchema = z
  .object({
    source: z.enum(["ibkr_flex", "snaptrade"]),
    sourceAccountRef: nonblankSchema,
    idempotencyKey: nonblankSchema,
    sourceActivityId: optionalNonblankSchema,
    sourceExecutionId: optionalNonblankSchema,
    sourceTradeId: optionalNonblankSchema,
    sourceRevisionOfId: optionalNonblankSchema,
    sourceSecurityId: optionalNonblankSchema,
    sourceSecurityIdKind: optionalNonblankSchema,
    activityType: z.enum([
      "buy",
      "sell",
      "dividend",
      "interest",
      "fee",
      "tax",
      "deposit",
      "withdrawal",
      "transfer",
      "other",
    ]),
    tradeDate: dateSchema,
    settlementDate: dateSchema.optional(),
    quantity: decimalSchema.optional(),
    quantityUnit: optionalNonblankSchema,
    price: decimalSchema.optional(),
    grossAmount: decimalSchema.optional(),
    feeAmount: decimalSchema.optional(),
    taxAmount: decimalSchema.optional(),
    netCashAmount: decimalSchema.optional(),
    currency: currencySchema.optional(),
    rawType: nonblankSchema,
    rawCode: optionalNonblankSchema,
    rawDescription: optionalNonblankSchema,
    provenance: z.enum(["broker_reported", "user_entered", "imported"]),
  })
  .superRefine((value, context) => {
    if ((value.sourceSecurityId === undefined) !== (value.sourceSecurityIdKind === undefined)) {
      context.addIssue({
        code: "custom",
        message: "source security id and kind must be supplied together",
      });
    }
    if ((value.quantity === undefined) !== (value.quantityUnit === undefined)) {
      context.addIssue({
        code: "custom",
        message: "quantity and unit must be supplied together",
      });
    }
  });

const openLotSchema = z.object({
  source: z.enum(["ibkr_flex", "snaptrade", "opening_lot_import"]),
  sourceAccountRef: nonblankSchema,
  idempotencyKey: nonblankSchema,
  sourceLotId: optionalNonblankSchema,
  sourceSecurityId: nonblankSchema,
  sourceSecurityIdKind: nonblankSchema,
  tradeDate: dateSchema,
  settlementDate: dateSchema.optional(),
  originalQuantity: decimalSchema,
  remainingQuantity: decimalSchema,
  quantityUnit: nonblankSchema,
  unitCost: decimalSchema.optional(),
  totalCost: decimalSchema,
  fees: decimalSchema.optional(),
  currency: currencySchema,
  provenance: z.enum(["broker_reported", "user_entered", "imported"]),
});

export function normalizeInvestmentActivityEvidence(input: unknown): InvestmentActivityEvidence {
  return checked(activitySchema, input);
}

export function normalizeOpenLotEvidence(input: unknown): OpenLotEvidence {
  return checked(openLotSchema, input);
}
