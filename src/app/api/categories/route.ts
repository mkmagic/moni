// Category management (the Categories tab). Category names are Tier-2
// plaintext labels (data-model.md §5), so nothing here is encrypted — which
// is also why the tab works without a data key doing any decryption.
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/domain/auth";
import {
  CategoryNotFoundError,
  InvalidCategoryNestingError,
  createCategory,
} from "@/domain/categorization";
import { CategoryBodySchema } from "./schema";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const parsed = CategoryBodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }

  try {
    return NextResponse.json({ id: await createCategory(session, parsed.data) });
  } catch (err) {
    if (err instanceof InvalidCategoryNestingError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof CategoryNotFoundError) {
      return NextResponse.json({ error: "unknown parent category" }, { status: 400 });
    }
    throw err;
  }
}
