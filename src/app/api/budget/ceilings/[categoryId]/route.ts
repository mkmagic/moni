import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/domain/auth";
import { deleteCeiling } from "@/domain/budget";

/** Stops budgeting a category outright, history included. Ending a budget
 * line while keeping what it was is `POST /api/budget/ceilings` with a new
 * amount from this month forward. */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ categoryId: string }> },
): Promise<NextResponse> {
  const session = getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { categoryId } = await params;
  if (!z.uuid().safeParse(categoryId).success) {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }

  await deleteCeiling(session, categoryId);
  return NextResponse.json({ ok: true });
}
