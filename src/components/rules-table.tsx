"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2, Pencil } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { RuleForm } from "@/components/rule-form";
import type { CategoryView, RuleView } from "@/domain/categorization";

interface RulesTableProps {
  rules: RuleView[];
  categories: CategoryView[];
}

/**
 * The rules screen. It exists because rules get written on the user's behalf
 * — by the "apply to future" checkbox and by the learner after three
 * agreeing corrections — and a rule the user can't see, disable, or delete
 * would be indistinguishable from magic (docs/design/categorization.md).
 */
export function RulesTable({ rules, categories }: RulesTableProps) {
  const router = useRouter();
  const [editing, setEditing] = useState<RuleView | "new" | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function toggle(rule: RuleView, active: boolean) {
    setBusyId(rule.id);
    const res = await fetch(`/api/rules/${rule.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ active }),
    });
    setBusyId(null);
    if (res.ok) router.refresh();
  }

  async function remove(rule: RuleView) {
    setBusyId(rule.id);
    const res = await fetch(`/api/rules/${rule.id}`, { method: "DELETE" });
    setBusyId(null);
    if (res.ok) router.refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        {/* Outline, not primary: every row already carries an amber Switch,
            and a filled amber button on top of N amber toggles is more accent
            than this view should have (docs/design/ui-and-feel.md — amber is
            sparing, one accent element per view). */}
        <Button variant="outline" onClick={() => setEditing("new")}>
          <Plus className="h-4 w-4" />
          {"New rule"}
        </Button>
      </div>

      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-5 py-3 font-medium">Rule</th>
              <th className="px-5 py-3 font-medium">When</th>
              <th className="px-5 py-3 font-medium">Category</th>
              <th className="px-5 py-3 font-medium">Active</th>
              <th className="px-5 py-3 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rules.map((rule) => (
              <tr key={rule.id}>
                <td className="px-5 py-3 text-foreground">
                  {/* A rule name is entirely user text and is routinely
                      Hebrew, so it gets its own bidi isolate — otherwise it
                      reorders the `learned` badge beside it. */}
                  <bdi>{rule.name}</bdi>
                  {rule.learned && <Badge className="ml-2">learned</Badge>}
                </td>
                <td className="px-5 py-3 font-mono text-xs text-muted-foreground">
                  {rule.summary}
                </td>
                <td className="px-5 py-3">
                  {rule.categoryName ? (
                    <Badge>{rule.categoryName}</Badge>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="px-5 py-3">
                  <Switch
                    checked={rule.active}
                    disabled={busyId === rule.id}
                    onCheckedChange={(next) => void toggle(rule, next)}
                  />
                </td>
                <td className="whitespace-nowrap px-5 py-3 text-right">
                  <button
                    type="button"
                    onClick={() => setEditing(rule)}
                    aria-label={`Edit ${rule.name}`}
                    className="rounded-[var(--radius)] p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    disabled={busyId === rule.id}
                    onClick={() => void remove(rule)}
                    aria-label={`Delete ${rule.name}`}
                    className="rounded-[var(--radius)] p-1.5 text-muted-foreground transition hover:bg-muted hover:text-negative focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </td>
              </tr>
            ))}
            {rules.length === 0 && (
              <tr>
                <td colSpan={5} className="px-5 py-8 text-center text-muted-foreground">
                  {
                    "No rules yet. Categorize a transaction and tick “Also categorize future transactions” to create one."
                  }
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      {editing && (
        <RuleForm
          rule={editing === "new" ? null : editing}
          categories={categories}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
