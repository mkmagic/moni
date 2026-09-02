"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Users, UserPlus, Copy, Check, ArrowRight } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

/** One household the caller belongs to, as the server component read it. Names
 * (household + shared lines) are group-readable but authored by another member,
 * so they are rendered as untrusted data — plain text, never as markup. */
export interface HouseholdRow {
  householdId: string;
  name: string;
  memberCount: number;
  sharedCategoryNames: string[];
}

type Ttl = "1d" | "1w" | "1m" | "never";
const TTL_OPTIONS: { value: Ttl; label: string }[] = [
  { value: "1d", label: "1 day" },
  { value: "1w", label: "1 week" },
  { value: "1m", label: "1 month" },
  { value: "never", label: "Never" },
];

export function HouseholdSettingsPanel({ households }: { households: HouseholdRow[] }) {
  const [revealed, setRevealed] = useState<{ secret: string; household: string } | null>(null);

  return (
    <div className="flex flex-col gap-4">
      {revealed && (
        <InviteReveal
          secret={revealed.secret}
          household={revealed.household}
          onDismiss={() => setRevealed(null)}
        />
      )}

      <Card>
        <div data-tour="settings-household" className="flex flex-col gap-1 px-6 pb-2 pt-6">
          <span className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Users className="h-4 w-4 text-muted-foreground" />
            Household sharing
          </span>
          <span className="text-xs leading-relaxed text-muted-foreground">
            {
              "Share a live budget on chosen categories with someone else on this Moni — you each keep your own private ledger, and only a per-category monthly total ever crosses between you. Set up who is in the household here; the combined budget and who-owes-whom live on the Household page."
            }
          </span>
        </div>
      </Card>

      {households.length > 0 && (
        <Card>
          <div className="flex flex-col px-6 pb-2 pt-6">
            <span className="text-sm font-medium text-foreground">Your households</span>
          </div>
          <ul className="flex flex-col divide-y divide-border">
            {households.map((h) => (
              <MembershipRow
                key={h.householdId}
                household={h}
                onInvited={(secret) => setRevealed({ secret, household: h.name })}
              />
            ))}
          </ul>
        </Card>
      )}

      <CreateHousehold />
      <JoinHousehold />
    </div>
  );
}

function MembershipRow({
  household,
  onInvited,
}: {
  household: HouseholdRow;
  onInvited: (secret: string) => void;
}) {
  const [ttl, setTtl] = useState<Ttl>("1w");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function invite() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/households/invite", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ householdId: household.householdId, ttl }),
      });
      if (!res.ok) throw new Error();
      const body = (await res.json()) as { secret: string };
      onInvited(body.secret);
    } catch {
      setError("Could not create an invite — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="flex flex-col gap-3 px-6 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="truncate text-sm font-medium text-foreground">
            <bdi>{household.name}</bdi>
          </span>
          <span className="text-xs text-muted-foreground">
            {household.memberCount} member{household.memberCount === 1 ? "" : "s"}
          </span>
        </div>
        <Link
          href="/household"
          className="flex shrink-0 items-center gap-1 text-xs text-primary underline-offset-2 hover:underline"
        >
          Open household budget
          <ArrowRight className="h-3 w-3" />
        </Link>
      </div>

      {household.sharedCategoryNames.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {household.sharedCategoryNames.map((name, i) => (
            <Badge key={i}>
              <bdi>{name}</bdi>
            </Badge>
          ))}
        </div>
      ) : (
        <span className="text-xs text-muted-foreground">
          No shared categories yet — add them on the Household page.
        </span>
      )}

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="shrink-0">Invite expires</span>
          <select
            value={ttl}
            onChange={(e) => setTtl(e.target.value as Ttl)}
            aria-label="Invite expiry"
            className="rounded-[var(--radius)] border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          >
            {TTL_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <Button
          variant="outline"
          onClick={() => void invite()}
          disabled={busy}
          className="sm:ml-auto"
        >
          <UserPlus className="h-4 w-4" />
          Invite someone
        </Button>
      </div>
      {error && <span className="text-xs text-negative">{error}</span>}
    </li>
  );
}

function CreateHousehold() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/households", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      if (!res.ok) throw new Error();
      setName("");
      router.refresh();
    } catch {
      setError("Could not create the household — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <div className="flex flex-col gap-3 px-6 pb-6 pt-6">
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-foreground">Create a household</span>
          <span className="text-xs leading-relaxed text-muted-foreground">
            Give it a name you and the other person will recognise. You become its first member;
            invite the other from the list above once it exists.
          </span>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Home"
            maxLength={80}
            className="sm:max-w-xs"
            aria-label="Household name"
          />
          <Button
            onClick={() => void create()}
            disabled={busy || name.trim() === ""}
            className="shrink-0 sm:ml-auto"
          >
            <Users className="h-4 w-4" />
            Create household
          </Button>
        </div>
        {error && <span className="text-xs text-negative">{error}</span>}
      </div>
    </Card>
  );
}

function JoinHousehold() {
  const router = useRouter();
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function join() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/households/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ secret: secret.trim() }),
      });
      if (!res.ok) {
        const msg = ((await res.json().catch(() => null)) as { error?: string } | null)?.error;
        setError(msg ?? "Could not join — check the code and try again.");
        return;
      }
      setSecret("");
      router.refresh();
    } catch {
      setError("Could not join — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <div className="flex flex-col gap-3 px-6 pb-6 pt-6">
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-foreground">Join a household</span>
          <span className="text-xs leading-relaxed text-muted-foreground">
            Paste the one-time invite code the other person shared with you. It unlocks their shared
            budget for you and enrols you as a member.
          </span>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Input
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder="moni_hh_invite_…"
            className="font-mono sm:max-w-xs"
            aria-label="Invite code"
          />
          <Button
            onClick={() => void join()}
            disabled={busy || secret.trim() === ""}
            className="shrink-0 sm:ml-auto"
          >
            <UserPlus className="h-4 w-4" />
            Join
          </Button>
        </div>
        {error && <span className="text-xs text-negative">{error}</span>}
      </div>
    </Card>
  );
}

function InviteReveal({
  secret,
  household,
  onDismiss,
}: {
  secret: string;
  household: string;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked — the code is still selectable on screen */
    }
  }

  return (
    <Card className="border-primary/40 bg-primary/5">
      <div className="flex flex-col gap-3 px-6 pb-6 pt-6">
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium text-foreground">
            Invite code for <bdi>{household}</bdi>
          </span>
          <span className="text-xs leading-relaxed text-muted-foreground">
            {
              "Send this to the person you're inviting — this is the only time it's shown, and Moni keeps only a hash. Anyone who has it can join the household and see the shared totals, so share it directly and let it expire."
            }
          </span>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <code className="min-w-0 flex-1 break-all rounded-[var(--radius)] border border-border bg-background px-3 py-2 font-mono text-xs text-foreground">
            {secret}
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
