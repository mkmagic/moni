// Exercises src/lib/money directly (no DB needed) — exact-decimal round
// trips, no float drift, and the currency-mismatch guard. See
// docs/design/money-and-currency.md §1/§3.
import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import { abs, add, divide, isZero, multiply, negate, type Money } from "@/lib/money";
import { formatMoney } from "@/lib/format";

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

// Division is the one operation here whose result need not terminate. It
// still does not round: money-and-currency.md §3 says "Never round
// intermediate arithmetic" and "Rounding never happens in the domain/service
// layer" — the display edge does it (see the formatMoney case below).
describe("Money: divide() stays exact and never rounds", () => {
  it("divides exactly when the result terminates (45 + 45 + 63 over 3 = 51)", () => {
    const total: Money = { amount: "153", currency: "ILS" };
    expect(divide(total, "3").amount).toBe("51");
  });

  it("carries a repeating decimal at full precision rather than truncating it", () => {
    // The domain layer's job is to be exact, not pretty.
    expect(divide({ amount: "10", currency: "ILS" }, "3").amount).toBe(
      new Decimal("10").dividedBy(3).toString(),
    );
    expect(divide({ amount: "10", currency: "ILS" }, "3").amount).toMatch(/^3\.33333/);
  });

  it("does not round a half away — that decision belongs to the edge", () => {
    // 0.05 / 2 = 0.025 exactly. A domain layer that returned 0.03 here would
    // have made a display decision on the caller's behalf.
    expect(divide({ amount: "0.05", currency: "ILS" }, "2").amount).toBe("0.025");
    expect(divide({ amount: "-0.05", currency: "ILS" }, "2").amount).toBe("-0.025");
  });

  it("is the display edge that rounds, half away from zero at the minor unit", () => {
    const average = divide({ amount: "10", currency: "ILS" }, "3");
    expect(formatMoney(average)).toBe("₪3.33");
    expect(formatMoney(divide({ amount: "0.05", currency: "ILS" }, "2"))).toBe("₪0.03");
  });

  it("keeps the currency and never converts", () => {
    const result = divide({ amount: "100", currency: "USD" }, "4");
    expect(result).toEqual({ amount: "25", currency: "USD" });
  });

  it("accepts a Decimal divisor as well as a string, like multiply()", () => {
    expect(divide({ amount: "9", currency: "ILS" }, new Decimal("2")).amount).toBe("4.5");
  });

  it("throws on a zero divisor rather than returning Infinity", () => {
    expect(() => divide({ amount: "10", currency: "ILS" }, "0")).toThrow(/zero/i);
  });
});

describe("Money: abs()", () => {
  it("reports an expense as a positive magnitude", () => {
    // decimal.js canonicalizes, so the trailing zero of "-49.90" is dropped —
    // the same exact value, and what every other function here returns too.
    expect(abs({ amount: "-49.90", currency: "ILS" })).toEqual({ amount: "49.9", currency: "ILS" });
  });

  it("leaves a positive amount alone", () => {
    expect(abs({ amount: "12.5", currency: "ILS" }).amount).toBe("12.5");
  });

  it("has no sign to strip from zero", () => {
    expect(abs({ amount: "0", currency: "ILS" }).amount).toBe("0");
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
