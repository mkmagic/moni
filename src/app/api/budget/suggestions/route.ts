// A starting budget derived from what the user actually spent. Read-only:
// nothing is written until the user accepts, the same posture as
// categorization suggestions (ADR 0002).
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/domain/auth";
import { availableHistoryMonths, proposeBudget } from "@/domain/budget";

/** The three windows the empty state offers. Capped server-side at the
 * history that actually exists, so a user who backfilled three months can't
 * ask for twelve and get nine months of zeros averaged in. */
const WindowSchema = z.coerce
  .number()
  .int()
  .refine((n) => [3, 6, 12].includes(n));

export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const parsed = WindowSchema.safeParse(req.nextUrl.searchParams.get("months"));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }

  const available = await availableHistoryMonths(session);
  const months = Math.min(parsed.data, available);
  if (months < 1) {
    return NextResponse.json({ months: 0, ceilings: [], income: null });
  }

  const proposal = await proposeBudget(session, months);
  return NextResponse.json({ months, ...proposal });
}
