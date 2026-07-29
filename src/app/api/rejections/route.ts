// Thumbs-down on a suggestion — the write behind the ✗ on a suggestion chip.
//
// A rejection is scoped to the MATCH TEXT, not to the transaction the user
// clicked, so one click clears a wrong guess from every entry sharing that
// text (docs/design/categorization.md §10). It suppresses suggestions only:
// a rule may still assign the same category.
//
// There is no accept counterpart. Accepting a suggestion is an ordinary
// categorization and goes through PATCH /api/entries/[id] unchanged.
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/domain/auth";
import { CategoryNotFoundError, rejectSuggestion } from "@/domain/categorization";

// Zod at the trust boundary (docs/design/conventions.md — Validation). The
// match text is bounded like the rule form's, since both end up as one
// encrypted condition-sized value.
const PostSchema = z.object({
  matchText: z.string().min(1).max(200),
  categoryId: z.uuid(),
});

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const parsed = PostSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }

  try {
    await rejectSuggestion(session, parsed.data.matchText, parsed.data.categoryId);
  } catch (err) {
    // RLS already scoped the lookup, so "not found" covers both a missing
    // category and another user's — deliberately the same answer.
    if (err instanceof CategoryNotFoundError) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    throw err;
  }

  return NextResponse.json({ ok: true });
}
