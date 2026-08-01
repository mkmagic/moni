// POST creates a connection. Credentials are encrypted under the credential
// key (CK) BEFORE the first write — createConnection() does this, never this
// route directly (one access path, AGENTS.md).
//
// CK comes from the armed credential window, so this route returns 423 when
// the window is closed, exactly like the sync route. It used to accept the
// Moni login password inline and unwrap CK from it; issue #7 removed that
// path entirely — the login password no longer wraps CK on any row, so
// there is nothing here to unwrap it with. The client arms with a passkey
// first (an enrollment leaves the window armed, so the very first connection
// in onboarding still needs no extra step).
// GET lists the caller's connections — never their credentials.
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/domain/auth";
import {
  createConnection,
  InvalidCredentialsShapeError,
  listConnections,
} from "@/domain/connections";
import { getCredentialKey } from "@/lib/auth/cred-window";
import { getConnectorDefinition, isConnectorId } from "@/lib/connectors";

// Zod at the trust boundary (docs/design/conventions.md — Validation).
const CreateConnectionSchema = z
  .object({
    connectorId: z.string().min(1),
    credentials: z.record(z.string(), z.string()).optional(),
    displayName: z.string().min(1).optional(),
  })
  .strict();

export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const connections = await listConnections(session.userId);
  return NextResponse.json({ connections });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const parsed = CreateConnectionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }

  if (!isConnectorId(parsed.data.connectorId)) {
    return NextResponse.json({ error: "unknown connector" }, { status: 400 });
  }
  const connectorId = parsed.data.connectorId;
  const definition = getConnectorDefinition(connectorId);
  if (!definition) return NextResponse.json({ error: "unknown connector" }, { status: 400 });

  if (definition.mode === "user_mediated_import") {
    if (parsed.data.credentials !== undefined)
      return NextResponse.json({ error: "invalid request" }, { status: 400 });
    try {
      const { id } = await createConnection(
        session.userId,
        connectorId,
        null,
        null,
        parsed.data.displayName,
      );
      return NextResponse.json({ id }, { status: 201 });
    } catch (err) {
      if (err instanceof InvalidCredentialsShapeError) {
        return NextResponse.json({ error: "invalid request" }, { status: 400 });
      }
      throw err;
    }
  }
  if (parsed.data.credentials === undefined)
    return NextResponse.json({ error: "invalid request" }, { status: 400 });

  // 423 Locked — remediation is "unlock with your passkey", not "log in
  // again" (docs plan §B). credentialKey is BORROWED from the cred-window
  // store; this route must never wipe it.
  const credentialKey = getCredentialKey(session.id);
  if (!credentialKey) {
    return NextResponse.json({ error: "credential_window_locked" }, { status: 423 });
  }

  try {
    const { id } = await createConnection(
      session.userId,
      connectorId,
      parsed.data.credentials,
      credentialKey,
      parsed.data.displayName,
    );
    return NextResponse.json({ id }, { status: 201 });
  } catch (err) {
    if (err instanceof InvalidCredentialsShapeError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}
