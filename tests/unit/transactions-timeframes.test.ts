// Timeframe presets (issue #107). Pure string date math, so it pins the
// boundaries exactly — a "This Week" that started on Monday, or a "This Month"
// that leaked into the previous one, would silently filter the wrong rows.
import { describe, expect, it } from "vitest";
import {
  TIMEFRAME_PRESETS,
  matchingTimeframe,
  startOfMonth,
  startOfWeek,
} from "@/lib/transactions/timeframes";

const range = (key: string, today: string) =>
  TIMEFRAME_PRESETS.find((p) => p.key === key)!.range(today);

describe("startOfWeek", () => {
  // 2026-01-01 is a Thursday, so 2026-01-04 is the Sunday that opens its week.
  it("returns the Sunday on or before the date", () => {
    expect(startOfWeek("2026-01-07")).toBe("2026-01-04"); // Wednesday -> prior Sunday
    expect(startOfWeek("2026-01-10")).toBe("2026-01-04"); // Saturday -> same week's Sunday
  });

  it("is a no-op when the date is already a Sunday", () => {
    expect(startOfWeek("2026-01-04")).toBe("2026-01-04");
  });

  it("crosses a month boundary correctly", () => {
    // 2026-08-01 is a Saturday; its week opened the previous Sunday, in July.
    expect(startOfWeek("2026-08-01")).toBe("2026-07-26");
  });
});

describe("startOfMonth", () => {
  it("returns the first of the month", () => {
    expect(startOfMonth("2026-08-16")).toBe("2026-08-01");
    expect(startOfMonth("2026-08-01")).toBe("2026-08-01");
  });
});

describe("TIMEFRAME_PRESETS", () => {
  const today = "2026-08-16"; // a Sunday

  it("This Week runs from the week's Sunday to today", () => {
    expect(range("week", today)).toEqual({ from: "2026-08-16", to: "2026-08-16" });
    expect(range("week", "2026-08-19")).toEqual({ from: "2026-08-16", to: "2026-08-19" });
  });

  it("This Month runs from the first of the month to today", () => {
    expect(range("month", today)).toEqual({ from: "2026-08-01", to: "2026-08-16" });
  });

  it("Last 3 Months runs three calendar months back to today", () => {
    expect(range("3m", today)).toEqual({ from: "2026-05-16", to: "2026-08-16" });
  });

  it("exposes the three presets the issue asked for, in order", () => {
    expect(TIMEFRAME_PRESETS.map((p) => p.label)).toEqual([
      "This Week",
      "This Month",
      "Last 3 Months",
    ]);
  });
});

describe("matchingTimeframe", () => {
  const today = "2026-08-19";

  it("names the preset whose range matches exactly", () => {
    expect(matchingTimeframe("2026-08-01", "2026-08-19", today)).toBe("month");
    expect(matchingTimeframe("2026-08-16", "2026-08-19", today)).toBe("week");
  });

  it("is undefined for a custom range that matches no preset", () => {
    expect(matchingTimeframe("2026-08-03", "2026-08-19", today)).toBeUndefined();
  });

  it("is undefined when either endpoint is unset", () => {
    expect(matchingTimeframe("", "2026-08-19", today)).toBeUndefined();
    expect(matchingTimeframe("2026-08-01", "", today)).toBeUndefined();
  });
});
