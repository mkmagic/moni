import "dotenv/config";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { decodeBinaryChildFrame, encodeBinaryChildFrame, readChildStdin } from "@/lib/connectors";
import { completeSourceRefresh, fetchIbkrFlexXml, normalizeIbkrPayload } from "@/lib/investments";
import { promoteInvestmentSnapshot } from "@/domain/investment-promotion";
import { missingBoiFxPairs } from "@/domain/fx-rates";
import { wipe } from "@/lib/crypto";

async function cacheBoi(required: Array<{ currency: string; date: string }>): Promise<void> {
  const missing = await missingBoiFxPairs(required);
  if (missing.length === 0) return;
  const child = spawn(
    join(process.cwd(), "node_modules/.bin/tsx"),
    [join(process.cwd(), "scripts/boi-worker.mts")],
    { stdio: ["pipe", "ignore", "ignore"] },
  );
  child.stdin.write(encodeBinaryChildFrame({ required: missing }, []));
  child.stdin.end();
  await new Promise<void>((resolve, reject) =>
    child
      .once("exit", (code) => (code === 0 ? resolve() : reject(new Error("boi_failed"))))
      .once("error", reject),
  );
}
async function main(): Promise<void> {
  const frame = await readChildStdin(process.stdin);
  let segments: Buffer[] = [];
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
  } finally {
    for (const segment of segments) wipe(segment);
    wipe(frame);
  }
}
main().catch(() => {
  process.exitCode = 1;
});
