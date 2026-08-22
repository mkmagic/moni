import { NextResponse, type NextRequest } from "next/server";
import { OAuthProtectedResourceMetadataSchema } from "@modelcontextprotocol/sdk/shared/auth.js";
import { issuerFromRequest } from "@/lib/mcp/oauth-http";

export function GET(request: NextRequest): NextResponse {
  const issuer = issuerFromRequest(request);
  const metadata = OAuthProtectedResourceMetadataSchema.parse({
    resource: `${issuer}/api/mcp`,
    authorization_servers: [issuer],
    scopes_supported: ["mcp:read"],
    bearer_methods_supported: ["header"],
    resource_name: "Moni read-only personal finance MCP",
  });
  return NextResponse.json(metadata, {
    headers: { "Cache-Control": "public, max-age=300" },
  });
}
