"use client";

import { useState } from "react";
import { KeyRound, Loader2, TriangleAlert } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { enrollPasskey } from "@/lib/passkey-client";

export interface PasskeyRow {
  id: string;
  label: string;
  /** Pre-formatted on the SERVER — a date formatted here is a hydration
   * mismatch (server locale/timezone vs the browser's). */
  addedLabel: string;
  /** False when the passkey was enrolled under a different RP ID, i.e. the
   * deployment moved. It can never unlock anything again. */
  usable: boolean;
  rpId: string;
}

/**
 * Enrol and review the passkeys that unlock stored bank logins.
 *
 * This is the only way in: since issue #7 the Moni login password cannot
 * reach those credentials, and there is deliberately no recovery path — lose
 * every passkey here and the remedy is deleting the connection and typing
 * the bank login again. That is stated plainly below rather than buried,
 * because it is the one thing a family member has to understand before
 * connecting an account.
 *
 * Removal is not offered: with no recovery path, a "Remove" button next to
 * the last passkey is a one-click way to destroy every stored bank login.
 */
export function PasskeyManager({ initialPasskeys }: { initialPasskeys: PasskeyRow[] }) {
  const [passkeys, setPasskeys] = useState(initialPasskeys);
  const [label, setLabel] = useState("");
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onAdd() {
    setBusy(true);
    setError(null);
    const name = label.trim() || defaultLabel(passkeys.length);
    const result = await enrollPasskey(name);
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setPasskeys((current) => [
      ...current,
      {
        id: result.value.id,
        label: result.value.label,
        addedLabel: "Just now",
        usable: true,
        rpId: "",
      },
    ]);
    setLabel("");
    setAdding(false);
  }

  const none = passkeys.length === 0;

  return (
    <Card>
      <div className="flex flex-col gap-5 px-6 pb-6 pt-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-2xl">
            <p className="text-sm font-medium text-foreground">Passkeys</p>
            <p className="text-xs text-muted-foreground">
              {none
                ? "A passkey is required for bank, card, and IBKR logins. Schwab CSV imports do not need one."
                : "Your passkey unlocks your stored bank logins each time you sync."}
            </p>
          </div>
          {!adding && (
            <Button
              type="button"
              variant={none ? "primary" : "outline"}
              onClick={() => setAdding(true)}
              className="gap-1.5"
            >
              <KeyRound className="h-3.5 w-3.5" />
              {none ? "Set up a passkey" : "Add another passkey"}
            </Button>
          )}
        </div>

        {passkeys.length > 0 && (
          <ul className="flex flex-col divide-y divide-border border-y border-border">
            {passkeys.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-4 py-3">
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-[var(--radius)] bg-muted text-muted-foreground">
                    <KeyRound className="h-4 w-4" />
                  </div>
                  <div>
                    <p className="text-sm text-foreground">{p.label}</p>
                    <p className="text-xs text-muted-foreground">{p.addedLabel}</p>
                  </div>
                </div>
                {!p.usable && (
                  <p className="max-w-xs text-right text-xs text-negative">
                    {`Registered for ${p.rpId} — it can't unlock anything here. Add a new one.`}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}

        {adding && (
          <div className="flex flex-col gap-4 rounded-[var(--radius)] border border-border p-5">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="passkey-label" className="text-xs font-medium text-muted-foreground">
                Name it (optional)
              </label>
              <Input
                id="passkey-label"
                type="text"
                autoComplete="off"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder={defaultLabel(passkeys.length)}
                className="max-w-sm"
              />
              <p className="text-xs text-muted-foreground">
                {
                  "Add one per device family — an iPhone and Mac share iCloud Keychain, but an Android phone needs its own."
                }
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setAdding(false);
                  setError(null);
                }}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button
                type="button"
                onClick={() => void onAdd()}
                disabled={busy}
                className="gap-1.5"
              >
                {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {busy ? "Waiting for your device…" : "Create passkey"}
              </Button>
            </div>
          </div>
        )}

        {error && (
          <div className="flex gap-2.5 rounded-[var(--radius)] border border-negative/30 bg-negative/10 px-4 py-3">
            <TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0 text-negative" />
            <p className="break-words text-xs text-muted-foreground">{error}</p>
          </div>
        )}

        <p className="max-w-2xl text-xs text-muted-foreground">
          {
            "If you lose every passkey there is no way back into your stored bank logins — you'd delete the connection and enter the login again. Nothing else is lost: your transactions and balances are unlocked by your password, not your passkey."
          }
        </p>
      </div>
    </Card>
  );
}

function defaultLabel(existing: number): string {
  return existing === 0 ? "My device" : `Device ${existing + 1}`;
}
