"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Optional line under the title. */
  description?: string;
  children: ReactNode;
  className?: string;
}

/**
 * Modal dialog. A real `role="dialog" aria-modal` element with focus
 * management, not a styled `div` — the same bar `switch.tsx` sets by being a
 * `role="switch"` button rather than a restyled checkbox.
 *
 * Surface is `bg-popover`, one step brighter than `card`, with a hairline
 * border and NO shadow: depth in this UI is a surface step plus a 1px
 * border (docs/design/ui-and-feel.md). The backdrop is the only place a
 * scrim is allowed, and it exists to dim the page, not to cast a shadow.
 */
export function Dialog({ open, onClose, title, description, children, className }: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;

    previouslyFocused.current = document.activeElement as HTMLElement | null;
    // Land on the first text field if there is one — in this app the first
    // button in DOM order is the header's Close, and opening a dialog with
    // focus on "dismiss" is the wrong starting point. The fallback for a
    // dialog with no text field (a delete confirmation) skips Close for the
    // same reason, so it lands on the body's first control — Cancel, which
    // is the safe default for a destructive prompt. Panel last, so focus is
    // never left behind the backdrop.
    const panel = panelRef.current;
    const target =
      panel?.querySelector<HTMLElement>("input:not([type=checkbox]), textarea, select") ??
      panel?.querySelector<HTMLElement>(
        'button:not([data-dialog-close]), [href], input, [tabindex]:not([tabindex="-1"])',
      ) ??
      panel;
    target?.focus();

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      // Keep Tab inside the panel — a modal the user can tab out of isn't one.
      const items = panelRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!items || items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused.current?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-background/80 p-4 pt-[10vh]"
      onMouseDown={(e) => {
        // Only a press that both starts and ends on the backdrop closes —
        // a drag that began inside the panel must not dismiss it.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={cn(
          "w-full max-w-lg rounded-[var(--radius)] border border-border bg-popover focus:outline-none",
          className,
        )}
      >
        <div className="flex items-start justify-between gap-4 border-b border-border p-5">
          <div className="flex flex-col gap-1">
            <h2 className="text-sm font-medium text-foreground">{title}</h2>
            {description && <p className="text-xs text-muted-foreground">{description}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            // Marks this as the dismiss control so the open-focus fallback
            // above can skip it. Tab order still reaches it normally.
            data-dialog-close
            className="rounded-[var(--radius)] p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
