// Which action the connect wizard offers after a failed first sync depends
// entirely on this classifier, and its input is a string written by
// scripts/scrape-worker.mts from the scraper library's error enum.
import { describe, expect, it } from "vitest";
import { classifySyncFailure } from "@/lib/sync-error";

describe("classifySyncFailure", () => {
  it("treats a rejected login as a credential problem", () => {
    expect(classifySyncFailure("INVALID_PASSWORD: Invalid password")).toBe("credentials");
    expect(classifySyncFailure("CHANGE_PASSWORD: must change password")).toBe("credentials");
    expect(classifySyncFailure("ACCOUNT_BLOCKED: account is blocked")).toBe("credentials");
  });

  it("treats a bank or scrape misbehaving as transient", () => {
    expect(classifySyncFailure("GENERIC: Navigation timeout of 30000 ms exceeded")).toBe(
      "transient",
    );
    expect(classifySyncFailure("TIMEOUT")).toBe("transient");
    expect(classifySyncFailure("GENERAL_ERROR: something went wrong")).toBe("transient");
  });

  it("falls back to unknown so both actions are offered", () => {
    // Neither re-entering credentials nor retrying fixes this one.
    expect(classifySyncFailure("TWO_FACTOR_RETRIEVER_MISSING")).toBe("unknown");
    // A message the worker wrote itself, with no scraper prefix at all.
    expect(classifySyncFailure("scrape-worker exited (code 1)")).toBe("unknown");
    expect(classifySyncFailure(null)).toBe("unknown");
    expect(classifySyncFailure("")).toBe("unknown");
  });

  it("ignores colons inside the message", () => {
    expect(classifySyncFailure("INVALID_PASSWORD: at 10:30, login failed")).toBe("credentials");
  });
});
