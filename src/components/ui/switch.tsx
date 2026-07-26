"use client";

import { cn } from "@/lib/utils";

interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Id of the element labelling this switch, for screen readers. */
  "aria-labelledby"?: string;
  className?: string;
}

/**
 * On/off toggle. A `role="switch"` button rather than a styled checkbox —
 * the native control can't be restyled into a track-and-knob without
 * `appearance-none` hacks, and this keeps keyboard + screen-reader semantics
 * intact (Space/Enter toggle it, state is announced).
 *
 * Amber is the sole brand accent and marks the primary action, so an "on"
 * track uses it deliberately (docs/design/ui-and-feel.md — Do/Don't).
 */
export function Switch({ checked, onCheckedChange, disabled, className, ...aria }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={aria["aria-labelledby"]}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background disabled:pointer-events-none disabled:opacity-50",
        checked ? "border-primary bg-primary" : "border-border bg-muted",
        className,
      )}
    >
      <span
        className={cn(
          "pointer-events-none inline-block h-3.5 w-3.5 rounded-full transition-transform",
          checked
            ? "translate-x-[1.125rem] bg-primary-foreground"
            : "translate-x-0.5 bg-muted-foreground",
        )}
      />
    </button>
  );
}
