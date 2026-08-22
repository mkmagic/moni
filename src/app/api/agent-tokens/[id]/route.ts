// Per-token operations for the agent (MCP) surface (issue #113 Phase 5).
//   DELETE — revoke this token (the primary kill switch for one token).
//   POST   — rotate: mint a replacement (inheriting the label) and revoke this
//            one, returning the new one-time secret.
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/domain/auth";
import { AgentAccessDisabledError, revokeToken, rotateToken } from "@/domain/agent-token";

const ParamsSchema = z.object({ id: z.uuid() });

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = ParamsSchema.safeParse(await params);
  if (!parsed.success) return NextResponse.json({ error: "invalid request" }, { status: 400 });

  const revoked = await revokeToken(session.userId, parsed.data.id);
  if (!revoked) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = ParamsSchema.safeParse(await params);
  if (!parsed.success) return NextResponse.json({ error: "invalid request" }, { status: 400 });

  try {
    const minted = await rotateToken(session.userId, session.dataKey, parsed.data.id);
    if (!minted) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json(minted, { status: 201 });
  } catch (err) {
    if (err instanceof AgentAccessDisabledError) {
      return NextResponse.json({ error: "agent access not enabled" }, { status: 403 });
    }
    throw err;
  }
}
