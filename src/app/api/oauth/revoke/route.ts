import { NextResponse } from "next/server";
import { OAuthTokenRevocationRequestSchema } from "@modelcontextprotocol/sdk/shared/auth.js";
import { revokeByRefreshToken } from "@/domain/mcp-oauth";

export async function POST(request: Request): Promise<NextResponse> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/x-www-form-urlencoded")) {
    return NextResponse.json({ error: "invalid_request" }, { status: 415 });
  }
  const form = await request.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const parsed = OAuthTokenRevocationRequestSchema.safeParse(Object.fromEntries(form));
  if (!parsed.success) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  await revokeByRefreshToken(parsed.data.token);
  return new NextResponse(null, { status: 200, headers: { "Cache-Control": "no-store" } });
}
