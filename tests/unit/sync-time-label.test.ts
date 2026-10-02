import { describe, expect, it } from "vitest";
import { syncTimeLabel } from "@/lib/sync-time-label";

describe("connection sync time label", () => {
  it.each([
    ["2026-09-23T15:03:00Z", "23 Sept 2026, 18:03"],
    ["2026-01-23T15:03:00Z", "23 Jan 2026, 17:03"],
    ["2026-09-23T22:30:00Z", "24 Sept 2026, 01:30"],
  ])("renders %s in Israel time", (instant, expected) => {
    expect(syncTimeLabel(new Date(instant))).toBe(`Last synced ${expected} (Israel time)`);
  });
});
