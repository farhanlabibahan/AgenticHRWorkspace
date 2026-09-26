import { describe, expect, it } from 'vitest';
import { languageFolder, ocrLangs } from '@/server/ocr/engine';
import {
  decodeBmp,
  downscale,
  fixPolarity,
  grayFromPdfImage,
  imageInfo,
  jpegOrientation,
  orient,
  rotate,
  toPgm,
  withReadableOrientation,
  type Gray,
} from '@/server/ocr/image';
import { coverage, Matrix2D, multiply, pageQualifies } from '@/server/ocr/pages';
import { MAX_OCR_ATTEMPTS, OCR_VERSION, ocrPending } from '@/server/ocr/status';
import { cleanOcrText, passesGate } from '@/server/ocr/text';

/** The pure parts of OCR: which pages count as scans, pixels, orientation, cleanup and the confidence bar. */

const gray = (width: number, height: number, values: number[]): Gray => ({ width, height, data: Uint8Array.from(values) });
const rows = (g: Gray) => Array.from({ length: g.height }, (_, y) => Array.from(g.data.subarray(y * g.width, (y + 1) * g.width)));

describe('which pages are scans', () => {
  const scan = { width: 2550, height: 3300, coverage: 1 };

  it('takes a page with next to no text layer and one big image', () => {
    expect(pageQualifies({ textChars: 0, image: scan })).toBe(true);
    expect(pageQualifies({ textChars: 49, image: { width: 600, height: 800, coverage: 0.5 } })).toBe(true);
  });

  it('leaves text pages, small images and partial images alone', () => {
    expect(pageQualifies({ textChars: 50, image: scan })).toBe(false);
    expect(pageQualifies({ textChars: 0, image: null })).toBe(false);
    expect(pageQualifies({ textChars: 0, image: { width: 599, height: 3300, coverage: 1 } })).toBe(false);
    expect(pageQualifies({ textChars: 0, image: { width: 2550, height: 3300, coverage: 0.49 } })).toBe(false);
  });

  it("measures an image's share of the page from its transform, clipped to the page", () => {
    const letter = [0, 0, 612, 792];
    expect(coverage([612, 0, 0, 792, 0, 0], letter)).toBe(1);
    expect(coverage([612, 0, 0, 396, 0, 396], letter)).toBe(0.5);
    // Page-sized but drawn from the middle: the quarter that lands on the page counts.
    expect(coverage([612, 0, 0, 792, 306, 396], letter)).toBe(0.25);
    // Sideways (rotated 90 degrees) and still covering the page.
    expect(coverage([0, 792, -612, 0, 612, 0], letter)).toBe(1);
    expect(coverage([10, 0, 0, 10, 1000, 1000], letter)).toBe(0);
  });

  it("stands in for DOMMatrix where pdf.js's parser needs one (no @napi-rs/canvas in the function)", () => {
    // What pdf.js builds to outline a Type3 glyph of 10 x 20 pixels.
    const m = new Matrix2D().scaleSelf(1 / 10, -1 / 20).translateSelf(0, -20);
    expect([m.a, m.b, m.c, m.d, m.e, m.f]).toEqual([0.1, 0, 0, -0.05, 0, 1]);
    const inv = new Matrix2D([2, 0, 0, 4, 10, 20]).invertSelf();
    expect([inv.a, inv.d, inv.e, inv.f]).toEqual([0.5, 0.25, -5, -5]);
    expect(new Matrix2D([1, 0, 0, 1, 5, 0]).preMultiplySelf(new Matrix2D([2, 0, 0, 2, 0, 0])).e).toBe(10);
  });

  it('composes transforms the way PDF does: the new matrix first, then the current one', () => {
    // Scale by 2, then move by (10, 20).
    expect(multiply([1, 0, 0, 1, 10, 20], [2, 0, 0, 2, 0, 0])).toEqual([2, 0, 0, 2, 10, 20]);
    expect(multiply([2, 0, 0, 2, 0, 0], [1, 0, 0, 1, 10, 20])).toEqual([2, 0, 0, 2, 20, 40]);
  });
});

