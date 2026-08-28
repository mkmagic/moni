// Which action the connect wizard offers after a failed first sync depends
// entirely on this classifier, and its input is a string written by
// scripts/scrape-worker.mts from the scraper library's error enum.
import { describe, expect, it } from "vitest";
import { classifySyncFailure } from "@/lib/sync-error";
import { syncErrorMessage } from "@/lib/sync-error-message";

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

describe("syncErrorMessage", () => {
  it("distinguishes a rejected run from an unexpected save failure", () => {
    // These two used to share the `invalid_sync` code, so a database fault was
    // indistinguishable from a deliberate guard rejection.
    expect(syncErrorMessage("invalid_sync")).toMatch(/no longer matches its connection/);
    expect(syncErrorMessage("promotion_failed")).toMatch(/MONI_SYNC_DIAGNOSTIC=1/);
    expect(syncErrorMessage("invalid_sync")).not.toBe(syncErrorMessage("promotion_failed"));
  });

  it("still falls back to the raw code for anything unmapped", () => {
    expect(syncErrorMessage("some_new_code")).toBe("some_new_code");
    expect(syncErrorMessage(null)).toBe("Last sync failed");
  });

  it("explains every way an imported document can fail", () => {
    // A document import has exactly one failure path (#76 D9), so a code
    // missing here is the whole thing the user sees. `balance_check_failed`
    // arrives with the failing check appended; the advice hangs off the code in
    // front of it, and the check name is a log diagnostic, not a message.
    for (const code of [
      "balance_check_failed",
      "account_type_mismatch",
      "unrecognised_document",
      "malformed_document",
      "unreadable_document",
      "empty_portfolio",
    ])
      expect(syncErrorMessage(code)).not.toBe(code);

    expect(syncErrorMessage("balance_check_failed: balance_equation")).toBe(
      syncErrorMessage("balance_check_failed"),
    );
    expect(syncErrorMessage("balance_check_failed: column_total:severance")).toBe(
      syncErrorMessage("balance_check_failed"),
    );
  });
});
