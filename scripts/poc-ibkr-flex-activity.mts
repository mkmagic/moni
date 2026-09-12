/**
 * POC (throwaway): pull an IBKR Activity Flex report and analyze the *activity*
 * sections — Trades (executions), Open-Position lots, Cash Transactions, Change
 * in Dividend Accruals, Corporate Actions — that Moni's snapshot parser
 * (src/lib/investments/ibkr-flex.ts) deliberately ignores today.
 *
 * It answers the field-spec questions from issue #135: do executions / lots /
 * dividends arrive with stable-enough identity, do they reconcile against the
 * current snapshot, and does replaying the same report create duplicates?
 *
 * This is NOT wired into the app: no DB, no encryption, no domain layer. The
 * production fetch lives in src/lib/investments/workers.ts (fetchIbkrFlexXml);
 * this reimplements a minimal copy so the POC runs standalone with just a token.
 *
 * Fetch the live report (pipe token bytes on stdin + stored query id):
 *   secret-provider | IBKR_QUERY_ID=1588880 npx tsx scripts/poc-ibkr-flex-activity.mts
 *   (or pass --query 1588880)
 * Analyze a report already on disk (no network):
 *   npx tsx scripts/poc-ibkr-flex-activity.mts --file report.xml
 *
 * The Flex token is Tier-0 in Moni: this POC reads it into a Buffer, never logs it,
 * and wipes it after the request. It deliberately provides no plaintext export path.
 */
import { readFileSync } from "node:fs";
import Decimal from "decimal.js";
import { XMLParser } from "fast-xml-parser";

const FLEX_URL = "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService";
const INITIAL_WAIT_MS = 20_000;
const RETRY_WAIT_MS = 5_000;
const MAX_ATTEMPTS = 6;

// ---------------------------------------------------------------------------- args

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// ---------------------------------------------------------------------------- fetch

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Reads Status / ReferenceCode / ErrorCode from a Flex Web Service envelope, or null if the body is the report itself. */
function statusEnvelope(
  xml: string,
): { status?: string; referenceCode?: string; errorCode?: string } | null {
  const parsed = new XMLParser({ parseTagValue: false, trimValues: true }).parse(xml) as {
    FlexStatementResponse?: { Status?: unknown; ReferenceCode?: unknown; ErrorCode?: unknown };
  };
  const response = parsed.FlexStatementResponse;
  if (!response || typeof response !== "object") return null;
  const text = (v: unknown): string | undefined => (typeof v === "string" ? v.trim() : undefined);
  return {
    status: text(response.Status)?.toLowerCase(),
    referenceCode: text(response.ReferenceCode),
    errorCode: text(response.ErrorCode),
  };
}

async function get(url: URL): Promise<string> {
  const response = await fetch(url.toString(), {
    redirect: "error",
    headers: { Accept: "application/xml, text/xml", "User-Agent": "Moni-IBKR-Flex-POC/0.1" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

function readTokenFromStdin(): Buffer {
  const input = readFileSync(0);
  let end = input.length;
  while (end > 0 && (input[end - 1] === 0x0a || input[end - 1] === 0x0d)) end -= 1;
  if (end === 0) {
    input.fill(0);
    throw new Error("Provide the Flex token on stdin");
  }
  if (end === input.length) return input;
  const token = Buffer.from(input.subarray(0, end));
  input.fill(0);
  return token;
}

async function fetchFlexXml(token: Buffer, queryId: string): Promise<string> {
  try {
    const send = new URL(`${FLEX_URL}/SendRequest`);
    send.searchParams.set("t", token.toString("ascii"));
    send.searchParams.set("q", queryId);
    send.searchParams.set("v", "3");
    const accepted = statusEnvelope(await get(send));
    send.searchParams.delete("t");
    if (accepted?.status === "fail")
      throw new Error(`SendRequest failed: code ${accepted.errorCode}`);
    if (accepted?.status !== "success" || !accepted.referenceCode)
      throw new Error("SendRequest: unexpected response (token/query id valid?)");

    const statement = new URL(`${FLEX_URL}/GetStatement`);
    statement.searchParams.set("t", token.toString("ascii"));
    statement.searchParams.set("q", accepted.referenceCode);
    statement.searchParams.set("v", "3");

    console.log(`SendRequest accepted (ref ${accepted.referenceCode}); waiting for the report…`);
    await sleep(INITIAL_WAIT_MS);
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const body = await get(statement);
      const pending = statusEnvelope(body);
      if (!pending) {
        statement.searchParams.delete("t");
        return body; // a body with no status envelope IS the report
      }
      console.log(
        `  attempt ${attempt}: status=${pending.status} code=${pending.errorCode ?? "-"}`,
      );
      if (pending.status === "fail" && attempt === MAX_ATTEMPTS)
        throw new Error(`GetStatement failed: code ${pending.errorCode}`);
      await sleep(RETRY_WAIT_MS);
    }
    throw new Error("GetStatement: report not ready after retries");
  } finally {
    token.fill(0);
  }
}

// ------------------------------------------------------------------------- parsing

type Attrs = Record<string, string>;
const a = (row: Attrs, key: string): string | undefined => row[key]?.trim() || undefined;

/** Collect every element with the given tag, anywhere in the tree, as its string attributes. */
function records(root: unknown, tag: string): Attrs[] {
  const found: Attrs[] = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === tag) {
        for (const candidate of Array.isArray(child) ? child : [child]) {
          if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
          const attrs = Object.fromEntries(
            Object.entries(candidate).filter(([, v]) => typeof v === "string"),
          ) as Attrs;
          if (Object.keys(attrs).length) found.push(attrs);
        }
      }
      visit(child);
    }
  };
  visit(root);
  return found;
}

