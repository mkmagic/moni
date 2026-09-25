import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import { and, eq } from "drizzle-orm";

import { withUser } from "@/db/client";
import {
  investmentDisposalResolutionQueue,
  investmentOpeningCashEvidence,
  investmentReconciliationQuality,
} from "@/db/schema";
import { decText, encText } from "./fields";
import { reconcileInvestmentActivity } from "./investment-valuation";

export class OpeningCashError extends Error {
  constructor(readonly code: "gap_not_found" | "not_a_cash_gap" | "invalid_amount") {
    super(code);
    this.name = "OpeningCashError";
  }
}

const AMOUNT = /^-?\d+(?:\.\d+)?$/;

/**
 * Records the cash an account held before its activity history begins, from a
 * pending `cash_balance` gap, then re-reconciles the account so the gap can
 * close. The amount is the whole opening balance for that currency: a second
 * entry replaces the first rather than adding to it.
 */
export async function recordOpeningCashForGap(input: {
  userId: string;
  /** Tier-1 data key. The caller owns its lifetime and wiping. */
  dataKey: Uint8Array;
  queueId: string;
  amount: string;
}): Promise<{ accountId: string; gaps: number }> {
  if (!AMOUNT.test(input.amount)) throw new OpeningCashError("invalid_amount");
  const amount = new Decimal(input.amount).toFixed();
  const accountId = await withUser(input.userId, async (tx) => {
    const [item] = await tx
      .select()
      .from(investmentDisposalResolutionQueue)
      .where(
        and(
          eq(investmentDisposalResolutionQueue.id, input.queueId),
          eq(investmentDisposalResolutionQueue.kind, "reconciliation_gap"),
          eq(investmentDisposalResolutionQueue.status, "pending"),
        ),
      )
      .limit(1);
    if (!item?.reconciliationQualityId) throw new OpeningCashError("gap_not_found");
    const [quality] = await tx
      .select()
      .from(investmentReconciliationQuality)
      .where(eq(investmentReconciliationQuality.id, item.reconciliationQualityId))
      .limit(1);
    if (!quality || quality.dimension !== "cash_balance" || !quality.currency)
      throw new OpeningCashError("not_a_cash_gap");

    const [existing] = await tx
      .select()
      .from(investmentOpeningCashEvidence)
      .where(
        and(
          eq(investmentOpeningCashEvidence.accountId, quality.accountId),
          eq(investmentOpeningCashEvidence.currency, quality.currency),
        ),
      )
      .limit(1);
    if (existing) {
      if (
        decText(input.dataKey, existing.amountCt, existing.id, "amount_ct", existing.version) !==
        amount
      ) {
        const version = existing.version + 1;
        await tx
          .update(investmentOpeningCashEvidence)
          .set({
            amountCt: encText(input.dataKey, amount, existing.id, "amount_ct", version),
            provenance: "user_entered",
            version,
          })
          .where(eq(investmentOpeningCashEvidence.id, existing.id));
      }
    } else {
      const id = randomUUID();
      await tx.insert(investmentOpeningCashEvidence).values({
        id,
        ownerId: input.userId,
        accountId: quality.accountId,
        currency: quality.currency,
        amountCt: encText(input.dataKey, amount, id, "amount_ct", 1),
        provenance: "user_entered",
      });
    }
    return quality.accountId;
  });
  const result = await reconcileInvestmentActivity({
    userId: input.userId,
    accountId,
    dataKey: input.dataKey,
  });
  return { accountId, gaps: result.gaps };
}
