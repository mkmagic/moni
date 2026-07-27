// User-authored categorization rules. Rule condition values are Tier-1
// (they can embed a counterparty), so they are encrypted by the domain layer
// before they ever reach the database — this handler never sees ciphertext.
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/domain/auth";
import { CategoryNotFoundError, listRules, upsertRule } from "@/domain/categorization";
import { RuleBodySchema } from "./schema";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json(await listRules(session));
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const parsed = RuleBodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }

  try {
    // `categorized` is how many uncategorized entries the new rule just
    // claimed — saving a rule applies it immediately, it is not future-only.
    return NextResponse.json(await upsertRule(session, parsed.data));
  } catch (err) {
    if (err instanceof CategoryNotFoundError) {
      return NextResponse.json({ error: "unknown category" }, { status: 400 });
    }
    throw err;
  }
}
