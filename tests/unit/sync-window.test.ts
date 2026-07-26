// src/domain/sync-promotion.ts's computeSyncStartDate — decision #7's
// `startDate = min(today - 30d, lastSyncAt - 7d)`, computed server-side. A
// pure function (no DB), so exercised directly here rather than through a
// route or a real sync.
import { describe, expect, it } from "vitest";
import { computeSyncStartDate } from "@/domain/sync-promotion";

describe("computeSyncStartDate", () => {
  const now = new Date("2026-07-26T12:00:00Z");

  it("collapses to exactly 30 days back when lastSyncAt is null (onboarding)", () => {
    expect(computeSyncStartDate(null, now)).toBe("2026-06-26");
  });

  it("uses today-30d when it is EARLIER than lastSyncAt-7d (recent, regular syncing)", () => {
    // Synced yesterday: lastSyncAt-7d is only 8 days back, today-30d (30
    // days back) is earlier — the 30-day floor wins.
    const lastSyncAt = new Date("2026-07-25T09:00:00Z");
    expect(computeSyncStartDate(lastSyncAt, now)).toBe("2026-06-26");
  });

  it("uses lastSyncAt-7d when it is EARLIER than today-30d (a long gap since last sync)", () => {
    // Hasn't synced in 2 months: lastSyncAt-7d reaches back further than
    // the 30-day floor, closing the middle-month gap.
    const lastSyncAt = new Date("2026-05-26T09:00:00Z");
    expect(computeSyncStartDate(lastSyncAt, now)).toBe("2026-05-19");
  });

  it("accepts an exact-30-day boundary without off-by-one drift", () => {
    const lastSyncAt = new Date("2026-06-30T00:00:00Z"); // -7d = 2026-06-23, earlier than -30d floor
    expect(computeSyncStartDate(lastSyncAt, now)).toBe("2026-06-23");
  });
});
