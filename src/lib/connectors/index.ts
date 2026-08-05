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
  LongTermSavingsProduct,
} from "./types";
export { SCRAPER_BACKED_KINDS } from "./types";
export {
  CONNECTOR_REGISTRY,
  CONNECTOR_LIST,
  getConnectorDefinition,
  institutionDisplayName,
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
  encodeBinaryChildFrame,
  decodeBinaryChildFrame,
  MAX_CHILD_STDIN_BYTES,
  MAX_CHILD_SEGMENT_BYTES,
  MAX_CHILD_METADATA_BYTES,
  MAX_CHILD_FRAME_BYTES,
  type ChildStdinPayload,
} from "./child-stdin-framing";
export { readChildStdin } from "./read-child-stdin";
