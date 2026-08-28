/**
 * Parses an uploaded Agam Liderim portfolio export and promotes it to
 * long-term-savings accounts and balances.
 *
 * Like the PDF report worker, the reason for a separate process is bundle
 * containment, not credential isolation: parsing in the API route would pull
 * this connector's xlsx reader (and `fast-xml-parser`'s worksheet handling)
 * into the Next server bundle. Nothing imports this script, so `next build`
 * never bundles it (connector-interface.md §3). There is no Tier-0 credential,
 * no FX and no network here — the uploaded file is the only sensitive input,
 * and it is wiped after the parse.
 */
import "dotenv/config";
import { decodeBinaryChildFrame, readChildStdin } from "@/lib/connectors";
import {
  AGAM_LIDERIM_PARSER_ID,
  AGAM_LIDERIM_PARSER_VERSION,
  parseAgamLiderimPortfolio,
} from "@/lib/connectors/agam-liderim";
import { DocumentParseError } from "@/lib/connectors/documents/types";
import { promoteAgamLiderimPortfolio } from "@/domain/agam-liderim-promotion";
import { markSyncRunFailed } from "@/domain/sync-promotion";
import { wipe } from "@/lib/crypto";
import { errorLabel, syncLog } from "@/lib/sync-log";

async function main(): Promise<void> {
  const frame = await readChildStdin(process.stdin);
  const decoded = decodeBinaryChildFrame(frame);
  const segments = decoded.segments;
  const { userId, connectionId, syncRunId } = decoded.metadata;
  try {
    if (
      typeof userId !== "string" ||
      typeof connectionId !== "string" ||
      typeof syncRunId !== "string" ||
      segments.length !== 2
    )
      throw new Error("invalid_frame");

    // The parser is its own guard: a workbook without the balances sheet and
    // its headers throws `unrecognised_document`, a row it cannot read throws
    // `malformed_document`, and a non-zip throws `unreadable_document`.
    const portfolio = parseAgamLiderimPortfolio(new Uint8Array(segments[1]));

    await promoteAgamLiderimPortfolio({
      userId,
      connectionId,
      syncRunId,
      dataKey: segments[0],
      parserId: AGAM_LIDERIM_PARSER_ID,
      parserVersion: AGAM_LIDERIM_PARSER_VERSION,
      accounts: portfolio.accounts,
    });
  } catch (error) {
    // A parse failure never reached promotion, so nothing has marked the run.
    // Every other failure was already recorded by promotion itself.
    if (
      error instanceof DocumentParseError &&
      typeof userId === "string" &&
      typeof syncRunId === "string"
    )
      await markSyncRunFailed(userId, syncRunId, error.code);
    throw error;
  } finally {
    // The uploaded export holds the member's policy numbers, provider names and
    // balances, and is never stored — wipe it so it does not outlive the parse.
    for (const segment of segments) wipe(segment);
    wipe(frame);
  }
}

main().catch((error) => {
  syncLog("worker.failed", {
    script: "agam-liderim-import-worker.mts",
    error: errorLabel(error),
  });
  process.exitCode = 1;
});
