// Create a shared budget line in a household (issue #115). The name is
// plaintext and deliberately shared with every member. Splits, mappings, and
// the household ceiling are set afterwards via the [id] PATCH route.
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/domain/auth";
import { SharedCategoryError, createSharedCategory } from "@/domain/shared-categories";
import { CreateSharedCategorySchema } from "../schema";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const parsed = CreateSharedCategorySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid request" }, { status: 400 });

  try {
    const { sharedCategoryId } = await createSharedCategory(
      session.userId,
      parsed.data.householdId,
      parsed.data.name,
      { isRecurring: parsed.data.isRecurring },
    );
    return NextResponse.json({ sharedCategoryId }, { status: 201 });
  } catch (err) {
    if (err instanceof SharedCategoryError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}
