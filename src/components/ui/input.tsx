import type { InputHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        // text-base (16px) on mobile so iOS Safari doesn't auto-zoom the page
        // when the field is focused; back to text-sm (14px) at sm+ where that
        // zoom behaviour doesn't apply and the tighter size matches the desktop UI.
        "w-full rounded-[var(--radius)] border border-input bg-background px-3 py-2 text-base text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring sm:text-sm",
        className,
      )}
      {...props}
    />
  );
}
