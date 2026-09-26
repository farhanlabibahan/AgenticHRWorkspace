/**
 * Shared types for document text extraction (src/server/text).
 *
 * Each adapter turns one file format into raw text. index.ts sniffs the real
 * format from the bytes (never the declared MIME or the filename), dispatches
 * to the adapter, normalizes the text, and reports a status that is stored on
 * StoredFile so the backfill knows what is worth retrying.
 */

export type TextFormat = 'pdf' | 'docx' | 'doc' | 'odt' | 'rtf' | 'txt' | 'html';

/**
 * What an adapter returns. `text` is raw (index.ts normalizes it); `links` are
 * link targets that are not visible in the text itself, e.g. a PDF link
 * annotation or a DOCX hyperlink behind the words "LinkedIn".
 */
export type AdapterOutput = { text: string; links: string[]; pages?: number };

export type Adapter = (data: Uint8Array) => AdapterOutput | Promise<AdapterOutput>;

export type SniffResult = {
  format: TextFormat | null;
  /** Why there is no format: nothing to extract, or a type we don't read. */
  reason?: 'empty' | 'encrypted' | 'image' | 'zip-other' | 'ole2-other' | 'binary' | 'unknown';
};

/** Stored as StoredFile.textStatus. Everything but FAILED is final for an extractor version. */
export type TextStatus = 'OK' | 'EMPTY' | 'UNSUPPORTED' | 'ENCRYPTED' | 'TOO_LARGE' | 'MISSING' | 'FAILED';

/** A password-protected document. Final: retrying won't help. */
export class EncryptedDocumentError extends Error {
  constructor(message = 'The document is password-protected') {
    super(message);
    this.name = 'EncryptedDocumentError';
  }
}

/** A document that trips a safety limit: a zip bomb, too many entries, nesting too deep. */
export class DocumentLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentLimitError';
  }
}
