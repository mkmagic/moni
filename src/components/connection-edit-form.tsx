"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getConnectorDefinition } from "@/lib/connectors";
import { sendUnlocked } from "@/lib/passkey-client";
import { cn } from "@/lib/utils";

interface ConnectionEditFormProps {
  connectionId: string;
  connectorId: string;
  displayName: string | null;
  onSaved: () => void;
  onCancel: () => void;
  /** Open with the login fields already expanded. The connections row wants
   * the "Replace login details" link (renaming is the common case there); the
   * connect wizard reaches this form only after a credential failure, where
   * replacing them IS the task. */
  startReplacing?: boolean;
  /** Replaces the row-embedded chrome (top border, card padding) when the
   * form is rendered somewhere that already provides its own. */
  className?: string;
  saveLabel?: string;
}

/** Rename a connection and/or replace its stored bank credentials. Login
 * fields come from the registry (never hardcoded username+password, which
 * would break hapoalim/isracard/discount/yahav). Credentials are cleared from
 * state the moment the request is fired, exactly as in the connect form. */
export function ConnectionEditForm({
  connectionId,
  connectorId,
  displayName,
  onSaved,
  onCancel,
  startReplacing = false,
  className,
  saveLabel = "Save",
}: ConnectionEditFormProps) {
  const def = getConnectorDefinition(connectorId);
  const [name, setName] = useState(displayName ?? "");
  const [replacing, setReplacing] = useState(startReplacing);
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const body: Record<string, unknown> = { displayName: name.trim() === "" ? null : name.trim() };
    if (replacing) body.credentials = values;
    const payload = JSON.stringify(body);
    setValues({});

    try {
      // Only the credential replacement needs the credential key; a rename
      // never returns 423, so `sendUnlocked` costs nothing on that path.
      const sent = await sendUnlocked(() =>
        fetch(`/api/connections/${connectionId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: payload,
        }),
      );
      if (!sent.ok) {
        setError(sent.message);
        return;
      }
      if (sent.res.ok) {
        onSaved();
        return;
      }
      const responseBody = (await sent.res.json().catch(() => ({}))) as { error?: string };
      setError(responseBody.error ?? "Could not save");
    } catch {
      setError("Could not reach the server");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className={cn("flex flex-col gap-5 border-t border-border px-6 py-6", className)}
    >
      <div className="flex flex-col gap-1.5">
        <label
          htmlFor={`name-${connectionId}`}
          className="text-xs font-medium text-muted-foreground"
        >
          Nickname
        </label>
        <Input
          id={`name-${connectionId}`}
          type="text"
          autoComplete="off"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={def?.label ?? connectorId}
        />
      </div>

      {!replacing ? (
        <button
          type="button"
          onClick={() => setReplacing(true)}
          className="self-start text-xs text-primary hover:underline"
        >
          Replace login details
        </button>
      ) : (
        <div className="flex flex-col gap-5 rounded-[var(--radius)] border border-border p-5">
          <p className="text-xs text-muted-foreground">
            {`Re-enter your ${def?.label ?? connectorId} login. The stored details are replaced, not merged.`}
          </p>
          {def?.loginFields.map((field) => (
            <div key={field.key} className="flex flex-col gap-1.5">
              <label
                htmlFor={`${connectionId}-${field.key}`}
                className="text-xs font-medium text-muted-foreground"
              >
                {field.label}
              </label>
              <Input
                id={`${connectionId}-${field.key}`}
                type={field.inputType}
                autoComplete="off"
                required
                value={values[field.key] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
              />
            </div>
          ))}
          <p className="text-xs text-muted-foreground">
            {"Saving will ask for your passkey — it's what unlocks the stored login."}
          </p>
        </div>
      )}

      {error && <p className="text-sm text-negative">{error}</p>}
      <div className="flex gap-2">
        <Button type="button" variant="outline" onClick={onCancel} disabled={loading}>
          Cancel
        </Button>
        <Button type="submit" disabled={loading}>
          {loading ? "Saving…" : saveLabel}
        </Button>
      </div>
    </form>
  );
}
