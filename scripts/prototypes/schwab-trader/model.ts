// PROTOTYPE — throwaway evidence collector for issue #39.
//
// Schwab returns monetary JSON values as number tokens. JSON.parse would turn
// those tokens into floating-point numbers, so this parser preserves every JSON
// number as its original decimal text.
import Decimal from "decimal.js";

export interface ExactJsonNumber {
  readonly kind: "number";
  readonly raw: string;
}

export type ExactJsonValue =
  null | boolean | string | ExactJsonNumber | ExactJsonValue[] | { [key: string]: ExactJsonValue };

export interface ContractCheck {
  name: string;
  status: "proven" | "unproven";
  evidence: string;
}

export interface SchwabInventory {
  accountCount: number;
  positionCount: number;
  responseBytes: number;
  responseDateHeader: "present" | "absent";
  accountFields: string[];
  positionFields: string[];
  instrumentFields: string[];
  currentBalanceFields: string[];
  checks: ContractCheck[];
}

class ExactJsonParser {
  private offset = 0;

  constructor(private readonly source: string) {}

  parse(): ExactJsonValue {
    const value = this.parseValue();
    this.skipWhitespace();
    if (this.offset !== this.source.length) throw new Error("trailing_json_content");
    return value;
  }

  private parseValue(): ExactJsonValue {
    this.skipWhitespace();
    const character = this.source[this.offset];

    if (character === '"') return this.parseString();
    if (character === "{") return this.parseObject();
    if (character === "[") return this.parseArray();
    if (character === "t") return this.parseLiteral("true", true);
    if (character === "f") return this.parseLiteral("false", false);
    if (character === "n") return this.parseLiteral("null", null);
    return this.parseNumber();
  }

  private parseObject(): { [key: string]: ExactJsonValue } {
    const result: { [key: string]: ExactJsonValue } = {};
    this.offset += 1;
    this.skipWhitespace();

    if (this.source[this.offset] === "}") {
      this.offset += 1;
      return result;
    }

    while (this.offset < this.source.length) {
      const key = this.parseString();
      this.skipWhitespace();
      if (this.source[this.offset] !== ":") throw new Error("invalid_json_object");
      this.offset += 1;
      result[key] = this.parseValue();
      this.skipWhitespace();

      const delimiter = this.source[this.offset];
      this.offset += 1;
      if (delimiter === "}") return result;
      if (delimiter !== ",") throw new Error("invalid_json_object");
      this.skipWhitespace();
    }

    throw new Error("unterminated_json_object");
  }

  private parseArray(): ExactJsonValue[] {
    const result: ExactJsonValue[] = [];
    this.offset += 1;
    this.skipWhitespace();

    if (this.source[this.offset] === "]") {
      this.offset += 1;
      return result;
    }

    while (this.offset < this.source.length) {
      result.push(this.parseValue());
      this.skipWhitespace();

      const delimiter = this.source[this.offset];
      this.offset += 1;
      if (delimiter === "]") return result;
      if (delimiter !== ",") throw new Error("invalid_json_array");
    }

    throw new Error("unterminated_json_array");
  }

  private parseString(): string {
    const start = this.offset;
    this.offset += 1;
    let escaped = false;

    while (this.offset < this.source.length) {
      const character = this.source[this.offset];
      this.offset += 1;

      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (character === '"') {
        const literal = this.source.slice(start, this.offset);
        const value: unknown = JSON.parse(literal);
        if (typeof value !== "string") throw new Error("invalid_json_string");
        return value;
      }
    }

    throw new Error("unterminated_json_string");
  }

  private parseNumber(): ExactJsonNumber {
    const match = this.source
      .slice(this.offset)
      .match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!match) throw new Error("invalid_json_value");

    this.offset += match[0].length;
    return { kind: "number", raw: match[0] };
  }

  private parseLiteral<T extends boolean | null>(literal: string, value: T): T {
    if (!this.source.startsWith(literal, this.offset)) throw new Error("invalid_json_literal");
    this.offset += literal.length;
    return value;
  }

  private skipWhitespace(): void {
    while (/\s/.test(this.source[this.offset] ?? "")) this.offset += 1;
  }
}

