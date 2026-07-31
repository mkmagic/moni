#!/usr/bin/env node
// PROTOTYPE — throwaway live Tiingo EOD evidence collector for #38/#40.
//
// It writes nothing and does not use Moni's database. The API token is read
// interactively so it does not enter argv, shell history, or the environment.
// The supported-ticker inventory and quote CSVs remain in RAM. Final output
// contains only structural counts, dates, ages, and contract results.
import {
  analyzeTiingoEvidence,
  extractSupportedTickerCsv,
  type QuoteEvidence,
  type QuoteInventory,
  type SymbolSpec,
} from "./model";

const TIINGO_API_ORIGIN = "https://api.tiingo.com";
const TIINGO_MEDIA_ORIGIN = "https://apimedia.tiingo.com";
const COVERAGE_PATH = "/docs/tiingo/daily/supported_tickers.zip";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_COVERAGE_ZIP_BYTES = 5 * 1024 * 1024;
const MAX_QUOTE_BYTES = 128 * 1024;
const MAX_TOKEN_BYTES = 256;

const SYMBOLS: readonly SymbolSpec[] = [
  { ticker: "VTI", assetType: "ETF", priceCurrency: "USD" },
  { ticker: "VXUS", assetType: "ETF", priceCurrency: "USD" },
  { ticker: "AAPL", assetType: "Stock", priceCurrency: "USD" },
];

const bold = "\x1b[1m";
const dim = "\x1b[2m";
const reset = "\x1b[0m";

class SafeProbeError extends Error {
  constructor(readonly safeCode: string) {
    super(safeCode);
  }
}

type Phase = "ready" | "coverage" | "quotes" | "analyzing" | "complete" | "failed";

interface ProbeState {
  phase: Phase;
  coverage: "pending" | "received" | "failed";
  quoteResponses: number;
  failureCode?: string;
  inventory?: QuoteInventory;
}

function clearFrame(): void {
  if (process.stdout.isTTY) process.stdout.write("\x1b[2J\x1b[H");
}

function renderState(state: ProbeState): void {
  clearFrame();
  console.log(`${bold}Tiingo EOD POC — #38/#40${reset}`);
  console.log(
    `${dim}Can one daily valuation refresh obtain exact, source-dated closes for the ETF/major-stock test scope?${reset}\n`,
  );
  console.log(`${bold}phase${reset}: ${state.phase}`);
  console.log(`${bold}coverage inventory${reset}: ${state.coverage}`);
  console.log(`${bold}quote responses${reset}: ${state.quoteResponses} of ${SYMBOLS.length}`);

  if (state.failureCode) console.log(`${bold}safe failure code${reset}: ${state.failureCode}`);
  if (state.inventory) renderInventory(state.inventory);
}

function renderInventory(inventory: QuoteInventory): void {
  console.log(`\n${bold}Redacted quote inventory${reset}`);
  console.log(`requested symbols: ${inventory.symbolsRequested}`);
  console.log(`covered symbols: ${inventory.symbolsCovered}`);
  console.log(`latest quote rows: ${inventory.quoteRows}`);
  console.log(`newest quote date: ${inventory.newestQuoteDate ?? "absent"}`);
  console.log(`oldest quote age: ${inventory.oldestQuoteAgeDays ?? "unknown"} calendar day(s)`);

  console.log(`\n${bold}Source-contract evidence${reset}`);
  for (const result of inventory.checks) {
    const marker = result.status === "proven" ? "✓" : "?";
    console.log(`${marker} ${result.status.padEnd(8)} ${result.name} — ${result.evidence}`);
  }

  const complete = inventory.checks.every((result) => result.status === "proven");
  console.log(
    `\n${bold}verdict${reset}: ${
      complete
        ? "EOD quote contract proven for the VTI/VXUS ETF and AAPL stock sample"
        : "EOD quote contract remains unproven for this sample"
    }`,
  );
  console.log(
    `${dim}No token, URL, name, exchange, price, holding quantity, or raw provider response was printed or persisted.${reset}`,
  );
  console.log(
    `${dim}Residual: the HTTP client converts the token-bearing Authorization header to an immutable JS string inside this short-lived process.${reset}`,
  );
}

