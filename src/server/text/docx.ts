/**
 * DOCX (also .docm and .dotx) to text. Reads the main document part found
 * through the package relationships, the headers and footers its sections
 * reference, and the footnotes and endnotes. Text boxes are kept once (the
 * DrawingML choice, not the VML fallback) and hyperlink targets are kept;
 * deleted and moved-from text, comments, hidden runs, field instructions,
 * content-control metadata and the glossary are dropped.
 */
import { ZipReader } from './zip';
import { scanXmlNs, parseRels, type Rel } from './xml';
import { collectLink, linkDisplay, linkSuffix, hyperlinkFromInstr } from './links';
import { readRtf } from './rtf';
import { decodeText } from './txt';
import { readHtml } from './html';
import type { AdapterOutput } from './types';

const NS: Record<string, string> = {
  'http://schemas.openxmlformats.org/wordprocessingml/2006/main': 'w',
  'http://purl.oclc.org/ooxml/wordprocessingml/main': 'w',
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships': 'r',
  'http://purl.oclc.org/ooxml/officeDocument/relationships': 'r',
  'http://schemas.openxmlformats.org/markup-compatibility/2006': 'mc',
  'http://schemas.openxmlformats.org/officeDocument/2006/math': 'm',
  'http://purl.oclc.org/ooxml/officeDocument/math': 'm',
};

// Elements whose whole subtree carries no visible text.
const SKIP = new Set([
  'w:del', 'w:moveFrom', 'w:delText', 'w:delInstrText', 'w:sdtPr', 'w:rt', 'w:fldData',
  'w:commentReference', 'w:annotationRef', 'w:pPrChange', 'w:rPrChange', 'w:sectPrChange',
]);

type Ref = { kind: 'header' | 'footer'; id: string; type: string };

export function docxToText(data: Uint8Array): AdapterOutput {
  const links = new Set<string>();
  return { text: readDocx(data, links), links: [...links] };
}

/** `parent`: the archive this DOCX is an altChunk of, whose inflate budget it shares. */
function readDocx(data: Uint8Array, links: Set<string>, parent?: ZipReader): string {
  const zip = parent ? parent.nested(data) : ZipReader.open(data);
  if (!zip) throw new Error('docx: not a readable ZIP archive');
  const pkgRels = parseRels(zip.text('_rels/.rels'));
  const officeDoc = [...pkgRels.values()].find((r) => r.type.endsWith('/officeDocument'));
  const main = officeDoc ? resolvePart('', officeDoc.target) : 'word/document.xml';
  const mainXml = zip.text(main);
  if (mainXml == null) throw new Error('docx: no main document part');
  const mainRels = parseRels(zip.text(relsPath(main)));

  // w:altChunk: content Word imports on open (html-docx-js and similar tools
  // put the whole resume there). Each part is read once, however many
  // altChunks point at it.
  const chunksRead = new Set<string>();
  const altChunk = (id: string): string => {
    const rel = mainRels.get(id);
    if (!rel || rel.external) return '';
    const part = resolvePart(main, rel.target);
    if (chunksRead.has(part)) return '';
    chunksRead.add(part);
    const bytes = zip.bytes(part);
    return bytes ? altChunkToText(bytes, links, parent ? null : zip) : '';
  };
  const body = walk(mainXml, mainRels, links, altChunk);
  const headers: string[] = [];
  const footers: string[] = [];
  const seen = new Set<string>();
  // Within a section Word lists default/first/even in any order; the
  // first-page header is what a reader sees first.
  const rank = (t: string) => (t === 'first' ? 0 : t === 'default' ? 1 : 2);
  const refs = body.refs.map((r, i) => ({ ...r, i })).sort((a, b) => rank(a.type) - rank(b.type) || a.i - b.i);
  for (const ref of refs) {
    const rel = mainRels.get(ref.id);
    if (!rel || rel.external) continue;
    const part = resolvePart(main, rel.target);
    if (seen.has(part)) continue;
    seen.add(part);
    const xml = zip.text(part);
    if (!xml) continue;
    const t = walk(xml, parseRels(zip.text(relsPath(part))), links).text.trim();
    if (t) (ref.kind === 'header' ? headers : footers).push(t);
  }
  const notes: string[] = [];
  for (const kind of ['/footnotes', '/endnotes']) {
    for (const rel of mainRels.values()) {
      if (!rel.type.endsWith(kind) || rel.external) continue;
      const part = resolvePart(main, rel.target);
      const xml = zip.text(part);
      if (!xml) continue;
      const t = walk(xml, parseRels(zip.text(relsPath(part))), links).text.trim();
      if (t) notes.push(t);
    }
  }
  return [...new Set(headers), body.text, ...notes, ...new Set(footers)].join('\n');
}

