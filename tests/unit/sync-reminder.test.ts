import { describe, expect, it } from "vitest";
import { shouldPromptSync, SYNC_REMINDER_STALE_MS } from "@/lib/sync-reminder";

const NOW = Date.UTC(2026, 7, 15, 12, 0, 0);
const fresh = new Date(NOW - 60 * 60 * 1000); // 1h ago
const stale = new Date(NOW - SYNC_REMINDER_STALE_MS - 1); // just over the window

describe("shouldPromptSync (issue #97)", () => {
  const base = { autoSyncOnLogin: true, dismissed: false, now: NOW };

  it("stays hidden when the user has not opted in", () => {
    expect(shouldPromptSync({ ...base, autoSyncOnLogin: false, syncableLastSyncAt: [stale] })).toBe(
      false,
    );
  });

  it("stays hidden once dismissed this session", () => {
    expect(shouldPromptSync({ ...base, dismissed: true, syncableLastSyncAt: [stale] })).toBe(false);
  });

  it("stays hidden with nothing Moni can refresh", () => {
    expect(shouldPromptSync({ ...base, syncableLastSyncAt: [] })).toBe(false);
  });

  it("disappears the moment a sync makes the data fresh — the bug it fixes", () => {
    expect(shouldPromptSync({ ...base, syncableLastSyncAt: [fresh] })).toBe(false);
  });

  it("shows when the data has gone stale past the window", () => {
    expect(shouldPromptSync({ ...base, syncableLastSyncAt: [stale] })).toBe(true);
  });

  it("shows when a connection has never been synced", () => {
    expect(shouldPromptSync({ ...base, syncableLastSyncAt: [null] })).toBe(true);
  });

  it("shows when the stalest of several connections is overdue, even beside a fresh one", () => {
    expect(shouldPromptSync({ ...base, syncableLastSyncAt: [fresh, stale] })).toBe(true);
    expect(shouldPromptSync({ ...base, syncableLastSyncAt: [fresh, null] })).toBe(true);
  });

  it("stays hidden when every connection is fresh", () => {
    expect(shouldPromptSync({ ...base, syncableLastSyncAt: [fresh, fresh] })).toBe(false);
  });
});
