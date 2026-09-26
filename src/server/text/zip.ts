/**
 * Minimal ZIP reader for DOCX and ODT: the central directory plus node:zlib
 * raw inflate. Zip-bomb safe: every entry inflates with `maxOutputLength`, so
 * zlib stops as soon as the output passes the cap (the sizes in the directory
 * are attacker-controlled and never trusted), and a per-archive budget bounds
 * the total across entries, shared with any archive nested inside it.
 */
import { inflateRawSync } from 'node:zlib';
import { DocumentLimitError, EncryptedDocumentError } from './types';

type ZipEntry = { method: number; flags: number; csize: number; offset: number };

export type ZipLimits = {
  /** Entries in the central directory (a DOCX has about 10–40). */
  maxEntries: number;
  /** Inflated bytes for any single entry. */
  maxEntryBytes: number;
  /** Inflated bytes across every entry read from one archive. */
  maxTotalBytes: number;
};

const LIMITS: ZipLimits = {
  maxEntries: 5_000,
  maxEntryBytes: 32 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
};

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOC = 0x07064b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;
const utf8 = new TextDecoder('utf-8');

export class ZipReader {
  private readonly buf: Uint8Array;
  private readonly entries: Map<string, ZipEntry>;
  private readonly limits: ZipLimits;
  /** Inflated bytes so far, by this archive and the ones nested in it. */
  private readonly budget: { used: number };

  private constructor(buf: Uint8Array, entries: Map<string, ZipEntry>, limits: ZipLimits, budget: { used: number }) {
    this.buf = buf;
    this.entries = entries;
    this.limits = limits;
    this.budget = budget;
  }

  /**
   * Null when the bytes have no readable central directory (not a ZIP, or
   * truncated). Throws DocumentLimitError for an archive with too many entries.
   */
  static open(buf: Uint8Array, limits: ZipLimits = LIMITS): ZipReader | null {
    const entries = readCentralDirectory(buf, limits.maxEntries);
    return entries ? new ZipReader(buf, entries, limits, { used: 0 }) : null;
  }

  /**
   * An archive stored inside this one (a DOCX in a w:altChunk). It draws on
   * this archive's budget: with a fresh one, a few KB of nested archives
   * could each inflate the full limit.
   */
  nested(buf: Uint8Array): ZipReader | null {
    const entries = readCentralDirectory(buf, this.limits.maxEntries);
    return entries ? new ZipReader(buf, entries, this.limits, this.budget) : null;
  }

  has(name: string): boolean {
    return this.entries.has(name.toLowerCase());
  }

  /** Inflated bytes of an entry (names are case-insensitive), or null if there is none. */
  bytes(name: string): Uint8Array | null {
    const e = this.entries.get(name.toLowerCase());
    if (!e) return null;
    if (e.flags & 0x1) throw new EncryptedDocumentError('The archive has encrypted entries');
    const dv = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
    const o = e.offset;
    if (o + 30 > this.buf.byteLength || dv.getUint32(o, true) !== SIG_LOC) throw new Error('zip: bad local header');
    const start = o + 30 + dv.getUint16(o + 26, true) + dv.getUint16(o + 28, true);
    const end = start + e.csize;
    if (end > this.buf.byteLength) throw new Error('zip: truncated entry');
    const raw = this.buf.subarray(start, end);
    const cap = Math.min(this.limits.maxEntryBytes, this.limits.maxTotalBytes - this.budget.used);
    let out: Uint8Array;
    if (e.method === 0) {
      if (raw.byteLength > cap) throw new DocumentLimitError('A ZIP entry is over the size limit');
      out = raw;
    } else if (e.method === 8) {
      try {
        out = inflateRawSync(raw, { maxOutputLength: Math.max(cap, 1) });
      } catch (err) {
        if ((err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') {
          throw new DocumentLimitError('A ZIP entry inflates past the size limit');
        }
        throw err;
      }
    } else {
      throw new Error(`zip: unsupported compression method ${e.method}`);
    }
    this.budget.used += out.byteLength;
    return out;
  }

  text(name: string): string | null {
    const b = this.bytes(name);
    return b ? utf8.decode(b) : null;
  }
}

function readCentralDirectory(buf: Uint8Array, maxEntries: number): Map<string, ZipEntry> | null {
  const len = buf.byteLength;
  if (len < 22) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, len);
  let eocd = -1;
  for (let i = len - 22, stop = Math.max(0, len - 22 - 0xffff); i >= stop; i--) {
    if (buf[i] === 0x50 && dv.getUint32(i, true) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  let count = dv.getUint16(eocd + 10, true);
  let cdSize = dv.getUint32(eocd + 12, true);
  let cdOff = dv.getUint32(eocd + 16, true);
  if (count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) {
    const loc = eocd - 20;
    if (loc < 0 || dv.getUint32(loc, true) !== SIG_EOCD64_LOC) return null;
    const e64 = Number(dv.getBigUint64(loc + 8, true));
    if (e64 + 56 > len || dv.getUint32(e64, true) !== SIG_EOCD64) return null;
    count = Number(dv.getBigUint64(e64 + 32, true));
    cdSize = Number(dv.getBigUint64(e64 + 40, true));
    cdOff = Number(dv.getBigUint64(e64 + 48, true));
  }
  if (count > maxEntries) throw new DocumentLimitError(`The archive has more than ${maxEntries} entries`);
  if (cdOff + cdSize > len) return null;
  const entries = new Map<string, ZipEntry>();
  let p = cdOff;
  for (let i = 0; i < count; i++) {
    if (p + 46 > len || dv.getUint32(p, true) !== SIG_CEN) return null;
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    let csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    let offset = dv.getUint32(p + 42, true);
    if (p + 46 + nameLen + extraLen > len) return null;
    const name = utf8.decode(buf.subarray(p + 46, p + 46 + nameLen));
    if (usize === 0xffffffff || csize === 0xffffffff || offset === 0xffffffff) {
      // ZIP64 extra field (0x0001): only the maxed-out fields are present, in this order.
      let q = p + 46 + nameLen;
      const qEnd = q + extraLen;
      while (q + 4 <= qEnd) {
        const id = dv.getUint16(q, true);
        const size = dv.getUint16(q + 2, true);
        if (id === 0x0001) {
          let r = q + 4;
          const rEnd = r + size;
          if (usize === 0xffffffff && r + 8 <= rEnd) r += 8; // uncompressed size: never trusted
          if (csize === 0xffffffff && r + 8 <= rEnd) {
            csize = Number(dv.getBigUint64(r, true));
            r += 8;
          }
          if (offset === 0xffffffff && r + 8 <= rEnd) offset = Number(dv.getBigUint64(r, true));
          break;
        }
        q += 4 + size;
      }
    }
    entries.set(name.toLowerCase(), { method, flags, csize, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}
