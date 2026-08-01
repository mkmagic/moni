import { spawn } from "node:child_process";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/domain/auth";
import { getConnection, getDecryptedCredentials } from "@/domain/connections";
import {
  computeSyncStartDate,
  markSyncRunFailed,
  startActiveConnectionSyncRun,
} from "@/domain/sync-promotion";
import { getCredentialKey } from "@/lib/auth/cred-window";
import { BACKFILL_MAX_MONTHS, isBackfillStartAllowed, todayIso } from "@/lib/backfill-window";
import {
  encodeChildStdinFrame,
  getConnectorDefinition,
  isConnectorId,
  type ChildStdinPayload,
} from "@/lib/connectors";
import { spawnInvestmentSyncWorker } from "@/lib/investments";

const Params = z.object({ id: z.uuid() });
const validIsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    );
  });
const Json = z
  .object({
    startDate: validIsoDate
      .refine((d) => isBackfillStartAllowed(d, todayIso()), {
        message: `within ${BACKFILL_MAX_MONTHS} months`,
      })
      .optional(),
  })
  .strict();
const Currency = z.string().regex(/^[A-Z]{3}$/);
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsedParams = Params.safeParse(await params);
  if (!parsedParams.success)
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  const contentType = req.headers.get("content-type") ?? "";
  // Preserve the existing JSON credential-window contract for ordinary banks
  // and IBKR. Imports are multipart and deliberately bypass this gate.
  const credentialKey = contentType.startsWith("application/json")
    ? getCredentialKey(session.id)
    : null;
  if (contentType.startsWith("application/json") && !credentialKey)
    return NextResponse.json({ error: "credential_window_locked" }, { status: 423 });
  const connection = await getConnection(session.userId, parsedParams.data.id);
  if (!connection) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!isConnectorId(connection.connectorId))
    return NextResponse.json({ error: "unknown connector" }, { status: 400 });
  const definition = getConnectorDefinition(connection.connectorId)!;

  if (definition.mode === "user_mediated_import") {
    if (!contentType.startsWith("multipart/form-data"))
      return NextResponse.json({ error: "invalid request" }, { status: 400 });
    const form = await req.formData().catch(() => null);
    const file = form?.get("file");
    const valuationCurrency = form?.get("valuationCurrency");
    if (
      !(file instanceof File) ||
      !(typeof valuationCurrency === "string" && Currency.safeParse(valuationCurrency).success)
    )
      return NextResponse.json({ error: "invalid request" }, { status: 400 });
    if (file.size > MAX_UPLOAD_BYTES)
      return NextResponse.json({ error: "source_too_large" }, { status: 400 });
    const bytes = Buffer.from(await file.arrayBuffer());
    if (bytes.length > MAX_UPLOAD_BYTES) {
      bytes.fill(0);
      return NextResponse.json({ error: "source_too_large" }, { status: 400 });
    }
    const syncRunId = await startActiveConnectionSyncRun(session.userId, connection.id);
    if (!syncRunId) {
      bytes.fill(0);
      return NextResponse.json({ error: "connection_unavailable" }, { status: 409 });
    }
    const started = await spawnInvestmentSyncWorker({
      script: "schwab-import-worker.mts",
      metadata: {
        userId: session.userId,
        connectionId: connection.id,
        syncRunId,
        valuationCurrency,
      },
      segments: [Buffer.from(session.dataKey), bytes],
      userId: session.userId,
      syncRunId,
    });
    if (!started) return NextResponse.json({ error: "sync_unavailable" }, { status: 500 });
    return NextResponse.json({ syncRunId }, { status: 202 });
  }

  if (!contentType.startsWith("application/json"))
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  const parsed = Json.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid request" }, { status: 400 });
  // Multipart returned above, and JSON returned when the window was locked.
  if (!credentialKey)
    return NextResponse.json({ error: "credential_window_locked" }, { status: 423 });
  const decrypted = await getDecryptedCredentials(session.userId, connection.id, credentialKey);
  if (!decrypted) return NextResponse.json({ error: "not found" }, { status: 404 });
  const syncRunId = await startActiveConnectionSyncRun(session.userId, connection.id);
  if (!syncRunId) return NextResponse.json({ error: "connection_unavailable" }, { status: 409 });
  if (connection.connectorId === "ibkr_flex") {
    const token = Buffer.from(decrypted.credentials.flexToken ?? "", "utf8");
    const queryId = Buffer.from(decrypted.credentials.queryId ?? "", "utf8");
    if (!token.length || !queryId.length) {
      token.fill(0);
      queryId.fill(0);
      await markSyncRunFailed(session.userId, syncRunId, "invalid_credentials");
      return NextResponse.json({ error: "invalid request" }, { status: 400 });
    }
    const started = await spawnInvestmentSyncWorker({
      script: "ibkr-worker.mts",
      metadata: { userId: session.userId, connectionId: connection.id, syncRunId },
      segments: [Buffer.from(session.dataKey), token, queryId],
      userId: session.userId,
      syncRunId,
    });
    if (!started) return NextResponse.json({ error: "sync_unavailable" }, { status: 500 });
  } else if (connection.connectorId === "snaptrade") {
    const clientId = Buffer.from(decrypted.credentials.clientId ?? "", "utf8");
    const consumerKey = Buffer.from(decrypted.credentials.consumerKey ?? "", "utf8");
    if (!clientId.length || !consumerKey.length) {
      clientId.fill(0);
      consumerKey.fill(0);
      await markSyncRunFailed(session.userId, syncRunId, "invalid_credentials");
      return NextResponse.json({ error: "invalid request" }, { status: 400 });
    }
    const started = await spawnInvestmentSyncWorker({
      script: "snaptrade-worker.mts",
      metadata: { userId: session.userId, connectionId: connection.id, syncRunId },
      segments: [Buffer.from(session.dataKey), clientId, consumerKey],
      userId: session.userId,
      syncRunId,
    });
    if (!started) return NextResponse.json({ error: "sync_unavailable" }, { status: 500 });
  } else {
    spawnBankWorker(session.dataKey, {
      syncRunId,
      userId: session.userId,
      connectionId: connection.id,
      connectorId: connection.connectorId,
      startDate: parsed.data.startDate ?? computeSyncStartDate(connection.lastSyncAt),
      credentials: decrypted.credentials,
    });
  }
  return NextResponse.json({ syncRunId }, { status: 202 });
}

function spawnBankWorker(dataKey: Buffer, payload: ChildStdinPayload): void {
  const child = spawn(
    path.join(process.cwd(), "node_modules", ".bin", "tsx"),
    [path.join(process.cwd(), "scripts", "scrape-worker.mts")],
    { stdio: ["pipe", "ignore", "ignore"] },
  );
  const frame = encodeChildStdinFrame(dataKey, payload);
  child.stdin.write(frame, () => frame.fill(0));
  child.stdin.end();
  child.once("error", () => frame.fill(0));
  let kill: NodeJS.Timeout | undefined;
  const term = setTimeout(
    () => {
      child.kill("SIGTERM");
      kill = setTimeout(() => child.kill("SIGKILL"), 5_000);
    },
    5 * 60 * 1000,
  );
  const done = () => {
    clearTimeout(term);
    if (kill) clearTimeout(kill);
  };
  const failed = () => {
    void markSyncRunFailed(payload.userId, payload.syncRunId, "scrape_worker_failed");
  };
  child.once("close", (code, signal) => {
    done();
    if (code !== 0 || signal) failed();
  });
  child.once("error", () => {
    done();
    failed();
  });
}
