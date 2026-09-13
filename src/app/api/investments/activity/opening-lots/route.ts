import { NextRequest, NextResponse } from "next/server";

import { getSessionFromRequest } from "@/domain/auth";
import { OpeningLotImportError, promoteSingleOpeningLot } from "@/domain/investment-opening-lots";
import { singleOpeningLotBody } from "../schemas";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = singleOpeningLotBody.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "invalid request" }, { status: 400 });
  try {
    return NextResponse.json(
      await promoteSingleOpeningLot({
        userId: session.userId,
        dataKey: session.dataKey,
        ...body.data,
      }),
    );
  } catch (error) {
    if (error instanceof OpeningLotImportError)
      return NextResponse.json({ error: error.code.replaceAll("_", " ") }, { status: 409 });
    throw error;
  }
}
