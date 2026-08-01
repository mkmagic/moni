import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/domain/auth";
import { tiingoWorkerConfiguration } from "@/domain/investment-valuation";
import { runTiingoWorker } from "@/lib/investments";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const token = tiingoWorkerConfiguration();
  if (!token) return NextResponse.json({ refreshed: false });
  const refreshed = await runTiingoWorker({
    userId: session.userId,
    dataKey: Buffer.from(session.dataKey),
    token,
  });
  if (!refreshed) return NextResponse.json({ error: "quote_refresh_failed" }, { status: 502 });
  return NextResponse.json({ refreshed: true });
}
