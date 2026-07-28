"use client";

import { useState } from "react";
import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * The password field a 423 asks for: it re-opens the credential window (10
 * minute TTL) so a stored bank login can be decrypted. Shown by every surface
 * that can start a sync — the connections list, the dashboard, and the connect
 * wizard's retry path.
 */
export function ArmPrompt({ label, onArm }: { label: string; onArm: (password: string) => void }) {
  const [password, setPassword] = useState("");
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const p = password;
        setPassword("");
        onArm(p);
      }}
    >
      <Lock className="h-3.5 w-3.5 text-muted-foreground" />
      <Input
        type="password"
        autoComplete="current-password"
        placeholder="Password"
        className="w-32"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
      />
      <Button type="submit" variant="outline" className="whitespace-nowrap px-2 py-1 text-xs">
        {label}
      </Button>
    </form>
  );
}
