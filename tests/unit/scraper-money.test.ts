// src/lib/money/from-scraper-number.ts — the ONE place allowed to touch a
// money-bearing JS number (docs plan §"Money at the scraper boundary").
// Confirms realistic scraper amounts round-trip exactly to a canonical
// decimal string, and non-finite input is rejected rather than silently
// coerced.
import { describe, expect, it } from "vitest";
import { decimalStringFromScraperNumber } from "@/lib/money/from-scraper-number";

describe("decimalStringFromScraperNumber", () => {
  it.each([
    [19.99, "19.99"],
    [-4500, "-4500"],
    [123456.78, "123456.78"],
  ])("round-trips %p exactly as %p", (input, expected) => {
    expect(decimalStringFromScraperNumber(input)).toBe(expected);
  });

  it("throws on non-finite input (never silently coerced)", () => {
    expect(() => decimalStringFromScraperNumber(NaN)).toThrow();
    expect(() => decimalStringFromScraperNumber(Infinity)).toThrow();
    expect(() => decimalStringFromScraperNumber(-Infinity)).toThrow();
  });
});
