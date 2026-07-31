// PROTOTYPE — throwaway evidence collector for issue #39.
//
// Question: can one real IBKR Activity Flex Query supply every source field
// Moni 1.1 requires for a complete investment-account snapshot, while the
// probe keeps the token and financial payload out of arguments, environment
// variables, logs, and disk?
//
// This module is deliberately pure. The terminal/network shell in index.ts
// feeds it redacted events and an in-memory XML report.
import Decimal from "decimal.js";

export type ProbePhase =
  "ready" | "requesting" | "waiting" | "retrieving" | "analyzing" | "complete" | "failed";

export interface ContractCheck {
  name: string;
  status: "proven" | "unproven";
  evidence: string;
}

export interface ReportInventory {
  rootTag: string;
  reportBytes: number;
  recordCounts: Record<string, number>;
  fieldNames: Record<string, string[]>;
  checks: ContractCheck[];
}

export interface ProbeState {
  phase: ProbePhase;
  sendRequest: "pending" | "succeeded" | "failed";
  referenceCode: "absent" | "received";
  retrieveAttempts: number;
  failureCode?: string;
  inventory?: ReportInventory;
}

export type ProbeEvent =
  | { type: "start" }
  | { type: "reference_received" }
  | { type: "waiting" }
  | { type: "retrieve_attempt" }
  | { type: "analyzing" }
  | { type: "complete"; inventory: ReportInventory }
  | { type: "failed"; code: string };

export const initialProbeState: ProbeState = {
  phase: "ready",
  sendRequest: "pending",
  referenceCode: "absent",
  retrieveAttempts: 0,
};

export function transition(state: ProbeState, event: ProbeEvent): ProbeState {
  switch (event.type) {
    case "start":
      return { ...initialProbeState, phase: "requesting" };
    case "reference_received":
      return {
        ...state,
        phase: "waiting",
        sendRequest: "succeeded",
        referenceCode: "received",
      };
    case "waiting":
      return { ...state, phase: "waiting" };
    case "retrieve_attempt":
      return {
        ...state,
        phase: "retrieving",
        retrieveAttempts: state.retrieveAttempts + 1,
      };
    case "analyzing":
      return { ...state, phase: "analyzing" };
    case "complete":
      return { ...state, phase: "complete", inventory: event.inventory };
    case "failed":
      return {
        ...state,
        phase: "failed",
        sendRequest: state.phase === "requesting" ? "failed" : state.sendRequest,
        failureCode: event.code,
      };
  }
}

interface XmlTag {
  name: string;
  attributes: Record<string, string>;
}

const RECORD_TAGS = [
  "FlexStatement",
  "AccountInformation",
  "OpenPosition",
  "CashReportCurrency",
  "EquitySummaryByReportDateInBase",
] as const;

const DECIMAL_TEXT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

function parseTags(xml: string): XmlTag[] {
  const tags: XmlTag[] = [];
  const tagPattern = /<([A-Za-z_:][\w:.-]*)(\s[^<>]*?)?\/?>/g;

  for (const match of xml.matchAll(tagPattern)) {
    const attributes: Record<string, string> = {};
    const attributeText = match[2] ?? "";
    const attributePattern = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

    for (const attribute of attributeText.matchAll(attributePattern)) {
      attributes[attribute[1]] = attribute[2] ?? attribute[3] ?? "";
    }

    tags.push({ name: match[1], attributes });
  }

  return tags;
}

function hasNonEmptyAttribute(tag: XmlTag, names: readonly string[]): boolean {
  return names.some((name) => (tag.attributes[name] ?? "").trim().length > 0);
}

function hasExactDecimal(tag: XmlTag, name: string): boolean {
  const value = tag.attributes[name]?.trim();
  if (!value || !DECIMAL_TEXT.test(value)) return false;

  try {
    return new Decimal(value).isFinite();
  } catch {
    return false;
  }
}

function isNonZeroPosition(tag: XmlTag): boolean {
  const value = tag.attributes.position?.trim();
  if (!value || !DECIMAL_TEXT.test(value)) return true;

  try {
    return !new Decimal(value).isZero();
  } catch {
    return true;
  }
}

function everyOrUnproven(rows: XmlTag[], predicate: (row: XmlTag) => boolean): boolean {
  return rows.length > 0 && rows.every(predicate);
}

function check(name: string, proven: boolean, evidence: string): ContractCheck {
  return { name, status: proven ? "proven" : "unproven", evidence };
}

