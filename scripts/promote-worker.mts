// promote-worker.mts — the PROMOTER half of a bank sync (issue #92). A
// short-lived child of trusted domain code only: no network, no scraper
// dependencies, no plaintext credentials. It receives, over the binary frame,
// exactly two segments — the data key (DK) and the fetcher's normalized
// `{accounts}` JSON — plus non-secret metadata, then persists the ledger.
//
// It is the ONLY side of a bank sync that ever holds the DK or touches the
// database. The fetcher's output is treated as hostile and re-validated here
// (trust boundary #2) before it reaches `promoteScrapeResult`, which does the
// whole promotion in one `withUser` transaction. Runs via `tsx`; loads dotenv
// because it needs DATABASE_URL.
import "dotenv/config";
import { z } from "zod";
import {
  decodeBinaryChildFrame,
  isConnectorId,
  readChildStdin,
  scraperAccountSchema,
  type ConnectorId,
} from "@/lib/connectors";
import { markSyncRunFailed, promoteScrapeResult } from "@/domain/sync-promotion";
import { wipe } from "@/lib/crypto";

const accountsSchema = z.array(scraperAccountSchema);

interface PromoteJob {
  userId: string;
  connectionId: string;
  connectorId: ConnectorId;
  syncRunId: string;
}

function parseJob(metadata: Record<string, unknown>): PromoteJob {
  const { userId, connectionId, connectorId, syncRunId } = metadata;
  if (
    typeof userId !== "string" ||
    typeof connectionId !== "string" ||
    typeof connectorId !== "string" ||
    typeof syncRunId !== "string" ||
    !isConnectorId(connectorId)
  )
    throw new Error("invalid_frame");
  return { userId, connectionId, connectorId, syncRunId };
}

/** The fetcher emits its result as the final stdout line; take that line so a
 * stray dependency log line can't corrupt the parse. */
function extractAccounts(segment: Buffer): z.infer<typeof accountsSchema> {
  const line =
    segment
      .toString("utf8")
      .split("\n")
      .map((value) => value.trim())
      .filter(Boolean)
      .pop() ?? "";
  const payload = JSON.parse(line) as { accounts?: unknown };
  return accountsSchema.parse(payload.accounts);
}

async function main(): Promise<void> {
  const frame = await readChildStdin(process.stdin);
  let segments: Buffer[] = [];
  let job: PromoteJob | undefined;
  try {
    const decoded = decodeBinaryChildFrame(frame);
    segments = decoded.segments;
    if (segments.length !== 2) throw new Error("invalid_frame");
    job = parseJob(decoded.metadata);

    const accounts = extractAccounts(segments[1]);
    const summary = await promoteScrapeResult({
      userId: job.userId,
      dataKey: segments[0],
      connectionId: job.connectionId,
      connectorId: job.connectorId,
      syncRunId: job.syncRunId,
      accounts,
    });
    process.stdout.write(`${JSON.stringify({ ok: true, syncRunId: job.syncRunId, summary })}\n`);
    process.exitCode = 0;
  } catch (err) {
    if (job) {
      // Its OWN transaction, separate from the rolled-back promotion. A bad
      // frame/parse is invalid worker output; anything else is a promote error.
      const reason =
        err instanceof z.ZodError || (err instanceof Error && err.message === "invalid_frame")
          ? "invalid_worker_output"
          : "promote_failed";
      await markSyncRunFailed(job.userId, job.syncRunId, reason).catch(() => undefined);
    }
    process.exitCode = 1;
  } finally {
    // DK (segments[0]) and the Tier-1 payload (segments[1]) — this process's own
    // copies, received over stdin — wiped as it exits (threat-model.md §5.5).
    for (const segment of segments) wipe(segment);
    wipe(frame);
  }
}

main().catch(() => {
  process.exitCode = 1;
});
