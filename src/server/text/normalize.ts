/**
 * Clean-up shared by every format, applied to adapter output before it is
 * stored. Format-specific repairs (PDF line assembly, de-hyphenation) stay in
 * the adapters; this only makes text safe for Postgres and consistent to
 * search.
 */

export const MAX_TEXT_CHARS = 100_000;
export const MAX_LINKS = 10;

const LIGATURES: Record<string, string> = {
  '\ufb00': 'ff',
  '\ufb01': 'fi',
  '\ufb02': 'fl',
  '\ufb03': 'ffi',
  '\ufb04': 'ffl',
  '\ufb05': 'st',
  '\ufb06': 'st',
};

// NUL (Postgres rejects it), other C0 controls, DEL, soft hyphens, zero-width
// spaces and unpaired surrogates. imports/text.ts `scrub` turns lone
// surrogates into U+FFFD, which would put junk characters into search text.
// The zero-width joiner and non-joiner stay: they hold emoji sequences
// together and are part of how Persian and Indic words are spelled.
const DROP =
  /[\u0000-\u0008\u000e-\u001f\u007f\u00ad\u200b\u2060\ufeff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** Icon-font glyphs (an envelope, a phone) have private-use code points, which show as boxes. */
const PRIVATE_USE = /\p{Co}/gu;

/** Vertical tab is Word's manual line break; U+2028/2029 are Unicode's. */
const LINE_BREAKS = /\r\n?|[\v\f\u2028\u2029]/g;

const SPACES = /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g;

/** Raw extracted text → clean text, or null when nothing readable is left. */
export function normalizeText(raw: string): string | null {
  let text = raw
    .replace(LINE_BREAKS, '\n')
    .replace(DROP, '')
    .normalize('NFC')
    .replace(/[\ufb00-\ufb06]/g, (c) => LIGATURES[c])
    .replace(PRIVATE_USE, ' ')
    .replace(SPACES, ' ')
    // Trailing blanks and leading spaces on each line (an icon's, once it is a
    // space). /[ \t]+\n/ does the same but backtracks quadratically: 40,000
    // tabs without a newline took 3.6 s.
    .split('\n')
    .map((line) => line.trimEnd().replace(/^ +/, ''))
    .join('\n')
    .replace(/ {2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text.length > MAX_TEXT_CHARS) {
    // Don't cut between the two halves of a surrogate pair (emoji, rare CJK).
    const high = text.charCodeAt(MAX_TEXT_CHARS - 1);
    text = text.slice(0, high >= 0xd800 && high <= 0xdbff ? MAX_TEXT_CHARS - 1 : MAX_TEXT_CHARS).trimEnd();
  }
  return text || null;
}

const LINK = /^(?:https?:\/\/|mailto:)[^\s\u0000-\u001f\u007f]+$/i;

/** Link targets a contact can use: web and mailto only, deduped, at most MAX_LINKS. */
export function normalizeLinks(links: string[]): string[] {
  const kept = links.map((l) => l.trim()).filter((l) => l.length <= 2048 && LINK.test(l) && l.isWellFormed());
  return [...new Set(kept)].slice(0, MAX_LINKS);
}
