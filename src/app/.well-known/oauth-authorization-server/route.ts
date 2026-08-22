import { NextResponse, type NextRequest } from "next/server";
import { OAuthMetadataSchema } from "@modelcontextprotocol/sdk/shared/auth.js";
import { issuerFromRequest } from "@/lib/mcp/oauth-http";

export function GET(request: NextRequest): NextResponse {
  const issuer = issuerFromRequest(request);
  const metadata = OAuthMetadataSchema.parse({
    issuer,
    authorization_endpoint: `${issuer}/api/oauth/authorize`,
    token_endpoint: `${issuer}/api/oauth/token`,
    revocation_endpoint: `${issuer}/api/oauth/revoke`,
    scopes_supported: ["mcp:read", "offline_access"],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    client_id_metadata_document_supported: true,
  });
  return NextResponse.json(metadata, {
    headers: { "Cache-Control": "public, max-age=300" },
  });
}
