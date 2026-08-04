import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/domain/auth";
import { RESIDUAL_KEY, deleteCeiling } from "@/domain/budget";

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

  // The residual ceiling has no category to name it in the path, so it is
  // addressed by the same literal the domain layer uses for its map key.
  const { categoryId } = await params;
  const target = categoryId === RESIDUAL_KEY ? null : categoryId;
  if (target !== null && !z.uuid().safeParse(target).success) {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }

  await deleteCeiling(session, target);
  return NextResponse.json({ ok: true });
}
