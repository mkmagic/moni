#!/usr/bin/env node
// PROTOTYPE — throwaway live IBKR Flex evidence collector for issue #39.
//
// It does not write files or use Moni's database. The Flex token and query ID
// are read interactively so they do not enter shell history, argv, or the
// environment. Each report stays in RAM and only record counts, field names,
// and contract results are rendered.
import {
  analyzeFlexReport,
  initialProbeState,
  isRetryableReportCode,
  parseControlResponse,
  transition,
  type ProbeState,
  type ReportInventory,
} from "./model";

const FLEX_ORIGIN = "https://ndcdyn.interactivebrokers.com";
const FLEX_BASE_PATH = "/AccountManagement/FlexWebService";
const USER_AGENT = "Moni-IBKR-Flex-POC/0.1";
const INITIAL_REPORT_WAIT_MS = 20_000;
const RETRY_WAIT_MS = 5_000;
const MAX_REPORT_ATTEMPTS = 5;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 50 * 1024 * 1024;

const bold = "\x1b[1m";
const dim = "\x1b[2m";
const reset = "\x1b[0m";

class SafeProbeError extends Error {
  constructor(readonly safeCode: string) {
    super(safeCode);
  }
}

function clearFrame(): void {
  if (process.stdout.isTTY) process.stdout.write("\x1b[2J\x1b[H");
}

function renderState(state: ProbeState): void {
  clearFrame();
  console.log(`${bold}IBKR Flex POC — issue #39${reset}`);
  console.log(
    `${dim}Can one real Activity Flex Query satisfy Moni's complete snapshot contract without persisting or printing secrets/data?${reset}\n`,
  );
  console.log(`${bold}phase${reset}: ${state.phase}`);
  console.log(`${bold}SendRequest${reset}: ${state.sendRequest}`);
  console.log(`${bold}reference code${reset}: ${state.referenceCode}`);
  console.log(`${bold}GetStatement attempts${reset}: ${state.retrieveAttempts}`);

  if (state.failureCode) {
    console.log(`${bold}safe failure code${reset}: ${state.failureCode}`);
  }

  if (state.inventory) renderInventory(state.inventory);
}

function renderInventory(inventory: ReportInventory): void {
  console.log(`\n${bold}Redacted report inventory${reset}`);
  console.log(`root tag: ${inventory.rootTag}`);
  console.log(`bytes held in RAM: ${inventory.reportBytes}`);

  for (const [tag, count] of Object.entries(inventory.recordCounts)) {
    const fields = inventory.fieldNames[tag];
    console.log(`${tag}: ${count}`);
    console.log(`  fields: ${fields.length > 0 ? fields.join(", ") : "(none observed)"}`);
  }

  console.log(`\n${bold}Source-contract evidence${reset}`);
  for (const result of inventory.checks) {
    const marker = result.status === "proven" ? "✓" : "?";
    console.log(`${marker} ${result.status.padEnd(8)} ${result.name} — ${result.evidence}`);
  }

  const complete = inventory.checks.every((result) => result.status === "proven");
  console.log(
    `\n${bold}verdict${reset}: ${
      complete
        ? "field contract proven for this account/query sample"
        : "field contract remains unproven; adjust the Flex Query or source contract"
    }`,
  );
  console.log(
    `${dim}No token, query ID, reference code, URL, field value, or raw response was printed or persisted.${reset}`,
  );
  console.log(
    `${dim}Residual: IBKR mandates the token in a URL query string, creating an unwipeable JS string inside this short-lived process.${reset}`,
  );
}

function printHelp(): void {
  console.log(`IBKR Flex POC

Question:
  Can one real Activity Flex Query satisfy Moni's complete investment snapshot
  contract without persisting or printing the token or portfolio payload?

IBKR setup:
  1. In Client Portal → Performance & Reports → Flex Queries, create an
     Activity Flex Query with XML output.
  2. Include only the 1.1 contract fields:
     - Account Information: Account ID, alias, type, and base currency.
     - Open Positions: account identity; durable security identifiers; kind,
       symbol/description, listing exchange, and multiplier; currency,
       quantity, mark price, position value, and report date.
     - Cash Report: account identity, currency, ending cash, and report dates.
     - NAV Summary In Base: account identity, report date, and total.
  3. Enable Flex Web Service, use the shortest practical token lifetime
     (six hours for the POC), and restrict it to this host's public egress IP
     when stable.
  4. Copy the numeric Current Token and Query ID.

Run:
  npm run poc:ibkr-flex

The terminal prompts for both values without putting them in argv, shell
history, or environment variables. The process keeps the report in RAM and
prints only field names, row counts, and contract results.`);
}

async function readOneKey(): Promise<number> {
  if (!process.stdin.isTTY) throw new SafeProbeError("interactive_tty_required");

  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();

    const cleanup = (): void => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
    };

    const onData = (chunk: Buffer): void => {
      const value = chunk[0];
      chunk.fill(0);
      cleanup();
      if (value === 0x03) reject(new SafeProbeError("cancelled"));
      else resolve(value);
    };

    stdin.on("data", onData);
  });
}

