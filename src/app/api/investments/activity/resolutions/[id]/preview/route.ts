import { NextRequest, NextResponse } from "next/server";

import { getSessionFromRequest } from "@/domain/auth";
import {
  InvestmentResolutionError,
  previewDisposalResolution,
} from "@/domain/investment-activity-resolution";
import { allocationBody } from "../../../schemas";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = allocationBody.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "invalid request" }, { status: 400 });
  try {
    return NextResponse.json(
      await previewDisposalResolution(session, (await params).id, body.data.allocations),
    );
  } catch (error) {
    if (error instanceof InvestmentResolutionError)
      return NextResponse.json(
        { error: error.code.replaceAll("_", " ") },
        { status: error.code === "not_found" ? 404 : 409 },
      );
    throw error;
  }
}
