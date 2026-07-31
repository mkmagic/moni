"use client";

import { useEffect } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { useRouter } from "next/navigation";

const variants = [
  { key: "A", name: "Balanced overview" },
  { key: "B", name: "Portfolio spotlight" },
  { key: "C", name: "Dense ledger" },
] as const;

export type PrototypeVariant = (typeof variants)[number]["key"];

export function PrototypeSwitcher({ current }: { current: PrototypeVariant }) {
  const router = useRouter();
  const index = variants.findIndex((variant) => variant.key === current);

  function select(offset: number) {
    const next = variants[(index + offset + variants.length) % variants.length];
    router.replace(`/prototype/investments?variant=${next.key}`, { scroll: false });
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, [contenteditable=true]")) return;
      if (event.key === "ArrowLeft") select(-1);
      if (event.key === "ArrowRight") select(1);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  if (process.env.NODE_ENV === "production") return null;
  const selected = variants[index];

  return (
    <div className="fixed bottom-5 left-1/2 z-40 flex -translate-x-1/2 items-center gap-3 rounded-full border border-primary/40 bg-popover px-2 py-2 shadow-xl shadow-black/40">
      <button
        type="button"
        aria-label="Previous prototype variant"
        onClick={() => select(-1)}
        className="rounded-full p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
      </button>
      <span className="min-w-44 text-center text-xs font-medium text-foreground">
        {selected.key} — {selected.name}
      </span>
      <button
        type="button"
        aria-label="Next prototype variant"
        onClick={() => select(1)}
        className="rounded-full p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <ArrowRight className="h-4 w-4" />
      </button>
    </div>
  );
}
