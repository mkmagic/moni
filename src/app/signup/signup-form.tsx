"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function SignupForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [signupToken, setSignupToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (password !== confirmPassword) {
      setError("Passwords don't match");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password, signupToken }),
      });
      if (res.status === 201) {
        router.push("/onboarding");
        router.refresh();
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? "Sign up failed");
    } catch {
      setError("Could not reach the server");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="email" className="text-xs font-medium text-muted-foreground">
          Email
        </label>
        <Input
          id="email"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="password" className="text-xs font-medium text-muted-foreground">
          Password
        </label>
        <Input
          id="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="confirmPassword" className="text-xs font-medium text-muted-foreground">
          Confirm password
        </label>
        <Input
          id="confirmPassword"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          placeholder="••••••••"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="signupToken" className="text-xs font-medium text-muted-foreground">
          Invite token
        </label>
        <Input
          id="signupToken"
          type="text"
          autoComplete="off"
          required
          value={signupToken}
          onChange={(e) => setSignupToken(e.target.value)}
          placeholder="Shared by whoever runs this Moni instance"
        />
      </div>

      <div className="flex gap-2 rounded-[var(--radius)] border border-negative/40 bg-negative/10 p-3">
        <TriangleAlert className="h-4 w-4 shrink-0 text-negative" />
        {/* The text after </strong> is its own {"..."} string expression,
            not raw JSX text — Turbopack's JSX whitespace trimming was
            observed (via browser click-through) to silently drop the space
            between an element and immediately-following JSX text on the
            same line ("reset.If you forget..."), and Prettier re-collapses
            a bare {" "} separator back into plain text that hits the same
            bug. An expression is immune to both. */}
        <p className="text-xs text-foreground">
          <strong>There is no password reset.</strong>{" "}
          {
            "If you forget this password, your data is permanently unrecoverable — not by you, not by whoever runs this Moni instance, not by anyone. Choose a password you'll remember, and keep it somewhere safe."
          }
        </p>
      </div>

      {error && <p className="text-sm text-negative">{error}</p>}
      <Button type="submit" disabled={loading} className="mt-1">
        {loading ? "Creating account…" : "Create account"}
      </Button>
    </form>
  );
}
