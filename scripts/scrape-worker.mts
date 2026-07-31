// scrape-worker.mts — the short-lived child process that actually talks to
// the bank (docs plan §C "The child process"). Spawned once per scrape by a
// parent (an API route in a later cluster, or scripts/scrape-test.ts for the
// manual real-bank gate — see that file's header, "driven by task 13, not
// by UI") and exits when the scrape and promotion are done.
//
// Receives the data key (DK) and the rest of its inputs over stdin using the
// length-prefixed binary frame in src/lib/connectors/child-stdin-framing.ts
// — deliberately NOT JSON — so DK stays a raw Buffer end to end and never
// becomes an unwipeable V8 String (threat-model.md §5.5). The parent already
// decrypted `credentials_ct` with the credential key (CK) before spawning;
// this process never sees CK or ciphertext, only the plaintext credential
// strings (the scraper API's own unavoidable-string residual) and DK
// (needed here to encrypt the promoted entries).
//
// Runs via `tsx` in dev AND production (docs plan §C) — nothing imports this
// file, so `next build` never bundles it and there is no separate build step
// to forget.
import "dotenv/config";
import { createScraper, CompanyTypes, type ScraperCredentials } from "israeli-bank-scrapers";
import {
  decodeChildStdinFrame,
  isConnectorId,
  scraperScrapingResultSchema,
  type ChildStdinPayload,
  type ConnectorId,
} from "@/lib/connectors";
import { markSyncRunFailed, promoteScrapeResult } from "@/domain/sync-promotion";
import { wipe } from "@/lib/crypto";
import { redactSecrets } from "@/lib/redact-secrets";

async function readAllStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function printResult(result: Record<string, unknown>): void {
  // The one line of stdout a caller (scrape-test.ts) can reliably parse;
  // anything else (scraper progress, etc.) goes to stderr instead.
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

/**
 * Per-page-operation timeout, raised from Puppeteer's 30_000 default — a
 * real Leumi login exceeded it three times on 2026-07-26 ("GENERIC:
 * Navigation timeout of 30000 ms exceeded") without ever reaching the
 * credential form.
 *
 * MUST be `defaultTimeout`, not the sibling `timeout` option. Despite its
 * doc comment ("Maximum navigation time in milliseconds"), `timeout` is
 * passed straight to `puppeteer.launch()` and only bounds *browser
 * startup*; only `defaultTimeout` reaches `page.setDefaultTimeout()`,
 * which is what governs `page.goto` (base-scraper-with-browser.js:95 vs
 * :136). Setting `timeout` alone changes nothing and the error message
 * still reads 30000 — verified the hard way.
 *
 * This is per operation, not per scrape, so it is NOT a budget for the
 * whole run: a login flow with several slow page loads can still outlast
 * it in aggregate. The real backstop stays the parent's 5-minute
 * SIGTERM/SIGKILL in the sync route, which records the run as `failed`
 * either way.
 *
 * Note `navigationRetryCount` does NOT help here: it only retries on a
 * non-ok HTTP status, and a timeout throws out of `page.goto` before that
 * check is ever reached.
 */
const PAGE_TIMEOUT_MS = 60_000;

async function run(dataKey: Buffer, payload: ChildStdinPayload): Promise<void> {
  if (!isConnectorId(payload.connectorId)) {
    throw new Error(`Unknown connector id "${payload.connectorId}"`);
  }
  const connectorId: ConnectorId = payload.connectorId;

  const scraper = createScraper({
    companyId: CompanyTypes[connectorId],
    startDate: new Date(payload.startDate),
    combineInstallments: false,
    // Headless by default (this runs unattended in production); the manual
    // real-bank gate can flip this on to debug a stuck login
    // (.agents/skills/israeli-scraper/SKILL.md's showBrowser troubleshooting note).
    showBrowser: process.env.MONI_SCRAPE_SHOW_BROWSER === "true",
    executablePath: process.env.MONI_CHROME_PATH,
    defaultTimeout: PAGE_TIMEOUT_MS,
    // Unset in normal operation (the option is then a no-op). Set it to a
    // .png FILE path to have the scraper snapshot the page at the moment of
    // failure — the only way to see which page a headless run actually died
    // on, since the error text names a timeout but never a step.
    storeFailureScreenShotPath: process.env.MONI_SCRAPE_FAILURE_SCREENSHOT,
  });

  const rawResult = await scraper.scrape(payload.credentials as ScraperCredentials);
  // The real untrusted-input boundary (docs/design/conventions.md: "Zod at
  // every trust boundary... scraper output") — nothing past this point is
  // trusted shape without having gone through this parse first.
  const parsed = scraperScrapingResultSchema.parse(rawResult);

  if (!parsed.success) {
    const detail = [parsed.errorType, parsed.errorMessage].filter(Boolean).join(": ");
    throw new Error(
      redactSecrets(
        `Scrape failed${detail ? `: ${detail}` : ""}`,
        Object.values(payload.credentials),
      ),
    );
  }

  const summary = await promoteScrapeResult({
    userId: payload.userId,
    dataKey,
    connectionId: payload.connectionId,
    connectorId,
    syncRunId: payload.syncRunId,
    accounts: parsed.accounts ?? [],
  });

  printResult({ ok: true, syncRunId: payload.syncRunId, summary });
}

async function main(): Promise<void> {
  const frame = await readAllStdin();
  let dataKey: Buffer | undefined;
  let payload: ChildStdinPayload | undefined;

  try {
    ({ dataKey, payload } = decodeChildStdinFrame(frame));
    await run(dataKey, payload);
    process.exitCode = 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const safeMessage = payload
      ? redactSecrets(message, Object.values(payload.credentials))
      : message;
    if (payload) {
      // Deliberately its OWN transaction, separate from whatever run() ->
      // promoteScrapeResult() attempted and already rolled back (docs plan
      // §D: "the failed write happens in a separate transaction from the
      // outer catch").
      await markSyncRunFailed(payload.userId, payload.syncRunId, safeMessage).catch((markErr) => {
        console.error("scrape-worker: failed to record sync_runs failure:", markErr);
      });
      printResult({ ok: false, syncRunId: payload.syncRunId, error: safeMessage });
    } else {
      // Reading/decoding stdin itself failed — no syncRunId to mark failed.
      console.error("scrape-worker: fatal error before a payload could be read:", safeMessage);
    }
    process.exitCode = 1;
  } finally {
    // The child's OWN copies of Tier-0 key material — received fresh over
    // stdin, not borrowed from a live session store — wiped as soon as this
    // short-lived process is done with them (threat-model.md §3/§5.5). Do
    // NOT confuse `dataKey` here with a parent's `session.dataKey`, which
    // must never be wiped by a caller (docs plan §C) — that key belongs to
    // the session store, not to this process.
    if (dataKey) wipe(dataKey);
    wipe(frame);
  }
}

main().catch((err) => {
  console.error("scrape-worker: unexpected top-level failure:", err);
  process.exitCode = 1;
});
