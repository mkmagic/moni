// Ceilings: set one, or accept a whole suggested budget at once.
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/domain/auth";
import {
  BudgetBranchConflictError,
  BudgetCategoryNotBudgetableError,
  createCeilings,
  setCeiling,
} from "@/domain/budget";
import { CeilingBatchSchema, CeilingBodySchema } from "../schema";

/** Both "a group and its children are both budgeted" and "that category
 * cannot take a ceiling" are the user telling the app something it must
 * refuse — a 400 with the domain layer's own wording, which already names
 * the offending category. */
function budgetError(err: unknown): NextResponse | null {
  if (err instanceof BudgetBranchConflictError || err instanceof BudgetCategoryNotBudgetableError) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
  return null;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const batch = CeilingBatchSchema.safeParse(body);
  if (batch.success) {
    try {
      return NextResponse.json({ created: await createCeilings(session, batch.data.ceilings) });
    } catch (err) {
      const response = budgetError(err);
      if (response) return response;
      throw err;
    }
  }

  const single = CeilingBodySchema.safeParse(body);
  if (!single.success) {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }
  try {
    await setCeiling(session, single.data);
  } catch (err) {
    const response = budgetError(err);
    if (response) return response;
    throw err;
  }
  return NextResponse.json({ ok: true });
}
