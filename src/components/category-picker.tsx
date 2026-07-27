"use client";

import { useMemo, useState } from "react";
import { Check, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CategoryView } from "@/domain/categorization";

interface CategoryPickerProps {
  categories: CategoryView[];
  value: string | null;
  onChange: (categoryId: string) => void;
}

/**
 * Grouped, type-to-filter category list. Built as a scrolling list of
 * buttons rather than a `<select>` because the set is two-level and ~60
 * items — the same reasoning behind institution-picker.tsx, whose shape this
 * follows.
 *
 * Only leaf categories are selectable. A parent is a heading: assigning a
 * transaction to "Food & Drink" instead of "Groceries" loses the detail that
 * makes budgeting useful, and the shipped tree always offers a child.
 */
export function CategoryPicker({ categories, value, onChange }: CategoryPickerProps) {
  const [query, setQuery] = useState("");

  const groups = useMemo(() => {
    const parents = categories.filter((c) => !c.parentId);
    const q = query.trim().toLowerCase();
    return parents
      .map((parent) => {
        const children = categories.filter((c) => c.parentId === parent.id);
        if (q === "") return { parent, children };
        // A parent matching the query keeps all its children, so searching
        // "food" shows the whole group rather than nothing.
        if (parent.name.toLowerCase().includes(q)) return { parent, children };
        return { parent, children: children.filter((c) => c.name.toLowerCase().includes(q)) };
      })
      .filter((g) => g.children.length > 0);
  }, [categories, query]);

  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search categories"
          className="w-full rounded-[var(--radius)] border border-input bg-background py-2 pl-9 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </div>

      <div className="max-h-64 overflow-y-auto rounded-[var(--radius)] border border-border">
        {groups.map(({ parent, children }) => (
          <div key={parent.id}>
            <p className="sticky top-0 bg-card px-3 py-1.5 text-xs uppercase tracking-wide text-muted-foreground">
              {parent.name}
            </p>
            {children.map((child) => (
              <button
                key={child.id}
                type="button"
                onClick={() => onChange(child.id)}
                className={cn(
                  "flex w-full items-center justify-between px-3 py-2 text-left text-sm transition",
                  child.id === value
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                {child.name}
                {child.id === value && <Check className="h-4 w-4 text-primary" />}
              </button>
            ))}
          </div>
        ))}
        {groups.length === 0 && (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">
            {"No category matches that search."}
          </p>
        )}
      </div>
    </div>
  );
}
