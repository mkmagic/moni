import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/domain/auth";
import { buildPerformanceView } from "@/app/(app)/investments/performance/view";
import { searchParams, uuid } from "../route-input";

const Query = z.object({ accountId: uuid.optional() }).strict();

export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = Query.safeParse(searchParams(req));
  if (!parsed.success) return NextResponse.json({ error: "invalid request" }, { status: 400 });
  return NextResponse.json(await buildPerformanceView(session, parsed.data.accountId));
}
