import { spawn } from "node:child_process";
import path from "node:path";
import { markSyncRunFailed } from "@/domain/sync-promotion";
import { encodeBinaryChildFrame } from "@/lib/connectors";

export const WORKER_TIMEOUT_MS = 5 * 60 * 1000;
const KILL_GRACE_MS = 5_000;

export interface TiingoRefreshCounts {
  attempted: number;
  updated: number;
}

/**
 * Reads the one structural line a quote worker writes to stdout. Counts only —
 * a worker never puts a symbol or a provider message on a pipe the route reads.
 */
export function parseTiingoRefreshCounts(output: string): TiingoRefreshCounts {
  try {
    const parsed = JSON.parse(output.trim().split("\n").pop() ?? "") as unknown;
    const counts = parsed as { attempted?: unknown; updated?: unknown };
    if (
      typeof counts?.attempted !== "number" ||
      typeof counts?.updated !== "number" ||
      !Number.isInteger(counts.attempted) ||
      !Number.isInteger(counts.updated) ||
      counts.attempted < 0 ||
      counts.updated < 0 ||
      counts.updated > counts.attempted
    )
      return { attempted: 0, updated: 0 };
    return { attempted: counts.attempted, updated: counts.updated };
  } catch {
    return { attempted: 0, updated: 0 };
  }
}

function start(script: string, frame: Buffer, captureStdout = false): ReturnType<typeof spawn> {
  const child = spawn(
    path.join(process.cwd(), "node_modules", ".bin", "tsx"),
    [path.join(process.cwd(), "scripts", script)],
    {
      stdio: [
        "pipe",
        captureStdout ? "pipe" : "ignore",
        process.env.MONI_IBKR_DIAGNOSTIC === "1" || process.env.MONI_SYNC_DIAGNOSTIC === "1"
          ? "inherit"
          : "ignore",
      ],
    },
  );
  // A conditional stdio entry costs the literal-tuple overload that used to
  // prove stdin is a pipe. Both callers already treat a throw here as a failed
  // start and wipe the frame themselves.
  if (!child.stdin) throw new Error("worker_stdin_unavailable");
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
}): Promise<{ ok: boolean } & TiingoRefreshCounts> {
  const frame = encodeBinaryChildFrame({ userId: input.userId }, [input.dataKey, input.token]);
  let child: ReturnType<typeof spawn>;
  try {
    child = start("tiingo-quote-worker.mts", frame, true);
  } catch {
    frame.fill(0);
    input.dataKey.fill(0);
    input.token.fill(0);
    return { ok: false, attempted: 0, updated: 0 };
  }
  input.dataKey.fill(0);
  input.token.fill(0);
  // Bounded: the worker writes one short counts line, and a runaway child must
  // not be able to grow the route's memory.
  let output = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    if (output.length < 1024) output += chunk;
  });
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
      resolve({ ok, ...(ok ? parseTiingoRefreshCounts(output) : { attempted: 0, updated: 0 }) });
    };
    child.once("close", (code, signal) => done(code === 0 && !signal));
    child.once("error", () => done(false));
  });
}
