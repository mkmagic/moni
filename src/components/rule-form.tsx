"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CategoryPicker } from "@/components/category-picker";
import type { CategoryView, RuleConditionInput, RuleView } from "@/domain/categorization";

interface RuleFormProps {
  /** Null to create. */
  rule: RuleView | null;
  categories: CategoryView[];
  onClose: () => void;
}

/** The v1.0 condition vocabulary. Deliberately small, and deliberately no
 * regex: rule values are user-authored but descriptions are untrusted
 * scraper output, so a regex engine on that path is a ReDoS surface for no
 * real gain (docs/design/categorization.md). */
const FIELDS = [
  { value: "description", label: "Description" },
  { value: "amount", label: "Amount" },
] as const;

const OPERATORS = {
  description: [
    { value: "contains", label: "contains" },
    { value: "starts_with", label: "starts with" },
    { value: "equals", label: "is exactly" },
  ],
  amount: [
    { value: "gt", label: "is more than" },
    { value: "lt", label: "is less than" },
    { value: "eq", label: "equals" },
  ],
} as const;

type Field = (typeof FIELDS)[number]["value"];

interface ConditionDraft {
  field: Field;
  operator: string;
  value: string;
}

function toDraft(c: RuleConditionInput | undefined): ConditionDraft {
  if (!c || (c.conditionType !== "description" && c.conditionType !== "amount")) {
    return { field: "description", operator: "contains", value: "" };
  }
  return { field: c.conditionType, operator: c.operator, value: c.value };
}

export function RuleForm({ rule, categories, onClose }: RuleFormProps) {
  const router = useRouter();
  const [name, setName] = useState(rule?.name ?? "");
  const [categoryId, setCategoryId] = useState<string | null>(rule?.categoryId ?? null);
  // One condition, plus an optional second ANDed on. That is exactly the
  // schema's one nesting level, so the form can't express something the
  // matcher is unable to evaluate.
  const [first, setFirst] = useState<ConditionDraft>(toDraft(rule?.conditions[0]));
  const [second, setSecond] = useState<ConditionDraft | null>(
    rule && rule.conditions.length > 1 ? toDraft(rule.conditions[1]) : null,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const drafts = second ? [first, second] : [first];
  const valid = name.trim() !== "" && categoryId !== null && drafts.every((d) => d.value !== "");

  async function save() {
    if (!categoryId) return;
    setSaving(true);
    setError(null);

    const conditions: RuleConditionInput[] = drafts.map((d) => ({
      conditionType: d.field,
      operator: d.operator as RuleConditionInput["operator"],
      value: d.value.trim(),
    }));

    const res = await fetch(rule ? `/api/rules/${rule.id}` : "/api/rules", {
      method: rule ? "PATCH" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: name.trim(),
        active: rule?.active ?? true,
        effectiveDate: rule?.effectiveDate ?? null,
        categoryId,
        conditions,
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
      title={rule ? "Edit rule" : "New rule"}
      description="Rules run before the built-in merchant list, and never touch a category you set by hand."
    >
      <div className="flex flex-col gap-5">
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="text-muted-foreground">Name</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Groceries" />
        </label>

        <div className="flex flex-col gap-3">
          <span className="text-sm text-muted-foreground">When</span>
          <ConditionRow draft={first} onChange={setFirst} />
          {second ? (
            <div className="flex items-start gap-2">
              <div className="flex-1">
                <ConditionRow draft={second} onChange={setSecond} prefix="and" />
              </div>
              <Button variant="ghost" onClick={() => setSecond(null)}>
                {"Remove"}
              </Button>
            </div>
          ) : (
            <Button
              variant="ghost"
              className="self-start px-0"
              onClick={() => setSecond({ field: "description", operator: "contains", value: "" })}
            >
              {"+ Add condition"}
            </Button>
          )}
        </div>

        <div className="flex flex-col gap-1.5 text-sm">
          <span className="text-muted-foreground">Set category to</span>
          <CategoryPicker categories={categories} value={categoryId} onChange={setCategoryId} />
        </div>

        {error && <p className="text-sm text-negative">{error}</p>}

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            {"Cancel"}
          </Button>
          <Button disabled={!valid || saving} onClick={() => void save()}>
            {saving ? "Saving…" : "Save rule"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function ConditionRow({
  draft,
  onChange,
  prefix,
}: {
  draft: ConditionDraft;
  onChange: (next: ConditionDraft) => void;
  prefix?: string;
}) {
  const selectClass =
    "rounded-[var(--radius)] border border-input bg-background px-2 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring";

  return (
    <div className="flex flex-wrap items-center gap-2">
      {prefix && <span className="text-sm text-muted-foreground">{prefix}</span>}
      <select
        value={draft.field}
        aria-label="Field"
        onChange={(e) => {
          const field = e.target.value as Field;
          onChange({ field, operator: OPERATORS[field][0].value, value: "" });
        }}
        className={selectClass}
      >
        {FIELDS.map((f) => (
          <option key={f.value} value={f.value}>
            {f.label}
          </option>
        ))}
      </select>
      <select
        value={draft.operator}
        aria-label="Operator"
        onChange={(e) => onChange({ ...draft, operator: e.target.value })}
        className={selectClass}
      >
        {OPERATORS[draft.field].map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <Input
        value={draft.value}
        onChange={(e) => onChange({ ...draft, value: e.target.value })}
        placeholder={draft.field === "amount" ? "100" : "שופרסל"}
        className="min-w-40 flex-1"
      />
    </div>
  );
}
