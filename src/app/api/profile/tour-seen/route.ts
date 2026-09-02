// Records that the caller has met the guided tour — set once when they start,
// finish, or dismiss the first-run prompt, so it never greets them again. A
// plaintext preference timestamp on `users`; no key material, and a later
// replay from Settings deliberately does not touch it (see markTourSeen).
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/domain/auth";
import { markTourSeen } from "@/domain/profile";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  await markTourSeen(session.userId);
  return NextResponse.json({ ok: true });
}
