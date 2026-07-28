"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Money } from "@/components/money";
import { CategoryPicker } from "@/components/category-picker";
import type { CategoryView } from "@/domain/categorization";
import type { EntryView } from "@/domain/transactions";

interface CategorizeDialogProps {
  entry: EntryView | null;
  categories: CategoryView[];
  /** Pre-selects the suggested category for an uncategorized entry, so
   * opening the dialog is a confirmation rather than a search. Never
   * overrides a category the entry already has. */
  suggestedCategoryId?: string | null;
  onClose: () => void;
}

/**
 * Categorize or re-categorize one transaction. Saving here LOCKS the
 * category: no rule and no model will ever overwrite it again
 * (docs/design/categorization.md).
 *
 * Every date shown arrives pre-formatted from the server as `dateLabel` —
 * formatting an ISO string in a client component is a hydration mismatch
 * (.agents/skills/ui-developer).
 */
export function CategorizeDialog({
  entry,
  categories,
  suggestedCategoryId = null,
  onClose,
}: CategorizeDialogProps) {
  const router = useRouter();
  // Callers mount this with `key={entry.id}`, so switching rows remounts the
  // component and these initializers ARE the reset — no effect needed.
  const [categoryId, setCategoryId] = useState<string | null>(
    entry?.categoryId ?? suggestedCategoryId,
  );
  const [createRule, setCreateRule] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!entry) return null;
  const matchText = entry.matchText;

  async function save(nextCategoryId: string | null) {
    if (!entry) return;
    setSaving(true);
    setError(null);
    const res = await fetch(`/api/entries/${entry.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        categoryId: nextCategoryId,
        ...(nextCategoryId && createRule && entry.matchText !== ""
          ? { createRule: { matchText: entry.matchText } }
          : {}),
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
    <Dialog open onClose={onClose} title="Categorize transaction">
      <div className="flex flex-col gap-5">
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
          <dt className="text-muted-foreground">Date</dt>
          <dd className="tabular-nums text-foreground">{entry.dateLabel}</dd>
          <dt className="text-muted-foreground">Payee</dt>
          <dd className="text-foreground">{entry.merchantName ?? entry.description}</dd>
          <dt className="text-muted-foreground">Account</dt>
          <dd className="text-foreground">{entry.accountName}</dd>
          <dt className="text-muted-foreground">Amount</dt>
          <dd>
            <Money value={entry.amount} signColor />
          </dd>
        </dl>

        <CategoryPicker categories={categories} value={categoryId} onChange={setCategoryId} />

        {matchText !== "" && (
          <label className="flex items-start gap-2.5 text-sm text-muted-foreground">
            <input
              type="checkbox"
              checked={createRule}
              onChange={(e) => setCreateRule(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-input bg-background accent-primary focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <span>
              {"Also categorize every uncategorized transaction matching "}
              <span className="text-foreground">
                {"\u201C"}
                <bdi>{matchText}</bdi>
                {"\u201D"}
              </span>
            </span>
          </label>
        )}

        {error && <p className="text-sm text-negative">{error}</p>}

        <div className="flex items-center justify-between gap-3">
          {entry.categoryId ? (
            <Button variant="ghost" disabled={saving} onClick={() => void save(null)}>
              {"Clear category"}
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} disabled={saving}>
              {"Cancel"}
            </Button>
            <Button
              disabled={saving || !categoryId || categoryId === entry.categoryId}
              onClick={() => void save(categoryId)}
            >
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
