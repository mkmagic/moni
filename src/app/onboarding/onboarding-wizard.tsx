"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { InstitutionPicker } from "@/components/institution-picker";
import { ConnectForm } from "@/components/connect-form";
import type { ConnectorId } from "@/lib/connectors";

type Step =
  | { kind: "pick" }
  | { kind: "connect"; connectorId: ConnectorId }
  | { kind: "syncing"; syncRunId: string; status: string; error: string | null };

/** Institution picker -> connect form -> first sync (docs plan §A3). The
 * connect form arms the credential window inline on success, so the sync
 * kicked off here needs no second password prompt. */
export function OnboardingWizard() {
  const router = useRouter();
  const [step, setStep] = useState<Step>({ kind: "pick" });

  async function onConnected(connectionId: string) {
    try {
      const res = await fetch(`/api/connections/${connectionId}/sync`, { method: "POST" });
      if (res.status === 202) {
        const body = (await res.json()) as { syncRunId: string };
        setStep({ kind: "syncing", syncRunId: body.syncRunId, status: "pending", error: null });
        return;
      }
    } catch {
      // fall through to the dashboard below
    }
    // The connection itself was created successfully even if the sync
    // couldn't be kicked off (unexpected — first-connect arms inline). The
    // zero-connections redirect no longer applies now that one exists; the
    // user can retry the sync from /settings.
    router.push("/dashboard");
    router.refresh();
  }

  useEffect(() => {
    if (step.kind !== "syncing") return;
    if (step.status === "succeeded" || step.status === "failed") return;
    const timer = setInterval(async () => {
      const res = await fetch(`/api/sync-runs/${step.syncRunId}`);
      if (!res.ok) return;
      const run = (await res.json()) as { status: string; error: string | null };
      setStep((s) => (s.kind === "syncing" ? { ...s, status: run.status, error: run.error } : s));
    }, 2000);
    return () => clearInterval(timer);
  }, [step]);

  function goToDashboard() {
    router.push("/dashboard");
    router.refresh();
  }

  if (step.kind === "pick") {
    return (
      <Card>
        <div className="p-6">
          <h1 className="mb-1 text-xl font-semibold">Connect an account</h1>
          <p className="mb-5 text-sm text-muted-foreground">
            Pick where your money lives. You can add more institutions later.
          </p>
          <InstitutionPicker
            onSelect={(connectorId) => setStep({ kind: "connect", connectorId })}
          />
        </div>
      </Card>
    );
  }

  if (step.kind === "connect") {
    return (
      <Card>
        <div className="p-6">
          <h1 className="mb-1 text-xl font-semibold">Enter your login</h1>
          <p className="mb-5 text-sm text-muted-foreground">
            We&apos;ll fetch the last 30 days to get you started.
          </p>
          <ConnectForm
            connectorId={step.connectorId}
            onBack={() => setStep({ kind: "pick" })}
            onConnected={onConnected}
          />
        </div>
      </Card>
    );
  }

  // step.kind === "syncing"
  const succeeded = step.status === "succeeded";
  const failed = step.status === "failed";
  return (
    <Card>
      <div className="flex flex-col items-center gap-4 p-8 text-center">
        {!succeeded && !failed && (
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        )}
        {succeeded && <CheckCircle2 className="h-8 w-8 text-positive" />}
        {failed && <XCircle className="h-8 w-8 text-negative" />}
        <div>
          <p className="text-sm font-medium text-foreground">
            {succeeded ? "All set" : failed ? "Sync failed" : "Fetching your transactions…"}
          </p>
          <p className="text-xs text-muted-foreground">
            {succeeded
              ? "Your account is connected and up to date."
              : failed
                ? "The connection was saved — you can retry the sync from Settings."
                : "This can take a minute for the first sync."}
          </p>
          {/* The run's own error, verbatim — without it a failure here is
              indistinguishable between a wrong password and a bank that
              never finished loading. */}
          {failed && step.error && (
            <p className="mt-2 break-words text-xs text-negative">{step.error}</p>
          )}
        </div>
        {(succeeded || failed) && <Button onClick={goToDashboard}>Go to dashboard</Button>}
      </div>
    </Card>
  );
}
