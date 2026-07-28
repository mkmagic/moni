// The backfill window's cap (ADR 0001) — the same pure functions the picker
// renders its bounds from and the sync route validates against, so a
// disagreement between the two would show up here.
import { describe, expect, it } from "vitest";
import {
  earliestBackfillStart,
  isBackfillStartAllowed,
  presetStartDate,
  subtractMonths,
  todayIso,
  BACKFILL_PRESETS,
} from "@/lib/backfill-window";

const TODAY = "2026-07-28";

describe("isBackfillStartAllowed", () => {
  it("accepts the exact twelve-month boundary", () => {
    expect(isBackfillStartAllowed("2025-07-28", TODAY)).toBe(true);
  });

  it("rejects one day beyond the boundary", () => {
    expect(isBackfillStartAllowed("2025-07-27", TODAY)).toBe(false);
  });

  it("accepts today", () => {
    expect(isBackfillStartAllowed(TODAY, TODAY)).toBe(true);
  });

  it("rejects a future date", () => {
    expect(isBackfillStartAllowed("2026-07-29", TODAY)).toBe(false);
  });

  it("accepts every preset it offers", () => {
    for (const preset of BACKFILL_PRESETS) {
      expect(isBackfillStartAllowed(presetStartDate(preset, TODAY), TODAY)).toBe(true);
    }
  });
});

describe("subtractMonths", () => {
  it("clamps day-of-month rather than overflowing into the next month", () => {
    // 2026-05-31 minus 3 months is February, which has no 31st.
    expect(subtractMonths("2026-05-31", 3)).toBe("2026-02-28");
  });

  it("crosses a year boundary", () => {
    expect(earliestBackfillStart("2026-01-15")).toBe("2025-01-15");
  });

  it("handles a leap day target", () => {
    expect(subtractMonths("2024-03-31", 1)).toBe("2024-02-29");
  });
});

describe("todayIso", () => {
  it("uses the local calendar date, zero-padded", () => {
    expect(todayIso(new Date(2026, 6, 5, 23, 30))).toBe("2026-07-05");
  });
});
