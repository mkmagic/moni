// Bank sync orchestration (issue #92, C1). The Israeli bank scrape is split
// into two disposable children the parent spawns and supervises:
//
//   FETCHER (scripts/scrape-worker.mts) — Chrome + israeli-bank-scrapers + the
//     connection's plaintext credentials. Decrypts its OWN credentials from
//     [CK, ciphertext]; it holds NO data key, NO database handle, and runs with
//     a stripped environment (no DATABASE_URL/secrets). Its stderr is IGNORED,
//     never inherited: Puppeteer protocol output can contain the typed
//     password, so failures surface only as an allowlisted code on stdout.
//
//   PROMOTER (scripts/promote-worker.mts) — trusted domain code only, no
//     network and no scraper dependencies. Receives [DK, accounts] and writes
//     the ledger. It is the only side that ever holds the DK or touches the DB.
//
// Credentials and the DK therefore live in SEPARATE processes, and the
// credential-bearing one has no route to the database — so a compromised
// scraper dependency cannot read the DB, obtain the DK, or (holding only this
// connection's ciphertext) decrypt any other connection. This is fire-and-
// forget: the route returns 202 immediately and the UI polls `sync_runs`.
import { spawn } from "node:child_process";
import { markSyncRunFailed } from "@/domain/sync-promotion";
import { encodeBinaryChildFrame, MAX_CHILD_SEGMENT_BYTES } from "@/lib/connectors";
import { workerRuntimePath } from "@/lib/worker-runtime";

const WORKER_TIMEOUT_MS = 5 * 60 * 1000;
const KILL_GRACE_MS = 5_000;

/** The only failure codes a fetcher may report; anything else collapses to a
 * generic code so raw provider text can never reach the parent or the DB. */
const FETCHER_FAILURE_CODES = new Set([
  "invalid_credentials",
  "login_failed",
  "scrape_failed",
  "worker_error",
]);

/** The fetcher runs Chrome + untrusted scraper deps, so it gets only the
 * variables Chromium needs — never DATABASE_URL, the signup token, or any
 * market-data/model secret in the parent's environment. */
function fetcherEnv(): NodeJS.ProcessEnv {
  const allow = [
    "PATH",
    "HOME",
    "TZ",
    "LANG",
    "NODE_ENV",
    "MONI_CHROME_PATH",
    "MONI_SCRAPE_SHOW_BROWSER",
    "MONI_SCRAPE_FAILURE_SCREENSHOT",
  ];
  const env: Record<string, string> = {};
  for (const key of allow) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env as NodeJS.ProcessEnv;
}

function readFailureCode(stdout: Buffer): string {
  try {
    const line = stdout.toString("utf8").trim().split("\n").pop() ?? "";
    const parsed = JSON.parse(line) as { code?: unknown };
    if (typeof parsed.code === "string" && FETCHER_FAILURE_CODES.has(parsed.code))
      return parsed.code;
  } catch {
    // fall through to the generic code
  }
  return "scrape_worker_failed";
}

/** Records a run failure without letting a rejected DB write become an
 * unhandled rejection in the long-lived server. */
function recordFailed(userId: string, syncRunId: string, code: string): void {
  void markSyncRunFailed(userId, syncRunId, code).catch(() => undefined);
}

function withTimeout(child: ReturnType<typeof spawn>): () => void {
  let kill: NodeJS.Timeout | undefined;
  const term = setTimeout(() => {
    child.kill("SIGTERM");
    kill = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
  }, WORKER_TIMEOUT_MS);
  return () => {
    clearTimeout(term);
    if (kill) clearTimeout(kill);
  };
}

export interface StartBankSyncInput {
  /** A parent-owned COPY of the credential key; wiped once framed. */
  credentialKey: Buffer;
  /** The connection's `credentials_ct`; wiped once framed. */
  ciphertext: Buffer;
  /** A parent-owned COPY of the data key; held until the promoter is spawned. */
  dataKey: Buffer;
  userId: string;
  connectionId: string;
  connectorId: string;
  syncRunId: string;
  startDate: string;
  version: number;
}

