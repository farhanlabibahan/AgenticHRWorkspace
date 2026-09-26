/**
 * HTML and MHTML to text: Word "Web Page" and "Single File Web Page" resumes
 * (often renamed to .doc), and the HTML or MHTML parts that export-to-Word
 * tools embed in a DOCX as w:altChunk. Scripts, styles and the head are
 * dropped, entities decoded, block elements become line breaks and links keep
 * their target. One forward scan with indexOf, so hostile markup can't make it
 * backtrack. Text only: nothing here is ever rendered.
 */
import { bomOf, decodeBytes, decodeText } from './txt';
import { collectLink, linkDisplay, linkSuffix } from './links';
import type { AdapterOutput } from './types';

// The Latin-1 entities, U+00A0 (&nbsp;) to U+00FF (&yuml;) in order: accents are how HTML resume tools write them.
const LATIN1 =
  'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute ' +
  'micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig ' +
  'Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash ' +
  'Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc ' +
  'euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml ' +
  'yacute thorn yuml';
const ENT: Record<string, string> = {
  ...Object.fromEntries(LATIN1.split(' ').map((name, i) => [name, String.fromCharCode(0xa0 + i)])),
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', shy: '', ndash: '–', mdash: '—',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•', hellip: '…', trade: '™', euro: '€',
};

// Elements dropped with their content, and a case-insensitive search for each one's end tag.
const SKIP_TAGS = new Map(
  ['script', 'style', 'head', 'title', 'xml', 'template', 'noscript'].map((t) => [t, new RegExp(`</${t}`, 'gi')]),
);
const BLOCK_TAGS = new Set([
  'p', 'div', 'br', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'ul', 'ol',
  'section', 'article', 'header', 'footer', 'blockquote', 'pre', 'dt', 'dd',
]);

export function htmlToText(data: Uint8Array): AdapterOutput {
  const links = new Set<string>();
  return { text: readHtml(data, links), links: [...links] };
}

/** True for the start of a MIME multipart/related message (a Word .mht). */
export function isMhtml(head: string): boolean {
  const lower = head.slice(0, 1024).toLowerCase();
  return /^(mime-version:|content-type:\s*multipart\/related|from:)/.test(lower) && lower.includes('multipart/related');
}

export function readHtml(data: Uint8Array, links: Set<string>): string {
  const head = latin1(data.subarray(0, 2048));
  if (isMhtml(head.trimStart())) return mhtmlToText(data, links);
  // A BOM wins, then a declared legacy charset; otherwise UTF-8, falling back to Windows-1252.
  const charset = bomOf(data) ? undefined : /charset\s*=\s*["']?\s*([\w-]+)/i.exec(head)?.[1]?.toLowerCase();
  const html = charset && !isUtf8OrLatin(charset) ? decodeBytes(data, charset) : decodeText(data);
  return markupToText(html, links);
}

/** The first text/html part of a MIME multipart, transfer-decoded. */
function mhtmlToText(data: Uint8Array, links: Set<string>): string {
  const s = latin1(data);
  const boundary = /boundary\s*=\s*"?([^"\r\n;]+)"?/i.exec(s)?.[1];
  const parts = boundary ? s.split('--' + boundary) : [s];
  for (const part of parts) {
    const split = part.search(/\r?\n\r?\n/);
    if (split < 0) continue;
    const head = part.slice(0, split);
    if (!/content-type:\s*text\/html/i.test(head)) continue;
    let body = part.slice(split).replace(/^\r?\n\r?\n/, '');
    const enc = /content-transfer-encoding:\s*([\w-]+)/i.exec(head)?.[1]?.toLowerCase();
    let raw: Buffer;
    if (enc === 'base64') raw = Buffer.from(body.replace(/\s+/g, ''), 'base64');
    else {
      if (enc === 'quoted-printable') {
        body = body.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
      }
      raw = Buffer.from(body, 'latin1');
    }
    const charset = /charset\s*=\s*"?([\w-]+)"?/i.exec(head)?.[1]?.toLowerCase() ?? 'utf-8';
    return markupToText(isUtf8OrLatin(charset) ? decodeText(raw) : decodeBytes(raw, charset), links);
  }
  return '';
}

function isUtf8OrLatin(charset: string): boolean {
  return /^(utf-?8|iso-8859-1|latin1|us-ascii|ascii|windows-1252|cp1252)$/.test(charset);
}

function latin1(b: Uint8Array): string {
  return Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('latin1');
}

function markupToText(html: string, links: Set<string>): string {
  const n = html.length;
  const out: string[] = [];
  const open: { url: string | null; start: number }[] = [];
  // Skipped elements with no end tag left in the document: each is searched for
  // once, so thousands of unclosed <script> tags stay linear.
  const unclosed = new Set<string>();
  let i = 0;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      out.push(textOf(html.slice(i)));
      break;
    }
    if (lt > i) out.push(textOf(html.slice(i, lt)));
    if (html.startsWith('<!--', lt)) {
      const e = html.indexOf('-->', lt + 4);
      i = e < 0 ? n : e + 3;
      continue;
    }
    // A '<' only opens a tag when a name, '/', '!' or '?' follows: "1 < 2" is text.
    if (!/[a-zA-Z/!?]/.test(html[lt + 1] ?? '')) {
      out.push('<');
      i = lt + 1;
      continue;
    }
    const gt = html.indexOf('>', lt + 1);
    if (gt < 0) {
      out.push(textOf(html.slice(lt)));
      break;
    }
    i = gt + 1;
    const m = /^(\/?)([a-zA-Z][\w:-]*)/.exec(html.slice(lt + 1, Math.min(gt, lt + 65)));
    if (!m) continue; // <!doctype>, <![if …]>, <?xml …?>
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    const endTag = closing || html[gt - 1] === '/' || unclosed.has(tag) ? undefined : SKIP_TAGS.get(tag);
    if (endTag) {
      endTag.lastIndex = i;
      const end = endTag.exec(html)?.index ?? -1;
      const endGt = end < 0 ? -1 : html.indexOf('>', end);
      if (endGt < 0) unclosed.add(tag); // an optional end tag (</head>) left out: keep the content
      else i = endGt + 1;
      continue;
    }
    if (tag === 'a') {
      if (!closing) {
        const href = /\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(html.slice(lt, Math.min(gt, lt + 4096)));
        open.push({ url: href ? decodeEntities(href[2] ?? href[3] ?? href[4] ?? '') : null, start: out.length });
      } else {
        const l = open.pop();
        if (l) {
          collectLink(links, l.url);
          out.push(linkSuffix(linkDisplay(out, l.start, l.url), l.url));
        }
      }
    } else if (tag === 'td' || tag === 'th') {
      if (closing) out.push('\t');
    } else if (BLOCK_TAGS.has(tag)) {
      out.push('\n');
    }
  }
  return out
    .join('')
    .split('\n')
    .map((line) => line.trim())
    .join('\n');
}

function textOf(s: string): string {
  return decodeEntities(s.replace(/\s+/g, ' '));
}

function decodeEntities(s: string): string {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : '';
    }
    return ENT[e] ?? ENT[e.toLowerCase()] ?? all;
  });
}