export function analyzeFlexReport(xml: string, reportBytes: number): ReportInventory {
  const tags = parseTags(xml);
  const rootTag = tags[0]?.name ?? "none";
  const rowsByName = new Map<string, XmlTag[]>();

  for (const tag of tags) {
    const rows = rowsByName.get(tag.name) ?? [];
    rows.push(tag);
    rowsByName.set(tag.name, rows);
  }

  const recordCounts: Record<string, number> = {};
  const fieldNames: Record<string, string[]> = {};
  for (const tagName of RECORD_TAGS) {
    const rows = rowsByName.get(tagName) ?? [];
    recordCounts[tagName] = rows.length;
    fieldNames[tagName] = [...new Set(rows.flatMap((row) => Object.keys(row.attributes)))].sort();
  }

  const statements = rowsByName.get("FlexStatement") ?? [];
  const accountInformation = rowsByName.get("AccountInformation") ?? [];
  const positions = rowsByName.get("OpenPosition") ?? [];
  const cashRows = rowsByName.get("CashReportCurrency") ?? [];
  const navRows = rowsByName.get("EquitySummaryByReportDateInBase") ?? [];

  const statementHasAccount = statements.some((row) =>
    hasNonEmptyAttribute(row, ["accountId", "accountAlias", "acctAlias"]),
  );
  const accountInfoHasAccount = accountInformation.some((row) =>
    hasNonEmptyAttribute(row, ["accountId", "accountAlias", "acctAlias"]),
  );
  const accountIdentityProven =
    statementHasAccount ||
    accountInfoHasAccount ||
    everyOrUnproven(positions, (row) =>
      hasNonEmptyAttribute(row, ["accountId", "accountAlias", "acctAlias"]),
    );

  const statementHasTimestamp = statements.some((row) =>
    hasNonEmptyAttribute(row, ["toDate", "whenGenerated", "reportDate"]),
  );
  const positionHasTimestamp = everyOrUnproven(positions, (row) =>
    hasNonEmptyAttribute(row, ["reportDate", "whenGenerated"]),
  );

  const checks: ContractCheck[] = [
    check("XML Flex report", rootTag === "FlexQueryResponse", `root tag is ${rootTag}`),
    check(
      "account identity",
      accountIdentityProven,
      "accountId/accountAlias exists at statement, account, or every position level",
    ),
    check(
      "account base currency",
      everyOrUnproven(accountInformation, (row) => hasNonEmptyAttribute(row, ["currency"])),
      "every AccountInformation record has an explicit base currency",
    ),
    check(
      "position rows",
      positions.length > 0,
      `${positions.length} OpenPosition record(s) observed`,
    ),
    check(
      "durable security identity",
      everyOrUnproven(positions, (row) =>
        hasNonEmptyAttribute(row, ["conid", "securityID", "isin", "cusip"]),
      ),
      "every position has conid, securityID, ISIN, or CUSIP",
    ),
    check(
      "exact position quantity",
      everyOrUnproven(positions, (row) => hasExactDecimal(row, "position")),
      "every position quantity is decimal text",
    ),
    check(
      "position currency",
      everyOrUnproven(positions, (row) => hasNonEmptyAttribute(row, ["currency"])),
      "every position has an explicit currency",
    ),
    check(
      "usable position valuation",
      everyOrUnproven(
        positions.filter(isNonZeroPosition),
        (row) =>
          hasExactDecimal(row, "positionValue") ||
          (hasExactDecimal(row, "position") && hasExactDecimal(row, "markPrice")),
      ),
      "every nonzero position has positionValue or exact position × markPrice inputs",
    ),
    check(
      "authoritative source timestamp",
      statementHasTimestamp || positionHasTimestamp,
      "statement or every position carries a source timestamp/date",
    ),
    check(
      "cash snapshot",
      everyOrUnproven(
        cashRows,
        (row) =>
          hasNonEmptyAttribute(row, ["currency"]) &&
          ["endingCash", "settledCash", "totalCashValue"].some((name) =>
            hasExactDecimal(row, name),
          ),
      ),
      `${cashRows.length} cash record(s), each requiring currency and an exact amount`,
    ),
    check(
      "broker account total",
      everyOrUnproven(
        navRows,
        (row) =>
          hasNonEmptyAttribute(row, ["accountId", "reportDate"]) && hasExactDecimal(row, "total"),
      ),
      `${navRows.length} NAV-in-base record(s), each requiring accountId, reportDate, and exact total`,
    ),
  ];

  return { rootTag, reportBytes, recordCounts, fieldNames, checks };
}

export interface ControlResponse {
  status: "success" | "failure" | "unknown";
  referenceCode?: string;
  errorCode?: string;
}

function elementText(xml: string, element: string): string | undefined {
  const pattern = new RegExp(`<${element}>\\s*([^<]*?)\\s*</${element}>`, "i");
  const value = pattern.exec(xml)?.[1]?.trim();
  return value || undefined;
}

export function parseControlResponse(xml: string): ControlResponse {
  const status = elementText(xml, "Status")?.toLowerCase();
  if (status === "success") {
    return {
      status: "success",
      referenceCode: elementText(xml, "ReferenceCode"),
    };
  }
  if (status === "fail") {
    const errorCode = elementText(xml, "ErrorCode");
    return {
      status: "failure",
      errorCode: errorCode && /^\d{1,12}$/.test(errorCode) ? errorCode : "unknown",
    };
  }
  return { status: "unknown" };
}

const RETRYABLE_REPORT_CODES = new Set([
  "1001",
  "1003",
  "1004",
  "1005",
  "1006",
  "1007",
  "1008",
  "1009",
  "1019",
  "1021",
]);

export function isRetryableReportCode(code: string | undefined): boolean {
  return code !== undefined && RETRYABLE_REPORT_CODES.has(code);
}
