"use client";

import { Landmark, CreditCard, TrendingUp, type LucideIcon } from "lucide-react";
import { CONNECTOR_LIST, type ConnectorDefinition, type ConnectorId } from "@/lib/connectors";

interface InstitutionPickerProps {
  onSelect: (connectorId: ConnectorId) => void;
  credentialedEnabled?: boolean;
}

/** Institution picker sourced entirely from CONNECTOR_REGISTRY — never a
 * second hardcoded source list. */
export function InstitutionPicker({
  onSelect,
  credentialedEnabled = true,
}: InstitutionPickerProps) {
  const banks = CONNECTOR_LIST.filter((c) => c.kind === "bank");
  const cards = CONNECTOR_LIST.filter((c) => c.kind === "credit_card");
  const investments = CONNECTOR_LIST.filter((c) => c.kind === "investment");

  return (
    <div className="flex flex-col gap-6">
      <PickerGroup
        icon={Landmark}
        label="Bank account"
        connectors={banks}
        onSelect={onSelect}
        credentialedEnabled={credentialedEnabled}
      />
      <PickerGroup
        icon={CreditCard}
        label="Credit card"
        connectors={cards}
        onSelect={onSelect}
        credentialedEnabled={credentialedEnabled}
      />
      <PickerGroup
        icon={TrendingUp}
        label="Investments"
        connectors={investments}
        onSelect={onSelect}
        credentialedEnabled={credentialedEnabled}
      />
    </div>
  );
}

function PickerGroup({
  icon: Icon,
  label,
  connectors,
  onSelect,
  credentialedEnabled,
}: {
  icon: LucideIcon;
  label: string;
  connectors: ConnectorDefinition[];
  onSelect: (connectorId: ConnectorId) => void;
  credentialedEnabled: boolean;
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
            disabled={!credentialedEnabled && c.mode === "credentialed_fetch"}
            title={
              !credentialedEnabled && c.mode === "credentialed_fetch"
                ? "Set up a passkey first"
                : undefined
            }
            className="rounded-[var(--radius)] border border-border bg-card px-3 py-2 text-left text-sm text-foreground transition hover:border-primary/50 hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
          >
            {c.label}
          </button>
        ))}
      </div>
    </div>
  );
}
