// Token-management API for the agent (MCP) surface (issue #113 Phase 5,
// docs/design/mcp-and-api.md §4). Same-origin, session-authenticated: the UI at
// /settings/ai calls these to list and mint the caller's own tokens.
//
// Minting is the one operation that needs DK in RAM — the new token re-wraps
// the user's data key — so it reads DK from the live web session (the only
// place DK exists behind the password) and never asks for it again.
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/domain/auth";
import { AgentAccessDisabledError, listTokens, mintToken } from "@/domain/agent-token";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Token lifetimes offered in the UI → ttlMs (null = never expires). */
const TTL_MS: Record<string, number | null> = {
  "1d": DAY_MS,
  "1w": 7 * DAY_MS,
  "1m": 30 * DAY_MS,
  "1y": 365 * DAY_MS,
  never: null,
};

const MintSchema = z.object({
  label: z.string().trim().max(80).optional(),
  ttl: z.enum(["1d", "1w", "1m", "1y", "never"]).optional(),
});

export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const tokens = await listTokens(session.userId);
  return NextResponse.json({ tokens });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const parsed = MintSchema.safeParse(body ?? {});
  if (!parsed.success) return NextResponse.json({ error: "invalid request" }, { status: 400 });

  try {
    // Reads the live session's DK; mintToken copies it internally and never
    // wipes the session's own key. An omitted ttl falls back to the domain's
    // default backstop; "never" maps to a null (no-expiry) token.
    const ttlMs = parsed.data.ttl ? TTL_MS[parsed.data.ttl] : undefined;
    const minted = await mintToken(session.userId, session.dataKey, {
      label: parsed.data.label,
      ttlMs,
    });
    // The secret appears in this response exactly once and is never stored
    // server-side (only its SHA-256 hash is).
    return NextResponse.json(minted, { status: 201 });
  } catch (err) {
    if (err instanceof AgentAccessDisabledError) {
      return NextResponse.json({ error: "agent access not enabled" }, { status: 403 });
    }
    throw err;
  }
}
