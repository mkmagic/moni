import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/domain/auth";
import {
  CategoryNotFoundError,
  RuleNotFoundError,
  deleteRule,
  setRuleActive,
  upsertRule,
} from "@/domain/categorization";
import { RulePatchSchema } from "../schema";

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

  const parsed = RulePatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }

  try {
    // The active-only shape is the row toggle; the full shape is the form.
    // Either way the saved rule runs immediately over everything still
    // uncategorized, and `categorized` reports how many it claimed.
    const categorized =
      "categoryId" in parsed.data
        ? (await upsertRule(session, { ...parsed.data, id })).categorized
        : await setRuleActive(session, id, parsed.data.active);
    return NextResponse.json({ ok: true, categorized });
  } catch (err) {
    if (err instanceof RuleNotFoundError) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    if (err instanceof CategoryNotFoundError) {
      return NextResponse.json({ error: "unknown category" }, { status: 400 });
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
    await deleteRule(session, id);
  } catch (err) {
    if (err instanceof RuleNotFoundError) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    throw err;
  }

  return NextResponse.json({ ok: true });
}