function isObject(value: ExactJsonValue | undefined): value is {
  [key: string]: ExactJsonValue;
} {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asObject(value: ExactJsonValue | undefined): { [key: string]: ExactJsonValue } {
  return isObject(value) ? value : {};
}

function isExactNumber(value: ExactJsonValue | undefined): value is ExactJsonNumber {
  if (!isObject(value) || value.kind !== "number" || typeof value.raw !== "string") return false;

  try {
    return new Decimal(value.raw).isFinite();
  } catch {
    return false;
  }
}

function hasText(value: ExactJsonValue | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function fieldUnion(rows: { [key: string]: ExactJsonValue }[]): string[] {
  return [...new Set(rows.flatMap((row) => Object.keys(row)))].sort();
}

function check(name: string, proven: boolean, evidence: string): ContractCheck {
  return { name, status: proven ? "proven" : "unproven", evidence };
}

function positionHasQuantity(position: { [key: string]: ExactJsonValue }): boolean {
  return isExactNumber(position.longQuantity) && isExactNumber(position.shortQuantity);
}

function positionIsNonZero(position: { [key: string]: ExactJsonValue }): boolean {
  const longQuantity = position.longQuantity;
  const shortQuantity = position.shortQuantity;
  if (!isExactNumber(longQuantity) || !isExactNumber(shortQuantity)) return true;

  return !new Decimal(longQuantity.raw).minus(shortQuantity.raw).isZero();
}

export function parseExactJson(source: string): ExactJsonValue {
  return new ExactJsonParser(source).parse();
}

export function analyzeAccountsResponse(
  source: string,
  responseBytes: number,
  responseDate: string | null,
): SchwabInventory {
  const root = parseExactJson(source);
  const wrappers = Array.isArray(root) ? root.map(asObject) : [];
  const accounts = wrappers
    .map((wrapper) => asObject(wrapper.securitiesAccount))
    .filter((account) => Object.keys(account).length > 0);
  const positions = accounts.flatMap((account) =>
    Array.isArray(account.positions) ? account.positions.map(asObject) : [],
  );
  const instruments = positions.map((position) => asObject(position.instrument));
  const currentBalances = accounts.map((account) => asObject(account.currentBalances));

  const responseDateIsUsable = responseDate !== null && !Number.isNaN(Date.parse(responseDate));
  const accountCurrencyIsExplicit = accounts.every(
    (account) => hasText(account.currency) || hasText(account.baseCurrency),
  );
  const positionCurrencyIsExplicit = positions.every((position, index) => {
    const instrument = instruments[index];
    return (
      hasText(position.currency) ||
      hasText(position.marketValueCurrency) ||
      hasText(instrument.currency)
    );
  });

  const checks: ContractCheck[] = [
    check("JSON account report", Array.isArray(root), "response root is an array"),
    check("account rows", accounts.length > 0, `${accounts.length} securitiesAccount record(s)`),
    check(
      "account identity",
      accounts.length > 0 && accounts.every((account) => hasText(account.accountNumber)),
      "every account has accountNumber",
    ),
    check(
      "account base currency",
      accounts.length > 0 && accountCurrencyIsExplicit,
      "every account explicitly identifies currency/baseCurrency",
    ),
    check("position rows", positions.length > 0, `${positions.length} position record(s)`),
    check(
      "durable security identity",
      positions.length > 0 &&
        instruments.every(
          (instrument) =>
            hasText(instrument.cusip) ||
            hasText(instrument.instrumentId) ||
            hasText(instrument.securityId),
        ),
      "every position instrument has CUSIP, instrumentId, or securityId",
    ),
    check(
      "instrument kind",
      positions.length > 0 && instruments.every((instrument) => hasText(instrument.assetType)),
      "every position instrument has assetType",
    ),
    check(
      "exact signed position quantity",
      positions.length > 0 && positions.every(positionHasQuantity),
      "every position has exact longQuantity and shortQuantity number tokens",
    ),
    check(
      "position currency",
      positions.length > 0 && positionCurrencyIsExplicit,
      "every position explicitly identifies its valuation currency",
    ),
    check(
      "usable position valuation",
      positions.length > 0 &&
        positions
          .filter(positionIsNonZero)
          .every((position) => isExactNumber(position.marketValue)),
      "every nonzero position has an exact marketValue number token",
    ),
    check(
      "authoritative source timestamp",
      responseDateIsUsable,
      "Schwab response supplies a parseable HTTP Date header",
    ),
    check(
      "cash snapshot inputs",
      currentBalances.length > 0 &&
        currentBalances.every(
          (balances) =>
            isExactNumber(balances.cashBalance) && isExactNumber(balances.moneyMarketFund),
        ),
      "every account has exact cashBalance and moneyMarketFund number tokens",
    ),
    check(
      "broker account total",
      currentBalances.length > 0 &&
        currentBalances.every((balances) => isExactNumber(balances.liquidationValue)),
      "every account has exact currentBalances.liquidationValue",
    ),
  ];

  return {
    accountCount: accounts.length,
    positionCount: positions.length,
    responseBytes,
    responseDateHeader: responseDateIsUsable ? "present" : "absent",
    accountFields: fieldUnion(accounts),
    positionFields: fieldUnion(positions),
    instrumentFields: fieldUnion(instruments),
    currentBalanceFields: fieldUnion(currentBalances),
    checks,
  };
}
