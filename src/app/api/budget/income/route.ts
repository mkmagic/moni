// Planned monthly income — one effective-dated figure per user.
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/domain/auth";
import { setPlannedIncome } from "@/domain/budget";
import { PlannedIncomeBodySchema } from "../schema";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const parsed = PlannedIncomeBodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }

  await setPlannedIncome(session, parsed.data.amount, parsed.data.effectiveFrom);
  return NextResponse.json({ ok: true });
}
