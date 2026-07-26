// Re-enter the Moni password to arm the ~10-minute credential window
// (decision #3, docs plan §B) — the normal path for every sync after the
// first (which arms inline via POST /api/connections instead).
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest, unlockCredentialKey } from "@/domain/auth";
import { armCredentialWindow } from "@/lib/auth/cred-window";

// Zod at the trust boundary (docs/design/conventions.md — Validation).
const ArmSchema = z.object({
  password: z.string().min(1),
});

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const parsed = ArmSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }

  // Arrives as a JS string at the HTTP/JSON boundary (unavoidable — see the
  // login route's identical comment); moved into a wipeable Buffer at once.
  const password = Buffer.from(parsed.data.password, "utf8");
  try {
    const credentialKey = await unlockCredentialKey(session.userId, password);
    if (!credentialKey) {
      return NextResponse.json({ error: "invalid password" }, { status: 401 });
    }
    // Ownership of credentialKey transfers to the window store here —
    // nothing left for this route to wipe.
    armCredentialWindow(session.id, session.userId, credentialKey);
    return NextResponse.json({ ok: true });
  } finally {
    password.fill(0);
  }
}
