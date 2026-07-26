// PATCH edits an existing connection: rename, and/or replace the stored bank
// credentials after a typo at connect time (previously only fixable with
// manual SQL).
//
// Renaming touches plaintext only and needs no password. Replacing
// credentials needs CK, so — exactly like POST /api/connections — the caller
// supplies their Moni login password inline rather than going through a 423
// dance in a settings form, and the same key then arms the credential window
// so an immediate re-sync needs no second prompt.
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest, unlockCredentialKey } from "@/domain/auth";
import {
  InvalidCredentialsShapeError,
  renameConnection,
  updateConnectionCredentials,
} from "@/domain/connections";
import { armCredentialWindow } from "@/lib/auth/cred-window";
import { wipe } from "@/lib/crypto";

const ParamsSchema = z.object({ id: z.uuid() });

// Zod at the trust boundary (docs/design/conventions.md — Validation).
// `credentials` and `password` travel together: neither is any use alone.
const PatchSchema = z
  .object({
    displayName: z.string().max(120).nullable().optional(),
    credentials: z.record(z.string(), z.string()).optional(),
    password: z.string().min(1).optional(),
  })
  .refine((v) => (v.credentials === undefined) === (v.password === undefined), {
    message: "credentials and password must be supplied together",
  })
  .refine((v) => v.displayName !== undefined || v.credentials !== undefined, {
    message: "nothing to update",
  });

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

  if (parsed.data.displayName !== undefined) {
    const found = await renameConnection(session.userId, connectionId, parsed.data.displayName);
    if (!found) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
  }

  if (parsed.data.credentials === undefined) {
    return NextResponse.json({ ok: true });
  }

  const credentials = parsed.data.credentials;
  // Non-null: the schema's refine guarantees password accompanies credentials.
  const password = Buffer.from(parsed.data.password!, "utf8");
  try {
    const credentialKey = await unlockCredentialKey(session.userId, password);
    if (!credentialKey) {
      return NextResponse.json({ error: "invalid password" }, { status: 401 });
    }

    try {
      const found = await updateConnectionCredentials(
        session.userId,
        connectionId,
        credentials,
        credentialKey,
      );
      if (!found) {
        wipe(credentialKey);
        return NextResponse.json({ error: "not found" }, { status: 404 });
      }
      // Ownership of credentialKey transfers to the window store here — this
      // route must NOT wipe it past this point (same contract as POST).
      armCredentialWindow(session.id, session.userId, credentialKey);
      return NextResponse.json({ ok: true });
    } catch (err) {
      // Threw before the window was armed — this route still owns the key.
      wipe(credentialKey);
      if (err instanceof InvalidCredentialsShapeError) {
        return NextResponse.json({ error: err.message }, { status: 400 });
      }
      throw err;
    }
  } finally {
    password.fill(0);
  }
}
