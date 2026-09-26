import type { OcrStatus, Prisma, TextStatus } from '@prisma/client';

/**
 * The OCR version and retry policy recorded on StoredFile. Apart from the
 * engine so a page can show a resume's OCR state without pulling Tesseract
 * and pdf.js into its bundle.
 */

/** Bump when OCR improves: the resume-ocr cron tries again every scan that still has no text. */
export const OCR_VERSION = 1;
/** Attempts per file and OCR version. Only FAILED (a crash or a timeout) is retried. */
export const MAX_OCR_ATTEMPTS = 3;

/**
 * Text statuses OCR may still turn into text: no text layer (a scanned PDF),
 * or a format text extraction doesn't read (an image, which only imports
 * bring). The OCR run reads the bytes and skips anything else.
 */
export const OCR_TEXT_STATUSES = ['EMPTY', 'UNSUPPORTED'] as const satisfies readonly TextStatus[];

type OcrFile = {
  textStatus: TextStatus | null;
  ocrStatus: OcrStatus | null;
  ocrVersion: number | null;
  ocrAttempts: number;
};

/**
 * Whether the resume-ocr cron will still try this file, once its text
 * extraction has settled with nothing (textPending is false): not tried by
 * this OCR version yet, or unfinished or FAILED with attempts left.
 */
export function ocrPending(file: OcrFile): boolean {
  if (!file.textStatus || !(OCR_TEXT_STATUSES as readonly TextStatus[]).includes(file.textStatus)) return false;
  if (file.ocrVersion === null || file.ocrVersion < OCR_VERSION) return true;
  return (file.ocrStatus === null || file.ocrStatus === 'FAILED') && file.ocrAttempts < MAX_OCR_ATTEMPTS;
}

/**
 * StoredFile filter: OCR has given its final answer for this version, so a
 * scan without text will stay without it. The mirror of ocrPending.
 */
export const ocrSettled: Prisma.StoredFileWhereInput = {
  ocrVersion: OCR_VERSION,
  OR: [{ ocrStatus: { in: ['OK', 'LOW_CONFIDENCE', 'SKIPPED'] } }, { ocrStatus: 'FAILED', ocrAttempts: { gte: MAX_OCR_ATTEMPTS } }],
};
