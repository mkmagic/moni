"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { InstitutionPicker } from "@/components/institution-picker";
import { ConnectForm } from "@/components/connect-form";
import type { ConnectorId } from "@/lib/connectors";

/** Same two-step institution-picker -> connect-form flow as onboarding,
 * reused rather than reinvented, for adding a second (or later) connection
 * from Settings. */
export function ConnectWizard() {
  const router = useRouter();
  const [connectorId, setConnectorId] = useState<ConnectorId | null>(null);

  function onConnected() {
    router.push("/settings/connections");
    router.refresh();
  }

  if (connectorId) {
    return (
      <ConnectForm
        connectorId={connectorId}
        onBack={() => setConnectorId(null)}
        onConnected={onConnected}
      />
    );
  }

  return <InstitutionPicker onSelect={setConnectorId} />;
}
