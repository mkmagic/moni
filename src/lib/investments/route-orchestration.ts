import { spawn } from "node:child_process";
import path from "node:path";
import { markSyncRunFailed } from "@/domain/sync-promotion";
import { encodeBinaryChildFrame } from "@/lib/connectors";

export const WORKER_TIMEOUT_MS = 5 * 60 * 1000;
const KILL_GRACE_MS = 5_000;

function start(script: string, frame: Buffer): ReturnType<typeof spawn> {
  const child = spawn(
    path.join(process.cwd(), "node_modules", ".bin", "tsx"),
    [path.join(process.cwd(), "scripts", script)],
    {
      stdio: [
        "pipe",
        "ignore",
        process.env.MONI_IBKR_DIAGNOSTIC === "1" || process.env.MONI_SYNC_DIAGNOSTIC === "1"
          ? "inherit"
          : "ignore",
      ],
    },
  );
  child.stdin.write(frame, () => frame.fill(0));
  child.stdin.end();
  child.once("error", () => frame.fill(0));
  return child;
}

/** Starts a source worker and preserves the existing guarded failed-run fallback. */
export async function spawnInvestmentSyncWorker(input: {
  script: "ibkr-worker.mts" | "schwab-import-worker.mts" | "snaptrade-worker.mts";
  metadata: Record<string, unknown>;
  segments: Buffer[];
  userId: string;
  syncRunId: string;
}): Promise<boolean> {
  let frame: Buffer | undefined;
  let child: ReturnType<typeof spawn>;
  try {
    frame = encodeBinaryChildFrame(input.metadata, input.segments);
    child = start(input.script, frame);
  } catch {
    frame?.fill(0);
    for (const segment of input.segments) segment.fill(0);
    await markSyncRunFailed(input.userId, input.syncRunId, "source_worker_start_failed");
    return false;
  }
  for (const segment of input.segments) segment.fill(0);
  let kill: NodeJS.Timeout | undefined;
  const term = setTimeout(() => {
    child.kill("SIGTERM");
    kill = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
  }, WORKER_TIMEOUT_MS);
  const finish = () => {
    clearTimeout(term);
    if (kill) clearTimeout(kill);
  };
  const failed = () => {
    void markSyncRunFailed(input.userId, input.syncRunId, "source_worker_failed");
  };
  child.once("close", (_code, signal) => {
    finish();
    if (_code !== 0 || signal) failed();
  });
  child.once("error", () => {
    finish();
    failed();
  });
  return true;
}

/** Quote refresh is intentionally awaited, but provider errors remain worker-local fallbacks. */
export async function runTiingoWorker(input: {
  userId: string;
  dataKey: Buffer;
  token: Buffer;
}): Promise<boolean> {
  const frame = encodeBinaryChildFrame({ userId: input.userId }, [input.dataKey, input.token]);
  let child: ReturnType<typeof spawn>;
  try {
    child = start("tiingo-quote-worker.mts", frame);
  } catch {
    frame.fill(0);
    input.dataKey.fill(0);
    input.token.fill(0);
    return false;
  }
  input.dataKey.fill(0);
  input.token.fill(0);
  return new Promise((resolve) => {
    let kill: NodeJS.Timeout | undefined;
    let settled = false;
    const term = setTimeout(() => {
      child.kill("SIGTERM");
      kill = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
      done(false, true);
    }, WORKER_TIMEOUT_MS);
    const done = (ok: boolean, preserveKill = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(term);
      if (kill && !preserveKill) clearTimeout(kill);
      resolve(ok);
    };
    child.once("close", (code, signal) => done(code === 0 && !signal));
    child.once("error", () => done(false));
  });
}
