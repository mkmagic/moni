"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getConnectorDefinition, type ConnectorId } from "@/lib/connectors";

interface ConnectFormProps {
  connectorId: ConnectorId;
  /** Called with the new connection's id and the nickname the user typed (null
   * if they left it blank) on success. The caller needs the nickname because
   * the credential-repair form PATCHes displayName alongside the credentials,
   * and would otherwise clear it. */
  onConnected: (connectionId: string, displayName: string | null) => void;
  onBack?: () => void;
}

/** Connector login fields are per-connector and rendered from the registry
 * (loginFields: key/label/inputType) — never hardcoded username+password,
 * which would break hapoalim, isracard, discount, and yahav. Credentials
 * never outlive the submit: cleared from state the moment the request is
 * fired, never logged, never in a URL. */
export function ConnectForm({ connectorId, onConnected, onBack }: ConnectFormProps) {
  const def = getConnectorDefinition(connectorId);
  const [values, setValues] = useState<Record<string, string>>({});
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  if (!def) return null;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const nickname = displayName.trim() || null;
    const body = JSON.stringify({
      connectorId,
      credentials: values,
      displayName: nickname ?? undefined,
      password,
    });
    // Credentials and password must not linger in this component's state
    // any longer than the submit — clear before awaiting the response.
    setValues({});
    setPassword("");

    try {
      const res = await fetch("/api/connections", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      if (res.status === 201) {
        const responseBody = (await res.json()) as { id: string };
        onConnected(responseBody.id, nickname);
        return;
      }
      const responseBody = (await res.json().catch(() => ({}))) as { error?: string };
      setError(responseBody.error ?? "Could not connect");
    } catch {
      setError("Could not reach the server");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      {/* A single template-literal expression, not adjacent JSX text nodes
          around {def.label} — Turbopack's JSX whitespace trimming was
          observed (via browser click-through) to silently drop the space
          between an expression and immediately-following text on the same
          line ("Bank Hapoalimlogin."). One expression sidesteps it. */}
      <p className="text-sm text-muted-foreground">
        {`Enter your ${def.label} login. Your credentials are encrypted before they're stored.`}
      </p>
      {def.loginFields.map((field) => (
        <div key={field.key} className="flex flex-col gap-1.5">
          <label htmlFor={field.key} className="text-xs font-medium text-muted-foreground">
            {field.label}
          </label>
          <Input
            id={field.key}
            type={field.inputType}
            autoComplete="off"
            required
            value={values[field.key] ?? ""}
            onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
          />
        </div>
      ))}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="displayName" className="text-xs font-medium text-muted-foreground">
          Nickname (optional)
        </label>
        <Input
          id="displayName"
          type="text"
          autoComplete="off"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder={def.label}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="moniPassword" className="text-xs font-medium text-muted-foreground">
          Your Moni password
        </label>
        <Input
          id="moniPassword"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Confirms it's you before we store this"
        />
      </div>
      {error && <p className="text-sm text-negative">{error}</p>}
      <div className="flex gap-2">
        {onBack && (
          <Button type="button" variant="outline" onClick={onBack} disabled={loading}>
            Back
          </Button>
        )}
        <Button type="submit" disabled={loading} className="flex-1">
          {loading ? "Connecting…" : `Connect ${def.label}`}
        </Button>
      </div>
    </form>
  );
}
