import { describe, expect, it } from "vitest";
import { valuationCoordinates, weekEnding } from "@/app/(app)/investments/chart-data";

describe("investment chart coordinates", () => {
  it("plots the ILS valuation and keeps the exact money strings beside it", () => {
    const points = valuationCoordinates({
      points: [
        {
          week: "2026-07-26",
          ilsValue: "3.3",
          composition: [
            { id: "a", label: "A", ilsValue: "1.1" },
            { id: "b", label: "B", ilsValue: "2.2" },
          ],
        },
      ],
      valuationChange: null,
      estimatedNow: null,
    });
    expect(points[0]).toEqual({
      week: "2026-07-26",
      total: "3.3",
      exact: { a: "1.1", b: "2.2" },
      values: { a: 1.1, b: 2.2 },
    });
    // The stack's top edge is the week's total worth, so the plotted bands
    // have to sum to it rather than to a ratio.
    expect(points[0].values.a + points[0].values.b).toBeCloseTo(3.3);
    expect(weekEnding("2026-07-26")).toBe("2026-08-01");
  });

  it("passes a non-date label through instead of throwing on an invalid date", () => {
    // The chart appends this label for the current estimate, and the axis tick
    // formatter and tooltip both run every x value through weekEnding.
    expect(weekEnding("Estimated now")).toBe("Estimated now");
  });
});
