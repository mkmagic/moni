import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/domain/auth";
import {
  BuiltinCategoryError,
  CategoryHasChildrenError,
  CategoryNotFoundError,
  InvalidCategoryNestingError,
  deleteCategory,
  updateCategory,
} from "@/domain/categorization";
import { CategoryBodySchema } from "../schema";

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

  const parsed = CategoryBodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }

  try {
    await updateCategory(session, id, parsed.data);
  } catch (err) {
    if (err instanceof InvalidCategoryNestingError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof CategoryNotFoundError) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    throw err;
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(
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

  try {
    await deleteCategory(session, id);
  } catch (err) {
    // Both refusals carry a message the user needs to see — "it's built in"
    // and "it still has subcategories" are different fixes.
    if (err instanceof BuiltinCategoryError || err instanceof CategoryHasChildrenError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof CategoryNotFoundError) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    throw err;
  }

  return NextResponse.json({ ok: true });
}
