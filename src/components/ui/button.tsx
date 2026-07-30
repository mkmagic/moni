import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "outline" | "ghost" | "destructive";
}

// Amber is the sole brand accent and is used only for the primary action
// (docs/design/ui-and-feel.md — Do/Don't).
export function Button({ className, variant = "primary", ...props }: ButtonProps) {
  const variants = {
    primary: "bg-primary text-primary-foreground hover:opacity-90",
    outline: "border border-border bg-transparent text-foreground hover:bg-muted",
    ghost: "bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground",
    // A destructive action never takes the amber — that belongs to the view's
    // real primary action, and "Delete" is not it. Coral outline that fills
    // only on hover, matching how the error blocks in `connections-list` and
    // `passkey-manager` already use `border-negative/30 bg-negative/10`.
    // A variant rather than utilities passed through `className`, because `cn`
    // is a plain join and the base `bg-transparent` would win by stylesheet
    // order (skill feedback, 2026-07-28).
    destructive: "border border-negative/40 bg-transparent text-negative hover:bg-negative/10",
  } as const;
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-[var(--radius)] px-4 py-2 text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-ring disabled:pointer-events-none disabled:opacity-50",
        variants[variant],
        className,
      )}
      {...props}
    />
  );
}
