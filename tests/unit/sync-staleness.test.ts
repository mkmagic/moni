import { describe, expect, it } from "vitest";
import { isConnectionStale, STALE_FETCH_DAYS, STALE_IMPORT_DAYS } from "@/lib/sync-staleness";

const NOW = Date.UTC(2026, 7, 15, 12, 0, 0);
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000);

describe("isConnectionStale", () => {
  describe("credentialed_fetch (weekly window)", () => {
    const mode = "credentialed_fetch" as const;

    it("is fresh within the window", () => {
      expect(isConnectionStale({ mode, lastSyncAt: daysAgo(STALE_FETCH_DAYS - 1), now: NOW })).toBe(
        false,
      );
    });

    it("is stale once the window has elapsed", () => {
      expect(isConnectionStale({ mode, lastSyncAt: daysAgo(STALE_FETCH_DAYS), now: NOW })).toBe(
        true,
      );
    });

    it("is stale when never synced", () => {
      expect(isConnectionStale({ mode, lastSyncAt: null, now: NOW })).toBe(true);
    });
  });

  describe("user_mediated_import (90-day window)", () => {
    const mode = "user_mediated_import" as const;

    it("is not flagged a week after upload — the bug this fixes", () => {
      // Same age that makes a fetch connection stale leaves an import fresh.
      expect(isConnectionStale({ mode, lastSyncAt: daysAgo(STALE_FETCH_DAYS), now: NOW })).toBe(
        false,
      );
    });

    it("stays fresh right up to the quarter mark", () => {
      expect(
        isConnectionStale({ mode, lastSyncAt: daysAgo(STALE_IMPORT_DAYS - 1), now: NOW }),
      ).toBe(false);
    });

    it("goes stale once no file has been uploaded in 90 days", () => {
      expect(isConnectionStale({ mode, lastSyncAt: daysAgo(STALE_IMPORT_DAYS), now: NOW })).toBe(
        true,
      );
    });

    it("is stale when no file was ever uploaded", () => {
      expect(isConnectionStale({ mode, lastSyncAt: null, now: NOW })).toBe(true);
    });
  });
});
