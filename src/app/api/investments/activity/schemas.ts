import Decimal from "decimal.js";
import { z } from "zod";

import { isoDate, uuid } from "../route-input";

const decimal = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => {
    try {
      return new Decimal(value).isFinite();
    } catch {
      return false;
    }
  });

export const allocationBody = z
  .object({
    allocations: z
      .array(z.object({ lotId: uuid, quantity: decimal }).strict())
      .min(1)
      .max(500),
  })
  .strict();

export const openingLotRow = z
  .object({
    account: z.string().min(1).max(500),
    isin: z.string().max(100).optional(),
    symbol: z.string().max(100).optional(),
    exchange: z.string().max(100).optional(),
    tradeDate: isoDate,
    quantity: decimal,
    remainingQuantity: decimal,
    unitCost: decimal.optional(),
    totalCost: decimal,
    currency: z.string().regex(/^[A-Z]{3}$/),
    fee: decimal.optional(),
    ilsFxRate: decimal.optional(),
    brokerLotId: z.string().max(500).optional(),
  })
  .strict();

export const importBody = z.object({ rows: z.array(openingLotRow).min(1).max(10_000) }).strict();

export const singleOpeningLotBody = z
  .object({
    accountId: uuid,
    instrumentId: uuid,
    tradeDate: isoDate,
    quantity: decimal,
    remainingQuantity: decimal,
    unitCost: decimal.optional(),
    totalCost: decimal,
    currency: z.string().regex(/^[A-Z]{3}$/),
    fee: decimal.optional(),
    ilsFxRate: decimal.optional(),
  })
  .strict();
