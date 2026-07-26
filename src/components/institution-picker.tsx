"use client";

import { Landmark, CreditCard, TrendingUp, type LucideIcon } from "lucide-react";
import { CONNECTOR_LIST, type ConnectorDefinition, type ConnectorId } from "@/lib/connectors";
import { Card } from "@/components/ui/card";

interface InstitutionPickerProps {
  onSelect: (connectorId: ConnectorId) => void;
}

/** Institution picker: Bank account and Credit card are live, sourced from
 * CONNECTOR_REGISTRY — never a second hardcoded list. Investments has no
 * registry entry at all (vision.md defers the module), so it's rendered as
 * a disabled tile with a plainly-visible "coming after v1.0" note rather
 * than offered as a real option. */
export function InstitutionPicker({ onSelect }: InstitutionPickerProps) {
  const banks = CONNECTOR_LIST.filter((c) => c.kind === "bank");
  const cards = CONNECTOR_LIST.filter((c) => c.kind === "credit_card");

  return (
    <div className="flex flex-col gap-6">
      <PickerGroup icon={Landmark} label="Bank account" connectors={banks} onSelect={onSelect} />
      <PickerGroup icon={CreditCard} label="Credit card" connectors={cards} onSelect={onSelect} />
      <div className="flex flex-col gap-2">
        <h3 className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <TrendingUp className="h-4 w-4" /> Investments
        </h3>
        <Card className="cursor-not-allowed px-4 py-3 opacity-50">
          <p className="text-sm text-foreground">Investment accounts</p>
          <p className="text-xs text-muted-foreground">Coming after v1.0</p>
        </Card>
      </div>
    </div>
  );
}

function PickerGroup({
  icon: Icon,
  label,
  connectors,
  onSelect,
}: {
  icon: LucideIcon;
  label: string;
  connectors: ConnectorDefinition[];
  onSelect: (connectorId: ConnectorId) => void;
}) {
  if (connectors.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <h3 className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
        <Icon className="h-4 w-4" /> {label}
      </h3>
      <div className="grid grid-cols-2 gap-2">
        {connectors.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => onSelect(c.id)}
            className="rounded-[var(--radius)] border border-border bg-card px-3 py-2 text-left text-sm text-foreground transition hover:border-primary/50 hover:bg-muted"
          >
            {c.label}
          </button>
        ))}
      </div>
    </div>
  );
}
