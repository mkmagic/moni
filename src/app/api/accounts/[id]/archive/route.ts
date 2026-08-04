import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/domain/auth";
import { archiveAccount } from "@/domain/accounts";

const Params = z.object({ id: z.uuid() });
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = Params.safeParse(await params);
  if (!parsed.success) return NextResponse.json({ error: "invalid request" }, { status: 400 });
  if (!(await archiveAccount(session.userId, parsed.data.id)))
    return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ archived: true });
}
