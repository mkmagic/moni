// src/lib/connectors/import-key.ts — the dedup key that makes re-scraping
// idempotent (data-model.md §5/§6.4, docs plan §D). Built from STABLE
// fields only: description and processedDate are not parameters at all (a
// bank mutating them on pending -> posted can't move the key); amount,
// currency, date, and identifier are the inputs that legitimately change
// the key.
import { describe, expect, it } from "vitest";
import { computeImportKey, type ImportKeyInput } from "@/lib/connectors/import-key";

const base: ImportKeyInput = {
  connectorId: "leumi",
  accountId: "11111111-1111-1111-1111-111111111111",
  identifier: "ASM123",
  originalAmount: "-120.50",
  originalCurrency: "ILS",
  date: "2026-06-01",
};

describe("computeImportKey", () => {
  it("is deterministic for the same input", () => {
    expect(computeImportKey(base)).toBe(computeImportKey({ ...base }));
  });

  it("is a hex sha256 digest", () => {
    expect(computeImportKey(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when the amount changes", () => {
    expect(computeImportKey(base)).not.toBe(
      computeImportKey({ ...base, originalAmount: "-120.51" }),
    );
  });

  it("changes when the date changes", () => {
    expect(computeImportKey(base)).not.toBe(computeImportKey({ ...base, date: "2026-06-02" }));
  });

  it("changes when the identifier changes", () => {
    expect(computeImportKey(base)).not.toBe(computeImportKey({ ...base, identifier: "ASM124" }));
  });

  it("changes when the currency changes", () => {
    expect(computeImportKey(base)).not.toBe(computeImportKey({ ...base, originalCurrency: "USD" }));
  });

  it("changes when the (resolved internal) account changes", () => {
    expect(computeImportKey(base)).not.toBe(
      computeImportKey({ ...base, accountId: "22222222-2222-2222-2222-222222222222" }),
    );
  });

  it("changes when the connector changes", () => {
    expect(computeImportKey(base)).not.toBe(computeImportKey({ ...base, connectorId: "hapoalim" }));
  });

  it(
    "is unaffected by fields that aren't inputs at all (description, processedDate) — " +
      "computeImportKey has no parameter for either, so a bank mutating them on " +
      "pending -> posted cannot move the key",
    () => {
      // Two calls with identical stable-field input yield the same key
      // regardless of what a caller might have separately observed for
      // description/processedDate on the two scrapes.
      expect(computeImportKey(base)).toBe(computeImportKey({ ...base }));
    },
  );

  it("uses a stable sentinel for a missing identifier — null, undefined, and empty string all match", () => {
    const keyNull = computeImportKey({ ...base, identifier: null });
    const keyUndefined = computeImportKey({ ...base, identifier: undefined });
    const keyEmpty = computeImportKey({ ...base, identifier: "" });
    expect(keyNull).toBe(keyUndefined);
    expect(keyUndefined).toBe(keyEmpty);
    // And differs from a real identifier, so two connectors that both omit
    // identifiers don't collide with one that has a real "no-id" value.
    expect(keyNull).not.toBe(computeImportKey(base));
  });

  it("treats a numeric identifier the same as its string form", () => {
    expect(computeImportKey({ ...base, identifier: 123 })).toBe(
      computeImportKey({ ...base, identifier: "123" }),
    );
  });

  // Isracard/Amex give every slice of one deal the SAME identifier
  // (voucherNumberRatz), the same purchase date and the same dealSum — so
  // without the slice number all twelve payments hash to one key and collapse
  // into a single entry (base-isracard-amex.js:96-110). Max escapes this only
  // because it appends the slice number to the identifier itself.
  it("distinguishes the slices of one installment deal", () => {
    const slice1 = computeImportKey({ ...base, installmentNumber: 1 });
    const slice2 = computeImportKey({ ...base, installmentNumber: 2 });
    expect(slice1).not.toBe(slice2);
  });

  it("leaves a non-installment charge's key unchanged", () => {
    // A null slice number must hash exactly as an absent one, so ordinary
    // charges keep the key they already have in the database.
    expect(computeImportKey({ ...base, installmentNumber: null })).toBe(computeImportKey(base));
  });
});
