import { cn } from "@/lib/utils";

interface MerchantIconProps {
  name: string;
  /** Origin-local path, or null. Never an external URL (docs/adr/0007-*). */
  logoUrl: string | null;
  /** Brand colour from the catalog; tints the monogram when there is no logo. */
  brandColor: string | null;
  className?: string;
}

/**
 * A merchant's icon: the bundled asset when one exists, otherwise a monogram
 * tinted with the brand's colour.
 *
 * The monogram is the complete answer for a payee we don't ship an asset for,
 * not a placeholder for one — nothing here ever reaches out to a logo service,
 * because doing so would tell that service which merchants this user pays, on
 * every render (docs/adr/0007-*).
 *
 * `brandColor` is a raw hex from the catalog rather than a theme token, and it
 * is applied at 18% as a fill with the full value as the text — the same
 * "tint, don't fill" weight the pill group and Switch use for amber.
 */
export function MerchantIcon({ name, logoUrl, brandColor, className }: MerchantIconProps) {
  const initial = [...name.trim()][0]?.toUpperCase() ?? "?";

  return (
    <span
      className={cn("flex h-8 w-12 shrink-0 items-center justify-center", className)}
      aria-hidden
    >
      <span
        className={cn(
          "flex h-8 min-w-8 max-w-12 items-center justify-center rounded-[var(--radius)] border border-border px-1 text-xs font-medium",
          !brandColor && "bg-muted text-muted-foreground",
        )}
        style={
          brandColor
            ? {
                backgroundColor: `${brandColor}2e`,
                color: brandColor,
                borderColor: `${brandColor}55`,
              }
            : undefined
        }
      >
        {logoUrl ? (
          // A bundled image at a known local path. next/image would add an
          // optimizer round-trip for no benefit, so the rule is waived here —
          // the disable has to sit on the line immediately before the element,
          // with no wrapped description, or it silently applies to nothing.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logoUrl} alt="" className="h-5 w-auto max-w-10 object-contain" />
        ) : (
          <bdi>{initial}</bdi>
        )}
      </span>
    </span>
  );
}
