import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/domain/auth";
import { revokeGrant } from "@/domain/mcp-oauth";

const ParamsSchema = z.object({ id: z.uuid() });

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const session = getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = ParamsSchema.safeParse(await params);
  if (!parsed.success) return NextResponse.json({ error: "invalid request" }, { status: 400 });
  if (!(await revokeGrant(session.userId, parsed.data.id))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
