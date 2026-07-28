"use client";

import { useState, type ReactNode } from "react";
import { CheckCircle2, Link2, Loader2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ArmPrompt } from "@/components/arm-prompt";
import { InstitutionPicker } from "@/components/institution-picker";
import { ConnectForm } from "@/components/connect-form";
import { ConnectionEditForm } from "@/components/connection-edit-form";
import { BackfillWindowPicker } from "@/components/backfill-window-picker";
import { BACKFILL_PRESETS, presetStartDate } from "@/lib/backfill-window";
import { classifySyncFailure } from "@/lib/sync-error";
import { startSyncRun, waitForSyncRun } from "@/lib/sync-client";
import { getConnectorDefinition, type ConnectorId } from "@/lib/connectors";

/** Institution -> credentials + backfill window -> first sync -> outcome. One
 * component for both entry points (onboarding and Settings -> Add connection)
 * so the backfill window, the failure branches, and the retry paths can't
 * drift apart. */
interface ConnectFlowProps {
  /** Today's calendar date (`YYYY-MM-DD`) from the SERVER — see
   * BackfillWindowPicker. */
  today: string;
  /** Runs after a connection finishes syncing and the user leaves the flow. */
  onDone: () => void;
  doneLabel: string;
  /** Offer "Add another account" on the outcome screen (onboarding does). */
  allowAddAnother?: boolean;
  /** Optional copy above the institution picker. */
  pickIntro?: ReactNode;
}

/** The connection under way, carried through every post-connect step. */
interface Target {
  connectionId: string;
  connectorId: ConnectorId;
  displayName: string | null;
}

type Step =
  | { kind: "pick" }
  | { kind: "connect"; connectorId: ConnectorId }
  | { kind: "syncing"; target: Target }
  | { kind: "succeeded"; target: Target }
  /** Connected with "Nothing for now" — no sync was ever started. */
  | { kind: "skipped"; target: Target }
  | { kind: "failed"; target: Target; error: string | null }
  /** A credential failure the user chose to repair — the edit form, inline. */
  | { kind: "fixing"; target: Target }
  /** 423: the credential window lapsed between connecting and retrying. */
  | { kind: "locked"; target: Target };

/** Matches what an unpicked first sync fetched before the backfill window
 * existed, so the default changes nothing for a user who ignores the picker. */
const DEFAULT_PRESET = BACKFILL_PRESETS[0];

