import "dotenv/config";
import { spawn } from "node:child_process";
import { decodeBinaryChildFrame, encodeBinaryChildFrame, readChildStdin } from "@/lib/connectors";
import {
  completeSourceRefresh,
  fetchIbkrFlexXml,
  InvestmentNormalizationError,
  normalizeIbkrPayload,
  refreshBoiWithFallback,
  WorkerSourceError,
} from "@/lib/investments";
import { promoteInvestmentSnapshot } from "@/domain/investment-promotion";
import { missingBoiFxPairs } from "@/domain/fx-rates";
import { markSyncRunFailed } from "@/domain/sync-promotion";
import { wipe } from "@/lib/crypto";
import { errorLabel, syncLog, syncLogEnabled } from "@/lib/sync-log";
import { workerRuntimePath } from "@/lib/worker-runtime";

async function cacheBoi(required: Array<{ currency: string; date: string }>): Promise<void> {
  await refreshBoiWithFallback(
    required,
    async (pairs) => {
      const child = spawn(
        workerRuntimePath("node_modules", ".bin", "tsx"),
        [workerRuntimePath("scripts", "boi-worker.mts")],
        { stdio: ["pipe", "ignore", syncLogEnabled() ? "inherit" : "ignore"] },
      );
      child.stdin.write(encodeBinaryChildFrame({ required: pairs }, []));
      child.stdin.end();
      await new Promise<void>((resolve, reject) =>
        child
          .once("exit", (code) => (code === 0 ? resolve() : reject(new Error("boi_failed"))))
          .once("error", reject),
      );
    },
    missingBoiFxPairs,
  );
}
async function main(): Promise<void> {
  const frame = await readChildStdin(process.stdin);
  let segments: Buffer[] = [];
  let run: { userId: string; syncRunId: string } | undefined;
  try {
    const decoded = decodeBinaryChildFrame(frame);
    segments = decoded.segments;
    const { userId, connectionId, syncRunId } = decoded.metadata;
    if (
      typeof userId !== "string" ||
      typeof connectionId !== "string" ||
      typeof syncRunId !== "string" ||
      segments.length !== 3
    )
      throw new Error("invalid_frame");
    run = { userId, syncRunId };
    const xml = await fetchIbkrFlexXml(segments[1], segments[2], fetch);
    const envelope = normalizeIbkrPayload(xml);
    await completeSourceRefresh({
      envelope,
      cacheBoi,
      promote: (ready) =>
        promoteInvestmentSnapshot({
          userId,
          connectionId,
          syncRunId,
          dataKey: segments[0],
          envelope: ready,
        }),
    });
  } catch (error) {
    if (run) {
      const safe =
        error instanceof WorkerSourceError || error instanceof InvestmentNormalizationError
          ? error.code
          : "source_worker_failed";
      await markSyncRunFailed(run.userId, run.syncRunId, safe);
    }
    throw error;
  } finally {
    for (const segment of segments) wipe(segment);
    wipe(frame);
  }
}
main().catch((error) => {
  syncLog("worker.failed", { script: "ibkr-worker.mts", error: errorLabel(error) });
  process.exitCode = 1;
});
