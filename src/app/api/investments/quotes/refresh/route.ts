import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/domain/auth";
import { tiingoWorkerConfiguration } from "@/domain/investment-valuation";
import { runTiingoWorker } from "@/lib/investments";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const token = tiingoWorkerConfiguration();
  // No counts here on purpose: nothing ran, so there is nothing to count.
  if (!token) return NextResponse.json({ refreshed: false });
  const result = await runTiingoWorker({
    userId: session.userId,
    dataKey: Buffer.from(session.dataKey),
    token,
  });
  if (!result.ok) return NextResponse.json({ error: "quote_refresh_failed" }, { status: 502 });
  return NextResponse.json({
    refreshed: true,
    attempted: result.attempted,
    updated: result.updated,
  });
}