// ------------------------------------------------------------------------ analysis

const line = (label: string, value: string): void => console.log(`  ${label.padEnd(34)}${value}`);
const verdict = (ok: boolean, warn = false): string => (warn ? "WARN" : ok ? "PASS" : "FAIL");
/** Exact-decimal sum of a string attribute (never touches JS float). */
function sum(rows: Attrs[], key: string): Decimal {
  return rows.reduce((acc, row) => acc.plus(new Decimal(a(row, key) ?? "0")), new Decimal(0));
}

function tradeKey(t: Attrs): string {
  const acct = a(t, "accountId") ?? "?";
  const exec = a(t, "ibExecID");
  return exec ? `${acct}:${exec}` : `${acct}:trade:${a(t, "tradeID") ?? "?"}`;
}
function lotKey(l: Attrs): string {
  const acct = a(l, "accountId") ?? "?";
  const txn = a(l, "originatingTransactionID");
  if (txn) return `${acct}:${txn}`;
  return `fp:${[
    acct,
    a(l, "conid") ?? "",
    a(l, "openDateTime") ?? "",
    a(l, "side") ?? "",
    a(l, "position") ?? "",
    a(l, "costBasisPrice") ?? "",
    a(l, "costBasisMoney") ?? "",
  ].join("|")}`;
}
function cashKey(c: Attrs): string {
  const acct = a(c, "accountId") ?? "?";
  const trade = a(c, "tradeID");
  if (trade) return `${acct}:cash:${trade}`;
  return `fp:${[
    "accountId",
    "dateTime",
    "type",
    "conid",
    "currency",
    "amount",
    "description",
    "code",
  ]
    .map((k) => a(c, k) ?? "")
    .join("|")}`;
}
const duplicates = (keys: string[]): number => keys.length - new Set(keys).size;
const dateOf = (value: string | undefined): string | undefined => value?.split(/[ ;T]/)[0];

