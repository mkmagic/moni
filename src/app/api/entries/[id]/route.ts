// Manual categorization of one ledger entry — the write behind the
// categorize dialog. Setting a category here locks the field against every
// rule and model pass forever; passing null clears both
// (docs/design/categorization.md).
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/domain/auth";
import { CategoryNotFoundError, setEntryCategory } from "@/domain/categorization";

// Zod at the trust boundary (docs/design/conventions.md — Validation).
const PatchSchema = z.object({
  categoryId: z.uuid().nullable(),
  /** Also write a rule so future transactions matching this condition get the
   * same category. The operator vocabulary is the description third of the
   * rule form's — amount operators have no meaning for a payee string. */
  createRule: z
    .object({
      operator: z.enum(["contains", "starts_with", "equals"]),
      value: z.string().min(1).max(200),
    })
    .optional(),
});

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

  const body = await req.json().catch(() => null);
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }

  try {
    await setEntryCategory(session, id, parsed.data.categoryId, {
      createRule: parsed.data.createRule,
    });
  } catch (err) {
    // RLS already scoped the lookup to this user, so "not found" covers both
    // a missing row and another user's row — deliberately the same answer.
    if (err instanceof CategoryNotFoundError) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    throw err;
  }

  return NextResponse.json({ ok: true });
}
