// The display edge for long-term savings (#77 §2/§3). These labels are the
// only place the UI states WHEN money is reachable and WHAT period a flow
// covers — both claims the document makes and Moni must not overstate.
import { describe, expect, it } from "vitest";
import {
  asOfLabel,
  forMonthLabel,
  formatPercent,
  liquidityBadge,
  statedPeriodLabel,
} from "@/lib/long-term-savings/labels";

describe("liquidityBadge", () => {
  it("names the report's own retirement age when one was imported", () => {
    expect(
      liquidityBadge({ liquidity: "locked_retirement", liquidFrom: null, retirementAge: 67 }),
    ).toEqual({ locked: true, text: "Locked until 67" });
  });

  it("says 'retirement' rather than inventing an age when no report has stated one", () => {
    expect(
      liquidityBadge({ liquidity: "locked_retirement", liquidFrom: null, retirementAge: null }),
    ).toEqual({ locked: true, text: "Locked until retirement" });
  });

  it("dates a קרן השתלמות from its own liquidity date", () => {
    expect(
      liquidityBadge({ liquidity: "liquid_after", liquidFrom: "2029-04-01", retirementAge: null }),
    ).toEqual({ locked: false, text: "Available from 2029" });
  });

  it("does not read as locked when the money is reachable today", () => {
    expect(liquidityBadge({ liquidity: "liquid", liquidFrom: null, retirementAge: null })).toEqual({
      locked: false,
      text: "Available now",
    });
  });
});

describe("statedPeriodLabel", () => {
  it("labels a Q3 report's flows with all nine months it covers, never 'this quarter'", () => {
    expect(statedPeriodLabel("2025-01-01", "2025-09-30")).toBe("Jan–Sep");
  });

  it("carries both years when the stated period crosses one", () => {
    expect(statedPeriodLabel("2025-11-01", "2026-03-31")).toBe("Nov 2025–Mar 2026");
  });
});

describe("asOfLabel", () => {
  it("uses the quarter the report printed", () => {
    expect(asOfLabel({ asOf: "2026-03-31", quarter: 1, fiscalYear: 2026 })).toBe("Q1 2026");
  });

  it("falls back to the report date when the document omitted its quarter", () => {
    expect(asOfLabel({ asOf: "2026-03-31", quarter: null, fiscalYear: null })).toBe("Mar 2026");
  });
});

describe("formatPercent", () => {
  it("renders a rate exactly as printed — shortening it would change the figure", () => {
    expect(formatPercent("0.0018")).toBe("0.0018%");
    expect(formatPercent("0.00")).toBe("0.00%");
  });
});

describe("forMonthLabel", () => {
  it("names the salary month a deposit is for", () => {
    expect(forMonthLabel("2026-02")).toBe("Feb 2026");
  });
});