describe('pixels', () => {
  it('unpacks 1-bit rows, padded to a byte, with a set bit as white', () => {
    // 10 pixels wide: two bytes a row.
    const g = grayFromPdfImage({ width: 10, height: 2, kind: 1, data: Uint8Array.from([0b01111111, 0b11000000, 0xff, 0b01000000]) });
    expect(rows(g!)).toEqual([
      [0, 255, 255, 255, 255, 255, 255, 255, 255, 255],
      [255, 255, 255, 255, 255, 255, 255, 255, 0, 255],
    ]);
  });

  it('reads a stencil mask as ink where it paints (a clear bit)', () => {
    const g = grayFromPdfImage({ width: 8, height: 1, data: Uint8Array.from([0b11110000]) }, true);
    expect(rows(g!)).toEqual([[255, 255, 255, 255, 0, 0, 0, 0]]);
  });

  it('turns color into luma, and alpha into paper', () => {
    const rgb = grayFromPdfImage({ width: 2, height: 1, kind: 2, data: Uint8Array.from([255, 255, 255, 255, 0, 0]) });
    expect(rows(rgb!)).toEqual([[255, 76]]);
    const rgba = grayFromPdfImage({ width: 2, height: 1, kind: 3, data: Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 255]) });
    expect(rows(rgba!)).toEqual([[255, 0]]);
  });

  it('refuses layouts it does not know, and short buffers', () => {
    expect(grayFromPdfImage({ width: 2, height: 2, kind: 9, data: new Uint8Array(16) })).toBeNull();
    expect(grayFromPdfImage({ width: 2, height: 2, kind: 2, data: new Uint8Array(5) })).toBeNull();
    expect(grayFromPdfImage({ width: 2, height: 2, kind: 2, data: null })).toBeNull();
  });

  it('flips a bilevel page that is mostly ink, and leaves paper alone', () => {
    expect(rows(fixPolarity(gray(4, 2, [0, 0, 0, 0, 0, 0, 0, 255])))).toEqual([
      [255, 255, 255, 255],
      [255, 255, 255, 0],
    ]);
    expect(rows(fixPolarity(gray(4, 1, [255, 0, 255, 255])))).toEqual([[255, 0, 255, 255]]);
  });

  it('writes binary PGM', () => {
    const pgm = toPgm(gray(3, 2, [0, 1, 2, 3, 4, 5]));
    expect(new TextDecoder().decode(pgm.subarray(0, 11))).toBe('P5\n3 2\n255\n');
    expect(Array.from(pgm.subarray(11))).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('turns a raster by quarter turns, clockwise', () => {
    const g = gray(3, 2, [1, 2, 3, 4, 5, 6]);
    expect(rows(rotate(g, 90))).toEqual([
      [4, 1],
      [5, 2],
      [6, 3],
    ]);
    expect(rows(rotate(g, 180))).toEqual([
      [6, 5, 4],
      [3, 2, 1],
    ]);
    expect(rows(rotate(g, 270))).toEqual([
      [3, 6],
      [2, 5],
      [1, 4],
    ]);
  });

  it('lays a raster out as it shows on the page', () => {
    const g = gray(3, 2, [1, 2, 3, 4, 5, 6]);
    expect(orient(g, [1, 0], [0, 1])).toBe(g); // upright
    // Columns run down the screen and rows run leftward: shown turned 90 degrees clockwise.
    expect(rows(orient(g, [0, 1], [-1, 0]))).toEqual(rows(rotate(g, 90)));
    expect(rows(orient(g, [-1, 0], [0, -1]))).toEqual(rows(rotate(g, 180)));
    expect(rows(orient(g, [0, -1], [1, 0]))).toEqual(rows(rotate(g, 270)));
    // Mirrored left to right.
    expect(rows(orient(g, [-1, 0], [0, 1]))).toEqual([
      [3, 2, 1],
      [6, 5, 4],
    ]);
  });

  it('averages a raster down', () => {
    expect(rows(downscale(gray(4, 2, [0, 255, 10, 20, 255, 0, 30, 40]), 2))).toEqual([[128, 25]]);
  });
});

