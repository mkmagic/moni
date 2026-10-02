import type {
  InvestmentInstrumentReturns,
  InvestmentReturnsRead,
} from "@/domain/investment-returns";

/** One selectable scope in the account selector. */
export interface PerformanceAccount {
  id: string;
  name: string;
}

/** Everything the Performance screen renders for one scope (portfolio or one
 * account). Re-fetched from `/api/investments/performance` when the selector
 * changes; the accounts list itself is stable and passed once from the page. */
export interface PerformanceView {
  scope: "portfolio" | "account";
  accountId: string | null;
  summary: InvestmentReturnsRead;
  instruments: InvestmentInstrumentReturns[];
  /** The engine's value-series is account-level, so per-holding TWR/IRR is not
   * available and the by-instrument rows deliberately omit it. */
  perHoldingTwrAvailable: boolean;
}
