import { describe, expect, it } from "vitest";

import {
  calculateMoneyWeightedReturn,
  calculateTimeWeightedReturn,
  datedFlowSeries,
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

  it("bounds MWR flows to the valuation interval", () => {
    const valuations = [
      { date: "2025-01-01", value: "100" },
      { date: "2026-01-01", value: "165" },
    ];
    // Capital before the opening value is already inside it; capital after the
    // closing value is outside the period. Neither may enter the IRR.
    expect(
      datedFlowSeries(valuations, [
        { date: "2024-06-01", amount: "80" },
        { date: "2025-01-01", amount: "5" },
        { date: "2025-07-01", amount: "50" },
        { date: "2026-03-01", amount: "20" },
      ]),
    ).toEqual([
      { date: "2025-01-01", amount: "-100" },
      { date: "2025-07-01", amount: "-50" },
      { date: "2026-01-01", amount: "165" },
    ]);
  });

  it("has no MWR with a single valuation", () => {
    const series = datedFlowSeries([{ date: "2026-01-01", value: "100" }], []);
    expect(series).toEqual([]);
    expect(calculateMoneyWeightedReturn(series)).toBeNull();
  });
});
