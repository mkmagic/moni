// Silences the dashboard sync offer for the rest of this session, so
// dismissing it stops it reappearing on every navigation. Touches a boolean UI
// hint on the in-RAM session and nothing else — no key material, no database
// write.
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/domain/auth";
import { dismissSyncPrompt } from "@/lib/auth/session-store";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  dismissSyncPrompt(session.id);
  return NextResponse.json({ ok: true });
}
