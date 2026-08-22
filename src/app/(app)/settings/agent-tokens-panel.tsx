"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { KeyRound, Copy, Check, RefreshCw, Trash2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { AgentConnectGuide } from "./agent-connect-guide";

/** One token as the server component formatted it — all dates already strings
 * (never format a date in a client component: it desyncs on hydration). */
export interface TokenRow {
  id: string;
  label: string | null;
  createdLabel: string;
  lastUsedLabel: string;
  expiresLabel: string;
  revoked: boolean;
  expired: boolean;
}

/** A freshly minted/rotated secret — shown exactly once, then gone. */
interface RevealedSecret {
  secret: string;
  label: string | null;
}

type Ttl = "1d" | "1w" | "1m" | "1y" | "never";
const TTL_OPTIONS: { value: Ttl; label: string }[] = [
  { value: "1d", label: "1 day" },
  { value: "1w", label: "1 week" },
  { value: "1m", label: "1 month" },
  { value: "1y", label: "1 year" },
  { value: "never", label: "Never" },
];

export function AgentTokensPanel({ tokens, endpoint }: { tokens: TokenRow[]; endpoint: string }) {
  const router = useRouter();
  const [label, setLabel] = useState("");
  const [ttl, setTtl] = useState<Ttl>("1m");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<RevealedSecret | null>(null);
  const [confirm, setConfirm] = useState<{ id: string; action: "revoke" | "rotate" } | null>(null);

  async function mint() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/agent-tokens", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: label.trim() || undefined, ttl }),
      });
      if (!res.ok) throw new Error();
      const body = (await res.json()) as { secret: string };
      setRevealed({ secret: body.secret, label: label.trim() || null });
      setLabel("");
      router.refresh();
    } catch {
      setError("Could not create a token — try again.");
    } finally {
      setBusy(false);
    }
  }

  async function rotate(id: string, rowLabel: string | null) {
    setBusy(true);
    setError(null);
    setConfirm(null);
    try {
      const res = await fetch(`/api/agent-tokens/${id}`, { method: "POST" });
      if (!res.ok) throw new Error();
      const body = (await res.json()) as { secret: string };
      setRevealed({ secret: body.secret, label: rowLabel });
      router.refresh();
    } catch {
      setError("Could not rotate that token — try again.");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    setBusy(true);
    setError(null);
    setConfirm(null);
    try {
      const res = await fetch(`/api/agent-tokens/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      router.refresh();
    } catch {
      setError("Could not revoke that token — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {revealed && <SecretReveal revealed={revealed} onDismiss={() => setRevealed(null)} />}

      {/* Mint */}
      <Card>
        <div className="flex flex-col gap-3 px-6 pb-6 pt-6">
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-foreground">Create a token</span>
            <span className="text-xs leading-relaxed text-muted-foreground">
              Give it a name so you can tell your devices apart. The secret is shown once, right
              after you create it.
            </span>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Claude on my laptop"
              maxLength={80}
              className="sm:max-w-xs"
              aria-label="Token name"
            />
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="shrink-0">Expires</span>
              <select
                value={ttl}
                onChange={(e) => setTtl(e.target.value as Ttl)}
                aria-label="Token expiry"
                className="rounded-[var(--radius)] border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              >
                {TTL_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <Button onClick={() => void mint()} disabled={busy} className="shrink-0 sm:ml-auto">
              <KeyRound className="h-4 w-4" />
              Create token
            </Button>
          </div>
          {error && <span className="text-xs text-negative">{error}</span>}
        </div>
      </Card>

      <AgentConnectGuide endpoint={endpoint} />

      {/* List */}
      <Card>
        <div className="flex flex-col px-6 pb-2 pt-6">
          <span className="text-sm font-medium text-foreground">Your tokens</span>
        </div>
        {tokens.length === 0 ? (
          <p className="px-6 pb-6 pt-2 text-xs text-muted-foreground">No tokens yet.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {tokens.map((t) => {
              const dead = t.revoked || t.expired;
              return (
                <li
                  key={t.id}
                  className="flex flex-col gap-3 px-6 py-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex min-w-0 flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <span
                        className={
                          dead
                            ? "truncate text-sm text-muted-foreground line-through"
                            : "truncate text-sm font-medium text-foreground"
                        }
                      >
                        {t.label ?? "Unlabeled token"}
                      </span>
                      <StatusBadge revoked={t.revoked} expired={t.expired} />
                    </div>
                    <span className="text-xs text-muted-foreground">
                      Created {t.createdLabel} · Last used {t.lastUsedLabel} · Expires{" "}
                      {t.expiresLabel}
                    </span>
                  </div>

                  {!dead &&
                    (confirm?.id === t.id ? (
                      <div className="flex shrink-0 items-center gap-2">
                        <span className="text-xs text-muted-foreground">
                          {confirm.action === "revoke"
                            ? "Revoke this token?"
                            : "Rotate this token?"}
                        </span>
                        <Button
                          variant={confirm.action === "revoke" ? "destructive" : "primary"}
                          disabled={busy}
                          onClick={() =>
                            confirm.action === "revoke"
                              ? void revoke(t.id)
                              : void rotate(t.id, t.label)
                          }
                        >
                          Yes
                        </Button>
                        <Button variant="ghost" disabled={busy} onClick={() => setConfirm(null)}>
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      <div className="flex shrink-0 items-center gap-2">
                        <Button
                          variant="outline"
                          disabled={busy}
                          onClick={() => setConfirm({ id: t.id, action: "rotate" })}
                        >
                          <RefreshCw className="h-4 w-4" />
                          Rotate
                        </Button>
                        <Button
                          variant="destructive"
                          disabled={busy}
                          onClick={() => setConfirm({ id: t.id, action: "revoke" })}
                        >
                          <Trash2 className="h-4 w-4" />
                          Revoke
                        </Button>
                      </div>
                    ))}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}

function StatusBadge({ revoked, expired }: { revoked: boolean; expired: boolean }) {
  if (revoked) return <Badge className="border-negative/40 text-negative">Revoked</Badge>;
  if (expired) return <Badge>Expired</Badge>;
  return <Badge className="border-positive/40 text-positive">Active</Badge>;
}

function SecretReveal({
  revealed,
  onDismiss,
}: {
  revealed: RevealedSecret;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(revealed.secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked — the secret is still selectable on screen */
    }
  }

  return (
    <Card className="border-primary/40 bg-primary/5">
      <div className="flex flex-col gap-3 px-6 pb-6 pt-6">
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium text-foreground">
            Token created{revealed.label ? ` · ${revealed.label}` : ""}
          </span>
          <span className="text-xs leading-relaxed text-muted-foreground">
            Copy it now — this is the only time it&apos;s shown. Store it in your agent&apos;s
            config; Moni keeps only a hash.
          </span>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <code className="min-w-0 flex-1 break-all rounded-[var(--radius)] border border-border bg-background px-3 py-2 font-mono text-xs text-foreground">
            {revealed.secret}
          </code>
          <Button variant="outline" onClick={() => void copy()} className="shrink-0">
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
        <div>
          <Button variant="ghost" onClick={onDismiss}>
            Done
          </Button>
        </div>
      </div>
    </Card>
  );
}
