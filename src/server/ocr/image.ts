/**
 * Pixels for Tesseract, without a canvas or an image library: 8-bit
 * grayscale rasters from pdf.js's decoded images, quarter turns, and PGM,
 * which Tesseract (Leptonica) reads directly. Plus just enough of each image
 * format's header to know what a file is and how big it is before OCR.
 */

/** An 8-bit grayscale raster, one byte per pixel, rows top to bottom, 0 = black. */
export type Gray = { width: number; height: number; data: Uint8Array };

/** pdf.js ImageKind: how a decoded image's `data` is laid out. */
export const IMAGE_KIND = { GRAYSCALE_1BPP: 1, RGB_24BPP: 2, RGBA_32BPP: 3 } as const;

/** A decoded image as pdf.js hands it over from page.objs. A stencil mask has no kind. */
export type PdfImage = { width: number; height: number; kind?: number; data?: Uint8Array | Uint8ClampedArray | null };

/**
 * A pdf.js image as grayscale. Bilevel rows are packed and padded to a
 * byte; a set bit is white for an image and unpainted for a stencil mask,
 * which is black where it paints. Alpha is composited onto white paper.
 * Null for a layout this doesn't know (an ImageBitmap has no bytes here).
 */
export function grayFromPdfImage(img: PdfImage, mask = false): Gray | null {
  const { width: w, height: h, data } = img;
  if (!data || !(w > 0) || !(h > 0)) return null;
  const out = new Uint8Array(w * h);
  if (mask || img.kind === IMAGE_KIND.GRAYSCALE_1BPP) {
    const rowBytes = (w + 7) >> 3;
    if (data.length < rowBytes * h) return null;
    for (let y = 0; y < h; y++) {
      const row = y * rowBytes;
      const o = y * w;
      for (let x = 0; x < w; x++) out[o + x] = data[row + (x >> 3)] & (128 >> (x & 7)) ? 255 : 0;
    }
    return fixPolarity({ width: w, height: h, data: out });
  }
  const step = img.kind === IMAGE_KIND.RGB_24BPP ? 3 : img.kind === IMAGE_KIND.RGBA_32BPP ? 4 : 0;
  if (!step || data.length < w * h * step) return null;
  for (let i = 0, j = 0; i < out.length; i++, j += step) {
    // Rec. 601 luma in fixed point.
    const luma = (data[j] * 77 + data[j + 1] * 150 + data[j + 2] * 29) >> 8;
    out[i] = step === 4 ? (luma * data[j + 3] + 255 * (255 - data[j + 3])) / 255 : luma;
  }
  return { width: w, height: h, data: out };
}

/**
 * A page of text is mostly paper. A bilevel scan that is mostly black was
 * decoded (or stored) inverted: a Decode array, a mask, a producer's own
 * convention. Flip it rather than make Tesseract read white on black.
 */
export function fixPolarity(g: Gray): Gray {
  // On a page, every 7th pixel is plenty to tell paper from ink.
  const step = g.data.length > 100_000 ? 7 : 1;
  let black = 0;
  let seen = 0;
  for (let i = 0; i < g.data.length; i += step, seen++) if (g.data[i] < 128) black++;
  if (black > seen * 0.6) for (let i = 0; i < g.data.length; i++) g.data[i] = 255 - g.data[i];
  return g;
}

/** Binary PGM (P5): the header, then one byte per pixel. */
export function toPgm(g: Gray): Uint8Array {
  const header = new TextEncoder().encode(`P5\n${g.width} ${g.height}\n255\n`);
  const out = new Uint8Array(header.length + g.data.length);
  out.set(header);
  out.set(g.data, header.length);
  return out;
}

export type QuarterTurn = 0 | 90 | 180 | 270;

/** Turns a raster clockwise by a multiple of 90 degrees. */
export function rotate(g: Gray, degrees: QuarterTurn): Gray {
  if (degrees === 0) return g;
  const { width: w, height: h, data } = g;
  const sideways = degrees !== 180;
  const W = sideways ? h : w;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Where source pixel (x, y) lands.
      const [nx, ny] = degrees === 90 ? [h - 1 - y, x] : degrees === 180 ? [w - 1 - x, h - 1 - y] : [y, w - 1 - x];
      out[ny * W + nx] = data[y * w + x];
    }
  }
  return { width: W, height: sideways ? w : h, data: out };
}

/**
 * Lays out a raster the way it shows on the page. `col` and `row` are the
 * directions, on screen (y down), in which the image's columns and rows
 * advance: [1, 0] and [0, 1] for an upright image. Mirroring is undone too.
 */
