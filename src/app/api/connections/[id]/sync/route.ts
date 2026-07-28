// The core sync route (task 14). Returns 423 Locked when the credential
// window is closed — the client keys off exactly that status to show the
// arm prompt (docs plan §B). Otherwise: decrypt credentials_ct with CK in
// this process, startSyncRun() (parent sets status='running' itself, right
// after spawn — docs plan §C), spawn scripts/scrape-worker.mts via the
// SAME encodeChildStdinFrame scripts/scrape-test.ts already proved against
// a real bank (cluster ②) — reused here, not reinvented — and return the
// syncRunId immediately. The scrape itself is never awaited: the UI polls
// GET /api/sync-runs/[id] instead.
import { spawn } from "node:child_process";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/domain/auth";
import { getConnection, getDecryptedCredentials } from "@/domain/connections";
import { computeSyncStartDate, markSyncRunFailed, startSyncRun } from "@/domain/sync-promotion";
import { getCredentialKey } from "@/lib/auth/cred-window";
import { BACKFILL_MAX_MONTHS, isBackfillStartAllowed, todayIso } from "@/lib/backfill-window";
import { encodeChildStdinFrame, isConnectorId, type ChildStdinPayload } from "@/lib/connectors";

const ParamsSchema = z.object({ id: z.uuid() });

// Zod at the trust boundary (docs/design/conventions.md — Validation). Body
// is optional: the backfill window (ADR 0001), an override for the computed
// scrape window (decision #7) used on a connection's first sync. Capped at
// twelve months HERE as well as in the picker, because a client-side clamp
// is advisory — an out-of-range date is a 400, not a silent adjustment.
const SyncBodySchema = z.object({
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
    .refine((d) => isBackfillStartAllowed(d, todayIso()), {
      message: `must be within the last ${BACKFILL_MAX_MONTHS} months and not in the future`,
    })
    .optional(),
});

/** SIGTERM after this long, then SIGKILL if it hasn't exited (task 14). */
const CHILD_TIMEOUT_MS = 5 * 60 * 1000;
const SIGKILL_GRACE_MS = 5 * 1000;

/** Cap on retained child stderr — enough for a stack trace, bounded so a
 * chatty (or hostile) scrape can't grow the server's heap. */
const MAX_STDERR_CHARS = 8 * 1024;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const session = getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const parsedParams = ParamsSchema.safeParse(await params);
  if (!parsedParams.success) {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }
  const connectionId = parsedParams.data.id;

  // 423 Locked, not 401/403 — remediation is "re-enter password" (arm the
  // window via POST /api/connections/arm), not "log in again" (docs plan
  // §B). credentialKey here is BORROWED from the cred-window store; this
  // route must never wipe it.
  const credentialKey = getCredentialKey(session.id);
  if (!credentialKey) {
    return NextResponse.json({ error: "credential_window_locked" }, { status: 423 });
  }

  const body = await req.json().catch(() => ({}));
  const parsed = SyncBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }

  const connection = await getConnection(session.userId, connectionId);
  if (!connection) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (!isConnectorId(connection.connectorId)) {
    // Can't happen through createConnection's own registry validation, but
    // fail closed rather than spawn a child with an id the registry doesn't
    // recognize.
    return NextResponse.json({ error: "unknown connector" }, { status: 500 });
  }
  const connectorId = connection.connectorId;

  // The parent decrypts credentials_ct with CK BEFORE spawning; the child
  // never sees CK or ciphertext, only the plaintext credentials (docs plan
  // §C).
  const decrypted = await getDecryptedCredentials(session.userId, connectionId, credentialKey);
  if (!decrypted) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const startDate = parsed.data.startDate ?? computeSyncStartDate(connection.lastSyncAt);

  // The parent sets status='running' itself right after spawn (docs plan
  // §C) — before the child process even starts, not by the child.
  const syncRunId = await startSyncRun(session.userId, connectionId);

  const payload: ChildStdinPayload = {
    syncRunId,
    userId: session.userId,
    connectionId,
    connectorId,
    startDate,
    credentials: decrypted.credentials,
  };

  // session.dataKey is BORROWED from the live session store — never wiped
  // here, only by destroySession()/expiry (docs plan §C's named trap).
  spawnScrapeWorker(session.dataKey, payload, session.userId, syncRunId);

  // Don't block the HTTP response on the scrape (task 14) — the UI polls
  // GET /api/sync-runs/[id] instead.
  return NextResponse.json({ syncRunId }, { status: 202 });
}

