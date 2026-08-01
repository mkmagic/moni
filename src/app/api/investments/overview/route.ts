import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/domain/auth";
import { getPortfolioOverview } from "@/domain/investments";
import { searchParams } from "../route-input";

const Query = z.object({}).strict();
export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!Query.safeParse(searchParams(req)).success)
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  return NextResponse.json(await getPortfolioOverview(session));
}
