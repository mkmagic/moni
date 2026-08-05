/**
 * Parses an uploaded long-term-savings report and promotes it to a snapshot.
 *
 * The usual reasons for a worker don't apply here — there is no Tier-0
 * credential to isolate, no FX lookup, no network call, and reading ~100KB of
 * text geometry takes milliseconds. The deciding reason is different: parsing in
 * the API route would pull `pdfjs-dist` into the Next server bundle, a large
 * library with worker and canvas assumptions. Nothing imports this script, so
 * `next build` never bundles it (docs/design/connector-interface.md §3) — the
 * same containment the existing workers give `israeli-bank-scrapers`.
 */
import "dotenv/config";
import {
  decodeBinaryChildFrame,
  getConnectorDefinition,
  readChildStdin,
  type ConnectorId,
} from "@/lib/connectors";
import { LONG_TERM_SAVINGS_IMPORTERS } from "@/lib/connectors/documents/registry";
import { loadItems } from "@/lib/connectors/documents/pdf-load";
import { DocumentParseError } from "@/lib/connectors/documents/types";
import { promoteLongTermSavingsSnapshot } from "@/domain/long-term-savings-promotion";
import { markSyncRunFailed } from "@/domain/sync-promotion";
import { wipe } from "@/lib/crypto";
import { errorLabel, syncLog } from "@/lib/sync-log";

async function main(): Promise<void> {
  const frame = await readChildStdin(process.stdin);
  const decoded = decodeBinaryChildFrame(frame);
  const segments = decoded.segments;
  const { userId, connectionId, syncRunId, connectorId, accountLabel } = decoded.metadata;
  try {
    if (
      typeof userId !== "string" ||
      typeof connectionId !== "string" ||
      typeof syncRunId !== "string" ||
      typeof accountLabel !== "string" ||
      typeof connectorId !== "string" ||
      segments.length !== 2
    )
      throw new Error("invalid_frame");

    // One connector id maps to exactly one importer. A connection whose id is
    // not in the map does not import documents at all, which means the frame
    // was addressed to the wrong worker.
    const importer = LONG_TERM_SAVINGS_IMPORTERS[connectorId as ConnectorId];
    // The registry is the one place a connector's product is stated (D7);
    // hardcoding it here would make a second parser silently create pension
    // accounts.
    const product = getConnectorDefinition(connectorId)?.product;
    if (!importer || !product) throw new Error("invalid_frame");

    const items = await loadItems(new Uint8Array(segments[1])).catch(() => {
      throw new DocumentParseError("unreadable_document");
    });
    // Recognition is a guard, not a router: the connection already chose this
    // parser, so a mismatch means the user uploaded the wrong statement.
    if (!importer.recognises(items)) throw new DocumentParseError("unrecognised_document");

    await promoteLongTermSavingsSnapshot({
      userId,
      connectionId,
      syncRunId,
      dataKey: segments[0],
      parserId: importer.parserId,
      parserVersion: importer.parserVersion,
      product,
      accountLabel,
      report: importer.read(items),
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
    // The uploaded report holds the member's name, ת.ז., salary and balances,
    // and is never stored (D10) — wipe it here so it does not outlive the parse.
    for (const segment of segments) wipe(segment);
    wipe(frame);
  }
}

main().catch((error) => {
  syncLog("worker.failed", {
    script: "long-term-savings-import-worker.mts",
    error: errorLabel(error),
  });
  process.exitCode = 1;
});
