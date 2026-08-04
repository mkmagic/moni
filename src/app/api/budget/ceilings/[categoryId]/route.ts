import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { MonthQuerySchema } from "../../schema";
import { getSessionFromRequest } from "@/domain/auth";
import { RESIDUAL_KEY, endCeiling } from "@/domain/budget";

/** Stops budgeting a category from the given month forward. Earlier months
 * keep the ceilings they had — nothing is erased, so a finished month still
 * reads as it was lived. */
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

  const month = req.nextUrl.searchParams.get("month");
  if (!month || !MonthQuerySchema.safeParse(month).success) {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }

  await endCeiling(session, target, month);
  return NextResponse.json({ ok: true });
}
