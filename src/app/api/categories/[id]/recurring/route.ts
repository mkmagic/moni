// PATCH /api/categories/[id]/recurring — the one gate on the recurring view.
//
// Separate from PATCH /api/categories/[id], which takes a whole category
// body: this is a toggle on a list row, and sending name/colour/icon/parent
// along with it would let a mis-set field overwrite four the user never
// touched.
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/domain/auth";
import { CategoryNotFoundError, setCategoryRecurring } from "@/domain/categorization";

const BodySchema = z.object({ isRecurring: z.boolean() });

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const session = getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  if (!z.uuid().safeParse(id).success) {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }

  try {
    await setCategoryRecurring(session, id, parsed.data.isRecurring);
  } catch (err) {
    if (err instanceof CategoryNotFoundError) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    throw err;
  }

  return NextResponse.json({ ok: true });
}
