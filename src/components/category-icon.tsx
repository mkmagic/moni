import { categoryIcon } from "@/lib/categorization/category-icons";
import { cn } from "@/lib/utils";

/**
 * `categories.color` holds a token NAME (`chart-1`), not a class, so the
 * mapping has to be a static table: Tailwind resolves utilities at build time
 * and a template like `bg-${color}` produces nothing. Keeping the table here
 * means the domain layer never learns about CSS.
 */
const COLOR_CLASS: Record<string, string> = {
  "chart-1": "bg-chart-1/12 text-chart-1",
  "chart-2": "bg-chart-2/12 text-chart-2",
  "chart-3": "bg-chart-3/12 text-chart-3",
  "chart-4": "bg-chart-4/12 text-chart-4",
  "chart-5": "bg-chart-5/12 text-chart-5",
};

export function categoryColorClass(color: string | null): string {
  return (color && COLOR_CLASS[color]) || "bg-muted text-muted-foreground";
}

interface CategoryIconTileProps {
  icon: string | null;
  color: string | null;
  /** Subcategories get the smaller tile, groups the larger one. */
  size?: "sm" | "md";
  className?: string;
}

export function CategoryIconTile({ icon, color, size = "md", className }: CategoryIconTileProps) {
  const Icon = categoryIcon(icon);
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-[var(--radius)]",
        size === "md" ? "h-9 w-9" : "h-7 w-7",
        categoryColorClass(color),
        className,
      )}
    >
      {/* `react-hooks/static-components` reads any capitalized binding
          assigned from a call as a component built during render. This one is
          a lookup in a module-level table of imported lucide components, so
          its identity is stable for a given `icon` and there is no state to
          reset. */}
      {/* eslint-disable-next-line react-hooks/static-components */}
      <Icon className={size === "md" ? "h-4.5 w-4.5" : "h-3.5 w-3.5"} />
    </span>
  );
}
