"use client";

import { useState } from "react";
import {
  ChevronLeft,
  Landmark,
  CreditCard,
  PiggyBank,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { CONNECTOR_LIST, type ConnectorDefinition, type ConnectorId } from "@/lib/connectors";

interface InstitutionPickerProps {
  onSelect: (connectorId: ConnectorId) => void;
  credentialedEnabled?: boolean;
}

/** The provider name a long-term-savings connector belongs to, e.g. "Harel". */
function providerOf(connector: ConnectorDefinition): string {
  return connector.institutionLabel ?? connector.label;
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
  const longTermSavings = CONNECTOR_LIST.filter((c) => c.kind === "long_term_savings");
  const [provider, setProvider] = useState<string | null>(null);

  // A provider publishes several reports and each is its own parser, so the
  // top level names the PROVIDER and its reports live one screen in. Listing
  // them flat put "Harel · Quarterly Pension Report" beside "Bank Leumi",
  // which reads as a different kind of thing than every tile around it.
  if (provider !== null) {
    return (
      <ProviderReports
        provider={provider}
        connectors={longTermSavings.filter((c) => providerOf(c) === provider)}
        onSelect={onSelect}
        onBack={() => setProvider(null)}
      />
    );
  }

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
      {longTermSavings.length > 0 && (
        <div className="flex flex-col gap-2">
          <GroupHeading icon={PiggyBank} label="Long-term savings" />
          <div className="grid grid-cols-2 gap-2">
            {[...new Set(longTermSavings.map(providerOf))].map((name) => (
              <Tile key={name} onClick={() => setProvider(name)}>
                {name}
              </Tile>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** The reports one provider publishes — the second step of the picker. */
function ProviderReports({
  provider,
  connectors,
  onSelect,
  onBack,
}: {
  provider: string;
  connectors: ConnectorDefinition[];
  onSelect: (connectorId: ConnectorId) => void;
  onBack: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h3 className="flex items-center gap-2 text-sm font-medium text-foreground">
          <PiggyBank className="h-4 w-4" /> <bdi>{provider}</bdi>
        </h3>
        <p className="text-sm text-muted-foreground">
          {"Pick the report you have. Each is a different document, read by its own parser."}
        </p>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {connectors.map((c) => (
          <Tile key={c.id} onClick={() => onSelect(c.id)}>
            {c.label}
          </Tile>
        ))}
      </div>
      <Button type="button" variant="ghost" onClick={onBack} className="gap-1 self-start px-0">
        <ChevronLeft className="h-3.5 w-3.5" /> Back
      </Button>
    </div>
  );
}

function GroupHeading({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <h3 className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
      <Icon className="h-4 w-4" /> {label}
    </h3>
  );
}

function Tile({
  children,
  onClick,
  disabled,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="rounded-[var(--radius)] border border-border bg-card px-3 py-2 text-left text-sm text-foreground transition hover:border-primary/50 hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function PickerGroup({
  icon,
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
      <GroupHeading icon={icon} label={label} />
      <div className="grid grid-cols-2 gap-2">
        {connectors.map((c) => {
          const locked = !credentialedEnabled && c.mode === "credentialed_fetch";
          return (
            <Tile
              key={c.id}
              onClick={() => onSelect(c.id)}
              disabled={locked}
              title={locked ? "Set up a passkey first" : undefined}
            >
              {c.label}
            </Tile>
          );
        })}
      </div>
    </div>
  );
}
