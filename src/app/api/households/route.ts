// Create a household (issue #115). Same-origin, session-authenticated: the
// caller becomes the first member, with the new group key wrapped under their
// live session DK. Mirrors src/app/api/budget/ceilings/route.ts.
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/domain/auth";
import { createHousehold } from "@/domain/household";
import { CreateHouseholdSchema } from "./schema";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const parsed = CreateHouseholdSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid request" }, { status: 400 });

  const { householdId } = await createHousehold(session.userId, session.dataKey, parsed.data.name);
  return NextResponse.json({ householdId }, { status: 201 });
}
