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
        onSkip={() => setPhase("connect")}
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

  return <AdditionalSettingsStep onFinish={() => router.push("/dashboard")} />;
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
function PasskeyStep({ onDone, onSkip }: { onDone: () => void; onSkip: () => void }) {
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
        {/* Named by what it costs, not by the one connector it used to name.
            "Or upload a Schwab csv" was already wrong the day a second file
            import existed, and it framed the skip as being about one file
            format rather than about which sources stay out of reach. */}
        <div className="flex flex-col gap-1.5 border-t border-border pt-5">
          <Button
            type="button"
            variant="ghost"
            onClick={onSkip}
            disabled={busy}
            // Not `px-0`: `cn` is a plain join, so the primitive's own `px-4`
            // wins by stylesheet order and the label sits 16px right of the
            // sentence under it. A negative margin isn't fighting a utility.
            className="-ml-4 self-start"
          >
            Skip for now
          </Button>
          <p className="text-xs text-muted-foreground">
            {
              "You can still import files — a broker statement or a provider's report. Linking a bank, card or broker with a stored login needs a passkey; you can set one up later under Settings › Connections."
            }
          </p>
        </div>
      </div>
    </Card>
  );
}

interface SettingOption {
  key: "autoSyncOnLogin" | "smartCategorize";
  id: string;
  title: string;
  description: string;
  defaultValue: boolean;
}

const ADDITIONAL_SETTINGS: SettingOption[] = [
  {
    key: "autoSyncOnLogin",
    id: "onboardingSyncReminder",
    title: "Remind me to sync when I sign in",
    description:
      "After you've been away a while, Moni offers to refresh every connection. You'll still confirm with your password — that's what unlocks your stored bank logins, and it never happens without you.",
    defaultValue: true,
  },
  {
    key: "smartCategorize",
    id: "onboardingSmartCategorize",
    title: "Smart Categorize with AI",
    description:
      "Send unrecognized merchant names to an AI model to suggest categories. Merchant names only — never amounts, dates, or accounts. Smart Categorization is triggered manually.",
    defaultValue: true,
  },
];

/**
 * The last onboarding step: "Additional Settings before we start..."
 * Modular toggles for initial profile preferences.
 */
function AdditionalSettingsStep({ onFinish }: { onFinish: () => void }) {
  const [settings, setSettings] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(ADDITIONAL_SETTINGS.map((s) => [s.key, s.defaultValue])),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(key: string, value: boolean) {
    setSettings((prev) => ({ ...prev, [key]: value }));
  }

  async function finish() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(settings),
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
      <div className="flex flex-col gap-6 p-6">
        <div>
          <h2 className="text-base font-semibold text-foreground">
            Additional Settings before we start…
          </h2>
          <p className="text-sm text-muted-foreground">
            You can change these whenever you like, under Settings.
          </p>
        </div>

        <div className="flex flex-col gap-6 divide-y divide-border">
          {ADDITIONAL_SETTINGS.map((item, idx) => (
            <div key={item.key} className={idx > 0 ? "pt-6" : ""}>
              <div className="flex items-start justify-between gap-6">
                <div className="flex flex-col gap-1.5">
                  <span id={item.id} className="text-sm font-medium text-foreground">
                    {item.title}
                  </span>
                  <span className="text-xs leading-relaxed text-muted-foreground">
                    {item.description}
                  </span>
                </div>
                <Switch
                  checked={Boolean(settings[item.key])}
                  onCheckedChange={(checked) => toggle(item.key, checked)}
                  aria-labelledby={item.id}
                  className="mt-0.5"
                />
              </div>
            </div>
          ))}
        </div>

        {error && <p className="text-xs text-negative">{error}</p>}

        <Button type="button" onClick={() => void finish()} disabled={saving} className="self-end">
          {saving ? "Saving…" : "Go to dashboard"}
        </Button>
      </div>
    </Card>
  );
}
