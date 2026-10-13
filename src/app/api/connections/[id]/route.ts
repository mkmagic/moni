// PATCH edits an existing connection: rename, and/or replace the stored bank
// credentials after a typo at connect time (previously only fixable with
// manual SQL). DELETE removes a file-import connection and all its data.
//
// Renaming touches plaintext only and needs no unlock. Replacing credentials
// needs CK, which — since issue #7 — comes only from the armed credential
// window: the login password no longer wraps CK on any row, so there is no
// inline password to accept here any more. A locked window is a 423 and the
// client unlocks with a passkey.
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/domain/auth";
import {
  InvalidCredentialsShapeError,
  ConnectionCredentialsUnavailableError,
  deleteImportConnection,
  disconnectConnection,
  renameConnection,
  updateConnectionCredentials,
} from "@/domain/connections";
import { getCredentialKey } from "@/lib/auth/cred-window";

const ParamsSchema = z.object({ id: z.uuid() });

// Zod at the trust boundary (docs/design/conventions.md — Validation).
const PatchSchema = z
  .object({
    displayName: z.string().max(120).nullable().optional(),
    credentials: z.record(z.string(), z.string()).optional(),
    disconnect: z.literal(true).optional(),
  })
  .refine(
    (v) => v.displayName !== undefined || v.credentials !== undefined || v.disconnect === true,
    {
      message: "nothing to update",
    },
  )
  .strict();

export async function PATCH(
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

  const body = await req.json().catch(() => null);
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }

  if (parsed.data.disconnect) {
    if (parsed.data.displayName !== undefined || parsed.data.credentials !== undefined)
      return NextResponse.json({ error: "invalid request" }, { status: 400 });
    const result = await disconnectConnection(session.userId, connectionId);
    if (result === "not_found") return NextResponse.json({ error: "not found" }, { status: 404 });
    if (result === "sync_running")
      return NextResponse.json({ error: "sync_running" }, { status: 409 });
    return NextResponse.json({ ok: true });
  }

  if (parsed.data.displayName !== undefined) {
    const found = await renameConnection(session.userId, connectionId, parsed.data.displayName);
    if (!found) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
  }

  if (parsed.data.credentials === undefined) {
    return NextResponse.json({ ok: true });
  }

  // BORROWED from the cred-window store — never wiped here.
  const credentialKey = getCredentialKey(session.id);
  if (!credentialKey) {
    return NextResponse.json({ error: "credential_window_locked" }, { status: 423 });
  }

  try {
    const found = await updateConnectionCredentials(
      session.userId,
      connectionId,
      parsed.data.credentials,
      credentialKey,
    );
    if (!found) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (
      err instanceof InvalidCredentialsShapeError ||
      err instanceof ConnectionCredentialsUnavailableError
    ) {
      return NextResponse.json({ error: "invalid request" }, { status: 400 });
    }
    throw err;
  }
}

const DeleteSchema = z.object({ password: z.string().min(1) }).strict();

/**
 * Permanently deletes a file-import connection and every account, report and
 * balance it imported (`deleteImportConnection`). Bank connections are refused
 * with 400 — they can only be disconnected (PATCH `{ disconnect: true }`).
 *
 * No undo, so the body must carry the login password, re-verified in the
 * domain layer — the session cookie alone is not enough (same contract as
 * DELETE /api/account).
 */
export async function DELETE(
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

  const body = await req.json().catch(() => null);
  const parsed = DeleteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }

  // Unwipeable JS string at the JSON boundary; move it into a Buffer at once
  // and wipe after use, as the login and account-deletion routes do.
  const password = Buffer.from(parsed.data.password, "utf8");
  let result: Awaited<ReturnType<typeof deleteImportConnection>>;
  try {
    result = await deleteImportConnection(session.userId, parsedParams.data.id, password);
  } finally {
    password.fill(0);
  }
  if (result === "invalid_password")
    return NextResponse.json({ error: "invalid password" }, { status: 401 });
  if (result === "not_found") return NextResponse.json({ error: "not found" }, { status: 404 });
  if (result === "not_import") return NextResponse.json({ error: "not_import" }, { status: 400 });
  if (result === "sync_running")
    return NextResponse.json({ error: "sync_running" }, { status: 409 });
  return NextResponse.json({ ok: true });
}
