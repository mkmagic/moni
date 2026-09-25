import { NextRequest, NextResponse } from "next/server";

import { getSessionFromRequest } from "@/domain/auth";
import { OpeningCashError, recordOpeningCashForGap } from "@/domain/investment-opening-cash";
import { uuid } from "../../../../route-input";
import { openingCashBody } from "../../../schemas";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const id = uuid.safeParse((await params).id);
  const body = openingCashBody.safeParse(await req.json().catch(() => null));
  if (!id.success || !body.success)
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  try {
    return NextResponse.json(
      await recordOpeningCashForGap({
        userId: session.userId,
        dataKey: session.dataKey,
        queueId: id.data,
        amount: body.data.amount,
      }),
    );
  } catch (error) {
    if (error instanceof OpeningCashError)
      return NextResponse.json(
        { error: error.code.replaceAll("_", " ") },
        { status: error.code === "gap_not_found" ? 404 : 409 },
      );
    throw error;
  }
}
