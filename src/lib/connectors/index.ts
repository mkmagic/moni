// Connector registry, scraper-output validation, dedup-key derivation, and
// the child-process stdin framing land here (docs plan §"Connector &
// worker"). See docs/design/connector-interface.md.
export type {
  ConnectorId,
  ConnectorKind,
  ConnectorMode,
  ConnectorDefinition,
  LoginFieldDescriptor,
  LoginFieldInputType,
} from "./types";
export {
  CONNECTOR_REGISTRY,
  CONNECTOR_LIST,
  getConnectorDefinition,
  isConnectorId,
} from "./registry";
export {
  scraperTransactionSchema,
  scraperAccountSchema,
  scraperScrapingResultSchema,
  type ScraperTransaction,
  type ScraperAccount,
  type ScraperScrapingResultParsed,
} from "./scraper-output.schema";
export { computeImportKey, type ImportKeyInput } from "./import-key";
export {
  encodeChildStdinFrame,
  decodeChildStdinFrame,
  type ChildStdinPayload,
} from "./child-stdin-framing";