export function ConnectFlow({
  today,
  onDone,
  doneLabel,
  allowAddAnother = false,
  pickIntro,
}: ConnectFlowProps) {
  const [step, setStep] = useState<Step>({ kind: "pick" });
  /** `null` means "connect but fetch nothing" — see BackfillWindowPicker. */
  const [startDate, setStartDate] = useState<string | null>(() =>
    presetStartDate(DEFAULT_PRESET, today),
  );
  const [addedCount, setAddedCount] = useState(0);

  /** Called once the connection row exists. Honours "Nothing for now" by never
   * starting a scrape at all — the connection is complete either way. */
  function afterConnected(target: Target) {
    setAddedCount((n) => n + 1);
    if (startDate === null) {
      setStep({ kind: "skipped", target });
      return;
    }
    void runSync(target);
  }

  /** Starts the first sync for `target` and drives it to a terminal step. The
   * chosen `startDate` rides along on every attempt, including retries — it
   * lives only in this component's state (ADR 0001). Only reached with a
   * non-null `startDate`; `?? undefined` keeps that honest for the retry
   * paths rather than silently sending "no window". */
  async function runSync(target: Target) {
    setStep({ kind: "syncing", target });
    const started = await startSyncRun(target.connectionId, startDate ?? undefined);
    if (started.kind === "locked") {
      setStep({ kind: "locked", target });
      return;
    }
    if (started.kind === "error") {
      setStep({ kind: "failed", target, error: started.message });
      return;
    }
    const run = await waitForSyncRun(started.syncRunId);
    if (run.status === "succeeded") {
      // Not counted here — afterConnected already counted the connection, and
      // this function also runs on every retry.
      setStep({ kind: "succeeded", target });
      return;
    }
    setStep({ kind: "failed", target, error: run.error });
  }

  function addAnother() {
    setStartDate(presetStartDate(DEFAULT_PRESET, today));
    setStep({ kind: "pick" });
  }

  if (step.kind === "pick") {
    return (
      <div className="flex flex-col gap-5">
        {pickIntro}
        <InstitutionPicker onSelect={(connectorId) => setStep({ kind: "connect", connectorId })} />
        {/* Only once something is connected — before that, leaving is what the
            zero-connections redirect already prevents. */}
        {addedCount > 0 && (
          <Button type="button" variant="ghost" onClick={onDone} className="self-start px-0">
            {doneLabel}
          </Button>
        )}
      </div>
    );
  }

  if (step.kind === "connect") {
    return (
      <div className="flex flex-col gap-5">
        <div>
          <h2 className="text-base font-semibold text-foreground">Enter your login</h2>
          <p className="text-sm text-muted-foreground">
            {startDate === null
              ? "We'll link the account without fetching anything yet."
              : "We'll fetch your transactions as soon as it's connected."}
          </p>
        </div>
        <BackfillWindowPicker today={today} value={startDate} onChange={setStartDate} />
        <div className="border-t border-border pt-5">
          <ConnectForm
            connectorId={step.connectorId}
            onBack={() => setStep({ kind: "pick" })}
            onConnected={(connectionId, displayName) =>
              afterConnected({ connectionId, connectorId: step.connectorId, displayName })
            }
          />
        </div>
      </div>
    );
  }

  if (step.kind === "fixing") {
    const def = getConnectorDefinition(step.target.connectorId);
    return (
      <div className="flex flex-col gap-4">
        <div>
          <h2 className="text-base font-semibold text-foreground">Check your login details</h2>
          <p className="text-sm text-muted-foreground">
            {`${def?.label ?? step.target.connectorId} rejected the details we stored. Re-enter them and we'll try the sync again.`}
          </p>
        </div>
        <ConnectionEditForm
          connectionId={step.target.connectionId}
          connectorId={step.target.connectorId}
          displayName={step.target.displayName}
          startReplacing
          saveLabel="Save & retry"
          className="border-t-0 px-0 pb-0 pt-0"
          onCancel={() => setStep({ kind: "failed", target: step.target, error: null })}
          onSaved={() => void runSync(step.target)}
        />
      </div>
    );
  }

  if (step.kind === "locked") {
    return (
      <Outcome
        icon={<XCircle className="h-8 w-8 text-muted-foreground" />}
        title="Confirm it's you"
        body="Your password unlocks the stored bank login. It's needed again because a few minutes have passed."
      >
        <ArmPrompt label="Unlock and retry" onArm={() => void runSync(step.target)} />
      </Outcome>
    );
  }

  if (step.kind === "syncing") {
    return (
      <Outcome
        icon={<Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />}
        title="Fetching your transactions…"
        body="This can take a minute for the first sync."
      />
    );
  }

  if (step.kind === "succeeded" || step.kind === "skipped") {
    const skipped = step.kind === "skipped";
    return (
      <Outcome
        icon={
          skipped ? (
            <Link2 className="h-8 w-8 text-muted-foreground" />
          ) : (
            <CheckCircle2 className="h-8 w-8 text-positive" />
          )
        }
        title={skipped ? "Connected" : "All set"}
        body={
          skipped
            ? "We haven't fetched anything yet — sync it from the dashboard whenever you're ready."
            : addedCount > 1
              ? `${addedCount} accounts connected.`
              : "Your account is connected and up to date."
        }
      >
        {allowAddAnother && (
          <Button type="button" variant="outline" onClick={addAnother}>
            Add another account
          </Button>
        )}
        <Button type="button" onClick={onDone}>
          {doneLabel}
        </Button>
      </Outcome>
    );
  }

  // step.kind === "failed". The connection itself was saved, so both exits
  // below leave the user with a connection they can sync later.
  const kind = classifySyncFailure(step.error);
  return (
    <Outcome
      icon={<XCircle className="h-8 w-8 text-negative" />}
      title="Sync failed"
      body="The connection was saved — you can sync it later from Settings."
      // The run's own error, verbatim: a scraper message is the only thing
      // that distinguishes a wrong password from a bank that never loaded.
      detail={step.error}
    >
      {kind !== "transient" && (
        <Button
          type="button"
          variant={kind === "credentials" ? "primary" : "outline"}
          onClick={() => setStep({ kind: "fixing", target: step.target })}
        >
          Fix login details
        </Button>
      )}
      {kind !== "credentials" && (
        <Button
          type="button"
          variant={kind === "transient" ? "primary" : "outline"}
          onClick={() => void runSync(step.target)}
        >
          Try again
        </Button>
      )}
      {allowAddAnother && (
        <Button type="button" variant="outline" onClick={addAnother}>
          Add another account
        </Button>
      )}
      <Button type="button" variant="ghost" onClick={onDone}>
        {doneLabel}
      </Button>
    </Outcome>
  );
}

function Outcome({
  icon,
  title,
  body,
  detail,
  children,
}: {
  icon: ReactNode;
  title: string;
  body: string;
  detail?: string | null;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-4 py-4 text-center">
      {icon}
      <div>
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="text-xs text-muted-foreground">{body}</p>
        {detail && <p className="mt-2 break-words text-xs text-negative">{detail}</p>}
      </div>
      {children && (
        <div className="flex flex-wrap items-center justify-center gap-2">{children}</div>
      )}
    </div>
  );
}