export function orient(g: Gray, col: [number, number], row: [number, number]): Gray {
  const colX = Math.abs(col[0]) >= Math.abs(col[1]);
  const rowX = Math.abs(row[0]) > Math.abs(row[1]);
  if (colX === rowX) return g; // degenerate (skewed past 45 degrees both ways): leave it
  const colSign = colX ? Math.sign(col[0]) : Math.sign(col[1]);
  const rowSign = rowX ? Math.sign(row[0]) : Math.sign(row[1]);
  if (colX && colSign > 0 && rowSign > 0) return g;
  const { width: w, height: h, data } = g;
  const W = colX ? w : h;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const alongRow = rowSign > 0 ? y : h - 1 - y;
    for (let x = 0; x < w; x++) {
      const alongCol = colSign > 0 ? x : w - 1 - x;
      const [nx, ny] = colX ? [alongCol, alongRow] : [alongRow, alongCol];
      out[ny * W + nx] = data[y * w + x];
    }
  }
  return { width: W, height: colX ? h : w, data: out };
}

/** Averages `factor` x `factor` blocks: a 600 dpi scan read at 300 costs a quarter of the time. */
export function downscale(g: Gray, factor: number): Gray {
  if (factor <= 1) return g;
  const W = Math.floor(g.width / factor);
  const H = Math.floor(g.height / factor);
  const out = new Uint8Array(W * H);
  const n = factor * factor;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let sum = 0;
      for (let dy = 0; dy < factor; dy++) {
        const row = (y * factor + dy) * g.width + x * factor;
        for (let dx = 0; dx < factor; dx++) sum += g.data[row + dx];
      }
      out[y * W + x] = Math.round(sum / n);
    }
  }
  return { width: W, height: H, data: out };
}

// ---------------------------------------------------------------- image files

export type ImageType = 'png' | 'jpeg' | 'gif' | 'webp' | 'tiff' | 'bmp' | 'heif';
export type ImageInfo = { type: ImageType; width: number | null; height: number | null };

const ascii = (b: Uint8Array, start: number, end: number) => String.fromCharCode(...b.subarray(start, Math.min(end, b.length)));
const u16be = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const u16le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const u32be = (b: Uint8Array, i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const u32le = (b: Uint8Array, i: number) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
const i32le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24);

/**
 * The image type from the magic bytes, and its size when the header says it
 * (null when it can't be found, which the caller treats as unknown). HEIC and
 * AVIF are recognized only to be turned away: Tesseract doesn't read them.
 */
export function imageInfo(b: Uint8Array): ImageInfo | null {
  if (b.length < 16) return null;
  if (b[0] === 0x89 && ascii(b, 1, 4) === 'PNG') {
    return { type: 'png', width: u32be(b, 16), height: u32be(b, 20) };
  }
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { type: 'jpeg', ...jpegSize(b) };
  if (ascii(b, 0, 4) === 'GIF8') return { type: 'gif', width: u16le(b, 6), height: u16le(b, 8) };
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return { type: 'webp', ...webpSize(b) };
  if (ascii(b, 0, 4) === 'II*\0' || ascii(b, 0, 4) === 'MM\0*') return { type: 'tiff', ...tiffSize(b) };
  if (ascii(b, 0, 2) === 'BM' && b.length >= 26 && u32le(b, 14) >= 40) {
    return { type: 'bmp', width: i32le(b, 18), height: Math.abs(i32le(b, 22)) };
  }
  if (ascii(b, 4, 8) === 'ftyp' && /^(heic|heix|hevc|mif1|msf1|avif)/.test(ascii(b, 8, 12))) {
    return { type: 'heif', width: null, height: null };
  }
  return null;
}

const unknown = { width: null, height: null };

function jpegSize(b: Uint8Array): { width: number | null; height: number | null } {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return unknown;
    const marker = b[i + 1];
    if (marker === 0xff) {
      i++; // fill byte
      continue;
    }
    // Start of frame: every SOFn except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: u16be(b, i + 5), width: u16be(b, i + 7) };
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2;
      continue;
    }
    i += 2 + u16be(b, i + 2);
  }
  return unknown;
}