/**
 * Spawns scripts/scrape-worker.mts as a short-lived child (docs plan §C),
 * the same spawn boundary scripts/scrape-test.ts already proved end-to-end
 * against a real bank (cluster ②) — reusing `encodeChildStdinFrame` rather
 * than reinventing the framing, so the data key stays a raw `Buffer` and
 * never becomes an unwipeable V8 `String`.
 *
 * Fire-and-forget from the route's perspective: the HTTP response has
 * already gone out by the time this settles. Enforces the 5-minute SIGTERM
 * / 5-second-grace SIGKILL timeout (task 14) and, on the child's `exit`
 * (any code) or a spawn-level `error`, calls `markSyncRunFailed` as a
 * safety net — guarded by `WHERE status='running'` inside that function, so
 * it's a no-op whenever the child's own catch (a clean failure) or
 * `promoteScrapeResult` (a clean success) already resolved the run first.
 *
 * The child's stderr is PIPED, not inherited. Inheriting pointed an
 * uninspected stream — from a process holding a plaintext bank credential —
 * straight at the server's log sink (journal, Docker log driver, aggregator),
 * against "credentials never to logs" (security-design-principles §1/§5).
 * The library's own debug output prints step names rather than values, but
 * `verbose: true` would enable Puppeteer protocol logging, which includes the
 * `Input.insertText` payload — i.e. the typed password. Piping means the
 * parent decides: bounded, redacted, and only on failure.
 */
function spawnScrapeWorker(
  dataKey: Buffer,
  payload: ChildStdinPayload,
  userId: string,
  syncRunId: string,
): void {
  const tsxBin = path.join(process.cwd(), "node_modules", ".bin", "tsx");
  const workerPath = path.join(process.cwd(), "scripts", "scrape-worker.mts");
  const child = spawn(tsxBin, [workerPath], { stdio: ["pipe", "ignore", "pipe"] });

  // Exactly the values we just handed the child, longest first so a value
  // that contains a shorter one is replaced whole. These are the same
  // unwipeable JS strings already in `payload` (the documented scraper-API
  // residual, threat-model §5.5) — holding them for the child's bounded
  // lifetime adds no exposure the payload didn't already have.
  const secrets = Object.values(payload.credentials)
    .filter((v) => v.length > 0)
    .sort((a, b) => b.length - a.length);

  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderr.length >= MAX_STDERR_CHARS) return;
    stderr += chunk.toString("utf8").slice(0, MAX_STDERR_CHARS - stderr.length);
  });

  /** Logs the child's stderr once, redacted and bounded, then drops it. */
  const flushStderr = (): void => {
    const captured = stderr;
    stderr = "";
    if (!captured.trim()) return;
    let safe = captured;
    for (const secret of secrets) safe = safe.split(secret).join("[redacted]");
    console.error(`scrape-worker[${syncRunId}] stderr:\n${safe}`);
  };

  let killTimer: NodeJS.Timeout | undefined;
  const termTimer = setTimeout(() => {
    child.kill("SIGTERM");
    killTimer = setTimeout(() => child.kill("SIGKILL"), SIGKILL_GRACE_MS);
  }, CHILD_TIMEOUT_MS);

  const clearTimers = (): void => {
    clearTimeout(termTimer);
    if (killTimer) clearTimeout(killTimer);
  };

  const recordFailureSafetyNet = (reason: string): void => {
    markSyncRunFailed(userId, syncRunId, reason).catch((err: unknown) => {
      console.error("sync route: failed to record child failure (may already be resolved):", err);
    });
  };

  // `close` rather than `exit`: `exit` can fire before the stderr pipe has
  // drained, which would log a truncated diagnostic (or none at all).
  child.on("close", (code, signal) => {
    clearTimers();
    // Only a failed run is worth logging; a clean scrape's chatter is noise,
    // and dropping it keeps scraper output out of the log by default.
    if (code !== 0 || signal) flushStderr();
    else stderr = "";
    recordFailureSafetyNet(
      signal ? `scrape-worker exited (signal ${signal})` : `scrape-worker exited (code ${code})`,
    );
  });

  child.on("error", (err) => {
    clearTimers();
    flushStderr();
    recordFailureSafetyNet(`scrape-worker spawn error: ${err.message}`);
  });

  child.stdin.write(encodeChildStdinFrame(dataKey, payload));
  child.stdin.end();
}