async function readHiddenDigits(label: string, maxLength: number): Promise<Buffer> {
  if (!process.stdin.isTTY) throw new SafeProbeError("interactive_tty_required");

  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const secret = Buffer.alloc(maxLength);
    let length = 0;
    process.stdout.write(`${label}: `);
    stdin.setRawMode(true);
    stdin.resume();

    const cleanup = (): void => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
    };

    const fail = (code: string): void => {
      secret.fill(0);
      cleanup();
      process.stdout.write("\n");
      reject(new SafeProbeError(code));
    };

    const finish = (): void => {
      if (length === 0) {
        fail("empty_input");
        return;
      }
      const result = Buffer.from(secret.subarray(0, length));
      secret.fill(0);
      cleanup();
      process.stdout.write("\n");
      resolve(result);
    };

    const onData = (chunk: Buffer): void => {
      for (const byte of chunk) {
        if (byte === 0x03) {
          chunk.fill(0);
          fail("cancelled");
          return;
        }
        if (byte === 0x0d || byte === 0x0a) {
          chunk.fill(0);
          finish();
          return;
        }
        if (byte === 0x7f || byte === 0x08) {
          if (length > 0) {
            length -= 1;
            secret[length] = 0;
            process.stdout.write("\b \b");
          }
          continue;
        }
        if (byte < 0x30 || byte > 0x39) {
          process.stdout.write("\x07");
          continue;
        }
        if (length >= maxLength) {
          chunk.fill(0);
          fail("input_too_long");
          return;
        }
        secret[length] = byte;
        length += 1;
        process.stdout.write("*");
      }
      chunk.fill(0);
    };

    stdin.on("data", onData);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestFlex(
  endpoint: "SendRequest" | "GetStatement",
  token: Buffer,
  query: Buffer,
): Promise<Buffer> {
  let tokenText = token.toString("ascii");
  let queryText = query.toString("ascii");
  let requestUrl = `${FLEX_ORIGIN}${FLEX_BASE_PATH}/${endpoint}?t=${tokenText}&q=${queryText}&v=3`;

  try {
    const response = await fetch(requestUrl, {
      headers: {
        Accept: "application/xml, text/xml, text/plain",
        "User-Agent": USER_AGENT,
      },
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).catch(() => {
      throw new SafeProbeError("network_request_failed");
    });

    if (!response.ok) {
      throw new SafeProbeError(`http_${response.status}`);
    }

    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
      throw new SafeProbeError("response_too_large");
    }

    const body = Buffer.from(await response.arrayBuffer());
    if (body.byteLength > MAX_RESPONSE_BYTES) {
      body.fill(0);
      throw new SafeProbeError("response_too_large");
    }
    return body;
  } finally {
    // Dropping references cannot wipe immutable JS strings. Process teardown
    // is the boundary for the provider-imposed query-string residual.
    tokenText = "";
    queryText = "";
    requestUrl = "";
  }
}

function decodeXml(body: Buffer): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(body);
}

async function runLiveProbe(
  token: Buffer,
  queryId: Buffer,
  update: (state: ProbeState) => void,
): Promise<ProbeState> {
  let state = transition(initialProbeState, { type: "start" });
  update(state);

  const sendBody = await requestFlex("SendRequest", token, queryId);
  let referenceCode: Buffer | undefined;

  try {
    const control = parseControlResponse(decodeXml(sendBody));
    if (control.status === "failure") {
      throw new SafeProbeError(`send_flex_${control.errorCode ?? "unknown"}`);
    }
    if (control.status !== "success" || !control.referenceCode) {
      throw new SafeProbeError("send_unexpected_response");
    }
    if (!/^\d+$/.test(control.referenceCode)) {
      throw new SafeProbeError("send_invalid_reference_code");
    }
    referenceCode = Buffer.from(control.referenceCode, "ascii");
  } finally {
    sendBody.fill(0);
  }

  state = transition(state, { type: "reference_received" });
  update(state);
  await delay(INITIAL_REPORT_WAIT_MS);

  try {
    for (let attempt = 1; attempt <= MAX_REPORT_ATTEMPTS; attempt += 1) {
      state = transition(state, { type: "retrieve_attempt" });
      update(state);

      const reportBody = await requestFlex("GetStatement", token, referenceCode);
      try {
        const reportXml = decodeXml(reportBody);
        const control = parseControlResponse(reportXml);
        if (control.status === "failure") {
          if (isRetryableReportCode(control.errorCode) && attempt < MAX_REPORT_ATTEMPTS) {
            state = transition(state, { type: "waiting" });
            update(state);
            await delay(RETRY_WAIT_MS);
            continue;
          }
          throw new SafeProbeError(`retrieve_flex_${control.errorCode ?? "unknown"}`);
        }

        state = transition(state, { type: "analyzing" });
        update(state);
        const inventory = analyzeFlexReport(reportXml, reportBody.byteLength);
        state = transition(state, { type: "complete", inventory });
        update(state);
        return state;
      } finally {
        reportBody.fill(0);
      }
    }
  } finally {
    referenceCode.fill(0);
  }

  throw new SafeProbeError("retrieve_attempts_exhausted");
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printHelp();
    return;
  }

  renderState(initialProbeState);
  console.log(`\n${bold}[r]${reset} run live probe    ${bold}[q]${reset} quit`);
  const key = await readOneKey();
  if (key === 0x71 || key === 0x51) return;
  if (key !== 0x72 && key !== 0x52) throw new SafeProbeError("unknown_action");

  clearFrame();
  console.log(`${bold}Credentials remain in this process only and are wiped on exit.${reset}\n`);
  const token = await readHiddenDigits("Current Token", 256);
  let queryId: Buffer | undefined;

  try {
    queryId = await readHiddenDigits("Query ID", 32);
    await runLiveProbe(token, queryId, renderState);
  } finally {
    token.fill(0);
    queryId?.fill(0);
  }
}

main().catch((error: unknown) => {
  const safeCode = error instanceof SafeProbeError ? error.safeCode : "unexpected_internal_failure";
  const failed = transition(initialProbeState, { type: "failed", code: safeCode });
  renderState(failed);
  process.exitCode = 1;
});
