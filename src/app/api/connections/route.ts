// POST creates a connection (task 14's sibling — the "first-connect arms
// inline" half of the plan): the caller supplies the connector's login
// fields plus their Moni login password, since no credential window can
// already be open before a connection exists (docs plan §"Connector
// registry (task 8)"). Credentials are encrypted under the credential key
// (CK) BEFORE the first write — createConnection() does this, never this
// route directly (one access path, AGENTS.md). On success the SAME key arms
// the credential window, so onboarding's first sync needs no second
// password prompt.
// GET lists the caller's connections — never their credentials.
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest, unlockCredentialKey } from "@/domain/auth";
import {
  createConnection,
  InvalidCredentialsShapeError,
  listConnections,
} from "@/domain/connections";
import { armCredentialWindow } from "@/lib/auth/cred-window";
import { wipe } from "@/lib/crypto";
import { isConnectorId } from "@/lib/connectors";

// Zod at the trust boundary (docs/design/conventions.md — Validation).
const CreateConnectionSchema = z.object({
  connectorId: z.string().min(1),
  credentials: z.record(z.string(), z.string()),
  displayName: z.string().min(1).optional(),
  // The user's Moni login password — unlocks CK. Arrives as a JS string at
  // the HTTP/JSON boundary (unavoidable — see the login route's identical
  // comment); moved into a wipeable Buffer immediately below.
  password: z.string().min(1),
});

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

  // Validated before the (expensive) Argon2id derivation below, so a bogus
  // connector id fails fast without paying for it.
  if (!isConnectorId(parsed.data.connectorId)) {
    return NextResponse.json({ error: "unknown connector" }, { status: 400 });
  }
  const connectorId = parsed.data.connectorId;

  const password = Buffer.from(parsed.data.password, "utf8");
  try {
    const credentialKey = await unlockCredentialKey(session.userId, password);
    if (!credentialKey) {
      return NextResponse.json({ error: "invalid password" }, { status: 401 });
    }

    try {
      const { id } = await createConnection(
        session.userId,
        connectorId,
        parsed.data.credentials,
        credentialKey,
        parsed.data.displayName,
      );
      // Success: arm the credential window with this SAME key. Ownership of
      // credentialKey transfers to the window store now — this route must
      // NOT wipe it below (armCredentialWindow/destroyCredentialWindow own
      // that wipe from here on).
      armCredentialWindow(session.id, session.userId, credentialKey);
      return NextResponse.json({ id }, { status: 201 });
    } catch (err) {
      // createConnection threw before the window was armed — this route
      // still owns credentialKey and must wipe it (Tier-0 hygiene).
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
