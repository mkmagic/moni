"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Pencil, Trash2, Search } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { CategoryIconTile } from "@/components/category-icon";
import { CategoryForm } from "@/components/category-form";
import type { CategoryDetailView, CategoryGroupView } from "@/domain/categorization";

interface CategoriesManagerProps {
  groups: CategoryGroupView[];
}

/** What the form is currently open for. `defaultParentId` pre-selects the
 * group when the user pressed "+" on a specific card. */
type Editing =
  | { category: CategoryDetailView; defaultParentId: null; hasChildren: boolean }
  | { category: null; defaultParentId: string | null; hasChildren: false };

export function CategoriesManager({ groups }: CategoriesManagerProps) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Editing | null>(null);
  const [deleting, setDeleting] = useState<CategoryDetailView | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    // `totalChildren` is the group's real size, carried separately from the
    // rendered `children`. The header states a fact about the category, so it
    // must not shrink to "1 subcategory" just because a filter is hiding the
    // other three.
    return groups
      .map((g) => ({
        ...g,
        totalChildren: g.children.length,
        // A group whose own name matches keeps all its children, so searching
        // "food" shows the whole group rather than an empty card.
        children:
          q === "" || g.name.toLowerCase().includes(q)
            ? g.children
            : g.children.filter((c) => c.name.toLowerCase().includes(q)),
      }))
      .filter((g) => q === "" || g.name.toLowerCase().includes(q) || g.children.length > 0);
  }, [groups, query]);

  async function confirmDelete() {
    if (!deleting) return;
    setBusy(true);
    setDeleteError(null);
    const res = await fetch(`/api/categories/${deleting.id}`, { method: "DELETE" });
    setBusy(false);
    if (res.ok) {
      setDeleting(null);
      router.refresh();
      return;
    }
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    setDeleteError(body.error ?? "Could not delete");
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search categories"
            className="w-full rounded-[var(--radius)] border border-input bg-background py-2 pl-9 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <Button
          onClick={() => setEditing({ category: null, defaultParentId: null, hasChildren: false })}
        >
          <Plus className="h-4 w-4" />
          {"New group"}
        </Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {visible.map((group) => (
          <Card key={group.id} className="flex flex-col gap-3 px-5 pb-4 pt-6">
            <div className="flex items-start gap-3">
              <CategoryIconTile icon={group.icon} color={group.color} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  {/* A category name is user text and is routinely Hebrew, so
                      it gets its own bidi isolate or it reorders the badge
                      beside it (.claude/skills/ui-developer). */}
                  <bdi className="font-medium text-foreground">{group.name}</bdi>
                  <Badge>{group.classification}</Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  {`${group.totalChildren} subcategor${group.totalChildren === 1 ? "y" : "ies"}`}
                </p>
              </div>
              {/* Gated on the real child count, not the filtered one: a
                  search that hides every child must not make the group look
                  deletable when the server will refuse it. */}
              <RowActions
                category={group}
                hasChildren={group.totalChildren > 0}
                onEdit={() =>
                  setEditing({
                    category: group,
                    defaultParentId: null,
                    hasChildren: group.totalChildren > 0,
                  })
                }
                onDelete={() => {
                  setDeleteError(null);
                  setDeleting(group);
                }}
              />
            </div>

            <div className="flex flex-col divide-y divide-border border-t border-border">
              {group.children.map((child) => (
                <div key={child.id} className="flex items-center gap-3 py-2">
                  <CategoryIconTile icon={child.icon} color={child.color} size="sm" />
                  {/* The isolate is wrapped rather than stretched: putting
                      `flex-1` on the <bdi> itself makes it its own paragraph,
                      and a Hebrew name then aligns to the far edge, stranded
                      away from its icon. Isolating inside an LTR box keeps
                      the name beside the icon and still stops it reordering
                      the count and buttons after it. */}
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                    <bdi>{child.name}</bdi>
                  </span>
                  <span className="tabular-nums text-xs text-muted-foreground">
                    {child.entryCount}
                  </span>
                  <RowActions
                    category={child}
                    hasChildren={false}
                    onEdit={() =>
                      setEditing({ category: child, defaultParentId: null, hasChildren: false })
                    }
                    onDelete={() => {
                      setDeleteError(null);
                      setDeleting(child);
                    }}
                  />
                </div>
              ))}
              {group.children.length === 0 && (
                <p className="py-3 text-sm text-muted-foreground">{"No subcategories yet."}</p>
              )}
            </div>

            <Button
              variant="ghost"
              className="self-start px-0 text-xs"
              onClick={() =>
                setEditing({ category: null, defaultParentId: group.id, hasChildren: false })
              }
            >
              <Plus className="h-3.5 w-3.5" />
              {"Add subcategory"}
            </Button>
          </Card>
        ))}
      </div>

      {visible.length === 0 && (
        <Card className="px-5 py-10 text-center text-sm text-muted-foreground">
          {"No category matches that search."}
        </Card>
      )}

      {editing && (
        <CategoryForm
          category={editing.category}
          defaultParentId={editing.defaultParentId}
          hasChildren={editing.hasChildren}
          groups={groups}
          onClose={() => setEditing(null)}
        />
      )}

      {deleting && (
        <Dialog open onClose={() => setDeleting(null)} title={`Delete ${deleting.name}?`}>
          <div className="flex flex-col gap-4 text-sm">
            <p className="text-muted-foreground">
              {deleting.entryCount === 0
                ? "No transactions use this category."
                : `${deleting.entryCount} transaction${deleting.entryCount === 1 ? "" : "s"} become uncategorized and pass back through the rules engine.`}
            </p>
            {deleting.ruleCount > 0 && (
              <p className="text-muted-foreground">
                {`${deleting.ruleCount} rule${deleting.ruleCount === 1 ? "" : "s"} that set this category ${deleting.ruleCount === 1 ? "is" : "are"} deleted with it — a rule can't assign a category that no longer exists.`}
              </p>
            )}
            {deleteError && <p className="text-negative">{deleteError}</p>}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setDeleting(null)} disabled={busy}>
                {"Cancel"}
              </Button>
              <Button
                variant="outline"
                className="border-negative text-negative hover:bg-negative/10"
                disabled={busy}
                onClick={() => void confirmDelete()}
              >
                {busy ? "Deleting…" : "Delete"}
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function RowActions({
  category,
  hasChildren,
  onEdit,
  onDelete,
}: {
  category: CategoryDetailView;
  hasChildren: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  // A built-in category is rename-only: `categories:sync` re-adds the shipped
  // set on upgrade, so a delete would appear to work and then come back.
  const deleteReason = category.builtin
    ? "Built-in categories can be renamed but not deleted"
    : hasChildren
      ? "Delete or move its subcategories first"
      : null;

  return (
    <div className="flex shrink-0 items-center">
      <button
        type="button"
        onClick={onEdit}
        aria-label={`Edit ${category.name}`}
        className="rounded-[var(--radius)] p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
      >
        <Pencil className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={onDelete}
        disabled={deleteReason !== null}
        title={deleteReason ?? undefined}
        aria-label={`Delete ${category.name}`}
        className="rounded-[var(--radius)] p-1.5 text-muted-foreground transition hover:bg-muted hover:text-negative focus:outline-none focus:ring-2 focus:ring-ring disabled:pointer-events-none disabled:opacity-30"
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  );
}
