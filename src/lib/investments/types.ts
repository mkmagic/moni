export interface InvestmentSyncEnvelope {
  source: "ibkr_flex" | "schwab_positions_csv";
  coverage: {
    kind: "configured_query_accounts" | "bound_single_account";
    accountRefs: string[];
  };
  sourceAsOf: { value: string; precision: "date" | "timestamp" };
  accounts: Array<{
    sourceAccountRef: string;
    baseCurrency: string;
    positions: Array<{
      sourceSecurityId: string;
      sourceSecurityIdKind: string;
      symbol?: string;
      name?: string;
      exchange?: string;
      assetKind: "stock" | "etf" | "mutual_fund" | "generic";
      quantity: string;
      quantityUnit: string;
      currency: string;
      sourcePrice?: string;
      sourcePriceCurrency?: string;
      sourceValue?: string;
      sourceValueCurrency?: string;
      sourceAsOf?: string;
    }>;
    cash: Array<{ currency: string; amount: string }>;
    brokerTotal: { amount: string; currency: string; asOf: string };
  }>;
}

export type InvestmentNormalizationErrorCode =
  | "blank_input"
  | "source_too_large"
  | "unsupported_source_shape"
  | "invalid_decimal"
  | "incomplete_coverage"
  | "identity_conflict"
  | "incomplete_snapshot"
  | "unvalued_position";

export class InvestmentNormalizationError extends Error {
  constructor(readonly code: InvestmentNormalizationErrorCode) {
    super(code);
    this.name = "InvestmentNormalizationError";
  }
}