function webpSize(b: Uint8Array): { width: number | null; height: number | null } {
  const chunk = ascii(b, 12, 16);
  if (chunk === 'VP8X' && b.length >= 30) return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
  if (chunk === 'VP8 ' && b.length >= 30) return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  if (chunk === 'VP8L' && b.length >= 25) {
    const bits = u32le(b, 21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return unknown;
}

function tiffSize(b: Uint8Array): { width: number | null; height: number | null } {
  const le = b[0] === 0x49;
  const u16 = (i: number) => (le ? u16le(b, i) : u16be(b, i));
  const u32 = (i: number) => (le ? u32le(b, i) : u32be(b, i));
  const ifd = u32(4);
  if (ifd + 2 > b.length) return unknown;
  const size: { width: number | null; height: number | null } = { ...unknown };
  for (let n = 0, count = u16(ifd); n < count && ifd + 2 + n * 12 + 12 <= b.length; n++) {
    const e = ifd + 2 + n * 12;
    const tag = u16(e);
    const value = u16(e + 2) === 3 ? u16(e + 8) : u32(e + 8); // SHORT or LONG
    if (tag === 256) size.width = value;
    if (tag === 257) size.height = value;
  }
  return size;
}

/**
 * A BMP as grayscale. tesseract.js converts BMPs with bmp-js by spreading the
 * file into a plain object: a 6 MB BMP took 900 MB and 3 s. Uncompressed
 * 1, 4, 8, 24 and 32-bit files (with 32-bit bitfields read as BGRA), which is
 * what Windows and scanners write; null for anything else (RLE, 16-bit).
 */
export function decodeBmp(b: Uint8Array): Gray | null {
  if (b.length < 54 || ascii(b, 0, 2) !== 'BM') return null;
  const offset = u32le(b, 10);
  const headerSize = u32le(b, 14);
  const w = i32le(b, 18);
  const rawH = i32le(b, 22);
  const bpp = u16le(b, 28);
  const compression = u32le(b, 30);
  const h = Math.abs(rawH);
  if (headerSize < 40 || w <= 0 || h === 0 || w > 30_000 || h > 30_000) return null;
  if (!(compression === 0 || (compression === 3 && bpp === 32))) return null;
  if (![1, 4, 8, 24, 32].includes(bpp)) return null;
  const stride = Math.ceil((w * bpp) / 32) * 4;
  if (offset + stride * h > b.length) return null;
  let palette: Uint8Array | null = null;
  if (bpp <= 8) {
    const colors = u32le(b, 46) || 1 << bpp;
    const start = 14 + headerSize;
    palette = new Uint8Array(colors);
    for (let c = 0; c < colors && start + c * 4 + 2 < b.length; c++) {
      const p = start + c * 4;
      palette[c] = (b[p + 2] * 77 + b[p + 1] * 150 + b[p] * 29) >> 8;
    }
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const src = offset + (rawH > 0 ? h - 1 - y : y) * stride; // bottom-up unless the height is negative
    const o = y * w;
    for (let x = 0; x < w; x++) {
      if (palette) {
        const bit = x * bpp;
        const index = (b[src + (bit >> 3)] >> (8 - bpp - (bit & 7))) & ((1 << bpp) - 1);
        out[o + x] = palette[index] ?? 0;
      } else {
        const p = src + x * (bpp >> 3);
        out[o + x] = (b[p + 2] * 77 + b[p + 1] * 150 + b[p] * 29) >> 8;
      }
    }
  }
  return { width: w, height: h, data: out };
}

/**
 * The EXIF orientation of a JPEG (1-8), in either byte order, or null.
 * Only looks at the APP1 segments before the image data.
 */
export function jpegOrientation(b: Uint8Array): number | null {
  let i = 2;
  while (i + 4 < b.length && b[i] === 0xff) {
    const marker = b[i + 1];
    if (marker === 0xda || marker === 0xd9) return null; // image data: no EXIF before it
    const len = u16be(b, i + 2);
    if (marker === 0xe1 && ascii(b, i + 4, i + 10) === 'Exif\0\0') {
      const t = i + 10;
      const le = ascii(b, t, t + 2) === 'II';
      const u16 = (k: number) => (le ? u16le(b, k) : u16be(b, k));
      const u32 = (k: number) => (le ? u32le(b, k) : u32be(b, k));
      const ifd = t + u32(t + 4);
      if (ifd + 2 > i + 2 + len) return null;
      for (let n = 0, count = u16(ifd); n < count; n++) {
        const e = ifd + 2 + n * 12;
        if (e + 12 > i + 2 + len) break;
        if (u16(e) === 0x0112) {
          const v = u16(e + 8);
          return v >= 1 && v <= 8 ? v : null;
        }
      }
      return null;
    }
    i += 2 + len;
  }
  return null;
}

/**
 * tesseract.js turns a JPEG upright from its EXIF orientation, but only finds
 * the tag in big-endian EXIF (iPhones); Android phones often write
 * little-endian, and those photos came out sideways and unreadable. A tiny
 * big-endian EXIF segment with the same orientation, put first, fixes that;
 * image decoders skip segments they don't need.
 */
export function withReadableOrientation(b: Uint8Array): Uint8Array {
  const orientation = jpegOrientation(b);
  if (!orientation || orientation === 1) return b;
  const tiff = [0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0, 0, 0];
  const payload = [...new TextEncoder().encode('Exif\0\0'), ...tiff];
  const segment = [0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 0xff, ...payload];
  const out = new Uint8Array(b.length + segment.length);
  out.set(b.subarray(0, 2));
  out.set(segment, 2);
  out.set(b.subarray(2), 2 + segment.length);
  return out;
}