/** `zip`: the containing archive, or null when a nested DOCX is already one level down. */
function altChunkToText(b: Uint8Array, links: Set<string>, zip: ZipReader | null): string {
  const head = Buffer.from(b.buffer, b.byteOffset, Math.min(b.byteLength, 64)).toString('latin1').trimStart();
  if (head.startsWith('{\\rtf')) return readRtf(b, links);
  if (head.startsWith('PK')) return zip ? readDocx(b, links, zip) : '';
  if (/^(mime-version|content-type)/i.test(head)) return readHtml(b, links);
  const text = decodeText(b);
  return /<(html|body|p|div|table)\b/i.test(text.slice(0, 4096)) ? readHtml(b, links) : text;
}

function walk(
  xml: string,
  rels: Map<string, Rel>,
  links: Set<string>,
  altChunk?: (id: string) => string,
): { text: string; refs: Ref[] } {
  const root: string[] = [];
  let cur = root;
  const bufs: string[][] = [];
  const stack: string[] = [];
  const ac: boolean[] = []; // per mc:AlternateContent: has a Choice been taken?
  const open: { url: string | null; buf: string[]; start: number }[] = [];
  const fields: { instr: string; result: boolean; buf: string[]; start: number }[] = [];
  const refs: Ref[] = [];
  let pendingBoxes: string[] = [];
  let skip = 0;
  let inT = false;
  let inInstr = false;
  let hidden = false;
  let instrOpen = 0; // fields still in their instruction part: their runs are not displayed

  const inRun = () => stack[stack.length - 1] === 'w:r';
  const endLink = (buf: string[], start: number, url: string | null) => {
    collectLink(links, url);
    return linkSuffix(linkDisplay(buf, start, url), url);
  };

  scanXmlNs(xml, NS, {
    open(name, attr) {
      if (skip) return void skip++;
      if (SKIP.has(name)) return void (skip = 1);
      switch (name) {
        case 'mc:AlternateContent':
          ac.push(false);
          break;
        case 'mc:Choice':
          if (ac[ac.length - 1]) return void (skip = 1);
          ac[ac.length - 1] = true;
          break;
        case 'mc:Fallback':
          if (ac[ac.length - 1]) return void (skip = 1);
          break;
        case 'w:footnote':
        case 'w:endnote': {
          const t = attr('w:type');
          if (t && t !== 'normal') return void (skip = 1); // separators
          break;
        }
        case 'w:r':
          hidden = false;
          break;
        case 'w:vanish':
        case 'w:specVanish':
          if (stack[stack.length - 1] === 'w:rPr' && stack[stack.length - 2] === 'w:r') {
            const v = attr('w:val');
            hidden = v !== '0' && v !== 'false' && v !== 'off';
          }
          break;
        case 'w:t':
        case 'm:t':
          inT = true;
          break;
        case 'w:instrText':
          inInstr = true;
          break;
        case 'w:tab':
        case 'w:ptab':
          if (inRun() && !hidden && !instrOpen) cur.push('\t');
          break;
        case 'w:br':
        case 'w:cr':
          if (inRun() && !hidden && !instrOpen) cur.push('\n');
          break;
        case 'w:noBreakHyphen':
          if (inRun() && !hidden && !instrOpen) cur.push('-');
          break;
        case 'w:sym':
          if (inRun() && !hidden && !instrOpen) cur.push(' '); // symbol-font icons (phone, envelope)
          break;
        case 'w:fldChar': {
          const t = attr('w:fldCharType');
          if (t === 'begin') {
            fields.push({ instr: '', result: false, buf: cur, start: cur.length });
            instrOpen++;
          } else if (t === 'separate') {
            const f = fields[fields.length - 1];
            if (f && !f.result) {
              f.result = true;
              f.buf = cur;
              f.start = cur.length;
              instrOpen--;
            }
          } else if (t === 'end') {
            const f = fields.pop();
            if (f) {
              if (!f.result) instrOpen--;
              else if (f.buf === cur) cur.push(endLink(cur, f.start, hyperlinkFromInstr(f.instr)));
            }
          }
          break;
        }
        case 'w:fldSimple':
          open.push({ url: hyperlinkFromInstr(attr('w:instr') ?? ''), buf: cur, start: cur.length });
          break;
        case 'w:hyperlink': {
          const id = attr('r:id');
          const rel = id ? rels.get(id) : undefined;
          open.push({ url: rel?.target ?? null, buf: cur, start: cur.length });
          break;
        }
        case 'w:txbxContent':
          bufs.push(cur);
          cur = [];
          break;
        case 'w:altChunk': {
          const id = attr('r:id');
          const t = id && altChunk ? altChunk(id).trim() : '';
          if (t) cur.push(t, '\n');
          break;
        }
        case 'w:headerReference':
        case 'w:footerReference': {
          const id = attr('r:id');
          if (id) refs.push({ kind: name === 'w:headerReference' ? 'header' : 'footer', id, type: attr('w:type') ?? 'default' });
          break;
        }
      }
      stack.push(name);
    },
    close() {
      if (skip) return void skip--;
      const name = stack.pop();
      switch (name) {
        case 'w:t':
        case 'm:t':
          inT = false;
          break;
        case 'w:instrText':
          inInstr = false;
          break;
        case 'mc:AlternateContent':
          ac.pop();
          break;
        case 'w:hyperlink':
        case 'w:fldSimple': {
          const l = open.pop();
          if (l && l.buf === cur) cur.push(endLink(cur, l.start, l.url));
          break;
        }
        case 'w:txbxContent': {
          const box = cur.join('').trim();
          cur = bufs.pop() ?? root;
          if (box) pendingBoxes.push(box);
          break;
        }
        case 'w:p':
          cur.push('\n');
          // A text box is anchored inside a paragraph; emit it after that
          // paragraph instead of splitting the paragraph's own text.
          if (bufs.length === 0 && pendingBoxes.length) {
            cur.push(pendingBoxes.join('\n'), '\n');
            pendingBoxes = [];
          }
          break;
      }
    },
    text(t) {
      if (skip) return;
      if (inT && !hidden && !instrOpen) cur.push(t);
      else if (inInstr && fields.length) fields[fields.length - 1].instr += t;
    },
  });
  if (pendingBoxes.length) root.push('\n', pendingBoxes.join('\n'));
  return { text: root.join(''), refs };
}

function relsPath(part: string): string {
  const i = part.lastIndexOf('/');
  return `${part.slice(0, i + 1)}_rels/${part.slice(i + 1)}.rels`;
}

function resolvePart(from: string, target: string): string {
  let t = target.replace(/\\/g, '/');
  try {
    t = decodeURIComponent(t);
  } catch {
    // Malformed escapes: use the target as written.
  }
  const base = t.startsWith('/') ? [] : from.split('/').slice(0, -1);
  for (const seg of t.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') base.pop();
    else base.push(seg);
  }
  return base.join('/');
}
