import type { TextStatus } from './types';

/**
 * The extractor version and retry policy recorded on StoredFile. Apart from
 * index.ts so a page can show a resume's text status without pulling the
 * extraction worker and its libraries into its bundle.
 */

/** Bump when extraction improves: the backfill retries every resume that has no text. */
export const EXTRACTOR_VERSION = 2;
/** Attempts per file and extractor version, the one at upload included. */
export const MAX_TEXT_ATTEMPTS = 3;

/**
 * Whether the resume-text backfill will still try this file: not read by this
 * extractor version yet, or unfinished or FAILED with attempts left.
 */
export function textPending(file: { textStatus: TextStatus | null; textVersion: number | null; textAttempts: number }): boolean {
  if (file.textVersion === null || file.textVersion < EXTRACTOR_VERSION) return true;
  return (file.textStatus === null || file.textStatus === 'FAILED') && file.textAttempts < MAX_TEXT_ATTEMPTS;
}
