// src/lib/recurring/cadence.ts — how often a merchant charges, read from the
// gaps between its transaction dates and nothing else (docs/adr/0006-*).
// Pinned here because the alternative to getting this right is inventing a
// cadence a payee doesn't have, which CONTEXT.md rules out explicitly.
import { describe, expect, it } from "vitest";
import { deriveCadence } from "@/lib/recurring/cadence";

describe("deriveCadence", () => {
  it("is unknown with no dates — there is no gap to read", () => {
    expect(deriveCadence([])).toBe("unknown");
  });

  it("is unknown with a single date, however recurring the payee really is", () => {
    expect(deriveCadence(["2026-01-15"])).toBe("unknown");
  });

  it("reads a clean monthly series", () => {
    expect(deriveCadence(["2026-01-15", "2026-02-15", "2026-03-15", "2026-04-15"])).toBe("monthly");
  });

  it("reads monthly through month-length jitter — 28, 31 and 30-day gaps are all one month", () => {
    // Jan 31 -> Feb 28 -> Mar 31 -> Apr 30: gaps of 28, 31, 30 days.
    expect(deriveCadence(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"])).toBe("monthly");
  });

  it("reads bi-monthly", () => {
    // Gaps of 59 and 61 days.
    expect(deriveCadence(["2026-01-01", "2026-03-01", "2026-05-01"])).toBe("bi-monthly");
  });

  it("reads quarterly", () => {
    expect(deriveCadence(["2026-01-01", "2026-04-01", "2026-07-01", "2026-10-01"])).toBe(
      "quarterly",
    );
  });

  it("reads yearly", () => {
    expect(deriveCadence(["2024-03-01", "2025-03-01", "2026-03-01"])).toBe("yearly");
  });

  it("stays monthly across one missed month — a skipped charge is not a different cadence", () => {
    // Gaps of 31, 59, 30: the 59 is the gap that swallowed March.
    expect(deriveCadence(["2026-01-15", "2026-02-15", "2026-04-15", "2026-05-15"])).toBe("monthly");
  });

  it("calls genuinely unstable spacing irregular rather than picking the nearest band", () => {
    // Gaps of 15, 41 and 191 days — nothing repeats.
    expect(deriveCadence(["2026-01-05", "2026-01-20", "2026-03-02", "2026-09-09"])).toBe(
      "irregular",
    );
  });

  it("is irregular when one plausible gap is outvoted by chaos, not rescued by it", () => {
    // Gaps of 30 and 200: half the evidence says monthly, which is not enough.
    expect(deriveCadence(["2026-01-01", "2026-01-31", "2026-08-19"])).toBe("irregular");
  });

  it("reads a cadence from a single gap — a guess, but the only one available at two dates", () => {
    expect(deriveCadence(["2026-01-15", "2026-02-15"])).toBe("monthly");
  });

  it("does not depend on the caller sorting the dates", () => {
    expect(deriveCadence(["2026-03-15", "2026-01-15", "2026-04-15", "2026-02-15"])).toBe("monthly");
  });
});
