/**
 * ODT (also .ott) to text: the content.xml body plus the page headers and
 * footers, which ODF keeps in the styles.xml master pages. Frames and text
 * boxes come after their anchor paragraph and footnotes at the end; tracked
 * deletions, comments and alt text are dropped.
 */
import { ZipReader } from './zip';
import { scanXmlNs } from './xml';
import { collectLink, linkDisplay, linkSuffix } from './links';
import type { AdapterOutput } from './types';

const NS: Record<string, string> = {
  'urn:oasis:names:tc:opendocument:xmlns:office:1.0': 'office',
  'urn:oasis:names:tc:opendocument:xmlns:text:1.0': 'text',
  'urn:oasis:names:tc:opendocument:xmlns:style:1.0': 'style',
  'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0': 'draw',
  'urn:oasis:names:tc:opendocument:xmlns:table:1.0': 'table',
  'urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0': 'svg',
  'http://www.w3.org/1999/xlink': 'xlink',
};

const SKIP = new Set([
  'text:tracked-changes', 'office:annotation', 'office:annotation-end', 'svg:title', 'svg:desc',
  'text:note-citation', 'text:sequence-decls', 'text:variable-decls', 'text:user-field-decls',
  'text:dde-connection-decls', 'office:forms', 'office:scripts', 'office:font-face-decls',
  'office:automatic-styles', 'office:styles', 'draw:image', 'office:binary-data', 'text:ruby-text',
]);

const HEADER_FOOTER = /^style:(header|footer)(?:-first|-left)?$/;

export function odtToText(data: Uint8Array): AdapterOutput {
  const zip = ZipReader.open(data);
  if (!zip) throw new Error('odt: not a readable ZIP archive');
  const content = zip.text('content.xml');
  if (content == null) throw new Error('odt: no content.xml');
  const styles = zip.text('styles.xml');
  const links = new Set<string>();
  const headers: string[] = [];
  const footers: string[] = [];
  if (styles) walk(styles, 'styles', headers, footers, links);
  const body = walk(content, 'content', headers, footers, links);
  return { text: [...new Set(headers), body, ...new Set(footers)].join('\n'), links: [...links] };
}

function walk(xml: string, part: 'content' | 'styles', headers: string[], footers: string[], links: Set<string>): string {
  const root: string[] = [];
  let cur = root;
  const bufs: string[][] = [];
  const stack: string[] = [];
  const open: { url: string | null; buf: string[]; start: number }[] = [];
  const notes: string[] = [];
  let pendingBoxes: string[] = [];
  let skip = 0;
  let paraDepth = 0;
  // In styles.xml only the master-page headers and footers carry document text.
  let hf: { kind: 'header' | 'footer'; saved: string[] } | null = null;

  scanXmlNs(xml, NS, {
    open(name, attr) {
      if (skip) return void skip++;
      if (SKIP.has(name) && !(part === 'styles' && name === 'office:styles')) return void (skip = 1);
      if (part === 'styles') {
        const m = HEADER_FOOTER.exec(name);
        if (m) {
          if (attr('style:display') === 'false') return void (skip = 1);
          hf = { kind: m[1] as 'header' | 'footer', saved: cur };
          cur = [];
        }
      }
      switch (name) {
        case 'text:p':
        case 'text:h':
          paraDepth++;
          break;
        case 'text:s': {
          const c = Number(attr('text:c') ?? 1);
          if (paraDepth) cur.push(' '.repeat(Math.min(Number.isFinite(c) && c > 0 ? c : 1, 100)));
          break;
        }
        case 'text:tab':
          if (paraDepth) cur.push('\t');
          break;
        case 'text:line-break':
          if (paraDepth) cur.push('\n');
          break;
        case 'text:a':
          open.push({ url: attr('xlink:href'), buf: cur, start: cur.length });
          break;
        case 'text:note-body':
        case 'draw:text-box':
          bufs.push(cur);
          cur = [];
          break;
      }
      stack.push(name);
    },
    close() {
      if (skip) return void skip--;
      const name = stack.pop();
      switch (name) {
        case 'text:p':
        case 'text:h':
          paraDepth--;
          cur.push('\n');
          if (bufs.length === 0 && pendingBoxes.length) {
            cur.push(pendingBoxes.join('\n'), '\n');
            pendingBoxes = [];
          }
          break;
        case 'text:a': {
          const l = open.pop();
          if (l && l.buf === cur) {
            collectLink(links, l.url);
            cur.push(linkSuffix(linkDisplay(cur, l.start, l.url), l.url));
          }
          break;
        }
        case 'text:note-body': {
          const t = cur.join('').trim();
          cur = bufs.pop() ?? root;
          if (t) notes.push(t);
          break;
        }
        case 'draw:text-box': {
          const t = cur.join('').trim();
          cur = bufs.pop() ?? root;
          if (t) pendingBoxes.push(t);
          break;
        }
      }
      if (part === 'styles' && hf && name && HEADER_FOOTER.test(name)) {
        const t = cur.join('').trim();
        if (t) (hf.kind === 'header' ? headers : footers).push(t);
        cur = hf.saved;
        hf = null;
      }
    },
    text(t) {
      if (skip || !paraDepth) return;
      if (part === 'styles' && !hf) return;
      // ODF collapses runs of XML whitespace; explicit spacing is text:s, text:tab and text:line-break.
      cur.push(t.replace(/[ \t\r\n]+/g, ' '));
    },
  });
  if (pendingBoxes.length) root.push('\n', pendingBoxes.join('\n'));
  if (notes.length) root.push('\n', notes.join('\n'));
  return root.join('');
}
