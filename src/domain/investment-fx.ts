import type { UserTransaction } from "@/db/client";
import { usableIlsRate } from "./ils-rate";

export interface AcquisitionFxInput {
  tradeDate: string;
  settlementDate?: string;
  fromCurrency: string;
  toCurrency: string;
}

export interface LockedAcquisitionFx {
  rateString: string | null;
  convention: string;
  observationDate: string | null;
  provenance: "boi_derived" | "unresolved";
}

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const currencyPattern = /^[A-Z]{3}$/;

/**
 * Locks acquisition FX in the BoI publication direction: `ILS_PER_USD`, for
 * example, means the number of ILS paid for one unit of USD. Settlement date
 * is retained in the input contract but deliberately does not select the rate.
 */
export async function lockAcquisitionFx(
  tx: UserTransaction,
  input: AcquisitionFxInput,
): Promise<LockedAcquisitionFx> {
  if (
    !datePattern.test(input.tradeDate) ||
    (input.settlementDate !== undefined && !datePattern.test(input.settlementDate)) ||
    !currencyPattern.test(input.fromCurrency) ||
    !currencyPattern.test(input.toCurrency)
  ) {
    throw new Error("invalid acquisition FX input");
  }

  const convention = `${input.toCurrency}_PER_${input.fromCurrency}`;
  if (input.toCurrency !== "ILS" || input.fromCurrency === "ILS") {
    return { rateString: null, convention, observationDate: null, provenance: "unresolved" };
  }

  const observation = await usableIlsRate(tx, input.fromCurrency, input.tradeDate);
  if (!observation) {
    return { rateString: null, convention, observationDate: null, provenance: "unresolved" };
  }
  return {
    rateString: observation.rate.toString(),
    convention,
    observationDate: observation.date,
    provenance: "boi_derived",
  };
}
