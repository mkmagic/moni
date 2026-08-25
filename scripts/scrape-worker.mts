// scrape-worker.mts — the FETCHER half of a bank sync (issue #92). A
// short-lived child that talks to the bank and returns normalized records; it
// has NO data key and NO database. The parent (the sync route, or
// scripts/scrape-test.ts for the manual real-bank gate) hands it, over the
// length-prefixed binary frame in src/lib/connectors/child-stdin-framing.ts,
// exactly two raw segments — the credential key (CK) and this connection's
// `credentials_ct` — plus non-secret metadata. This process decrypts its OWN
// credentials here (never the parent), scrapes, and writes the normalized
// `ScraperAccount[]` to stdout for the trusted promoter to persist.
//
// It deliberately does NOT load dotenv and runs with a stripped environment:
// no DATABASE_URL, no app secrets. Its stderr is ignored by the parent, so a
// failure is reported only as an allowlisted code on stdout — never raw
// provider/Puppeteer output, which can contain the typed password.
//
// Runs via `tsx` in dev AND production — nothing imports this file, so
// `next build` never bundles it.
import { createScraper, CompanyTypes, type ScraperCredentials } from "israeli-bank-scrapers";
import {
  decodeBinaryChildFrame,
  decryptWorkerCredentials,
  isConnectorId,
  readChildStdin,
  scraperScrapingResultSchema,
  type ConnectorId,
} from "@/lib/connectors";
import { wipe } from "@/lib/crypto";

/**
 * Per-page-operation timeout, raised from Puppeteer's 30_000 default — a real
 * Leumi login exceeded it three times on 2026-07-26 without ever reaching the
 * credential form. MUST be `defaultTimeout`, not the sibling `timeout` option:
 * only `defaultTimeout` reaches `page.setDefaultTimeout()`, which governs
 * `page.goto` (base-scraper-with-browser.js:95 vs :136). This is per operation,
 * not a whole-scrape budget; the real backstop is the parent's 5-minute
 * SIGTERM/SIGKILL, which records the run `failed` either way.
 */
const PAGE_TIMEOUT_MS = 60_000;

interface FetchJob {
  connectionId: string;
  connectorId: ConnectorId;
  startDate: string;
  version: number;
}

/** The one stdout line the parent reads: `{accounts}` on success, `{code}` on
 * failure. Nothing else — no provider message ever reaches this pipe. */
function emit(result: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

/** Maps a scraper error to one of the allowlisted codes, never provider text. */
function failureCode(errorType?: string): string {
  const type = (errorType ?? "").toLowerCase();
  if (type.includes("password") || type.includes("credential")) return "invalid_credentials";
  if (type.includes("login") || type.includes("account")) return "login_failed";
  return "scrape_failed";
}

function parseJob(metadata: Record<string, unknown>): FetchJob {
  const { connectionId, connectorId, startDate, version } = metadata;
  if (
    typeof connectionId !== "string" ||
    typeof connectorId !== "string" ||
    typeof startDate !== "string" ||
    typeof version !== "string" ||
    !isConnectorId(connectorId)
  )
    throw new Error("invalid_frame");
  const parsedVersion = Number(version);
  if (!Number.isInteger(parsedVersion)) throw new Error("invalid_frame");
  return { connectionId, connectorId, startDate, version: parsedVersion };
}

async function main(): Promise<void> {
  const frame = await readChildStdin(process.stdin);
  let segments: Buffer[] = [];
  try {
    const decoded = decodeBinaryChildFrame(frame);
    // decodeBinaryChildFrame copies each segment, so the frame still holds a CK
    // copy — wipe it now, not just in `finally`.
    wipe(frame);
    segments = decoded.segments;
    if (segments.length !== 2) throw new Error("invalid_frame");
    const job = parseJob(decoded.metadata);

    const credentials = decryptWorkerCredentials(segments[0], segments[1], {
      rowId: job.connectionId,
      version: job.version,
    });
    // CK (segments[0]) and ciphertext (segments[1]) are finished with — wipe
    // well before the multi-minute scrape. The decrypted strings are the
    // scraper API's unavoidable residual, confined to this process.
    for (const segment of segments) wipe(segment);
    segments = [];

    const scraper = createScraper({
      companyId: CompanyTypes[job.connectorId],
      startDate: new Date(job.startDate),
      combineInstallments: false,
      showBrowser: process.env.MONI_SCRAPE_SHOW_BROWSER === "true",
      executablePath: process.env.MONI_CHROME_PATH,
      defaultTimeout: PAGE_TIMEOUT_MS,
      storeFailureScreenShotPath: process.env.MONI_SCRAPE_FAILURE_SCREENSHOT,
    });

    const rawResult = await scraper.scrape(credentials as ScraperCredentials);
    // The real untrusted-input boundary #1 (scraper output) — the promoter
    // re-validates as boundary #2 before anything reaches the ledger.
    const parsed = scraperScrapingResultSchema.parse(rawResult);
    if (!parsed.success) {
      emit({ code: failureCode(parsed.errorType) });
      process.exitCode = 1;
      return;
    }
    emit({ accounts: parsed.accounts ?? [] });
    process.exitCode = 0;
  } catch (err) {
    // Never surface provider text: a bad frame is a worker error, anything else
    // is an opaque scrape failure.
    emit({
      code:
        err instanceof Error && err.message === "invalid_frame" ? "worker_error" : "scrape_failed",
    });
    process.exitCode = 1;
  } finally {
    wipe(frame);
    for (const segment of segments) wipe(segment);
  }
}

main().catch(() => {
  // main() handles its own errors and stdout; a throw here means stdin itself
  // failed before any code could be emitted. Stay silent (stderr is ignored).
  process.exitCode = 1;
});
