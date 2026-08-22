import { headers } from "next/headers";
import { requireSession } from "@/domain/auth";
import { getProfile } from "@/domain/profile";
import { listTokens } from "@/domain/agent-token";
import { listGrants } from "@/domain/mcp-oauth";
import { SmartCategorizePreference } from "../smart-categorize-preference";
import { AgentAccessPreference } from "../agent-access-preference";
import { AgentTokensPanel, type GrantRow, type TokenRow } from "../agent-tokens-panel";

// Dates are formatted server-side with a pinned locale and handed across the
// boundary as strings — the client component holds no date logic (the hydration
// rule, ui-developer feedback 2026-07-26).
const DATE_FMT = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" });

export default async function AiSettingsPage() {
  const session = await requireSession();
  const profile = await getProfile(session.userId);

  if (!profile) {
    return <p className="text-sm text-muted-foreground">Profile unavailable.</p>;
  }

  // The MCP endpoint URL for the connect snippet, built from this request's own
  // host so it is correct for whatever domain the deployment serves on. Behind
  // the TLS proxy the forwarded proto is https; a bare localhost dev host is http.
  const h = await headers();
  const host = h.get("host") ?? "your-moni-host";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const endpoint = `${proto}://${host}/api/mcp`;

  const now = new Date();
  const tokens: TokenRow[] = profile.agentAccessEnabled
    ? (await listTokens(session.userId)).map((t) => ({
        id: t.id,
        label: t.label,
        createdLabel: DATE_FMT.format(t.createdAt),
        lastUsedLabel: t.lastUsedAt ? DATE_FMT.format(t.lastUsedAt) : "Never",
        expiresLabel: t.expiresAt ? DATE_FMT.format(t.expiresAt) : "Never",
        revoked: t.revokedAt !== null,
        expired: t.revokedAt === null && t.expiresAt !== null && t.expiresAt <= now,
      }))
    : [];
  const grants: GrantRow[] = profile.agentAccessEnabled
    ? (await listGrants(session.userId)).map((grant) => ({
        id: grant.id,
        client: new URL(grant.clientId).hostname,
        createdLabel: DATE_FMT.format(grant.createdAt),
        lastUsedLabel: grant.lastUsedAt ? DATE_FMT.format(grant.lastUsedAt) : "Never",
        expiresLabel: grant.expiresAt ? DATE_FMT.format(grant.expiresAt) : "Never",
        revoked: grant.revokedAt !== null,
        expired: grant.revokedAt === null && grant.expiresAt !== null && grant.expiresAt <= now,
      }))
    : [];

  return (
    <div className="flex max-w-xl flex-col gap-8">
      <SmartCategorizePreference initial={profile.smartCategorize} />

      <div className="flex flex-col gap-4">
        <AgentAccessPreference initial={profile.agentAccessEnabled} />
        {profile.agentAccessEnabled && (
          <AgentTokensPanel tokens={tokens} grants={grants} endpoint={endpoint} />
        )}
      </div>
    </div>
  );
}
