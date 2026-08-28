import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/domain/auth";
import {
  getConnection,
  getDecryptedCredentials,
  getEncryptedCredentials,
} from "@/domain/connections";
import {
  computeSyncStartDate,
  markSyncRunFailed,
  startActiveConnectionSyncRun,
} from "@/domain/sync-promotion";
import { getCredentialKey } from "@/lib/auth/cred-window";
import { BACKFILL_MAX_MONTHS, isBackfillStartAllowed, todayIso } from "@/lib/backfill-window";
import { getConnectorDefinition, isConnectorId } from "@/lib/connectors";
import { startBankSync } from "@/lib/connectors/bank-sync";
import { acquireScrapeSlot, type ScrapeSlot } from "@/lib/scrape-slot";
import { spawnInvestmentSyncWorker } from "@/lib/investments";
import { PRODUCT_LABEL } from "@/lib/long-term-savings/labels";

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
/** Every PDF opens with this, whatever the browser claimed the type was. */
const PDF_MAGIC = Buffer.from("%PDF-", "ascii");

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
    if (!(file instanceof File))
      return NextResponse.json({ error: "invalid request" }, { status: 400 });
    // A long-term-savings report is denominated in shekels on the page and
    // needs no FX at import; an investment CSV must say what to value it in.
    const needsValuationCurrency = definition.kind !== "long_term_savings";
    if (
      needsValuationCurrency &&
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
    // A long-term-savings report is handed straight to pdfjs. Refuse anything
    // that is not a PDF here, where it costs one comparison and produces a
    // message, rather than in the worker as an opaque crash. The browser's
    // Content-Type is the uploader's claim; these five bytes are the file's.
    if (definition.kind === "long_term_savings" && !bytes.subarray(0, 5).equals(PDF_MAGIC)) {
      bytes.fill(0);
      return NextResponse.json({ error: "unreadable_document" }, { status: 400 });
    }
    const syncRunId = await startActiveConnectionSyncRun(session.userId, connection.id);
    if (!syncRunId) {
      bytes.fill(0);
      return NextResponse.json({ error: "connection_unavailable" }, { status: 409 });
    }
    const started = await spawnInvestmentSyncWorker({
      script:
        definition.kind === "long_term_savings"
          ? "long-term-savings-import-worker.mts"
          : "schwab-import-worker.mts",
      metadata: {
        userId: session.userId,
        connectionId: connection.id,
        syncRunId,
        connectorId: connection.connectorId,
        // The account's name until the user renames it. Derived here because
        // the worker has no registry-free way to name what it imported, and
        // the report itself carries no account name or number at all.
        //
        // Provider + PRODUCT, never provider + document: the account is a
        // pension held at Harel, and "Harel Quarterly Pension Report" names the
        // statement that reported it rather than the thing itself.
        accountLabel:
          connection.displayName ??
          (definition.product
            ? `${definition.institutionLabel} ${PRODUCT_LABEL[definition.product]}`
            : `${definition.institutionLabel} ${definition.label}`),
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
  // IBKR/SnapTrade credentials are still decrypted parent-side (tracked #92
  // follow-up). The bank path decrypts inside the disposable fetcher, so the
  // parent only reads ciphertext here and never materializes plaintext.
  const isBankScrape =
    connection.connectorId !== "ibkr_flex" && connection.connectorId !== "snaptrade";
  let decrypted: Awaited<ReturnType<typeof getDecryptedCredentials>> = null;
  let encrypted: Awaited<ReturnType<typeof getEncryptedCredentials>> = null;
  if (isBankScrape) {
    encrypted = await getEncryptedCredentials(session.userId, connection.id);
    if (!encrypted) return NextResponse.json({ error: "not found" }, { status: 404 });
  } else {
    decrypted = await getDecryptedCredentials(session.userId, connection.id, credentialKey);
    if (!decrypted) return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  // Box-wide concurrency guard (issue #82): a bank scrape peaks ~1.3–1.6 GB RSS
  // (#54) and two do not fit on the 4 GB host — including two started by
  // DIFFERENT users. The advisory-lock slot is cluster-global and independent
  // of RLS, so it serializes scrapes across every tenant without reading any
  // cross-tenant row. Only the scrape path takes it: IBKR/SnapTrade/imports are
  // light and never risk OOM. `startBankSync` releases the slot once the
  // Chrome-bearing fetcher exits; a server crash auto-releases it.
  let slot: ScrapeSlot | null = null;
  if (isBankScrape) {
    slot = await acquireScrapeSlot();
    if (!slot) {
      encrypted!.ciphertext.fill(0);
      return NextResponse.json({ error: "sync_already_in_progress" }, { status: 409 });
    }
  }
  const syncRunId = await startActiveConnectionSyncRun(session.userId, connection.id);
  if (!syncRunId) {
    slot?.release();
    // A concurrent run won the slot; nothing downstream will consume the
    // ciphertext copy, so clear it rather than abandon it to the GC.
    encrypted?.ciphertext.fill(0);
    return NextResponse.json({ error: "connection_unavailable" }, { status: 409 });
  }
  if (connection.connectorId === "ibkr_flex") {
    const token = Buffer.from(decrypted!.credentials.flexToken ?? "", "utf8");
    const queryId = Buffer.from(decrypted!.credentials.queryId ?? "", "utf8");
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
    const clientId = Buffer.from(decrypted!.credentials.clientId ?? "", "utf8");
    const consumerKey = Buffer.from(decrypted!.credentials.consumerKey ?? "", "utf8");
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
    startBankSync({
      credentialKey: Buffer.from(credentialKey),
      ciphertext: encrypted!.ciphertext,
      dataKey: Buffer.from(session.dataKey),
      userId: session.userId,
      connectionId: connection.id,
      connectorId: connection.connectorId,
      syncRunId,
      startDate: parsed.data.startDate ?? computeSyncStartDate(connection.lastSyncAt),
      version: encrypted!.version,
      // Non-null on this branch: isBankScrape acquired the slot above.
      slot: slot!,
    });
  }
  return NextResponse.json({ syncRunId }, { status: 202 });
}
