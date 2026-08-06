// Connector registry — the concrete list of supported israeli-bank-scrapers
// connectors, and the ordered login fields each one needs. Field key ORDER
// matters: it must match the library's `SCRAPERS[id].loginFields` exactly
// (verified against node_modules/israeli-bank-scrapers/lib/definitions.js at
// authoring time; tests/unit/connector-registry.test.ts is the drift gate
// that keeps it that way going forward).
import type { ConnectorDefinition, ConnectorId } from "./types";

const PASSWORD_FIELD = { key: "password", label: "Password", inputType: "password" } as const;

function usernamePassword(
  id: ConnectorId,
  label: string,
  kind: ConnectorDefinition["kind"] = "bank",
): ConnectorDefinition {
  return {
    id,
    label,
    kind,
    mode: "credentialed_fetch",
    loginFields: [{ key: "username", label: "Username", inputType: "text" }, PASSWORD_FIELD],
  };
}

export const CONNECTOR_REGISTRY: Record<ConnectorId, ConnectorDefinition> = {
  leumi: usernamePassword("leumi", "Bank Leumi"),
  mizrahi: usernamePassword("mizrahi", "Mizrahi Tefahot"),
  otsarHahayal: usernamePassword("otsarHahayal", "Otsar HaHayal"),
  max: usernamePassword("max", "Max", "credit_card"),
  visaCal: usernamePassword("visaCal", "Visa Cal", "credit_card"),
  union: usernamePassword("union", "Union Bank"),
  beinleumi: usernamePassword("beinleumi", "Bank Beinleumi"),
  massad: usernamePassword("massad", "Bank Massad"),
  pagi: usernamePassword("pagi", "Bank Pagi"),
  hapoalim: {
    id: "hapoalim",
    label: "Bank Hapoalim",
    kind: "bank",
    mode: "credentialed_fetch",
    loginFields: [{ key: "userCode", label: "User Code", inputType: "text" }, PASSWORD_FIELD],
  },
  isracard: {
    id: "isracard",
    label: "Isracard",
    kind: "credit_card",
    mode: "credentialed_fetch",
    loginFields: [
      { key: "id", label: "ID Number", inputType: "text" },
      { key: "card6Digits", label: "Last 6 Digits of Card", inputType: "text" },
      PASSWORD_FIELD,
    ],
  },
  amex: {
    id: "amex",
    label: "American Express (Isracard)",
    kind: "credit_card",
    mode: "credentialed_fetch",
    loginFields: [
      { key: "id", label: "ID Number", inputType: "text" },
      { key: "card6Digits", label: "Last 6 Digits of Card", inputType: "text" },
      PASSWORD_FIELD,
    ],
  },
  discount: {
    id: "discount",
    label: "Discount Bank",
    kind: "bank",
    mode: "credentialed_fetch",
    loginFields: [
      { key: "id", label: "ID Number", inputType: "text" },
      PASSWORD_FIELD,
      { key: "num", label: "Account Number", inputType: "text" },
    ],
  },
  mercantile: {
    id: "mercantile",
    label: "Mercantile Discount Bank",
    kind: "bank",
    mode: "credentialed_fetch",
    loginFields: [
      { key: "id", label: "ID Number", inputType: "text" },
      PASSWORD_FIELD,
      { key: "num", label: "Account Number", inputType: "text" },
    ],
  },
  yahav: {
    id: "yahav",
    label: "Bank Yahav",
    kind: "bank",
    mode: "credentialed_fetch",
    loginFields: [
      { key: "username", label: "Username", inputType: "text" },
      { key: "nationalID", label: "National ID", inputType: "text" },
      PASSWORD_FIELD,
    ],
  },
  ibkr_flex: {
    id: "ibkr_flex",
    label: "Interactive Brokers Flex",
    institutionLabel: "Interactive Brokers",
    kind: "investment",
    mode: "credentialed_fetch",
    loginFields: [
      { key: "flexToken", label: "Flex Token", inputType: "password" },
      { key: "queryId", label: "Query ID", inputType: "text" },
    ],
  },
  schwab_positions_csv: {
    id: "schwab_positions_csv",
    label: "Schwab Positions CSV",
    institutionLabel: "Charles Schwab",
    kind: "investment",
    mode: "user_mediated_import",
    loginFields: [],
  },
  snaptrade: {
    id: "snaptrade",
    label: "SnapTrade",
    kind: "investment",
    mode: "credentialed_fetch",
    loginFields: [
      { key: "clientId", label: "Client ID", inputType: "text" },
      { key: "consumerKey", label: "Consumer Key", inputType: "password" },
    ],
  },
  // One entry per document parser, not per provider: a provider's pension
  // report and its קרן השתלמות report are different layouts and therefore
  // different parsers. The provider-then-document picker falls out of the
  // existing fields — group by `institutionLabel`, list `label` beneath.
  harel_pension_quarterly: {
    id: "harel_pension_quarterly",
    label: "Quarterly Pension Report",
    institutionLabel: "Harel",
    kind: "long_term_savings",
    product: "pension",
    mode: "user_mediated_import",
    loginFields: [],
  },
  // One entry, not one per period: the quarterly and annual קרן השתלמות
  // reports are the same layout with sections dropped, so one parser reads
  // both and the user has one thing to pick rather than a guess about which
  // report they are holding.
  harel_hishtalmut: {
    id: "harel_hishtalmut",
    label: "קרן השתלמות Report (quarterly or annual)",
    institutionLabel: "Harel",
    kind: "long_term_savings",
    product: "hishtalmut",
    mode: "user_mediated_import",
    loginFields: [],
  },
};

export const CONNECTOR_LIST: ConnectorDefinition[] = Object.values(CONNECTOR_REGISTRY);

export function getConnectorDefinition(id: string): ConnectorDefinition | undefined {
  return (CONNECTOR_REGISTRY as Record<string, ConnectorDefinition>)[id];
}

export function isConnectorId(id: string): id is ConnectorId {
  return Object.prototype.hasOwnProperty.call(CONNECTOR_REGISTRY, id);
}

/**
 * The brokerage or bank to show a user for an account.
 *
 * A stored institution of "snaptrade" is Moni's own source id leaking through
 * — accounts created before the promotion learned the real name still carry
 * one, and a raw id is never the answer to "where is my money". Treat it as
 * unset and let the connector name its institution instead.
 */
export function institutionDisplayName(
  institution: string | null | undefined,
  connectorId: string | null | undefined,
): string | null {
  if (institution && !isConnectorId(institution)) return institution;
  const definition = connectorId ? getConnectorDefinition(connectorId) : undefined;
  return definition?.institutionLabel ?? definition?.label ?? institution ?? null;
}
