/**
 * Which parser reads which connector's documents.
 *
 * The connection the user picked chooses the parser; nothing sniffs the file.
 * Until there were two parsers the worker simply hardcoded the one, which is
 * why this module exists at all.
 *
 * It deliberately stays out of the Next server's import graph. Each entry
 * reaches a parser module, and a parser module reaching `pdf-load.ts` would
 * pull `pdfjs-dist` into the server bundle — so only the worker script imports
 * this. See docs/design/connector-interface.md §3.
 *
 * The `LongTermSavingsImporter` shape is what lets one worker serve every
 * provider: the provider-specific report type stops here, and everything
 * downstream sees the normalised `LongTermSavingsReport`.
 */
import type { ConnectorId } from "../types";
import { harelHishtalmutParser, normaliseHarelHishtalmut } from "./harel/hishtalmut";
import { harelPensionQuarterlyParser, normaliseHarelPension } from "./harel/pension-quarterly";
import type { LongTermSavingsReport } from "./long-term-savings-report";
import type { Item } from "./pdf-text";
import type { DocumentParser } from "./types";

export interface LongTermSavingsImporter {
  /** Stored on every snapshot, with the version, so a bad parse is traceable. */
  readonly parserId: string;
  readonly parserVersion: number;
  /**
   * A guard, not a router. The connection already chose this importer, so a
   * mismatch means the user uploaded the wrong document.
   */
  recognises(items: Item[]): boolean;
  /** Throws `DocumentParseError` when the document is recognised but unreadable. */
  read(items: Item[]): LongTermSavingsReport;
}

function importer<TReport>(
  parser: DocumentParser<TReport>,
  normalise: (report: TReport) => LongTermSavingsReport,
): LongTermSavingsImporter {
  return {
    parserId: parser.id,
    parserVersion: parser.version,
    recognises: (items) => parser.recognises(items),
    read: (items) => normalise(parser.parse(items)),
  };
}

/**
 * Partial over `ConnectorId` because most connectors are scraped, not imported.
 * A lookup miss is the worker's signal that the connection does not import
 * documents at all.
 */
export const LONG_TERM_SAVINGS_IMPORTERS: Partial<Record<ConnectorId, LongTermSavingsImporter>> = {
  harel_pension_quarterly: importer(harelPensionQuarterlyParser, normaliseHarelPension),
  harel_hishtalmut: importer(harelHishtalmutParser, normaliseHarelHishtalmut),
};
