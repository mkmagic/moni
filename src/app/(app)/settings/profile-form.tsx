"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface ProfileFormProps {
  email: string;
  displayName: string | null;
}

export function ProfileForm({ email, displayName }: ProfileFormProps) {
  const router = useRouter();
  const [name, setName] = useState(displayName ?? "");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: name.trim() === "" ? null : name.trim() }),
      });
      if (res.ok) {
        setSaved(true);
        router.refresh();
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? "Could not save");
    } catch {
      setError("Could not reach the server");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="email" className="text-xs font-medium text-muted-foreground">
          Email
        </label>
        <Input id="email" type="email" value={email} disabled readOnly />
        <p className="text-xs text-muted-foreground">
          {"Your email can't be changed yet — it identifies your encryption keys."}
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="displayName" className="text-xs font-medium text-muted-foreground">
          Name
        </label>
        <Input
          id="displayName"
          type="text"
          autoComplete="name"
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="What should we call you?"
        />
        <p className="text-xs text-muted-foreground">Used to greet you on the dashboard.</p>
      </div>

      {error && <p className="text-sm text-negative">{error}</p>}
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={loading}>
          {loading ? "Saving…" : "Save changes"}
        </Button>
        {saved && <span className="text-xs text-positive">Saved</span>}
      </div>
    </form>
  );
}
