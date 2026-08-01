import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/domain/auth";
import { getPortfolioSnapshot } from "@/domain/investments";
import { isoDate, isPortfolioInputError, page, searchParams } from "../../route-input";

const Params = z.object({ week: isoDate });
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ week: string }> },
): Promise<NextResponse> {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsedParams = Params.safeParse(await params);
  const parsedQuery = page.strict().safeParse(searchParams(req));
  if (!parsedParams.success || !parsedQuery.success)
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  try {
    return NextResponse.json(
      await getPortfolioSnapshot(session, parsedParams.data.week, parsedQuery.data),
    );
  } catch (error) {
    if (isPortfolioInputError(error))
      return NextResponse.json({ error: "invalid cursor" }, { status: 400 });
    throw error;
  }
}
