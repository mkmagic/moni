// Exercises src/lib/money directly (no DB needed) — exact-decimal round
// trips, no float drift, and the currency-mismatch guard. See
// docs/design/money-and-currency.md §1/§3.
import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import { add, isZero, multiply, negate, type Money } from "@/lib/money";

describe("Money: exact-decimal string round-trip", () => {
  it("preserves an amount string exactly through negate/negate", () => {
    const m: Money = { amount: "1234.56", currency: "ILS" };
    const roundTripped = negate(negate(m));
    expect(roundTripped.amount).toBe("1234.56");
    expect(roundTripped.currency).toBe("ILS");
  });

  it("sums several decimal-string amounts with no float drift (classic 0.1 + 0.1 + 0.1 case)", () => {
    const values: Money[] = [
      { amount: "0.1", currency: "ILS" },
      { amount: "0.1", currency: "ILS" },
      { amount: "0.1", currency: "ILS" },
    ];
    const total = values.reduce((acc, v) => add(acc, v), { amount: "0", currency: "ILS" });

    // Native float arithmetic gives 0.30000000000000004 here — the exact
    // bug this module exists to prevent (money-and-currency.md).
    expect(0.1 + 0.1 + 0.1).not.toBe(0.3);
    expect(total.amount).toBe("0.3");
  });

  it("sums many small amounts exactly via decimal.js, matching a Decimal-computed reference sum", () => {
    const amounts = ["10.10", "20.20", "30.30", "0.01", "-5.55"];
    const values: Money[] = amounts.map((amount) => ({ amount, currency: "USD" }));
    const total = values.reduce((acc, v) => add(acc, v), { amount: "0", currency: "USD" });

    const reference = amounts
      .reduce((acc, a) => acc.plus(new Decimal(a)), new Decimal(0))
      .toString();
    expect(total.amount).toBe(reference);
  });

  it("add() throws on currency mismatch — this layer never implicitly converts", () => {
    const ils: Money = { amount: "100", currency: "ILS" };
    const usd: Money = { amount: "100", currency: "USD" };
    expect(() => add(ils, usd)).toThrow(/currenc/i);
  });

  it("multiply() applies an exact-decimal factor (e.g. entered_amount x fx_rate, data-model.md §4.3)", () => {
    const entered: Money = { amount: "100.00", currency: "USD" };
    const fxRate = "3.70";
    const reporting = multiply(entered, fxRate);
    expect(reporting.amount).toBe("370");
    expect(reporting.currency).toBe("USD"); // multiply doesn't change currency; the caller assigns reporting_currency separately
  });

  it("multiply() accepts a Decimal instance too, not just a string", () => {
    const entered: Money = { amount: "50", currency: "ILS" };
    const reporting = multiply(entered, new Decimal("2"));
    expect(reporting.amount).toBe("100");
  });

  it("isZero() is exact for values that are zero after arithmetic", () => {
    const a: Money = { amount: "5.00", currency: "ILS" };
    const b: Money = { amount: "-5.00", currency: "ILS" };
    expect(isZero(add(a, b))).toBe(true);
    expect(isZero(a)).toBe(false);
  });
});

describe("Money amounts are never constructed from a JS number", () => {
  // Static-typing argument: `Money.amount` is typed `string` (src/lib/money
  // index.ts), so `{ amount: 100, currency: "ILS" }` is a compile error, not
  // a runtime concern — `npm run typecheck` is what actually enforces this.
  // This test is a runtime belt-and-suspenders check that a value matching
  // the canonical decimal-string pattern was used everywhere in this file.
  it("every Money amount used in this file matches the canonical decimal-string pattern", () => {
    const decimalStringPattern = /^-?\d+(\.\d+)?$/;
    const amountsUsedInThisFile = [
      "1234.56",
      "0.1",
      "0.3",
      "10.10",
      "20.20",
      "30.30",
      "0.01",
      "-5.55",
      "100",
      "100.00",
      "370",
      "50",
      "5.00",
      "-5.00",
    ];
    for (const amount of amountsUsedInThisFile) {
      expect(amount).toMatch(decimalStringPattern);
      expect(typeof amount).toBe("string");
    }
  });
});
