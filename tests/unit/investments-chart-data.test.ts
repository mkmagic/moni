import { describe, expect, it } from "vitest";
import { compositionCoordinates, weekEnding } from "@/app/(app)/investments/chart-data";

describe("investment chart coordinates", () => {
  it("keeps exact money strings outside Recharts and converts only unitless ratios", () => {
    const points = compositionCoordinates({
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
      values: { a: expect.any(Number), b: expect.any(Number) },
    });
    expect(points[0].values.a + points[0].values.b).toBeCloseTo(100);
    expect(weekEnding("2026-07-26")).toBe("2026-08-01");
  });
});
