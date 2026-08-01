"use client";

import { useState } from "react";
import { KeyRound, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * The button a 423 asks for: it re-opens the credential window (10 minute
 * TTL) so a stored bank login can be decrypted. Shown by every surface that
 * can start a sync — the connections list, the dashboard, and the connect
 * wizard's retry path.
 *
 * This used to be a password field. It is a passkey now (issue #7): the Moni
 * login password no longer wraps the key that decrypts bank credentials, so
 * there is nothing to type here. The caller owns the ceremony (via
 * `armWithPasskey`) because it also owns where the failure message goes; this
 * component only owns the button and its pending state.
 */
export function ArmPrompt({ label, onArm }: { label: string; onArm: () => void | Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void Promise.resolve(onArm()).finally(() => setBusy(false));
      }}
      className="gap-1.5 whitespace-nowrap px-3 py-1.5 text-xs"
    >
      {busy ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <KeyRound className="h-3.5 w-3.5" />
      )}
      {label}
    </Button>
  );
}
