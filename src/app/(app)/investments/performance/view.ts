import {
  readInvestmentInstrumentReturns,
  readInvestmentReturns,
  readPortfolioInvestmentReturns,
} from "@/domain/investment-returns";
import type { Session } from "@/lib/auth/session-store";
import type { PerformanceView } from "./types";

/** Assembles the Performance view for one scope through the domain layer only.
 * Shared by the server page (initial render) and the re-fetch API route. */
export async function buildPerformanceView(
  session: Session,
  accountId?: string,
): Promise<PerformanceView> {
  const summary = accountId
    ? await readInvestmentReturns({ userId: session.userId, accountId, dataKey: session.dataKey })
    : await readPortfolioInvestmentReturns({ userId: session.userId, dataKey: session.dataKey });
  const instruments = await readInvestmentInstrumentReturns({
    userId: session.userId,
    dataKey: session.dataKey,
    accountId,
  });
  return {
    scope: accountId ? "account" : "portfolio",
    accountId: accountId ?? null,
    summary,
    instruments,
    perHoldingTwrAvailable: false,
  };
}
