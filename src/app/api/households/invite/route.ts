// Mint a one-time invitation to a household (issue #115). The caller must be a
// member; the domain re-wraps the group key under a KEK derived from the fresh
// secret and returns that secret exactly once — shown to the inviter, never
// stored server-side (only its hash is). Treat the response like a recovery
// code, same shape as agent-token minting.
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/domain/auth";
import { InvalidInvitationError, inviteMember } from "@/domain/household";
import { INVITE_TTL_MS, InviteSchema } from "../schema";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const parsed = InviteSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid request" }, { status: 400 });

  try {
    // An omitted ttl falls back to the domain's default (7 days); "never" maps
    // to a null (no-expiry) invitation.
    const ttlMs = parsed.data.ttl ? INVITE_TTL_MS[parsed.data.ttl] : undefined;
    const minted = await inviteMember(session.userId, session.dataKey, parsed.data.householdId, {
      inviteeEmail: parsed.data.inviteeEmail,
      ttlMs,
    });
    return NextResponse.json(
      { secret: minted.secret, expiresAt: minted.expiresAt?.toISOString() ?? null },
      { status: 201 },
    );
  } catch (err) {
    // Not a member of the household (or it does not exist) — the caller has no
    // group key to wrap, so there is nothing to invite anyone into.
    if (err instanceof InvalidInvitationError) {
      return NextResponse.json({ error: "not a member of this household" }, { status: 403 });
    }
    throw err;
  }
}
