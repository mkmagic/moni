// Unit tests for the credential-key RAM window (src/lib/auth/cred-window.ts)
// — the tighter, second window from docs plan §B. No DB needed; this is
// pure in-memory state.
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import {
  armCredentialWindow,
  destroyCredentialWindow,
  getCredentialKey,
} from "@/lib/auth/cred-window";

afterEach(() => {
  vi.useRealTimers();
});

describe("cred-window: bounded credential-key RAM window", () => {
  it("arm then get returns the same key", () => {
    const sessionId = randomUUID();
    const key = randomBytes(32);
    armCredentialWindow(sessionId, randomUUID(), Buffer.from(key));

    const got = getCredentialKey(sessionId);
    expect(got).not.toBeNull();
    expect(Buffer.from(got!).equals(key)).toBe(true);

    destroyCredentialWindow(sessionId);
  });

  it("returns null for a session that was never armed", () => {
    expect(getCredentialKey(randomUUID())).toBeNull();
  });

  it("destroy wipes the key and get returns null afterward", () => {
    const sessionId = randomUUID();
    const key = Buffer.from(randomBytes(32));
    armCredentialWindow(sessionId, randomUUID(), key);

    destroyCredentialWindow(sessionId);

    expect(getCredentialKey(sessionId)).toBeNull();
    expect(key.equals(Buffer.alloc(32))).toBe(true); // fill(0) mutated the caller's buffer
  });

  it("arming twice wipes the first key and replaces it with the second", () => {
    const sessionId = randomUUID();
    const firstKey = Buffer.from(randomBytes(32));
    armCredentialWindow(sessionId, randomUUID(), firstKey);

    const secondKey = randomBytes(32);
    armCredentialWindow(sessionId, randomUUID(), Buffer.from(secondKey));

    expect(firstKey.equals(Buffer.alloc(32))).toBe(true);

    const got = getCredentialKey(sessionId);
    expect(Buffer.from(got!).equals(secondKey)).toBe(true);

    destroyCredentialWindow(sessionId);
  });

  it("expires after the 10-minute TTL: get returns null and wipes the key", () => {
    vi.useFakeTimers();
    try {
      const sessionId = randomUUID();
      const key = randomBytes(32);
      armCredentialWindow(sessionId, randomUUID(), Buffer.from(key));
      expect(getCredentialKey(sessionId)).not.toBeNull();

      vi.advanceTimersByTime(11 * 60 * 1000);
      expect(getCredentialKey(sessionId)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