function analyze(xml: string): void {
  const parsed = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
  }).parse(xml);

  const statements = records(parsed, "FlexStatement");
  const accounts = records(parsed, "AccountInformation");
  const trades = records(parsed, "Trade");
  const positions = records(parsed, "OpenPosition");
  const lots = positions.filter((p) => a(p, "levelOfDetail")?.toUpperCase() === "LOT");
  const summaries = positions.filter((p) => a(p, "levelOfDetail")?.toUpperCase() === "SUMMARY");
  const cash = records(parsed, "CashTransaction");
  const accruals = records(parsed, "ChangeInDividendAccrual");
  const corp = records(parsed, "CorporateAction");
  const securities = records(parsed, "SecurityInfo");

  console.log("\n=== IBKR Activity Flex — report overview ===");
  for (const s of statements)
    line(
      `statement ${a(s, "accountId") ?? "?"}`,
      `${a(s, "fromDate") ?? "?"} → ${a(s, "toDate") ?? "?"} (${a(s, "period") ?? "custom"})`,
    );
  line("accounts", String(accounts.length));
  line("Trade (executions)", String(trades.length));
  line("OpenPosition LOT / SUMMARY", `${lots.length} / ${summaries.length}`);
  line("CashTransaction", String(cash.length));
  line("ChangeInDividendAccrual", String(accruals.length));
  line("CorporateAction", String(corp.length));
  line("SecurityInfo (instruments)", String(securities.length));
  if (!statements.length)
    console.log("\n  ⚠ No FlexStatement found — is this the report XML, or an error envelope?");

  console.log("\n=== POC proof checks (issue #135 §3) ===");

  // 1. Every BUY/SELL execution has a usable ibExecID and tradeID.
  const fills = trades.filter((t) => {
    const bs = a(t, "buySell")?.toUpperCase();
    return bs === "BUY" || bs === "SELL";
  });
  const noExec = fills.filter((t) => !a(t, "ibExecID")).length;
  const noTrade = fills.filter((t) => !a(t, "tradeID")).length;
  console.log(
    `[1] ${verdict(fills.length > 0 && noExec === 0 && noTrade === 0, fills.length === 0)} ` +
      `execution identity — ${fills.length} BUY/SELL fills; missing ibExecID=${noExec}, missing tradeID=${noTrade}`,
  );

  // 2. Multiple fills of one order stay separate executions.
  const byOrder = new Map<string, Attrs[]>();
  for (const t of fills) {
    const order = a(t, "ibOrderID") ?? "(none)";
    byOrder.set(order, [...(byOrder.get(order) ?? []), t]);
  }
  const multi = [...byOrder.entries()].filter(([order, ts]) => order !== "(none)" && ts.length > 1);
  const collapsedExec = multi.some(
    ([, ts]) => new Set(ts.map((t) => a(t, "ibExecID"))).size !== ts.length,
  );
  console.log(
    `[2] ${verdict(!collapsedExec, multi.length === 0)} ` +
      `multi-fill orders — ${multi.length} order(s) with >1 fill; ` +
      `${collapsedExec ? "a fill shares an ibExecID (BAD)" : "each fill keeps a distinct ibExecID"}`,
  );

  // 3. Lot rows carry openDateTime, costBasisMoney, and an originating id (or a documented fallback).
  const lotsNoOpen = lots.filter((l) => !a(l, "openDateTime")).length;
  const lotsNoCost = lots.filter((l) => !a(l, "costBasisMoney")).length;
  const lotsNoTxn = lots.filter((l) => !a(l, "originatingTransactionID")).length;
  console.log(
    `[3] ${verdict(lots.length > 0 && lotsNoOpen === 0 && lotsNoCost === 0, lots.length === 0)} ` +
      `open lots — ${lots.length} LOT rows; missing openDateTime=${lotsNoOpen}, ` +
      `missing costBasisMoney=${lotsNoCost}; ${lotsNoTxn} need the fingerprint fallback (no originatingTransactionID)`,
  );

  // 4. A dividend links between the accrual and the booked cash.
  const cashDivs = cash.filter((c) => /dividend/i.test(a(c, "type") ?? ""));
  const accrualKeys = new Set(
    accruals.map((r) =>
      [a(r, "accountId"), a(r, "conid"), a(r, "currency"), dateOf(a(r, "payDate"))].join("|"),
    ),
  );
  const linked = cashDivs.filter((c) =>
    accrualKeys.has(
      [a(c, "accountId"), a(c, "conid"), a(c, "currency"), dateOf(a(c, "dateTime"))].join("|"),
    ),
  ).length;
  console.log(
    `[4] ${verdict(linked > 0, cashDivs.length === 0 || accruals.length === 0)} ` +
      `dividend accrual↔cash — ${cashDivs.length} cash dividend rows, ${accruals.length} accruals; ` +
      `${linked} linked on accountId+conid+currency+payDate`,
  );

  // 5. Withholding tax is not double-counted (surface both sources — do not sum them).
  const cashWht = cash.filter((c) => /withholding/i.test(a(c, "type") ?? ""));
  console.log(
    `[5] ${verdict(true, cashWht.length === 0)} withholding — ` +
      `booked cash withholding rows=${cashWht.length} (sum ${sum(cashWht, "amount").toString()}); ` +
      `accrual tax total=${sum(accruals, "tax").toString()}. Recognize ONE source, never both.`,
  );

  // 6. A reinvested dividend shows as dividend evidence AND a share acquisition.
  const reinvestBuys = fills.filter(
    (t) =>
      a(t, "buySell")?.toUpperCase() === "BUY" &&
      /(^|;)Re(;|$)|reinvest/i.test(a(t, "notes") ?? a(t, "code") ?? ""),
  );
  console.log(
    `[6] ${verdict(true, true)} reinvestment (manual) — ` +
      `${reinvestBuys.length} BUY rows flagged with a reinvestment code; ` +
      `confirm each pairs with a dividend row above`,
  );

  // 7. Splits appear under CorporateAction with quantity to update lots.
  const splits = corp.filter((c) =>
    ["FS", "RS", "SD"].includes((a(c, "type") ?? a(c, "code") ?? "").toUpperCase()),
  );
  const splitsNoQty = splits.filter((c) => !a(c, "quantity")).length;
  console.log(
    `[7] ${verdict(splitsNoQty === 0, splits.length === 0)} ` +
      `splits — ${splits.length} FS/RS/SD corporate actions; missing quantity=${splitsNoQty} ` +
      `(${corp.length - splits.length} other corp actions → UNSUPPORTED)`,
  );

  // 8. Replaying the same XML yields no duplicate evidence keys.
  const dupTrades = duplicates(fills.map(tradeKey));
  const dupLots = duplicates(lots.map(lotKey));
  const dupCash = duplicates(cash.map(cashKey));
  const dupCorp = duplicates(corp.map((c) => `${a(c, "accountId")}:corp:${a(c, "transactionID")}`));
  const totalDup = dupTrades + dupLots + dupCash + dupCorp;
  console.log(
    `[8] ${verdict(totalDup === 0)} idempotency — duplicate keys: ` +
      `trades=${dupTrades} lots=${dupLots} cash=${dupCash} corp=${dupCorp}. ` +
      `Identical keys on replay ⇒ upsert is stable (no duplicate rows).`,
  );

  // 9. Activity-derived remaining quantity reconciles against the snapshot position.
  const lotQty = new Map<string, Decimal>();
  for (const l of lots) {
    const key = `${a(l, "accountId")}:${a(l, "conid")}`;
    lotQty.set(key, (lotQty.get(key) ?? new Decimal(0)).plus(new Decimal(a(l, "position") ?? "0")));
  }
  let reconciled = 0;
  const mismatches: string[] = [];
  const summaryKeys = new Set<string>();
  for (const s of summaries) {
    const key = `${a(s, "accountId")}:${a(s, "conid")}`;
    summaryKeys.add(key);
    const snapshot = new Decimal(a(s, "position") ?? "0");
    const derived = lotQty.get(key);
    if (derived === undefined) {
      mismatches.push(`${a(s, "symbol") ?? key}: lots=missing vs snapshot=${snapshot.toString()}`);
      continue;
    }
    if (derived.equals(snapshot)) reconciled += 1;
    else
      mismatches.push(
        `${a(s, "symbol") ?? key}: lots=${derived.toString()} vs snapshot=${snapshot.toString()}`,
      );
  }
  for (const [key, derived] of lotQty) {
    if (!summaryKeys.has(key))
      mismatches.push(`${key}: lots=${derived.toString()} vs snapshot=missing`);
  }
  console.log(
    `[9] ${verdict(mismatches.length === 0, summaries.length === 0 && lots.length === 0)} ` +
      `lot↔snapshot reconciliation — ${reconciled} positions match; ${mismatches.length} mismatch`,
  );
  for (const m of mismatches.slice(0, 10)) console.log(`      ${m}`);
  console.log("");
}

// ----------------------------------------------------------------------------- main

async function main(): Promise<void> {
  const file = flag("file");
  let xml: string;
  if (file) {
    xml = readFileSync(file, "utf8");
  } else {
    const queryId = flag("query") ?? process.env.IBKR_QUERY_ID;
    if (!queryId) {
      console.error(
        "Provide the stored query id and pipe the Flex token on stdin:\n" +
          "  secret-provider | IBKR_QUERY_ID=1588880 npx tsx scripts/poc-ibkr-flex-activity.mts\n" +
          "  (or --query 1588880, or --file report.xml to analyze a saved report)",
      );
      process.exitCode = 1;
      return;
    }
    const token = readTokenFromStdin();
    xml = await fetchFlexXml(token, queryId);
  }
  analyze(xml);
}

main().catch((error: unknown) => {
  console.error(`POC failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
