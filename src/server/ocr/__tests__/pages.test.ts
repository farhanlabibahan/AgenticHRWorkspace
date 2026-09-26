import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { OcrEngine } from '@/server/ocr';
import { ocrDocument } from '@/server/ocr';
import type { Gray } from '@/server/ocr/image';
import { findScannedPages } from '@/server/ocr/pages-host';

/**
 * Which pages of a PDF are read, and how they are turned, on PDFs built here
 * byte by byte: an image's placement, the page's /Rotate, stencil masks, text
 * layers. And the orientation retries, with an engine that only reads a page
 * the right way up.
 */

/** A bilevel image, 1 = white, with a black square in its top-left corner: where "up" is. */
function marked(width: number, height: number): Buffer {
  const rowBytes = Math.ceil(width / 8);
  const data = Buffer.alloc(rowBytes * height, 0xff);
  for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) data[y * rowBytes + (x >> 3)] &= ~(128 >> (x & 7));
  return data;
}

type Img = { width: number; height: number; mask?: boolean; data?: Buffer };
type Page = { size?: [number, number]; rotate?: number; draw: { img: Img; cm: number[] }[]; text?: string };

/** Just enough PDF: Flate 1-bit images (or stencil masks) placed with a matrix, and optional text. */
function pdf(pages: Page[]): Uint8Array {
  const objects: (string | Buffer)[] = [];
  const add = (body: string | Buffer) => objects.push(body) && objects.length;
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pagesRef = objects.length + 1 + pages.reduce((n, p) => n + 2 + p.draw.length, 0);
  const kids: number[] = [];
  for (const page of pages) {
    const names = page.draw.map(({ img }) => {
      const stream = deflateSync(img.data ?? marked(img.width, img.height));
      const dict = img.mask
        ? `/ImageMask true /BitsPerComponent 1`
        : `/ColorSpace /DeviceGray /BitsPerComponent 1`;
      return add(
        Buffer.concat([
          Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} ${dict} /Filter /FlateDecode /Length ${stream.length} >>\nstream\n`),
          stream,
          Buffer.from('\nendstream'),
        ]),
      );
    });
    const ops =
      page.draw.map(({ cm }, i) => `q ${cm.join(' ')} cm /Im${i} Do Q`).join('\n') + (page.text ? `\nBT /F1 10 Tf 40 40 Td (${page.text}) Tj ET` : '');
    const content = add(`<< /Length ${ops.length} >>\nstream\n${ops}\nendstream`);
    const [w, h] = page.size ?? [612, 792];
    kids.push(
      add(
        `<< /Type /Page /Parent ${pagesRef} 0 R /MediaBox [0 0 ${w} ${h}]${page.rotate ? ` /Rotate ${page.rotate}` : ''} /Contents ${content} 0 R ` +
          `/Resources << /Font << /F1 ${font} 0 R >> /XObject << ${names.map((n, i) => `/Im${i} ${n} 0 R`).join(' ')} >> >> >>`,
      ),
    );
  }
  expect(add(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`)).toBe(pagesRef);
  const catalog = add(`<< /Type /Catalog /Pages ${pagesRef} 0 R >>`);
  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n')];
  const offsets: number[] = [];
  let length = chunks[0].length;
  objects.forEach((body, i) => {
    offsets.push(length);
    const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), Buffer.from(body), Buffer.from('\nendobj\n')]);
    chunks.push(chunk);
    length += chunk.length;
  });
  const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  chunks.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${length}\n%%EOF\n`));
  return new Uint8Array(Buffer.concat(chunks));
}

const FULL = [612, 0, 0, 792, 0, 0];
const scanImage = { width: 850, height: 1100 };
const isInk = (g: Gray, x: number, y: number) => g.data[y * g.width + x] < 128;

describe('finding scanned pages', () => {
  it('reads a full-page image as the page, upright, with its resolution', async () => {
    const scan = await findScannedPages(pdf([{ draw: [{ img: scanImage, cm: FULL }] }]), 30_000);
    expect(scan).toMatchObject({ pages: 1, textChars: 0 });
    const [page] = scan.scanned;
    expect(page).toMatchObject({ page: 1, dpi: 100 });
    expect([page.gray.width, page.gray.height]).toEqual([850, 1100]);
    expect(isInk(page.gray, 5, 5)).toBe(true);
    expect(isInk(page.gray, 845, 5)).toBe(false);
  });

  it("turns a page the way its /Rotate shows it, and an image the way its transform draws it", async () => {
    // Rotate 90: the viewer turns the page clockwise, so the image's top-left corner shows top-right.
    const rotated = await findScannedPages(pdf([{ rotate: 90, draw: [{ img: scanImage, cm: FULL }] }]), 30_000);
    const g = rotated.scanned[0].gray;
    expect([g.width, g.height]).toEqual([1100, 850]);
    expect(isInk(g, 1095, 5)).toBe(true);
    expect(isInk(g, 5, 5)).toBe(false);

    // Drawn upside down by its own matrix.
    const flipped = await findScannedPages(pdf([{ draw: [{ img: scanImage, cm: [-612, 0, 0, -792, 612, 792] }] }]), 30_000);
    const f = flipped.scanned[0].gray;
    expect(isInk(f, 845, 1095)).toBe(true);
    expect(isInk(f, 5, 5)).toBe(false);
  });

  it('reads a stencil-mask scan as black on white', async () => {
    const scan = await findScannedPages(pdf([{ draw: [{ img: { ...scanImage, mask: true }, cm: FULL }] }]), 30_000);
    const g = scan.scanned[0].gray;
    expect(isInk(g, 5, 5)).toBe(true);
    expect(isInk(g, 400, 600)).toBe(false);
  });

  it('skips pages with a text layer, small images, and images covering less than half the page', async () => {
    const words = 'Rowan Q Testperson Senior Data Engineer Portland Oregon Kafka';
    const scan = await findScannedPages(
      pdf([
        { text: words, draw: [{ img: scanImage, cm: FULL }] }, // 50+ characters of text
        { draw: [{ img: { width: 500, height: 700 }, cm: FULL }] }, // short side under 600 px
        { draw: [{ img: scanImage, cm: [612, 0, 0, 390, 0, 0] }] }, // under half the page
        { draw: [{ img: scanImage, cm: FULL }] },
      ]),
      30_000,
    );
    expect(scan.textChars).toBe(words.replace(/\s/g, '').length);
    expect(scan.scanned.map((p) => p.page)).toEqual([4]);
  });

  it('reads three scanned pages at most', async () => {
    const scan = await findScannedPages(pdf(Array.from({ length: 5 }, () => ({ draw: [{ img: scanImage, cm: FULL }] }))), 30_000);
    expect(scan.pages).toBe(5);
    expect(scan.scanned.map((p) => p.page)).toEqual([1, 2, 3]);
  });

  it('averages a 600 dpi scan down to 300', async () => {
    const scan = await findScannedPages(pdf([{ size: [144, 144], draw: [{ img: { width: 1200, height: 1200 }, cm: [144, 0, 0, 144, 0, 0] }] }]), 30_000);
    expect(scan.scanned[0]).toMatchObject({ dpi: 300 });
    expect(scan.scanned[0].gray.width).toBe(600);
  });
});

describe('reading pages the right way up', () => {
  /** Reads a page well only when the black square is top-left, as when a person holds it upright. */
  function uprightOnly() {
    const turns: string[] = [];
    const engine: OcrEngine = {
      langs: 'eng',
      async recognize(image) {
        const header = new TextDecoder().decode(image.subarray(0, 20)).split('\n');
        const [w, h] = header[1].split(' ').map(Number);
        const pixels = image.subarray(image.length - w * h);
        const upright = pixels[5 * w + 5] < 128;
        turns.push(`${w}x${h}`);
        return upright
          ? { text: 'ROWAN Q. TESTPERSON\nrowan.testperson@example.com\n' + 'Designed a streaming ingestion platform. '.repeat(4), confidence: 91 }
          : { text: '~ ,:. 1l |; ~', confidence: 31 };
      },
      close: async () => {},
    };
    return { engine, turns };
  }

  it('tries a badly read page upside down and sideways, and keeps the reading that works', async () => {
    const { engine, turns } = uprightOnly();
    // Upright and read well: one read.
    expect(await ocrDocument(pdf([{ draw: [{ img: scanImage, cm: FULL }] }]), { engine })).toMatchObject({ status: 'OK', confidence: 91 });
    expect(turns).toHaveLength(1);

    // Scanned upside down, with nothing in the file to say so: read, then turned 180 degrees.
    turns.length = 0;
    const flippedBits = Buffer.alloc(Math.ceil(850 / 8) * 1100, 0xff);
    // The square moved to the bottom-right corner, pixel for pixel.
    const rowBytes = Math.ceil(850 / 8);
    for (let y = 1060; y < 1100; y++) for (let x = 810; x < 850; x++) flippedBits[y * rowBytes + (x >> 3)] &= ~(128 >> (x & 7));
    const r = await ocrDocument(pdf([{ draw: [{ img: { ...scanImage, data: flippedBits }, cm: FULL }] }]), { engine });
    expect(r).toMatchObject({ status: 'OK', confidence: 91, pages: 1 });
    expect(r.text).toContain('rowan.testperson@example.com');
    expect(turns).toEqual(['850x1100', '850x1100']); // as is, then 180

    // Sideways (a landscape image of a portrait page): 90 degrees is tried first.
    turns.length = 0;
    const sidewaysBits = Buffer.alloc(Math.ceil(1100 / 8) * 850, 0xff);
    const sideRow = Math.ceil(1100 / 8);
    // Turned 90 degrees counter-clockwise, the top-left square sits bottom-left.
    for (let y = 810; y < 850; y++) for (let x = 0; x < 40; x++) sidewaysBits[y * sideRow + (x >> 3)] &= ~(128 >> (x & 7));
    const s = await ocrDocument(pdf([{ size: [792, 612], draw: [{ img: { width: 1100, height: 850, data: sidewaysBits }, cm: [792, 0, 0, 612, 0, 0] }] }]), { engine });
    expect(s).toMatchObject({ status: 'OK' });
    expect(turns).toEqual(['1100x850', '850x1100']);
  });

  it('gives up on a page that reads badly every way: LOW_CONFIDENCE, with no text', async () => {
    const engine: OcrEngine = { langs: 'eng', recognize: async () => ({ text: 'garbled '.repeat(30), confidence: 34 }), close: async () => {} };
    const r = await ocrDocument(pdf([{ draw: [{ img: scanImage, cm: FULL }] }]), { engine });
    expect(r).toMatchObject({ status: 'LOW_CONFIDENCE', text: null, confidence: 34, error: 'low_confidence' });
  });

  it('reports a crash or a timeout as FAILED, with no document text in the error', async () => {
    const engine: OcrEngine = {
      langs: 'eng',
      recognize: async () => {
        throw new Error('RuntimeError: memory access out of bounds near rowan.testperson@example.com');
      },
      close: async () => {},
    };
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      const r = await ocrDocument(pdf([{ draw: [{ img: scanImage, cm: FULL }] }]), { engine });
      expect(r.status).toBe('FAILED');
      expect(r.error).toContain('memory access out of bounds');
      expect(r.error).not.toContain('rowan.testperson');
    } finally {
      console.error = original;
    }
    expect(JSON.stringify(errors)).not.toContain('rowan.testperson');
  });
});
