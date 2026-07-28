"use client";

import { Input } from "@/components/ui/input";
import {
  BACKFILL_PRESETS,
  earliestBackfillStart,
  presetStartDate,
  type BackfillPreset,
} from "@/lib/backfill-window";
import { cn } from "@/lib/utils";

interface BackfillWindowPickerProps {
  /** Today's calendar date, `YYYY-MM-DD`, computed on the SERVER and passed
   * down. Deriving it here would make the rendered bounds depend on the
   * browser's clock and timezone — a hydration mismatch, and a disagreement
   * with the cap the sync route enforces. */
  today: string;
  /** Chosen start date, or `null` for "connect but don't fetch anything". */
  value: string | null;
  onChange: (startDate: string | null) => void;
}

/**
 * How far back to pull when a connection is first synced (ADR 0001). Presets
 * cover the realistic choices; the date field is the "optional date picker"
 * from issue #4, bounded to the same twelve months the server enforces.
 *
 * "Nothing for now" is a first-class answer to the question, not a separate
 * control: a user linking an account they only want going forward shouldn't
 * have to start a scrape to do it.
 */
export function BackfillWindowPicker({ today, value, onChange }: BackfillWindowPickerProps) {
  const earliest = earliestBackfillStart(today);
  const selectedPreset =
    value === null ? undefined : BACKFILL_PRESETS.find((p) => presetStartDate(p, today) === value);
  const skipping = value === null;

  function selectPreset(preset: BackfillPreset) {
    onChange(presetStartDate(preset, today));
  }

  return (
    <div className="flex flex-col gap-2.5">
      <span className="text-xs font-medium text-muted-foreground">
        How far back should we pull?
      </span>
      <div className="flex flex-wrap gap-2">
        <PillButton selected={skipping} onClick={() => onChange(null)}>
          Nothing for now
        </PillButton>
        {BACKFILL_PRESETS.map((preset) => (
          <PillButton
            key={preset.key}
            selected={selectedPreset?.key === preset.key}
            onClick={() => selectPreset(preset)}
          >
            {preset.label}
          </PillButton>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label
          htmlFor="backfillStart"
          className={cn("text-xs text-muted-foreground", skipping && "opacity-50")}
        >
          or from a specific date
        </label>
        <Input
          id="backfillStart"
          type="date"
          // `cn` is a plain join, not tailwind-merge, so `w-auto` would sit
          // alongside the primitive's `w-full` and lose. A max-width wins
          // outright and keeps the field beside its label.
          className="max-w-[11rem] disabled:opacity-50"
          min={earliest}
          max={today}
          // A disabled date input still needs a defined value, or React
          // switches it to uncontrolled and warns.
          value={value ?? ""}
          disabled={skipping}
          onChange={(e) => e.target.value && onChange(e.target.value)}
        />
      </div>
      {/* States the cap rather than letting the user discover it by having the
          date field silently refuse them. */}
      <p className="text-xs text-muted-foreground">
        {skipping
          ? "We'll link the account without fetching anything. Sync it whenever you're ready."
          : "We can reach back up to 12 months. Longer windows take longer to fetch."}
      </p>
    </div>
  );
}

function PillButton({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        "rounded-[var(--radius)] border px-3 py-1.5 text-xs transition",
        selected
          ? "border-primary/60 bg-primary/10 text-foreground"
          : "border-border bg-card text-muted-foreground hover:border-primary/50 hover:bg-muted",
      )}
    >
      {children}
    </button>
  );
}
