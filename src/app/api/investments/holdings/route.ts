import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/domain/auth";
import { listPortfolioHoldings } from "@/domain/investments";
import { isPortfolioInputError, page, searchParams, uuid } from "../route-input";

const Query = page
  .extend({
    connectionId: uuid.optional(),
    accountId: uuid.optional(),
    instrumentKind: z.enum(["stock", "etf", "mutual_fund", "generic"]).optional(),
    kind: z.enum(["position", "cash"]).optional(),
    freshness: z.enum(["current", "stale", "mixed_age"]).optional(),
    basis: z.enum(["broker_source", "tiingo_estimate", "mixed"]).optional(),
  })
  .strict();
export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = Query.safeParse(searchParams(req));
  if (!parsed.success) return NextResponse.json({ error: "invalid request" }, { status: 400 });
  try {
    return NextResponse.json(await listPortfolioHoldings(session, parsed.data));
  } catch (error) {
    if (isPortfolioInputError(error))
      return NextResponse.json({ error: "invalid cursor" }, { status: 400 });
    throw error;
  }
}
