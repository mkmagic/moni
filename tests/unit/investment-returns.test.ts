import { describe, expect, it } from "vitest";

import {
  calculateMoneyWeightedReturn,
  calculateTimeWeightedReturn,
} from "@/domain/investment-returns";

describe("investment return calculations", () => {
  it("excludes contributions from TWR", () => {
    expect(
      calculateTimeWeightedReturn(
        [
          { date: "2025-01-01", value: "100" },
          { date: "2026-01-01", value: "165" },
        ],
        [{ date: "2025-07-01", amount: "50" }],
      ),
    ).toBe("0.15");
  });

  it("includes dated contributions in MWR/IRR", () => {
    const withoutContribution = calculateMoneyWeightedReturn([
      { date: "2025-01-01", amount: "-100" },
      { date: "2026-01-01", amount: "165" },
    ]);
    const withContribution = calculateMoneyWeightedReturn([
      { date: "2025-01-01", amount: "-100" },
      { date: "2025-07-01", amount: "-50" },
      { date: "2026-01-01", amount: "165" },
    ]);
    expect(withoutContribution).toBe("0.65");
    expect(withContribution).not.toBeNull();
    expect(withContribution).not.toBe(withoutContribution);
  });
});