describe('image files', () => {
  const bytes = (...parts: (number[] | string)[]) =>
    Uint8Array.from(parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)));
  const pad = (n: number) => new Array(n).fill(0);

  it('knows the type and size from the header', () => {
    const png = bytes([0x89], 'PNG\r\n\x1a\n', [0, 0, 0, 13], 'IHDR', [0, 0, 0x0a, 0x00, 0, 0, 0x0c, 0x80], pad(8));
    expect(imageInfo(png)).toEqual({ type: 'png', width: 2560, height: 3200 });
    expect(imageInfo(bytes('GIF89a', [0x20, 0x03, 0x58, 0x02], pad(10)))).toEqual({ type: 'gif', width: 800, height: 600 });
    const jpeg = bytes([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0x0c, 0x80, 0x0a, 0x00, 1], pad(8));
    expect(imageInfo(jpeg)).toEqual({ type: 'jpeg', width: 2560, height: 3200 });
    const tiff = bytes('II*\0', [8, 0, 0, 0], [2, 0], [0, 1, 3, 0, 1, 0, 0, 0, 0x10, 0x00, 0, 0], [1, 1, 4, 0, 1, 0, 0, 0, 0x20, 0x00, 0, 0], pad(4));
    expect(imageInfo(tiff)).toEqual({ type: 'tiff', width: 16, height: 32 });
    expect(imageInfo(bytes([0, 0, 0, 0x18], 'ftypheic', pad(8)))).toMatchObject({ type: 'heif' });
    expect(imageInfo(bytes('%PDF-1.4 not an image here'))).toBeNull();
  });

  /** A BMP with a BITMAPINFOHEADER. */
  function bmp(width: number, height: number, bpp: number, pixels: number[], palette: number[] = []) {
    const offset = 54 + palette.length;
    const le32 = (v: number) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
    const header = [
      ...bytes('BM'),
      ...le32(offset + pixels.length),
      0, 0, 0, 0,
      ...le32(offset),
      ...le32(40),
      ...le32(width),
      ...le32(height),
      1, 0, bpp, 0,
      ...le32(0),
      ...le32(pixels.length),
      ...le32(2835),
      ...le32(2835),
      ...le32(palette.length / 4),
      ...le32(0),
    ];
    return Uint8Array.from([...header, ...palette, ...pixels]);
  }

  it('decodes BMPs itself (bmp-js needs 900 MB for a 6 MB file)', () => {
    // 24-bit, 2 x 2, bottom-up, rows padded to 4 bytes: bottom row first.
    const px = [0, 0, 0, 255, 255, 255, 0, 0, /* bottom */ 0, 0, 255, 255, 0, 0, 0, 0 /* top */];
    expect(rows(decodeBmp(bmp(2, 2, 24, px))!)).toEqual([
      [76, 28],
      [0, 255],
    ]);
    // 8-bit with a palette of black and white; a negative height is top-down.
    const top = bmp(3, 1, 8, [1, 0, 1, 0], [0, 0, 0, 0, 255, 255, 255, 0]);
    expect(rows(decodeBmp(top)!)).toEqual([[255, 0, 255]]);
    expect(imageInfo(top)).toEqual({ type: 'bmp', width: 3, height: 1 });
    // RLE: not read.
    const rle = bmp(2, 2, 8, [0, 0, 0, 0]);
    rle[30] = 1;
    expect(decodeBmp(rle)).toBeNull();
  });

  /** A JPEG head with one EXIF orientation tag, in either byte order. */
  function jpegWithExif(orientation: number, order: 'II' | 'MM') {
    const u16 = (v: number) => (order === 'II' ? [v & 255, v >> 8] : [v >> 8, v & 255]);
    const u32 = (v: number) => (order === 'II' ? [v & 255, 0, 0, 0] : [0, 0, 0, v & 255]);
    const tiff = [...bytes(order), ...u16(42), ...u32(8), ...u16(1), ...u16(0x0112), ...u16(3), ...u32(1), ...u16(orientation), 0, 0, ...u32(0)];
    const payload = [...bytes('Exif\0\0'), ...tiff];
    return Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 255, ...payload, 0xff, 0xda, 0, 2]);
  }

  it('finds the EXIF orientation in either byte order', () => {
    expect(jpegOrientation(jpegWithExif(6, 'MM'))).toBe(6);
    expect(jpegOrientation(jpegWithExif(8, 'II'))).toBe(8);
    expect(jpegOrientation(Uint8Array.from([0xff, 0xd8, 0xff, 0xda, 0, 2]))).toBeNull();
  });

  it("gives Tesseract a big-endian copy of a little-endian orientation, where tesseract.js's check finds it", () => {
    const fixed = withReadableOrientation(jpegWithExif(6, 'II'));
    // tesseract.js's own test (src/worker-script/utils/setImage.js).
    const found = Array.from(fixed.subarray(0, 500)).join(' ').match(/1 18 0 3 0 0 0 1 0 (\d)/)?.[1];
    expect(found).toBe('6');
    expect(jpegOrientation(fixed)).toBe(6);
    // Upright or unknown: untouched.
    const upright = jpegWithExif(1, 'II');
    expect(withReadableOrientation(upright)).toBe(upright);
  });
});

