// Redeem a household invitation (issue #115). Runs in the invitee's own
// session: the domain unwraps the group key with the presented secret's KEK and
// re-wraps it under the invitee's live DK, enrolling them as a member. The
// secret never leaves this request.
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/domain/auth";
import { AlreadyMemberError, InvalidInvitationError, acceptInvite } from "@/domain/household";
import { JoinSchema } from "../schema";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const parsed = JoinSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid request" }, { status: 400 });

  try {
    const { householdId } = await acceptInvite(session.userId, session.dataKey, parsed.data.secret);
    return NextResponse.json({ householdId }, { status: 201 });
  } catch (err) {
    // A bad, expired, or already-used secret is indistinguishable by design.
    if (err instanceof InvalidInvitationError) {
      return NextResponse.json(
        { error: "That invitation is invalid or has expired." },
        { status: 400 },
      );
    }
    if (err instanceof AlreadyMemberError) {
      return NextResponse.json(
        { error: "You are already a member of this household." },
        { status: 409 },
      );
    }
    throw err;
  }
}
