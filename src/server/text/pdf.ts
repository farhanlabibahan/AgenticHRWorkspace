import { createRequire } from 'node:module';
import path from 'node:path';
import { MAX_TEXT_CHARS } from './normalize';
import { EncryptedDocumentError, type AdapterOutput } from './types';

/**
 * PDF → text. pdf.js comes from unpdf's serverless build: no worker file, no
 * @napi-rs/canvas, nothing native, so it survives Next's output file tracing
 * (pdf-parse didn't, and every PDF on Vercel got no text).
 *
 * pdf.js reports positioned text items; we assemble them into lines ourselves.
 * On a benchmark of 20 synthetic resumes from Chrome, pdf-lib and macOS
 * Quartz this scored word F1 99.7 against 95.2 for pdf.js's stock text:
 * letter-spaced headings collapse, sidebars stay out of the main column, and
 * URLs that wrapped in a narrow column are rejoined. The heuristics depend on
 * how this exact pdf.js build reports items, which is why unpdf is pinned;
 * re-check extraction quality before bumping it.
 */

type Item = { str: string; transform: number[]; width: number; height: number; hasEOL?: boolean };
/** One text item's string, and the separator between it and the item to its left. */
type Part = { str: string; sep: string };
type Frag = { parts: Part[]; text: string; x0: number; x1: number; y: number; fs: number; eol: boolean; pendingSpace?: boolean; top: number; bot: number };

// Resource bounds, far past any real resume, so a crafted file costs little.
// A resume is a page or two, and a page has tens of fragments (under 60 on
// every benchmark resume) and a handful of line-end hyphens.
const MAX_PAGES = 20;
const MAX_LAYOUT_FRAGMENTS = 500;
const MAX_HYPHEN_BREAKS = 500;

const med = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);

