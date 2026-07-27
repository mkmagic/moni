"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CategoryIconTile, categoryColorClass } from "@/components/category-icon";
import {
  CATEGORY_ICON_NAMES,
  DEFAULT_CATEGORY_ICON,
  categoryIcon,
} from "@/lib/categorization/category-icons";
import { CATEGORY_COLORS } from "@/lib/categorization/default-categories";
import type { CategoryClassification } from "@/lib/categorization/default-categories";
import type { CategoryDetailView, CategoryGroupView } from "@/domain/categorization";
import { cn } from "@/lib/utils";

const CLASSIFICATIONS = [
  { value: "expense", label: "Expense" },
  { value: "income", label: "Income" },
  // A transfer category is what keeps money that only moved out of income and
  // expense totals — see src/domain/flows.ts.
  { value: "transfer", label: "Transfer" },
] as const;

interface CategoryFormProps {
  /** Null to create. */
  category: CategoryDetailView | null;
  /** Pre-selected parent when adding a subcategory to a specific group. */
  defaultParentId: string | null;
  /** Whether `category` still has subcategories, which pins it top-level. */
  hasChildren: boolean;
  groups: CategoryGroupView[];
  onClose: () => void;
}

export function CategoryForm({
  category,
  defaultParentId,
  hasChildren,
  groups,
  onClose,
}: CategoryFormProps) {
  const router = useRouter();
  const [name, setName] = useState(category?.name ?? "");
  const [parentId, setParentId] = useState<string | null>(
    category ? category.parentId : defaultParentId,
  );
  const [classification, setClassification] = useState<CategoryClassification>(
    category?.classification ?? "expense",
  );
  const [color, setColor] = useState<string>(category?.color ?? CATEGORY_COLORS[0]);
  const [icon, setIcon] = useState<string>(category?.icon ?? DEFAULT_CATEGORY_ICON);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parent = groups.find((g) => g.id === parentId) ?? null;
  // Classification and color are the parent's for a subcategory, so the form
  // shows them as inherited rather than offering a choice the domain layer
  // would silently overrule (`resolveCategoryInput`).
  const effectiveColor = parent ? (parent.color ?? color) : color;
  const effectiveClassification = parent ? parent.classification : classification;
  const valid = name.trim() !== "";

  async function save() {
    setSaving(true);
    setError(null);

    const res = await fetch(category ? `/api/categories/${category.id}` : "/api/categories", {
      method: category ? "PATCH" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: name.trim(),
        parentId,
        classification: effectiveClassification,
        color: effectiveColor,
        icon,
      }),
    });
    setSaving(false);
    if (res.ok) {
      router.refresh();
      onClose();
      return;
    }
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    setError(body.error ?? "Could not save");
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={category ? "Edit category" : "New category"}
      description={
        category?.builtin
          ? "Built in. Renaming it is safe — upgrades match on its key, not its name."
          : "Subcategories inherit their group's type and color."
      }
    >
      <div className="flex flex-col gap-5">
        <div className="flex items-end gap-3">
          <CategoryIconTile icon={icon} color={effectiveColor} className="mb-1" />
          <label className="flex flex-1 flex-col gap-1.5 text-sm">
            <span className="text-muted-foreground">Name</span>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Groceries"
              maxLength={60}
            />
          </label>
        </div>

        <label className="flex flex-col gap-1.5 text-sm">
          <span className="text-muted-foreground">Group</span>
          <select
            value={parentId ?? ""}
            disabled={hasChildren}
            onChange={(e) => setParentId(e.target.value === "" ? null : e.target.value)}
            className="rounded-[var(--radius)] border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
          >
            <option value="">{"None — this is a top-level group"}</option>
            {groups
              .filter((g) => g.id !== category?.id)
              .map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
          </select>
          {hasChildren && (
            <span className="text-xs text-muted-foreground">
              {"A group with subcategories has to stay top-level — categories nest one level deep."}
            </span>
          )}
        </label>

        {parent ? (
          <p className="text-xs text-muted-foreground">
            {`Inherits ${effectiveClassification} and its group's color from `}
            <bdi className="text-foreground">{parent.name}</bdi>
          </p>
        ) : (
          <>
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="text-muted-foreground">Type</span>
              <select
                value={classification}
                onChange={(e) => setClassification(e.target.value as CategoryClassification)}
                className="rounded-[var(--radius)] border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              >
                {CLASSIFICATIONS.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>

            <div className="flex flex-col gap-1.5 text-sm">
              <span className="text-muted-foreground">Color</span>
              <div className="flex gap-2">
                {CATEGORY_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-label={c}
                    aria-pressed={c === color}
                    onClick={() => setColor(c)}
                    className={cn(
                      "flex h-8 w-8 items-center justify-center rounded-full transition focus:outline-none focus:ring-2 focus:ring-ring",
                      categoryColorClass(c),
                      c === color ? "ring-2 ring-ring" : "hover:opacity-80",
                    )}
                  >
                    {c === color && <Check className="h-4 w-4" />}
                  </button>
                ))}
              </div>
            </div>
          </>
        )}

        <div className="flex flex-col gap-1.5 text-sm">
          <span className="text-muted-foreground">Icon</span>
          <div className="grid max-h-40 grid-cols-10 gap-1 overflow-y-auto rounded-[var(--radius)] border border-border p-2">
            {CATEGORY_ICON_NAMES.map((iconName) => {
              const Icon = categoryIcon(iconName);
              return (
                <button
                  key={iconName}
                  type="button"
                  aria-label={iconName}
                  aria-pressed={iconName === icon}
                  onClick={() => setIcon(iconName)}
                  className={cn(
                    "flex h-8 w-8 items-center justify-center rounded-[var(--radius)] transition focus:outline-none focus:ring-2 focus:ring-ring",
                    iconName === icon
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  <Icon className="h-4 w-4" />
                </button>
              );
            })}
          </div>
        </div>

        {error && <p className="text-sm text-negative">{error}</p>}

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            {"Cancel"}
          </Button>
          <Button disabled={!valid || saving} onClick={() => void save()}>
            {saving ? "Saving…" : "Save category"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
