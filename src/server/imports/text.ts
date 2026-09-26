/**
 * Small, dependency-free helpers adapters share for turning vendor payloads
 * into Source's plain-text fields.
 */

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  bull: '•',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : match;
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

const BLOCK_TAGS = new Set([
  'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'tr', 'blockquote',
  'section', 'article', 'header', 'footer', 'table', 'pre',
]);
const SKIP_TAGS = new Set(['script', 'style', 'head', 'template', 'noscript']);

/** Longest HTML we'll convert; job descriptions and notes are far below this. */
const MAX_HTML = 500_000;

/**
 * Vendor HTML (job descriptions, rich-text notes) → readable plain text:
 * block elements become line breaks, list items become "• " bullets, links
 * keep their URL. A single forward scan with indexOf — linear in the input,
 * so hostile markup can't make it backtrack. Not a sanitizer: the output is
 * rendered as text, never HTML.
 */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return '';
  const src = String(html).slice(0, MAX_HTML);
  const lower = src.toLowerCase();
  let out = '';
  let href: string | null = null;
  let linkText = '';
  const emit = (text: string) => {
    if (href !== null) linkText += text;
    else out += text;
  };

  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      emit(src.slice(i));
      break;
    }
    if (lt > i) emit(src.slice(i, lt));
    if (src.startsWith('<!--', lt)) {
      const close = src.indexOf('-->', lt + 4);
      i = close < 0 ? src.length : close + 3;
      continue;
    }
    // A '<' only opens a tag when a name, '/' or '!' follows (as in HTML): "1 < 2" is text.
    if (!/[a-zA-Z/!]/.test(src[lt + 1] ?? '')) {
      emit('<');
      i = lt + 1;
      continue;
    }
    const gt = src.indexOf('>', lt + 1);
    if (gt < 0) {
      emit(src.slice(lt));
      break;
    }
    const tag = src.slice(lt + 1, gt);
    i = gt + 1;
    const m = /^(\/?)([a-zA-Z][a-zA-Z0-9]*)/.exec(tag.slice(0, 64));
    if (!m) {
      emit(src.slice(lt, gt + 1));
      continue;
    }
    const closing = m[1] === '/';
    const name = m[2].toLowerCase();
    if (!closing && SKIP_TAGS.has(name)) {
      const end = lower.indexOf(`</${name}`, i);
      const endGt = end < 0 ? -1 : src.indexOf('>', end);
      i = endGt < 0 ? src.length : endGt + 1;
      continue;
    }
    if (name === 'br') emit('\n');
    else if (name === 'li' && !closing) emit('\n• ');
    else if (BLOCK_TAGS.has(name)) emit('\n');
    else if (name === 'a') {
      if (!closing) {
        const h = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag.slice(0, 2048));
        href = h ? (h[1] ?? h[2] ?? h[3] ?? '') : '';
        linkText = '';
      } else if (href !== null) {
        const label = linkText.trim();
        const url = href.trim();
        href = null;
        emit(label && url && !url.startsWith('mailto:') && label !== url ? `${label} (${url})` : label || url);
      }
    }
  }
  if (href !== null) out += linkText;

  return decodeEntities(out)
    .replace(/\r/g, '')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Epoch ms/seconds, ISO strings, or Date → Date; anything unparseable → null. */
export function toDate(value: unknown): Date | null {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') {
    // Heuristic: < 1e11 is seconds (until year 5138), otherwise milliseconds
    const d = new Date(value < 1e11 ? value * 1000 : value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const str = String(value).trim();
  if (/^\d+$/.test(str)) return toDate(Number(str));
  const d = new Date(str);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function cleanEmails(values: (string | null | undefined)[]): string[] {
  return [
    ...new Set(
      values
        .map((v) => (v ?? '').trim().toLowerCase())
        .filter((v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)),
    ),
  ];
}

export function cleanList(values: (string | null | undefined)[]): string[] {
  return [...new Set(values.map((v) => (v ?? '').trim()).filter(Boolean))];
}

export function fullName(first?: string | null, last?: string | null, fallback = 'Unknown candidate'): string {
  return [first, last].map((s) => (s ?? '').trim()).filter(Boolean).join(' ') || fallback;
}

/** Truncate long free text for Source's text columns. */
export function clip(text: string, max = 20_000): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** NUL and unpaired surrogates: Postgres rejects the first in text and JSON, and chokes on the second. */
const BAD_CHARS = /\u0000|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * Deep-clean a vendor record before it touches the database, so one odd
 * value can't fail the insert (and, replayed, the whole import).
 */
export function scrub<T>(value: T): T {
  if (typeof value === 'string') return value.replace(BAD_CHARS, (m) => (m === '\u0000' ? '' : '\ufffd')) as T;
  if (Array.isArray(value)) return value.map(scrub) as T;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [scrub(k), scrub(v)])) as T;
  }
  return value;
}
