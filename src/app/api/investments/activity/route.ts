import { NextRequest, NextResponse } from "next/server";

import { getSessionFromRequest } from "@/domain/auth";
import { readInvestmentActivity } from "@/domain/investment-activity-resolution";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json(await readInvestmentActivity(session));
}