/** "C O N TA C T" → "CONTACT": pdf.js turns tracking into spaces inside one item; real word gaps arrive as separate whitespace items. */
function despace(str: string): string {
  const chunks = str.trim().split(/ +/);
  if (chunks.length < 3) return str;
  const lens = chunks.map((c) => [...c].length);
  if (lens.some((n) => n > 2) || lens.filter((n) => n === 1).length / lens.length < 0.6) return str;
  if (!/^[\p{L}\p{N}&.,'’\-/ ]+$/u.test(str)) return str;
  return str.replace(/ {2,}/g, '\u0000').replace(/(\S) (?=\S)/g, '$1').replace(/\u0000/g, ' ');
}

const RTL_SCRIPT = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc]/;

/** Letters in right-to-left scripts (Hebrew, Arabic, and their presentation forms), and all other letters. */
function letters(s: string): { rtl: number; ltr: number } {
  let rtl = 0;
  let ltr = 0;
  for (const [ch] of s.matchAll(/\p{L}/gu)) {
    if (RTL_SCRIPT.test(ch)) rtl++;
    else ltr++;
  }
  return { rtl, ltr };
}

/**
 * A fragment's text from its parts, which pdf.js reports in visual order,
 * left to right. A Hebrew or Arabic line reads from the right: Chrome splits
 * Arabic words into a part per glyph cluster, and appending them spelled
 * every word backwards. Runs of left-to-right words (an address, a name) keep
 * their own order. A line mixing both scripts follows the page's majority.
 */
function joinParts(parts: Part[], page: { rtl: number; ltr: number }): string {
  const leftToRight = () => parts.map((p) => p.sep + p.str).join('');
  if (!page.rtl) return leftToRight();
  const counts = parts.map((p) => letters(p.str));
  if (!counts.some((c) => c.rtl) || (counts.some((c) => c.ltr) && page.rtl <= page.ltr)) return leftToRight();
  let out = '';
  for (let i = parts.length - 1; i >= 0; ) {
    let j = i;
    if (counts[i].ltr) for (let k = i - 1; k >= 0 && !counts[k].rtl; k--) if (counts[k].ltr) j = k;
    let run = parts[j].str;
    for (let k = j + 1; k <= i; k++) run += parts[k].sep + parts[k].str;
    out += run + (j > 0 ? parts[j].sep : '');
    i = j - 1;
  }
  return out;
}

/**
 * Text items → runs of text on one baseline. Whitespace-only items are only a
 * hint that a space belongs there, never geometry: some producers emit a space
 * that spans a column gutter. A gap over 0.18 em is a space.
 */
function toFragments(items: Item[]): Frag[] {
  const frags: Frag[] = [];
  let cur: Frag | null = null;
  for (const it of items) {
    if (typeof it.str !== 'string') continue; // marked content
    const [a, b, c, d, e, f] = it.transform;
    const fs = Math.hypot(c, d) || Math.hypot(a, b) || it.height || 10;
    if (it.str.trim() === '') {
      if (cur) {
        if (it.str.length) cur.pendingSpace = true;
        if (it.hasEOL) cur.eol = true;
      }
      continue;
    }
    const str = despace(it.str);
    const x1 = e + (it.width || 0);
    if (cur && !cur.eol && Math.abs(cur.y - f) < 0.35 * Math.max(fs, cur.fs)) {
      const em = Math.max(fs, cur.fs);
      const gap = e - cur.x1;
      if (gap > -0.5 * em && gap < 1.2 * em) {
        const space = (cur.pendingSpace || gap > 0.18 * em) && !/\s$/.test(cur.parts[cur.parts.length - 1].str) && !/^\s/.test(str);
        cur.parts.push({ str, sep: space ? ' ' : '' });
        cur.pendingSpace = false;
        cur.x1 = Math.max(cur.x1, x1);
        cur.fs = Math.max(cur.fs, fs);
        if (it.hasEOL) cur.eol = true;
        continue;
      }
    }
    cur = { parts: [{ str, sep: '' }], text: '', x0: e, x1, y: f, fs, eol: !!it.hasEOL, top: 0, bot: 0 };
    frags.push(cur);
  }
  const page = letters(frags.map((fr) => fr.parts.map((p) => p.str).join('')).join(''));
  for (const fr of frags) {
    fr.top = fr.y + 0.8 * fr.fs;
    fr.bot = fr.y - 0.25 * fr.fs;
    fr.text = joinParts(fr.parts, page).trimEnd(); // not /\s+$/: that backtracks quadratically on a long run of spaces
  }
  return frags.filter((fr) => fr.text.trim() !== '');
}

/** Same baseline joins with a space if there's a gap; a drop of over 1.9 em starts a paragraph. */
function joinFragments(frags: Frag[]): string {
  let out = '';
  let prev: Frag | null = null;
  for (const fr of frags) {
    if (prev) {
      const em = Math.max(fr.fs, prev.fs);
      if (Math.abs(prev.y - fr.y) < 0.35 * em && fr.x0 >= prev.x1 - 0.5 * em) out += fr.x0 - prev.x1 > 0.18 * em ? ' ' : '';
      else out += prev.y - fr.y > 1.9 * em || prev.y - fr.y < -em ? '\n\n' : '\n';
    }
    out += fr.text;
    prev = fr;
  }
  return out;
}

/** Recursive XY-cut: column gutters before row gaps. */
function xycut(frags: Frag[], depth = 0): Frag[] {
  if (frags.length <= 1 || depth > 40) return frags;
  const fsMed = med(frags.map((f) => f.fs)) || 10;
  const byX = [...frags].sort((p, q) => p.x0 - q.x0);
  let bestV: { gap: number; L: Frag[]; R: Frag[] } | null = null;
  let reach = byX[0].x1;
  for (let i = 1; i < byX.length; i++) {
    const gap = byX[i].x0 - reach;
    if (gap >= Math.max(8, 0.9 * fsMed)) {
      const split = byX[i].x0 - gap / 2;
      const L = frags.filter((f) => f.x1 <= split);
      const R = frags.filter((f) => f.x0 >= split);
      const lines = (arr: Frag[]) => new Set(arr.map((f) => Math.round(f.y / 2))).size;
      if (lines(L) >= 2 && lines(R) >= 2 && (!bestV || gap > bestV.gap)) bestV = { gap, L, R };
    }
    reach = Math.max(reach, byX[i].x1);
  }
  const byY = [...frags].sort((p, q) => q.top - p.top);
  let bestH: { gap: number; A: Frag[]; B: Frag[] } | null = null;
  let low = byY[0].bot;
  for (let i = 1; i < byY.length; i++) {
    const gap = low - byY[i].top;
    if (gap > 0.05 * fsMed && (!bestH || gap > bestH.gap)) {
      const split = byY[i].top + gap / 2;
      bestH = { gap, A: frags.filter((f) => f.bot >= split), B: frags.filter((f) => f.top <= split) };
    }
    low = Math.min(low, byY[i].bot);
  }
  if (bestV && (!bestH || bestV.gap >= 0.8 * bestH.gap)) return [...xycut(bestV.L, depth + 1), ...xycut(bestV.R, depth + 1)];
  if (bestH) return [...xycut(bestH.A, depth + 1), ...xycut(bestH.B, depth + 1)];
  return [...frags].sort((p, q) => (Math.abs(p.y - q.y) < 0.35 * fsMed ? p.x0 - q.x0 : q.y - p.y));
}

/**
 * True when the content stream alternates between two text columns row by
 * row. Most producers write a column at a time, and their stream order beats
 * any geometric guess, so XY-cut runs only for this pattern. The check costs
 * fragments × x positions, so a page with more fragments than any resume
 * (crafted, or not a resume) keeps stream order.
 */
function streamPingPongs(frags: Frag[]): boolean {
  if (frags.length < 12 || frags.length > MAX_LAYOUT_FRAGMENTS) return false;
  const byX = [...frags].sort((p, q) => p.x0 - q.x0);
  let best: { gap: number; split: number } | null = null;
  let reach = byX[0].x1;
  for (let i = 1; i < byX.length; i++) {
    const gap = byX[i].x0 - reach;
    if (gap >= 10 && (!best || gap > best.gap)) best = { gap, split: byX[i].x0 - gap / 2 };
    reach = Math.max(reach, byX[i].x1);
  }
  const candidates = [...new Set(frags.map((f) => Math.round(f.x0) - 1))].sort((a, b) => a - b);
  for (const split of best ? [best.split, ...candidates] : candidates) {
    const side = frags.map((f) => (f.x1 <= split ? 'L' : f.x0 >= split ? 'R' : null));
    if (side.filter((s) => s === null).length > Math.max(3, 0.1 * frags.length)) continue;
    const seq = side.filter((s): s is 'L' | 'R' => s !== null);
    const nL = seq.filter((s) => s === 'L').length;
    const nR = seq.length - nL;
    if (nL < 5 || nR < 5) continue;
    const chars = (k: 'L' | 'R') => frags.reduce((acc, f, i) => acc + (side[i] === k ? f.text.length : 0), 0);
    if (Math.min(chars('L'), chars('R')) < 0.15 * Math.max(chars('L'), chars('R'))) continue;
    let switches = 0;
    let run = 1;
    const runs: Record<'L' | 'R', number[]> = { L: [], R: [] };
    for (let i = 1; i < seq.length; i++) {
      if (seq[i] !== seq[i - 1]) {
        switches++;
        runs[seq[i - 1]].push(run);
        run = 1;
      } else run++;
    }
    runs[seq[seq.length - 1]].push(run);
    if (switches >= 8 && med(runs.L) === 1 && med(runs.R) === 1 && switches >= 0.6 * Math.min(nL, nR)) return true;
    if (best && split === best.split) break;
  }
  return false;
}

/**
 * "linkedin.com/in/rowan-\ntestperson": a URL that wrapped at the edge of a
 * narrow column. The repeats are bounded so a long run without spaces can't
 * make the regex backtrack quadratically.
 */
function joinWrappedUrls(t: string): string {
  return t.replace(/((?:https?:\/\/|www\.|[\w-]{1,63}\.(?:com|org|net|io|dev|co|me|app|ai|edu)\b|@)\S{0,256}[-/._])\n(?=[a-z0-9][\w./-]*(?:\s|$))/gi, '$1');
}

// Words that often end or start a hyphenated compound ("company-wide", "cross-functional").
const COMPOUND_PARTS = new Set(
  'wide end based driven facing time site level scale term stage ready oriented focused like free friendly related specific making owned led run house line known off up on out in over back to down side party stack source paced hand hands tier class grade week day year month hour person people user users client customer world first new old long short high low full part self cross multi non co pre re sub'.split(
    ' ',
  ),
);

/**
 * Undo line-end hyphenation. Soft hyphens and U+2010 at a line end always
 * join. pdf.js reports every hyphen as ASCII "-", so there we join only when
 * the document spells the word unbroken elsewhere, or when neither half looks
 * like part of a compound; joining blindly merged real compounds. Each of
 * those breaks searches the whole text, so past MAX_HYPHEN_BREAKS the rest
 * stay as they are.
 */
function dehyphenate(t: string): string {
  t = t.replace(/(\p{Ll})[\u00ad\u2010] *\n(?=\p{Ll})/gu, '$1');
  const flat = t.toLowerCase();
  let budget = MAX_HYPHEN_BREAKS;
  t = t.replace(/(\p{L}{0,63}\p{Ll})- *\n(\p{Ll}\p{L}*)/gu, (m: string, left: string, right: string) => {
    if (budget-- <= 0) return m;
    const l = left.toLowerCase();
    const r = right.toLowerCase();
    if (flat.includes(l + r)) return left + right;
    if (flat.includes(`${l}-${r}`) || COMPOUND_PARTS.has(r) || COMPOUND_PARTS.has(l)) return `${left}-${right}`;
    return l.length >= 2 && r.length >= 2 ? left + right : `${left}-${right}`;
  });
  return t.replace(/\u00ad/g, '');
}

/**
 * Some CJK fonts map a glyph to its Kangxi radical (U+2F2F "⼯") rather than
 * the ideograph ("工"), and Arabic fonts to a positional presentation form
 * ("ﺧ") rather than the letter ("خ"), which search wouldn't match.
 */
const foldForms = (t: string) => t.replace(/[\u2e80-\u2fdf\ufb50-\ufdff\ufe70-\ufefe]/g, (c) => c.normalize('NFKC'));

let dataDir: string | null | undefined;

/**
 * CMaps (CJK text in fonts that aren't embedded) and standard font data are
 * plain files in pdfjs-dist, which the app depends on for them alone.
 * unpdf's own default points pdf.js at a file:// URL string, which Node's
 * fs can't open. Resolved from the working directory because this module has
 * no usable path of its own: Turbopack rewrites createRequire(import.meta.url)
 * and vitest has no import.meta.resolve. The working directory is the app
 * root under next start, Vercel and the standalone server.js, and the repo
 * root under vitest.
 */
function pdfjsData(): { cMapUrl?: string; cMapPacked?: boolean; standardFontDataUrl?: string } {
  if (dataDir === undefined) {
    try {
      dataDir = path.dirname(createRequire(path.join(process.cwd(), 'package.json')).resolve('pdfjs-dist/package.json'));
    } catch {
      dataDir = null; // pdf.js warns when a document needs the files
    }
  }
  if (!dataDir) return {};
  // pdf.js appends file names to these, so they need the trailing slash.
  return { cMapUrl: `${dataDir}/cmaps/`, cMapPacked: true, standardFontDataUrl: `${dataDir}/standard_fonts/` };
}

/**
 * Link annotations are how PDFs keep a URL behind words like "LinkedIn".
 * Web and mailto: targets are kept, as for DOCX hyperlinks.
 */
function linkTarget(annotation: { subtype?: string; url?: unknown; unsafeUrl?: unknown }): string | null {
  if (annotation.subtype !== 'Link') return null;
  const url = annotation.url || annotation.unsafeUrl;
  return typeof url === 'string' && /^(?:https?:\/\/|mailto:)/i.test(url.trim()) ? url.trim() : null;
}

export async function pdfToText(data: Uint8Array): Promise<AdapterOutput> {
  const { getResolvedPDFJS } = await import('unpdf');
  const { getDocument } = await getResolvedPDFJS();
  // getDocument, not unpdf's getDocumentProxy, so a document that fails to
  // open (password, corrupt) still has a loading task to destroy. The font
  // options are unpdf's Node defaults. pdf.js detaches the buffer it's given,
  // so it gets a copy. Verbosity 0 (errors only): its warnings quote tokens
  // from the document, an applicant's address among them, straight into the
  // server log; errors reach index.ts, which redacts them.
  const task = getDocument({ data: new Uint8Array(data), useSystemFonts: true, disableFontFace: true, verbosity: 0, ...pdfjsData() });
  try {
    const doc = await task.promise.catch((err: unknown) => {
      throw err instanceof Error && err.name === 'PasswordException' ? new EncryptedDocumentError() : err;
    });
    const pages: string[] = [];
    const links = new Set<string>();
    // Stop once there's more text than normalize.ts would store.
    let chars = 0;
    for (let i = 1; i <= Math.min(doc.numPages, MAX_PAGES) && chars < MAX_TEXT_CHARS; i++) {
      const page = await doc.getPage(i);
      const frags = toFragments((await page.getTextContent()).items as Item[]);
      pages.push(joinFragments(streamPingPongs(frags) ? xycut(frags) : frags));
      chars += pages[pages.length - 1].length;
      for (const annotation of await page.getAnnotations({ intent: 'display' })) {
        const url = linkTarget(annotation);
        if (url) links.add(url);
      }
      page.cleanup();
    }
    const text = pages.join('\n\n').slice(0, MAX_TEXT_CHARS);
    // Ligatures, NBSP and whitespace are left to normalize.ts, which runs next.
    return { text: foldForms(dehyphenate(joinWrappedUrls(text))), links: [...links], pages: doc.numPages };
  } finally {
    await task.destroy();
  }
}
