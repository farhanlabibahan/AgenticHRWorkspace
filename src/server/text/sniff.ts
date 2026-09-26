/**
 * Picks the extractor from the bytes. The declared MIME type and the filename
 * are hints at best: a .doc that is really RTF or a Word web page, a .docx
 * sent as application/octet-stream, a PDF with junk before its header.
 */
import { ZipReader } from './zip';
import { isMhtml } from './html';
import type { SniffResult } from './types';

const ascii = (b: Uint8Array, start: number, end: number) => {
  let s = '';
  for (let i = start; i < Math.min(end, b.length); i++) s += String.fromCharCode(b[i]);
  return s;
};
const startsWith = (b: Uint8Array, sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v);

export function sniffFormat(b: Uint8Array): SniffResult {
  if (isBlank(b)) return { format: null, reason: 'empty' };
  if (ascii(b, 0, 5) === '%PDF-') return { format: 'pdf' };
  if (startsWith(b, [0x50, 0x4b, 0x03, 0x04]) || startsWith(b, [0x50, 0x4b, 0x05, 0x06])) return sniffZip(b);
  if (startsWith(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return sniffOle(b);
  if (isImage(b)) return { format: null, reason: 'image' };
  // PDF readers accept the header anywhere in the first 1024 bytes (mail or HTTP junk before it).
  if (ascii(b, 0, 1024).includes('%PDF-')) return { format: 'pdf' };

  // Text-based formats: look past a BOM and leading whitespace.
  let head: string;
  if (b[0] === 0xff && b[1] === 0xfe) head = new TextDecoder('utf-16le').decode(b.subarray(2, 2050));
  else if (b[0] === 0xfe && b[1] === 0xff) head = new TextDecoder('utf-16be').decode(b.subarray(2, 2050));
  else head = ascii(b, b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? 3 : 0, 2048);
  const lead = head.trimStart();
  if (lead.startsWith('{\\rtf')) return { format: 'rtf' };
  if (isMhtml(lead)) return { format: 'html' };
  // Markup: HTML (also XHTML, and pages saved by a browser with a leading comment), else XML we don't read.
  const markup = lead
    .slice(0, 1024)
    .toLowerCase()
    .replace(/^(?:<\?xml[^>]*>|<!--[^]*?-->|\s+)+/, '');
  if (/^(<!doctype html|<html[\s>]|<head[\s>]|<body[\s>]|<meta[\s>])/.test(markup)) return { format: 'html' };
  // WordML 2003, flat ODT, SVG and other XML would come out as tags, not text.
  if (lead.startsWith('<?xml') || /^<(!doctype|svg[\s>]|w:worddocument[\s>])/.test(markup)) return { format: null, reason: 'unknown' };
  if (looksLikeText(b)) return { format: 'txt' };
  return { format: null, reason: 'binary' };
}

/** Zero bytes, or nothing but whitespace after a byte-order mark. */
function isBlank(b: Uint8Array): boolean {
  const utf16 = (b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff);
  let i = utf16 ? 2 : b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? 3 : 0;
  for (; i < b.length; i++) {
    const c = b[i];
    if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d && c !== 0x0c && c !== 0x0b && !(utf16 && c === 0)) return false;
  }
  return true;
}

function isImage(b: Uint8Array): boolean {
  return (
    startsWith(b, [0x89, 0x50, 0x4e, 0x47]) || // PNG
    startsWith(b, [0xff, 0xd8, 0xff]) || // JPEG
    ascii(b, 0, 4) === 'GIF8' ||
    (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') ||
    startsWith(b, [0x49, 0x49, 0x2a, 0x00]) || // TIFF, little-endian
    startsWith(b, [0x4d, 0x4d, 0x00, 0x2a]) || // TIFF, big-endian
    (ascii(b, 4, 8) === 'ftyp' && /^(heic|heix|hevc|mif1|msf1|avif)/.test(ascii(b, 8, 12)))
  );
}

function sniffZip(b: Uint8Array): SniffResult {
  // ODF packages store an uncompressed "mimetype" entry first, so its value
  // sits at byte 38, readable even when the archive is truncated.
  if (ascii(b, 30, 38) === 'mimetype') {
    const odf = odfKind(ascii(b, 38, 38 + 80));
    if (odf) return odf;
  }
  try {
    const zip = ZipReader.open(b, { maxEntries: 5_000, maxEntryBytes: 1 << 20, maxTotalBytes: 2 << 20 });
    if (zip) {
      if (zip.has('mimetype')) {
        const odf = odfKind(zip.text('mimetype') ?? '');
        if (odf) return odf;
      }
      const ct = zip.text('[Content_Types].xml');
      if (ct) {
        if (/wordprocessingml\.(document|template)\.main\+xml|ms-word\.(document|template)\.macroEnabled/i.test(ct)) return { format: 'docx' };
        if (/spreadsheetml|ms-excel|presentationml|ms-powerpoint/i.test(ct)) return { format: null, reason: 'zip-other' };
      }
      if (zip.has('word/document.xml')) return { format: 'docx' };
      return { format: null, reason: 'zip-other' };
    }
  } catch {
    // Too many entries or a corrupt entry: fall back to the first file name, and let the extractor report it.
  }
  // Truncated or odd archive: the first local file name.
  const first = ascii(b, 30, 30 + Math.min(b[26] | (b[27] << 8), 64));
  if (first.startsWith('word/') || first === '[Content_Types].xml') return { format: 'docx' };
  return { format: null, reason: 'zip-other' };
}

/** ODF text documents (odt, ott, and the text-master and text-web variants); any other ODF or EPUB is zip-other. */
function odfKind(mimetype: string): SniffResult | null {
  const mt = mimetype.trim();
  if (mt.startsWith('application/vnd.oasis.opendocument.text')) return { format: 'odt' };
  if (mt.startsWith('application/vnd.oasis.opendocument.') || mt.startsWith('application/epub+zip')) {
    return { format: null, reason: 'zip-other' };
  }
  return null;
}

/** An OLE2 compound file, classified by the stream names in its directory. */
function sniffOle(b: Uint8Array): SniffResult {
  const ole = readOleDirectory(b);
  if (!ole) return { format: null, reason: 'ole2-other' };
  // Password-protected DOCX/XLSX/PPTX are OLE2 wrappers around an EncryptedPackage stream.
  if (ole.entries.has('encryptedpackage')) return { format: null, reason: 'encrypted' };
  const word = ole.entries.get('worddocument');
  if (!word) return { format: null, reason: 'ole2-other' };
  return wordEncrypted(b, ole, word) ? { format: null, reason: 'encrypted' } : { format: 'doc' };
}

type OleEntry = { start: number; size: number };
type OleDirectory = { entries: Map<string, OleEntry>; offset: (sector: number) => number; miniCutoff: number };

/**
 * The directory entries of a CFB file by lower-cased name, or null when the
 * structure is broken. The directory's sector chain is walked at most once
 * per sector the file holds, and a chain that loops back is broken: it would
 * send word-extractor, which follows the same chain, round it forever.
 */
function readOleDirectory(b: Uint8Array): OleDirectory | null {
  if (b.length < 512) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const shift = dv.getUint16(0x1e, true);
  if (shift !== 9 && shift !== 12) return null;
  const size = 1 << shift;
  const offset = (sector: number) => (sector + 1) * size;
  // FAT sector numbers: the first 109 live in the header (enough for about 7 MB with 512-byte sectors).
  const numFat = Math.min(dv.getUint32(0x2c, true), 109);
  const fat: number[] = [];
  for (let i = 0; i < numFat; i++) fat.push(dv.getUint32(0x4c + i * 4, true));
  const next = (sector: number): number => {
    const per = size / 4;
    const fatSector = fat[Math.floor(sector / per)];
    if (fatSector === undefined) return -1;
    const off = offset(fatSector) + (sector % per) * 4;
    return off + 4 <= b.length ? dv.getUint32(off, true) : -1;
  };
  const entries = new Map<string, OleEntry>();
  const visited = new Set<number>();
  const maxSectors = Math.min(4096, Math.floor(b.length / size));
  let sector = dv.getUint32(0x30, true);
  while (sector >= 0 && sector < 0xfffffffa && visited.size < maxSectors) {
    if (visited.has(sector)) return null;
    visited.add(sector);
    const base = offset(sector);
    if (base + size > b.length) break;
    for (let e = 0; e < size / 128; e++) {
      const o = base + e * 128;
      const nameLen = dv.getUint16(o + 0x40, true);
      const type = b[o + 0x42];
      if (type === 0 || nameLen < 2 || nameLen > 64) continue;
      let name = '';
      for (let k = 0; k < nameLen / 2 - 1; k++) name += String.fromCharCode(dv.getUint16(o + k * 2, true));
      entries.set(name.toLowerCase(), { start: dv.getUint32(o + 0x74, true), size: dv.getUint32(o + 0x78, true) });
    }
    sector = next(sector);
  }
  return entries.size ? { entries, offset, miniCutoff: dv.getUint32(0x38, true) } : null;
}

/** The fEncrypted flag of the Word FIB, which starts the WordDocument stream. */
function wordEncrypted(b: Uint8Array, ole: OleDirectory, word: OleEntry): boolean {
  // Streams under the cutoff live in the mini stream; a real WordDocument stream is never that small.
  if (word.size < ole.miniCutoff) return false;
  const fib = ole.offset(word.start);
  if (fib + 12 > b.length) return false;
  const ident = b[fib] | (b[fib + 1] << 8);
  if (ident !== 0xa5ec && ident !== 0xa5dc) return false;
  return ((b[fib + 10] | (b[fib + 11] << 8)) & 0x0100) !== 0;
}

/** Text: a BOM, UTF-16 NUL patterns, or almost no control bytes. */
function looksLikeText(b: Uint8Array): boolean {
  if ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff)) return true;
  const n = Math.min(b.length, 8192);
  let nul = 0;
  let ctrl = 0;
  let oddNul = 0;
  let evenNul = 0;
  for (let i = 0; i < n; i++) {
    const c = b[i];
    if (c === 0) {
      nul++;
      if (i & 1) oddNul++;
      else evenNul++;
    } else if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d && c !== 0x0c) ctrl++;
  }
  // UTF-16 without a BOM: NULs almost entirely in one byte lane (the other
  // lane legitimately holds bytes below 0x20, like the low byte of ’ U+2019).
  if (nul > n * 0.2 && (oddNul < nul * 0.05 || evenNul < nul * 0.05)) return true;
  return nul === 0 && ctrl <= n * 0.01;
}
