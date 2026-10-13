"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface RemoveConnectionDialogProps {
  open: boolean;
  connectionId: string;
  label: string;
  /** Already disconnected: the only step left is deleting it with its data. */
  disconnected: boolean;
  onClose: () => void;
  onRemoved: () => void;
}

/** Removes a file-import connection. Unticked, it disconnects (history kept,
 * no more uploads); ticked, it deletes the connection and everything imported
 * through it — the step before switching to a different import source. The
 * delete has no undo, so it re-asks for the login password
 * (ui-and-feel.md §6, Destructive action). */
export function RemoveConnectionDialog({
  open,
  connectionId,
  label,
  disconnected,
  onClose,
  onRemoved,
}: RemoveConnectionDialogProps) {
  const [deleteData, setDeleteData] = useState(disconnected);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = deleteData
        ? await fetch(`/api/connections/${connectionId}`, {
            method: "DELETE",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ password }),
          })
        : await fetch(`/api/connections/${connectionId}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ disconnect: true }),
          });
      if (res.ok) {
        onRemoved();
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      // A 401 here can only be the password: the dialog is unreachable
      // without a session.
      setError(
        res.status === 401
          ? "That password is not correct"
          : body.error === "sync_running"
            ? "An import is still running for this connection. Try again when it finishes."
            : (body.error ?? "Could not remove the connection"),
      );
    } catch {
      setError("Could not reach the server");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={busy ? () => undefined : onClose}
      title={`Remove ${label}?`}
      description={
        disconnected
          ? "This connection is already disconnected. Removing it deletes everything it imported."
          : "You won't be able to upload files to it any more."
      }
    >
      <div className="flex flex-col gap-4">
        {!disconnected && (
          <label className="flex items-start gap-2.5 text-sm text-foreground">
            <input
              type="checkbox"
              checked={deleteData}
              onChange={(e) => setDeleteData(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-input bg-background accent-primary focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <span className="flex flex-col gap-1">
              <span>{"Also delete all data imported from it"}</span>
              <span className="text-xs text-muted-foreground">
                {deleteData
                  ? "Deletes the accounts it created, with their balances and reports. There is no undo."
                  : "The accounts and their history stay, and keep counting toward your net worth."}
              </span>
            </span>
          </label>
        )}

        {deleteData && (
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor={`remove-password-${connectionId}`}
              className="text-xs font-medium text-muted-foreground"
            >
              Confirm with your password
            </label>
            <Input
              id={`remove-password-${connectionId}`}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
        )}

        {error && (
          <p className="rounded-[var(--radius)] border border-negative/30 bg-negative/10 px-3 py-2 text-xs text-negative">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => void submit()}
            disabled={busy || (deleteData && password === "")}
          >
            <Trash2 className="h-4 w-4" />
            {busy ? "Removing…" : deleteData ? "Delete connection and data" : "Disconnect"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
