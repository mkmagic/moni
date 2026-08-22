"use client";

import { useState } from "react";
import { Copy, Check } from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

// Placeholder the user swaps for the secret shown once at mint time. Never a
// real token — this component only knows the endpoint, not any secret.
const TOKEN = "moni_agent_YOUR_TOKEN";

type TabKey = "claude-code" | "claude-desktop" | "codex" | "curl";

const TABS: { key: TabKey; label: string; lang: string }[] = [
  { key: "claude-code", label: "Claude Code", lang: "bash" },
  { key: "claude-desktop", label: "Claude Desktop", lang: "json" },
  { key: "codex", label: "Codex", lang: "toml" },
  { key: "curl", label: "curl", lang: "bash" },
];

function snippet(key: TabKey, endpoint: string): string {
  switch (key) {
    case "claude-code":
      return [
        "claude mcp add --transport http moni \\",
        `  ${endpoint} \\`,
        `  --header "Authorization: Bearer ${TOKEN}"`,
      ].join("\n");
    case "claude-desktop":
      // Claude Desktop speaks stdio, so a remote server is reached through the
      // mcp-remote bridge. Add this to claude_desktop_config.json.
      return JSON.stringify(
        {
          mcpServers: {
            moni: {
              command: "npx",
              args: ["-y", "mcp-remote", endpoint, "--header", `Authorization: Bearer ${TOKEN}`],
            },
          },
        },
        null,
        2,
      );
    case "codex":
      // ~/.codex/config.toml — same mcp-remote bridge for a stdio client.
      return [
        "[mcp_servers.moni]",
        'command = "npx"',
        `args = ["-y", "mcp-remote", "${endpoint}", "--header", "Authorization: Bearer ${TOKEN}"]`,
      ].join("\n");
    case "curl":
      return [
        `curl -X POST ${endpoint} \\`,
        `  -H "Authorization: Bearer ${TOKEN}" \\`,
        '  -H "Accept: application/json, text/event-stream" \\',
        '  -H "Content-Type: application/json" \\',
        `  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
      ].join("\n");
  }
}

export function AgentConnectGuide({ endpoint }: { endpoint: string }) {
  const [tab, setTab] = useState<TabKey>("claude-code");
  const [copiedEndpoint, setCopiedEndpoint] = useState(false);
  const [copiedSnippet, setCopiedSnippet] = useState(false);

  const code = snippet(tab, endpoint);

  async function copyEndpoint() {
    try {
      await navigator.clipboard.writeText(endpoint);
      setCopiedEndpoint(true);
      setTimeout(() => setCopiedEndpoint(false), 2000);
    } catch {
      /* clipboard blocked — the URL is still selectable on screen */
    }
  }

  async function copySnippet() {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedSnippet(true);
      setTimeout(() => setCopiedSnippet(false), 2000);
    } catch {
      /* clipboard blocked — the snippet is still selectable on screen */
    }
  }

  return (
    <Card>
      <div className="flex flex-col gap-3 px-6 pb-6 pt-6">
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-foreground">Connect an agent</span>
          <span className="text-xs leading-relaxed text-muted-foreground">
            Add this URL in Claude or ChatGPT and choose OAuth.
          </span>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">OAuth connector URL</span>
          <div className="flex items-center gap-2 rounded-[var(--radius)] border border-border bg-background p-2">
            <code className="min-w-0 flex-1 select-all truncate px-1 font-mono text-xs text-foreground">
              {endpoint}
            </code>
            <button
              onClick={() => void copyEndpoint()}
              aria-label="Copy OAuth connector URL"
              className="inline-flex shrink-0 items-center gap-1.5 rounded-[var(--radius)] border border-border bg-card px-2.5 py-1.5 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground"
            >
              {copiedEndpoint ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
              {copiedEndpoint ? "Copied" : "Copy"}
            </button>
          </div>
        </div>

        <span className="text-xs leading-relaxed text-muted-foreground">
          Manual setup: create a token below, then replace{" "}
          <code className="font-mono">{TOKEN}</code> in a snippet.
        </span>

        {/* Tabs */}
        <div className="overflow-x-auto">
          <div className="flex w-max gap-1">
            {TABS.map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={cn(
                  "shrink-0 rounded-[var(--radius)] border px-3 py-1.5 text-xs transition",
                  tab === key
                    ? "border-primary/60 bg-primary/10 text-foreground"
                    : "border-border bg-card text-muted-foreground hover:border-primary/50 hover:bg-muted",
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Snippet */}
        <div className="relative">
          <pre className="overflow-x-auto rounded-[var(--radius)] border border-border bg-background px-3 py-3 pr-12 font-mono text-xs leading-relaxed text-foreground">
            <code>{code}</code>
          </pre>
          <button
            onClick={() => void copySnippet()}
            aria-label="Copy snippet"
            className="absolute right-2 top-2 rounded-[var(--radius)] border border-border bg-card p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
          >
            {copiedSnippet ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>
    </Card>
  );
}
