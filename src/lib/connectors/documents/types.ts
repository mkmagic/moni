/**
 * The contract every user-uploaded document parser implements.
 *
 * A parser is chosen by the connection the user picked, never by sniffing —
 * `connector_id` maps to exactly one parser. `recognises` is therefore a guard,
 * not a router: it exists so a user who uploads the wrong statement gets a
 * clear rejection instead of a plausible-looking misparse. Parsers need not be
 * mutually exclusive, and two providers with similar layouts stay a UX question
 * rather than a correctness problem.
 */
import type { Item } from "./pdf-text";

export type DocumentParseErrorCode =
  "unrecognised_document" | "malformed_document" | "unreadable_document";

export class DocumentParseError extends Error {
  constructor(readonly code: DocumentParseErrorCode) {
    super(code);
    this.name = "DocumentParseError";
  }
}

export interface DocumentParser<TReport> {
  /** Stored on every snapshot as `parser_id`. */
  readonly id: string;
  /**
   * Stored on every snapshot as `parser_version`. Bump whenever extraction
   * logic changes. The source PDF is discarded after parsing, so a parser bug
   * can never be fixed retroactively — knowing which snapshots came from the
   * buggy version is the only way to tell a user which history to distrust.
   */
  readonly version: number;
  /** Cheap structural check that these items are the document this parser reads. */
  recognises(items: Item[]): boolean;
  /** Throws `DocumentParseError` when the document is recognised but unreadable. */
  parse(items: Item[]): TReport;
}