describe('cleanup and the confidence bar', () => {
  it('drops tokens with no letter or digit, and rejoins split addresses', () => {
    const raw = [
      'ROWAN Q. TESTPERSON',
      '',
      '',
      '',
      'rowan. testperson@example.com | +1 (555) 010-4477 | Portland, Oregon',
      'linkedin.com/ in/rowan-testperson — github.com/rowan/ projects',
      '- Designed a platform ~ ©',
      '| — |',
    ].join('\n');
    expect(cleanOcrText(raw)).toBe(
      [
        'ROWAN Q. TESTPERSON',
        '',
        'rowan.testperson@example.com +1 (555) 010-4477 Portland, Oregon',
        'linkedin.com/in/rowan-testperson github.com/rowan/projects',
        'Designed a platform',
      ].join('\n'),
    );
  });

  it("keeps the words either side of a slash that isn't in an address", () => {
    expect(cleanOcrText('Python/ SQL and/ or')).toBe('Python/ SQL and/ or');
  });

  it('keeps pages that read confidently, if they add up to enough text', () => {
    const page = (confidence: number, chars = 150) => ({ text: 'x'.repeat(chars), confidence });
    expect(passesGate([page(93)])).toMatchObject({ ok: true, confidence: 93 });
    expect(passesGate([page(50, 100)])).toMatchObject({ ok: true });
    expect(passesGate([page(49)])).toMatchObject({ ok: false, confidence: 49 });
    expect(passesGate([page(95, 99)])).toMatchObject({ ok: false });
    // A garbled second page is left out, not averaged in.
    const mixed = passesGate([page(90, 300), page(30, 100)]);
    expect(mixed).toMatchObject({ ok: true, confidence: 90 });
    expect(mixed.text).toHaveLength(300);
    // Weighted by text: a full page counts for more than a line.
    expect(passesGate([page(90, 300), page(60, 100)]).confidence).toBe(83);
    expect(passesGate([])).toMatchObject({ ok: false, confidence: null });
  });
});

describe('settings and state', () => {
  it('reads OCR_LANGS, and falls back to English on anything odd', () => {
    expect(ocrLangs({})).toEqual(['eng']);
    expect(ocrLangs({ OCR_LANGS: 'eng+fra' })).toEqual(['eng', 'fra']);
    expect(ocrLangs({ OCR_LANGS: 'eng, deu,eng' })).toEqual(['eng', 'deu']);
    expect(ocrLangs({ OCR_LANGS: 'chi_sim' })).toEqual(['chi_sim']);
    expect(ocrLangs({ OCR_LANGS: '../../etc' })).toEqual(['eng']);
  });

  it('finds installed language data, and names the package to install otherwise', () => {
    expect(languageFolder(['eng'])).toMatch(/@tesseract\.js-data[/\\]eng[/\\]4\.0\.0_best_int$/);
    expect(() => languageFolder(['eng', 'xyz'])).toThrow('npm install @tesseract.js-data/xyz@1.0.0');
  });

  it('says whether OCR will still try a resume', () => {
    const file = { textStatus: 'EMPTY' as const, ocrStatus: null, ocrVersion: null, ocrAttempts: 0 };
    expect(ocrPending(file)).toBe(true);
    expect(ocrPending({ ...file, textStatus: 'UNSUPPORTED' })).toBe(true);
    expect(ocrPending({ ...file, textStatus: 'ENCRYPTED' })).toBe(false);
    expect(ocrPending({ ...file, textStatus: 'OK' })).toBe(false);
    expect(ocrPending({ ...file, ocrStatus: 'LOW_CONFIDENCE', ocrVersion: OCR_VERSION, ocrAttempts: 1 })).toBe(false);
    expect(ocrPending({ ...file, ocrStatus: 'LOW_CONFIDENCE', ocrVersion: OCR_VERSION - 1, ocrAttempts: 1 })).toBe(true);
    expect(ocrPending({ ...file, ocrStatus: 'FAILED', ocrVersion: OCR_VERSION, ocrAttempts: 1 })).toBe(true);
    expect(ocrPending({ ...file, ocrStatus: 'FAILED', ocrVersion: OCR_VERSION, ocrAttempts: MAX_OCR_ATTEMPTS })).toBe(false);
    // Claimed and not finished.
    expect(ocrPending({ ...file, ocrStatus: null, ocrVersion: OCR_VERSION, ocrAttempts: 1 })).toBe(true);
  });
});
