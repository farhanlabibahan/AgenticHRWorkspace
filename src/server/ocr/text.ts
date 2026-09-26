/**
 * What Tesseract's text needs before it is stored, and the bar it has to
 * clear. Pure, so the rules are tested without running OCR.
 */

/** Tesseract's mean word confidence (0-100) below which a page's text is not kept. */
export const MIN_CONFIDENCE = 50;
/** Fewer characters than this, after cleanup, is not a resume's worth of text. */
export const MIN_CHARS = 100;

const HAS_WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * Tesseract reads rules, bullets and specks as tokens ("|", "—", "~", "°");
 * a token with no letter or digit in it is dropped. Two splits it makes in
 * contact details are rejoined: "linkedin.com/ in/name" (a space after a
 * slash) and "rowan. testperson@example.com" (after a dot in an email
 * address, which a scan often shrinks to a speck).
 */
export function cleanOcrText(raw: string): string {
  const lines = raw
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) =>
      line
        .split(/[ \t]+/)
        .filter((token) => HAS_WORD_CHAR.test(token))
        .join(' '),
    );
  return (
    lines
      .join('\n')
      // A blank line between paragraphs is enough.
      .replace(/\n{3,}/g, '\n\n')
      .replace(/(\b[\w-]{1,63}\.(?:[a-z]{2,24})(?:\/[^\s/]{0,200})*\/) (?=[\w~%+-])/gi, '$1')
      .replace(/\b([\w+-]{1,64})\. ([\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63})+)/g, '$1.$2')
      .trim()
  );
}

export type PageReading = { text: string; confidence: number };

/**
 * Which pages' text to keep: each page on its own must reach MIN_CONFIDENCE
 * (a clean page 1 doesn't carry a garbled page 2), and the pages kept must
 * add up to MIN_CHARS. Sideways and upside-down pages scored 29-37 and read
 * as garbage; real scans, 90 and up.
 */
export function passesGate(pages: PageReading[]): { ok: boolean; text: string; confidence: number | null } {
  const kept = pages.filter((p) => p.confidence >= MIN_CONFIDENCE && p.text.length > 0);
  const text = kept.map((p) => p.text).join('\n\n');
  const scored = kept.length ? kept : pages;
  const chars = scored.reduce((n, p) => n + Math.max(p.text.length, 1), 0);
  // Weighted by text length: a page with a line on it says less than a full one.
  const confidence = scored.length ? Math.round(scored.reduce((n, p) => n + p.confidence * Math.max(p.text.length, 1), 0) / chars) : null;
  return { ok: kept.length > 0 && text.length >= MIN_CHARS, text, confidence };
}
