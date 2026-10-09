import Image from "next/image";
import type { ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import { Card } from "@/components/ui/card";

// The building blocks every connector setup guide shares (see
// docs/design/ui-and-feel.md, "Setup guide").

export function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <Card className="flex flex-col gap-4 p-6 text-sm leading-relaxed text-muted-foreground">
      <h3 className="flex items-center gap-3 text-base font-semibold text-foreground">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-primary/60 font-mono text-xs text-primary">
          {n}
        </span>
        {title}
      </h3>
      {children}
    </Card>
  );
}

/** A third-party screen label, set apart so it reads as "look for this on screen". */
export function Path({ children }: { children: ReactNode }) {
  return <span className="font-medium text-foreground">{children}</span>;
}

export function Note({ children }: { children: ReactNode }) {
  return (
    <p className="flex gap-2 rounded-[var(--radius)] border border-primary/40 p-3 text-xs">
      <TriangleAlert className="h-4 w-4 shrink-0 text-primary" />
      <span>{children}</span>
    </p>
  );
}

/** A screenshot that opens full size in a new tab — the labels are small.
 * `unoptimized`: the image optimizer breaks behind src/proxy.ts. */
export function Shot({
  src,
  alt,
  width = 1200,
  height = 577,
}: {
  src: string;
  alt: string;
  width?: number;
  height?: number;
}) {
  return (
    <a href={src} target="_blank" rel="noreferrer" className="mt-2 block">
      <Image
        src={src}
        alt={alt}
        width={width}
        height={height}
        unoptimized
        // A cropped shot narrower than the card stays at its own size rather than blurring.
        style={{ maxWidth: width }}
        className="h-auto w-full rounded-[var(--radius)] border border-border"
      />
    </a>
  );
}
