/**
 * Agam Liderim xlsx importer. Imported only by the import worker — never by the
 * Next server — so its xlsx reader stays out of the browser and server bundles.
 */
export {
  AGAM_LIDERIM_PARSER_ID,
  AGAM_LIDERIM_PARSER_VERSION,
  parseAgamLiderimPortfolio,
  recognises,
  type AgamLiderimAccount,
  type AgamLiderimPortfolio,
} from "./parse";
