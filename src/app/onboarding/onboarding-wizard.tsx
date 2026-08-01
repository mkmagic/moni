"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { KeyRound, Loader2, TriangleAlert } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ConnectFlow } from "@/components/connect-flow";
import { enrollPasskey } from "@/lib/passkey-client";

/** Set up the passkey that encrypts bank logins, connect one or more
 * institutions (each synced as it's added), then the sync-reminder question.
 * The connection loop lives in ConnectFlow, shared with Settings -> Add
 * connection.
 *
 * The passkey step comes FIRST and is not skippable: since issue #7 there is
 * no key to encrypt a bank login under until one exists, so "connect an
 * account" is simply not an available action before it. */
export function OnboardingWizard({ today, hasPasskey }: { today: string; hasPasskey: boolean }) {
  const router = useRouter();
  const [passkeyReady, setPasskeyReady] = useState(hasPasskey);
  const [phase, setPhase] = useState<"passkey" | "connect" | "reminder">(
    hasPasskey ? "connect" : "passkey",
  );

  if (phase === "passkey") {
    return (
      <PasskeyStep
        onDone={() => {
          setPasskeyReady(true);
          setPhase("connect");
        }}
        onSchwab={() => setPhase("connect")}
      />
    );
  }

  if (phase === "connect") {
    return (
      <Card>
        <div className="p-6">
          <ConnectFlow
            today={today}
            allowAddAnother
            credentialedEnabled={passkeyReady}
            doneLabel="Continue"
            onDone={() => setPhase("reminder")}
            pickIntro={
              <div>
                <h2 className="text-base font-semibold text-foreground">Connect an account</h2>
                <p className="text-sm text-muted-foreground">
                  Pick where your money lives. You can add as many as you like.
                </p>
              </div>
            }
          />
        </div>
      </Card>
    );
  }

  return <SyncReminderStep onFinish={() => router.push("/dashboard")} />;
}

/**
 * The first onboarding step: create the passkey that encrypts bank logins.
 *
 * Deliberately blunt about the tradeoff. A user who discovers only later
 * that losing every passkey means re-entering their bank logins has been
 * misled; one sentence here costs nothing and is the whole of what they need
 * to know. Their transactions and balances are unaffected either way — those
 * are unlocked by the login password.
 */
function PasskeyStep({ onDone, onSchwab }: { onDone: () => void; onSchwab: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    const result = await enrollPasskey("My device");
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    onDone();
  }

  return (
    <Card>
      <div className="flex flex-col gap-5 p-6">
        <div>
          <h2 className="text-base font-semibold text-foreground">Set up your passkey</h2>
          <p className="text-sm text-muted-foreground">
            {
              "Your bank logins are encrypted with a key only your device can produce — your Moni password can't open them, and neither can anyone who steals it."
            }
          </p>
        </div>
        <p className="text-xs text-muted-foreground">
          {
            "Your device will ask for Face ID, a fingerprint or your PIN. If you lose every passkey you've set up, you'll have to enter your bank logins again — nothing else is lost."
          }
        </p>
        {error && (
          <div className="flex gap-2.5 rounded-[var(--radius)] border border-negative/30 bg-negative/10 px-4 py-3">
            <TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0 text-negative" />
            <p className="break-words text-xs text-muted-foreground">{error}</p>
          </div>
        )}
        <Button
          type="button"
          onClick={() => void create()}
          disabled={busy}
          className="gap-1.5 self-start"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <KeyRound className="h-3.5 w-3.5" />
          )}
          {busy ? "Waiting for your device…" : "Create passkey"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={onSchwab}
          disabled={busy}
          className="self-start"
        >
          Import a Schwab statement without a passkey
        </Button>
      </div>
    </Card>
  );
}

/**
 * The last onboarding step: opt into the sync reminder. Pre-selected on —
 * it only ever produces an OFFER to sync (never a silent one, and never a use
 * of a stored bank login without the password), so the cost of a default-on
 * is one dismissible card after a long absence.
 */
function SyncReminderStep({ onFinish }: { onFinish: () => void }) {
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function finish() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ autoSyncOnLogin: enabled }),
      });
      if (!res.ok) throw new Error();
      onFinish();
    } catch {
      setError("Could not save that — try again.");
      setSaving(false);
    }
  }

  return (
    <Card>
      <div className="flex flex-col gap-5 p-6">
        <div>
          <h2 className="text-base font-semibold text-foreground">One last thing</h2>
          <p className="text-sm text-muted-foreground">
            You can change this whenever you like, under Settings.
          </p>
        </div>
        <div className="flex items-start justify-between gap-6">
          <div className="flex flex-col gap-1.5">
            <span id="onboardingSyncReminder" className="text-sm font-medium text-foreground">
              Remind me to sync when I sign in
            </span>
            <span className="text-xs leading-relaxed text-muted-foreground">
              {
                "After you've been away a while, Moni offers to refresh every connection. You'll still confirm with your password — that's what unlocks your stored bank logins, and it never happens without you."
              }
            </span>
          </div>
          <Switch
            checked={enabled}
            onCheckedChange={setEnabled}
            aria-labelledby="onboardingSyncReminder"
            className="mt-0.5"
          />
        </div>
        {error && <p className="text-xs text-negative">{error}</p>}
        <Button type="button" onClick={() => void finish()} disabled={saving} className="self-end">
          {saving ? "Saving…" : "Go to dashboard"}
        </Button>
      </div>
    </Card>
  );
}
