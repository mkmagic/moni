import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/domain/auth";
import { getPortfolioHistory } from "@/domain/investments";
import { isoDate, searchParams } from "../route-input";

const Query = z
  .object({
    start: isoDate,
    end: isoDate,
    groupBy: z.enum(["holding", "account"]).default("holding"),
  })
  .strict()
  .refine((value) => value.start <= value.end);
export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = Query.safeParse(searchParams(req));
  if (!parsed.success) return NextResponse.json({ error: "invalid request" }, { status: 400 });
  return NextResponse.json(
    await getPortfolioHistory(
      session,
      { start: parsed.data.start, end: parsed.data.end },
      parsed.data.groupBy,
    ),
  );
}
