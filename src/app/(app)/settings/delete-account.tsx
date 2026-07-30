"use client";

import { useState, type FormEvent } from "react";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

/**
 * Account deletion (issue #31) — the one control in Moni that destroys data
 * with no undo.
 *
 * The skill's own rule was "don't offer a destructive control with no undo…
 * until there's a confirm flow that can say what is lost" (2026-07-30, on
 * why `PasskeyManager` has no Remove). This is that flow, so it has to
 * actually enumerate the loss rather than say "are you sure?", and it asks
 * for the login password — a session cookie alone is not authority to erase
 * an account.
 */
export function DeleteAccount() {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function close() {
    if (loading) return; // don't strand an in-flight delete behind a closed dialog
    setOpen(false);
    setPassword("");
    setError(null);
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/account", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        // A full navigation, not `router.replace` — the account and its
        // session are gone, so every cached RSC payload in the client router
        // now belongs to a user that does not exist.
        window.location.assign("/login");
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(
        body.error === "invalid password"
          ? "That password is not correct"
          : "Could not delete your account",
      );
    } catch {
      setError("Could not reach the server");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <div className="flex flex-col gap-4 px-6 pb-7 pt-7">
        <div className="flex flex-col gap-1">
          <h2 className="text-sm font-medium text-foreground">Delete account</h2>
          <p className="max-w-2xl text-sm text-muted-foreground">
            {
              "Permanently deletes your accounts, transactions, categories, rules, merchants, bank connections and their saved logins. Nothing is archived and there is no way to undo it."
            }
          </p>
        </div>
        <div>
          <Button type="button" variant="destructive" onClick={() => setOpen(true)}>
            Delete account
          </Button>
        </div>
      </div>

      <Dialog open={open} onClose={close} title="Delete account">
        <form onSubmit={onSubmit} className="flex flex-col gap-5">
          <div className="flex gap-2.5 rounded-[var(--radius)] border border-negative/30 bg-negative/10 px-4 py-3">
            <TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0 text-negative" />
            <div className="flex flex-col gap-1 text-xs">
              <p className="font-medium text-negative">This cannot be undone</p>
              <p className="text-muted-foreground">
                Deleted immediately and permanently: your transactions and their history, your
                accounts and balances, your categories, rules and merchants, and every bank
                connection along with its encrypted login.
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="deletePassword" className="text-xs font-medium text-muted-foreground">
              Confirm with your password
            </label>
            <Input
              id="deletePassword"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>

          {error && <p className="text-sm text-negative">{error}</p>}

          <div className="flex items-center justify-end gap-3">
            <Button type="button" variant="outline" onClick={close} disabled={loading}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={loading || password === ""}>
              {loading ? "Deleting…" : "Delete account"}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
