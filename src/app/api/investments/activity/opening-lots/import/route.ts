import { NextRequest, NextResponse } from "next/server";

import { getSessionFromRequest } from "@/domain/auth";
import {
  OpeningLotImportError,
  promoteOpeningLotImportAndRefresh,
} from "@/domain/investment-opening-lots";
import { ensureBoiRates } from "@/lib/investments";
import { importBody } from "../../schemas";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = importBody.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "invalid request" }, { status: 400 });
  await ensureBoiRates(
    body.data.rows
      .filter((row) => row.currency !== "ILS")
      .map((row) => ({ currency: row.currency, date: row.tradeDate })),
  );
  try {
    return NextResponse.json(
      await promoteOpeningLotImportAndRefresh({
        userId: session.userId,
        dataKey: session.dataKey,
        rows: body.data.rows,
      }),
    );
  } catch (error) {
    if (error instanceof OpeningLotImportError)
      return NextResponse.json({ error: error.code.replaceAll("_", " ") }, { status: 409 });
    throw error;
  }
}