function printHelp(): void {
  console.log(`Tiingo EOD POC

Question:
  Can a user-triggered daily refresh classify VTI/VXUS as active USD ETFs and
  AAPL as an active USD stock, then obtain fresh closing prices as exact
  decimal text?

Setup:
  1. Create a personal Tiingo account: https://www.tiingo.com/account/signup
  2. Copy the API token from: https://api.tiingo.com/account/token
  3. Run: npm run poc:tiingo-eod

The terminal prompts for the token without putting it in argv, shell history,
or the environment. The probe downloads Tiingo's public coverage inventory and
makes one bounded EOD quote request per test symbol. Nothing is persisted.`);
}

async function readHiddenAscii(label: string): Promise<Buffer> {
  if (!process.stdin.isTTY) throw new SafeProbeError("interactive_tty_required");

  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const secret = Buffer.alloc(MAX_TOKEN_BYTES);
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
        if (byte < 0x21 || byte > 0x7e) {
          process.stdout.write("\x07");
          continue;
        }
        if (length >= MAX_TOKEN_BYTES) {
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

async function readBoundedBody(response: Response, maxBytes: number): Promise<Buffer> {
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new SafeProbeError("response_too_large");
  }

  const body = Buffer.from(await response.arrayBuffer());
  if (body.byteLength > maxBytes) {
    body.fill(0);
    throw new SafeProbeError("response_too_large");
  }
  return body;
}

async function fetchCoverage(): Promise<Buffer> {
  const response = await fetch(`${TIINGO_MEDIA_ORIGIN}${COVERAGE_PATH}`, {
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch(() => {
    throw new SafeProbeError("coverage_request_failed");
  });
  if (!response.ok) throw new SafeProbeError(`coverage_http_${response.status}`);
  return readBoundedBody(response, MAX_COVERAGE_ZIP_BYTES);
}

async function fetchLatestQuote(spec: SymbolSpec, token: Buffer): Promise<Buffer> {
  let tokenText = token.toString("ascii");
  let authorization = `Token ${tokenText}`;
  try {
    const response = await fetch(
      `${TIINGO_API_ORIGIN}/tiingo/daily/${encodeURIComponent(spec.ticker)}/prices?format=csv`,
      {
        headers: {
          Accept: "text/csv",
          Authorization: authorization,
        },
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    ).catch(() => {
      throw new SafeProbeError("quote_request_failed");
    });
    if (!response.ok) throw new SafeProbeError(`quote_http_${response.status}`);
    return readBoundedBody(response, MAX_QUOTE_BYTES);
  } finally {
    tokenText = "";
    authorization = "";
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printHelp();
    return;
  }
  if (process.argv.length > 2) throw new SafeProbeError("unexpected_arguments");

  const state: ProbeState = {
    phase: "ready",
    coverage: "pending",
    quoteResponses: 0,
  };
  renderState(state);

  let token: Buffer | undefined;
  let coverageZip: Buffer | undefined;
  let coverageCsv = "";
  const quoteBodies: Buffer[] = [];
  try {
    state.phase = "coverage";
    renderState(state);
    coverageZip = await fetchCoverage();
    coverageCsv = extractSupportedTickerCsv(coverageZip);
    coverageZip.fill(0);
    coverageZip = undefined;
    state.coverage = "received";
    renderState(state);

    token = await readHiddenAscii("Tiingo API token");
    state.phase = "quotes";
    renderState(state);

    const evidence: QuoteEvidence[] = [];
    for (const spec of SYMBOLS) {
      const body = await fetchLatestQuote(spec, token);
      quoteBodies.push(body);
      evidence.push({
        spec,
        csv: new TextDecoder("utf-8", { fatal: true }).decode(body),
      });
      state.quoteResponses += 1;
      renderState(state);
    }

    state.phase = "analyzing";
    renderState(state);
    state.inventory = analyzeTiingoEvidence(coverageCsv, evidence);
    state.phase = "complete";
    renderState(state);

    if (state.inventory.checks.some((result) => result.status !== "proven")) {
      process.exitCode = 1;
    }
  } catch (error) {
    state.phase = "failed";
    state.failureCode = error instanceof SafeProbeError ? error.safeCode : "unexpected_failure";
    if (state.coverage === "pending") state.coverage = "failed";
    renderState(state);
    process.exitCode = 1;
  } finally {
    token?.fill(0);
    coverageZip?.fill(0);
    coverageCsv = "";
    for (const body of quoteBodies) body.fill(0);
  }
}

await main();
