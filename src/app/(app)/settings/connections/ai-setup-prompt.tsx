"use client";

import { useState, type ReactNode } from "react";
import { Check, ChevronDown, Copy, Sparkles } from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/** A setup guide's "Set this up with your AI" card: a ready-made prompt for an
 * assistant that can drive the user's own browser, collapsed until asked for.
 * Each guide owns its prompt; `children` says in one paragraph what the
 * assistant will and won't do. */
export function AiSetupPrompt({ prompt, children }: { prompt: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked — the prompt is still selectable on screen */
    }
  }

  return (
    <Card className="flex flex-col gap-3 p-6 text-sm leading-relaxed text-muted-foreground">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-2 text-left text-base font-semibold text-foreground"
      >
        <Sparkles className="h-4 w-4 shrink-0 text-primary" />
        <span className="flex-1">Set this up with your AI</span>
        <ChevronDown
          className={cn(
            "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
      <p>{children}</p>
      {!open && (
        <button
          onClick={() => setOpen(true)}
          className="self-start text-sm font-medium text-primary underline-offset-2 hover:underline"
        >
          Show the prompt
        </button>
      )}
      {open && (
        <>
          <div className="relative">
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-[var(--radius)] border border-border bg-background px-3 py-3 pr-24 font-mono text-xs leading-relaxed text-foreground">
              <code>{prompt}</code>
            </pre>
            <button
              onClick={() => void copy()}
              aria-label="Copy prompt"
              className="absolute right-2 top-2 inline-flex items-center gap-1.5 rounded-[var(--radius)] border border-border bg-card px-2.5 py-1.5 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground"
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="text-xs">
            Prefer to do it yourself? The steps below are the same ones the assistant follows.
          </p>
        </>
      )}
    </Card>
  );
}
