/**
 * Plain-text decoding: a BOM, then UTF-16 without a BOM (NUL-lane heuristic),
 * then strict UTF-8, then UTF-8 with stray Windows-1252 bytes, then
 * Windows-1252. Windows-1252 uses our own table:
 * Node's TextDecoder('windows-1252') decodes 0x80–0x9F as C1 controls on some
 * Node 22 builds (fixed in 22.23 / 24), turning ’ “ ” – • € into invisible
 * garbage, and Docker images float across those builds.
 */
import type { AdapterOutput } from './types';

// Windows-1252 0x80–0x9F (undefined slots map to the C1 code point, like browsers).
const CP1252_HIGH = [
  0x20ac, 0x81, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8d, 0x017d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x9d, 0x017e, 0x0178,
];

const cp1252 = (b: number) => (b >= 0x80 && b <= 0x9f ? CP1252_HIGH[b - 0x80] : b);

function decodeCp1252(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    const chunk = bytes.subarray(i, i + 8192);
    const codes = new Array<number>(chunk.length);
    for (let j = 0; j < chunk.length; j++) codes[j] = cp1252(chunk[j]);
    s += String.fromCharCode(...codes);
  }
  return s;
}

const decoders = new Map<string, TextDecoder | null>();

/** Decode legacy code-page bytes (a WHATWG encoding label). Unknown labels fall back to Windows-1252. */
export function decodeBytes(bytes: Uint8Array, label: string): string {
  if (label === 'windows-1252') return decodeCp1252(bytes);
  let d = decoders.get(label);
  if (d === undefined) {
    try {
      d = new TextDecoder(label);
    } catch {
      d = null; // e.g. a Node build without full ICU
    }
    decoders.set(label, d);
  }
  return d ? d.decode(bytes) : decodeCp1252(bytes);
}

/** The encoding a byte-order mark declares, and the mark's length. */
export function bomOf(b: Uint8Array): { enc: 'utf-8' | 'utf-16le' | 'utf-16be'; length: number } | null {
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return { enc: 'utf-8', length: 3 };
  if (b[0] === 0xff && b[1] === 0xfe) return { enc: 'utf-16le', length: 2 };
  if (b[0] === 0xfe && b[1] === 0xff) return { enc: 'utf-16be', length: 2 };
  return null;
}

/** The length of the well-formed UTF-8 sequence at b[i] (1 for ASCII), or 0 if there is none. */
function utf8Length(b: Uint8Array, i: number): number {
  const c = b[i];
  if (c < 0x80) return 1;
  const n = c >= 0xc2 && c <= 0xdf ? 2 : c >= 0xe0 && c <= 0xef ? 3 : c >= 0xf0 && c <= 0xf4 ? 4 : 0;
  if (!n || i + n > b.length) return 0;
  for (let k = 1; k < n; k++) if ((b[i + k] & 0xc0) !== 0x80) return 0;
  // Overlong forms, surrogates and code points past U+10FFFF.
  const second = b[i + 1];
  if ((c === 0xe0 && second < 0xa0) || (c === 0xed && second > 0x9f) || (c === 0xf0 && second < 0x90) || (c === 0xf4 && second > 0x8f)) return 0;
  return n;
}

/**
 * UTF-8 with stray Windows-1252 bytes (a file edited in two programs): each
 * well-formed UTF-8 sequence decodes as UTF-8 and any other byte as
 * Windows-1252. Null when the stray bytes are the majority: that is a
 * Windows-1252 file, where two accented characters form a "sequence" only by
 * chance ("ß”").
 */
function decodeMixed(b: Uint8Array): string | null {
  let sequences = 0;
  let stray = 0;
  let s = '';
  let codes: number[] = [];
  for (let i = 0; i < b.length; ) {
    const n = utf8Length(b, i);
    if (n === 0) {
      stray++;
      codes.push(cp1252(b[i++]));
    } else {
      if (n > 1) sequences++;
      // The lead byte's payload bits, then six from each continuation byte.
      let cp = n === 1 ? b[i] : b[i] & (0xff >> (n + 1));
      for (let k = 1; k < n; k++) cp = (cp << 6) | (b[i + k] & 0x3f);
      codes.push(cp);
      i += n;
    }
    if (codes.length >= 8192) {
      s += String.fromCodePoint(...codes);
      codes = [];
    }
  }
  return stray > sequences ? null : s + String.fromCodePoint(...codes);
}

function guessEncoding(b: Uint8Array): { enc: 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252'; bom: number } {
  const bom = bomOf(b);
  if (bom) return { enc: bom.enc, bom: bom.length };
  // No BOM: mostly-Latin UTF-16 has a NUL in nearly every high byte.
  const n = Math.min(b.length, 4096) & ~1;
  if (n >= 4) {
    let evenNul = 0;
    let oddNul = 0;
    for (let i = 0; i < n; i += 2) {
      if (b[i] === 0) evenNul++;
      if (b[i + 1] === 0) oddNul++;
    }
    const pairs = n / 2;
    if (oddNul > pairs * 0.4 && evenNul < pairs * 0.05) return { enc: 'utf-16le', bom: 0 };
    if (evenNul > pairs * 0.4 && oddNul < pairs * 0.05) return { enc: 'utf-16be', bom: 0 };
  }
  return { enc: isUtf8(b) ? 'utf-8' : 'windows-1252', bom: 0 };
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });
function isUtf8(b: Uint8Array): boolean {
  try {
    strictUtf8.decode(b);
    return true;
  } catch {
    return false;
  }
}

export function decodeText(data: Uint8Array): string {
  const { enc, bom } = guessEncoding(data);
  const body = data.subarray(bom);
  if (enc !== 'windows-1252') return new TextDecoder(enc).decode(body);
  return decodeMixed(body) ?? decodeCp1252(body);
}

export function txtToText(data: Uint8Array): AdapterOutput {
  return { text: decodeText(data), links: [] };
}
