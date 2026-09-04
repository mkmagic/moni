"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Pencil } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Money } from "@/components/money";
import { CategoryPicker } from "@/components/category-picker";
import type { CategoryView, DescriptionOperator } from "@/domain/categorization";
import type { EntryView } from "@/domain/transactions";

/** The same labels the rule form uses, so the rule you write here and the
 * rule you later edit on the Rules tab read identically. */
const OPERATORS: { value: DescriptionOperator; label: string }[] = [
  { value: "contains", label: "contains" },
  { value: "starts_with", label: "starts with" },
  { value: "equals", label: "is exactly" },
];

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
 * Edit one transaction: set its category, or correct its date. Both writes
 * LOCK the field — no rule, model, or later scrape overwrites a value a human
 * set (docs/design/categorization.md, src/domain/attribute-locks.ts).
 *
 * The date is shown pre-formatted from the server as `dateLabel` — formatting
 * an ISO string in a client component is a hydration mismatch
 * (.agents/skills/ui-developer). The date-picker instead binds to the raw
 * `entry.date` (already `YYYY-MM-DD`), which a native date input takes as-is.
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
  // On by default. The old opt-in checkbox wrote a rule only for the exact
  // text, which meant the one setting people never turned on was also the one
  // that would rarely have fired — the default and the value were both wrong.
  // An editable condition earns being on: you can see what it will match
  // before you save, and widen or narrow it in place.
  const [createRule, setCreateRule] = useState(true);
  const [operator, setOperator] = useState<DescriptionOperator>("contains");
  const [ruleValue, setRuleValue] = useState(entry?.matchText ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingDate, setEditingDate] = useState(false);
  const [dateValue, setDateValue] = useState(entry?.date ?? "");

  if (!entry) return null;
  const matchText = entry.matchText;
  const ruleReady = !createRule || ruleValue.trim() !== "";

  async function save(nextCategoryId: string | null) {
    if (!entry) return;
    setSaving(true);
    setError(null);
    const res = await fetch(`/api/entries/${entry.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        categoryId: nextCategoryId,
        ...(nextCategoryId && createRule && ruleValue.trim() !== ""
          ? { createRule: { operator, value: ruleValue.trim() } }
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

  async function saveDate() {
    if (!entry || dateValue === "") return;
    setSaving(true);
    setError(null);
    const res = await fetch(`/api/entries/${entry.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ date: dateValue }),
    });
    setSaving(false);
    if (res.ok) {
      router.refresh();
      onClose();
      return;
    }
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    setError(body.error ?? "Could not save the date");
  }

  return (
    <Dialog open onClose={onClose} title="Edit transaction">
      <div className="flex flex-col gap-5">
        <dl className="grid grid-cols-[auto_1fr] items-center gap-x-6 gap-y-1.5 text-sm">
          <dt className="text-muted-foreground">Date</dt>
          <dd className="text-foreground">
            {editingDate ? (
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  type="date"
                  value={dateValue}
                  aria-label="Transaction date"
                  disabled={saving}
                  onChange={(e) => setDateValue(e.target.value)}
                  className="max-w-40 tabular-nums"
                />
                <Button
                  disabled={saving || dateValue === "" || dateValue === entry.date}
                  onClick={() => void saveDate()}
                >
                  {saving ? "Saving…" : "Save"}
                </Button>
                <Button
                  variant="outline"
                  disabled={saving}
                  onClick={() => {
                    setDateValue(entry.date);
                    setEditingDate(false);
                  }}
                >
                  {"Cancel"}
                </Button>
              </div>
            ) : (
              <span className="flex items-center gap-2">
                <span className="tabular-nums">{entry.dateLabel}</span>
                <button
                  type="button"
                  aria-label="Edit date"
                  onClick={() => setEditingDate(true)}
                  className="rounded p-1 text-muted-foreground hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
              </span>
            )}
          </dd>
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
          <div className="flex flex-col gap-2.5">
            <label className="flex items-center gap-2.5 text-sm text-foreground">
              <input
                type="checkbox"
                checked={createRule}
                onChange={(e) => setCreateRule(e.target.checked)}
                className="h-4 w-4 rounded border-input bg-background accent-primary focus:outline-none focus:ring-2 focus:ring-ring"
              />
              <span>{"Create a rule"}</span>
            </label>
            {/* Disabled rather than unmounted: this sits directly under the
                category picker, and a section that appears and disappears
                would resize the dialog under the pointer. */}
            <div className="flex flex-wrap items-center gap-2 pl-6">
              <span className="text-sm text-muted-foreground">{"Description"}</span>
              <select
                value={operator}
                aria-label="Operator"
                disabled={!createRule}
                onChange={(e) => setOperator(e.target.value as DescriptionOperator)}
                className="rounded-[var(--radius)] border border-input bg-background px-2 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
              >
                {OPERATORS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              {/* Prefilled with the match text and Hebrew far more often than
                  not; `dir="auto"` lets the caret and cursor keys follow the
                  text the user is actually editing. */}
              <Input
                value={ruleValue}
                dir="auto"
                disabled={!createRule}
                aria-label="Rule text"
                onChange={(e) => setRuleValue(e.target.value)}
                className="min-w-40 flex-1 disabled:opacity-50"
              />
            </div>
            <p className="pl-6 text-xs text-muted-foreground">
              {
                "Applies to every uncategorized transaction, past and future. It never overrides a category you set by hand."
              }
            </p>
          </div>
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
              disabled={saving || !categoryId || categoryId === entry.categoryId || !ruleReady}
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