/**
 * Spawns the fetcher, then (on a clean fetch) the promoter. Returns as soon as
 * the fetcher is launched; the promotion happens in the fetcher's `close`
 * handler. Any failure path records the run `failed` and wipes the DK.
 */
export function startBankSync(input: StartBankSyncInput): void {
  const fail = (code: string) => recordFailed(input.userId, input.syncRunId, code);

  let fetcher: ReturnType<typeof spawn>;
  const inFrame = encodeBinaryChildFrame(
    {
      connectionId: input.connectionId,
      connectorId: input.connectorId,
      startDate: input.startDate,
      version: String(input.version),
    },
    [input.credentialKey, input.ciphertext],
  );
  // The frame owns copies now; clear the parent's CK/ct copies immediately.
  input.credentialKey.fill(0);
  input.ciphertext.fill(0);

  try {
    fetcher = spawn(
      workerRuntimePath("node_modules", ".bin", "tsx"),
      [workerRuntimePath("scripts", "scrape-worker.mts")],
      { stdio: ["pipe", "pipe", "ignore"], env: fetcherEnv() },
    );
  } catch {
    inFrame.fill(0);
    input.dataKey.fill(0);
    fail("scrape_worker_start_failed");
    return;
  }
  fetcher.stdin?.write(inFrame, () => inFrame.fill(0));
  fetcher.stdin?.end();
  fetcher.once("error", () => inFrame.fill(0));

  let stdout = Buffer.alloc(0);
  let truncated = false;
  fetcher.stdout?.on("data", (chunk: Buffer) => {
    if (truncated) return;
    if (stdout.length + chunk.length > MAX_CHILD_SEGMENT_BYTES) {
      truncated = true;
      return;
    }
    stdout = Buffer.concat([stdout, chunk]);
  });

  const clearFetcherTimeout = withTimeout(fetcher);
  let settled = false;
  const onFetcherDone = (ok: boolean) => {
    if (settled) return;
    settled = true;
    clearFetcherTimeout();
    if (ok && !truncated) {
      startPromoter(input, stdout);
    } else {
      input.dataKey.fill(0);
      fail(truncated ? "worker_output_too_large" : readFailureCode(stdout));
    }
    stdout = Buffer.alloc(0);
  };
  fetcher.once("close", (code, signal) => onFetcherDone(code === 0 && !signal));
  fetcher.once("error", () => onFetcherDone(false));
}

/** Hands the fetcher's validated-downstream output plus the DK to the trusted
 * promoter. The promoter re-validates the accounts as hostile input. */
function startPromoter(input: StartBankSyncInput, accounts: Buffer): void {
  let promoter: ReturnType<typeof spawn>;
  const frame = encodeBinaryChildFrame(
    {
      userId: input.userId,
      connectionId: input.connectionId,
      connectorId: input.connectorId,
      syncRunId: input.syncRunId,
    },
    [input.dataKey, accounts],
  );
  // The frame owns copies now; clear the DK and the Tier-1 payload.
  input.dataKey.fill(0);
  accounts.fill(0);

  try {
    promoter = spawn(
      workerRuntimePath("node_modules", ".bin", "tsx"),
      [workerRuntimePath("scripts", "promote-worker.mts")],
      { stdio: ["pipe", "ignore", "ignore"] },
    );
  } catch {
    frame.fill(0);
    recordFailed(input.userId, input.syncRunId, "promote_worker_start_failed");
    return;
  }
  promoter.stdin?.write(frame, () => frame.fill(0));
  promoter.stdin?.end();
  promoter.once("error", () => frame.fill(0));

  const clearPromoterTimeout = withTimeout(promoter);
  const finish = (failed: boolean) => {
    clearPromoterTimeout();
    // The promoter marks its own failures; this is the guarded safety net for a
    // kill/crash before it could (markSyncRunFailed no-ops a resolved run).
    if (failed) recordFailed(input.userId, input.syncRunId, "promote_worker_failed");
  };
  promoter.once("close", (code, signal) => finish(code !== 0 || Boolean(signal)));
  promoter.once("error", () => finish(true));
}
