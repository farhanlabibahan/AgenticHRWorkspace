import { createRequire } from 'node:module';
import path from 'node:path';
import { isMainThread } from 'node:worker_threads';
import { downscale, grayFromPdfImage, orient, type Gray, type PdfImage } from './image';

/**
 * The scanned pages of a PDF, as grayscale rasters, without rendering: a
 * scan is one big image per page, so the pixels pdf.js decodes for that
 * image are the page. The operator list says which images a page paints and
 * where (the transform in force at each paint), and page.objs has their
 * decoded pixels.
 *
 * This uses pdfjs-dist's own build, not the one unpdf bundles for text
 * extraction: unpdf's serverless build stubs out pdf.js's WebAssembly image
 * decoders, so every CCITT fax, JBIG2 and JPEG 2000 image (what office
 * scanners and fax services write) failed with "JBig2 failed to
 * initialize". pdfjs-dist loads them from its wasm/ folder.
 */

/** Pages OCR reads at most: a resume is one or two. */
export const MAX_OCR_PAGES = 3;
/** Pages looked at for scans before giving up (their text layers are counted too). */
export const MAX_EXAMINED_PAGES = 10;
/** A page with this much text layer is text, whatever images it paints. */
export const PAGE_TEXT_LIMIT = 50;
/** A document with this much text layer is not a scan. */
export const DOC_TEXT_LIMIT = 200;
/** A scan's image: its short side in pixels, and how much of the page it covers. */
export const MIN_SHORT_SIDE = 600;
export const MIN_COVERAGE = 0.5;
/** pdf.js won't decode an image with more pixels (a 600 dpi letter page is 34 million). */
export const MAX_IMAGE_PIXELS = 40_000_000;
/** Past this resolution a page is averaged down toward 300 dpi before OCR. */
const DOWNSCALE_ABOVE_DPI = 450;

export type PageStats = { textChars: number; image: { width: number; height: number; coverage: number } | null };

/**
 * The rule for a scanned page: next to no text layer, and one image that
 * covers at least half the page with enough pixels to read.
 */
export function pageQualifies(p: PageStats): boolean {
  if (p.textChars >= PAGE_TEXT_LIMIT || !p.image) return false;
  return Math.min(p.image.width, p.image.height) >= MIN_SHORT_SIDE && p.image.coverage >= MIN_COVERAGE;
}

export type ScannedPage = {
  /** 1-based. */
  page: number;
  gray: Gray;
  /** The image's resolution on the page after any downscale, when the page says it. */
  dpi: number | null;
};

export type PdfScan = {
  pages: number;
  /** Non-whitespace characters in the text layers of the pages looked at. */
  textChars: number;
  scanned: ScannedPage[];
};

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** m1 then m2, in pdf.js's (and PDF's) row-vector convention. */
export function multiply(m2: Matrix, m1: Matrix): Matrix {
  return [
    m2[0] * m1[0] + m2[2] * m1[1],
    m2[1] * m1[0] + m2[3] * m1[1],
    m2[0] * m1[2] + m2[2] * m1[3],
    m2[1] * m1[2] + m2[3] * m1[3],
    m2[0] * m1[4] + m2[2] * m1[5] + m2[4],
    m2[1] * m1[4] + m2[3] * m1[5] + m2[5],
  ];
}

/**
 * The share of the page (x0, y0, x1, y1 in user space) that an image drawn
 * with `ctm` covers: the unit square's bounding box, clipped to the page.
 */
export function coverage(ctm: Matrix, view: number[]): number {
  const pts = [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ].map(([u, v]) => [ctm[0] * u + ctm[2] * v + ctm[4], ctm[1] * u + ctm[3] * v + ctm[5]]);
  const [vx0, vy0, vx1, vy1] = [Math.min(view[0], view[2]), Math.min(view[1], view[3]), Math.max(view[0], view[2]), Math.max(view[1], view[3])];
  const x0 = Math.max(vx0, Math.min(...pts.map((p) => p[0])));
  const x1 = Math.min(vx1, Math.max(...pts.map((p) => p[0])));
  const y0 = Math.max(vy0, Math.min(...pts.map((p) => p[1])));
  const y1 = Math.min(vy1, Math.max(...pts.map((p) => p[1])));
  const page = (vx1 - vx0) * (vy1 - vy0);
  return page > 0 && x1 > x0 && y1 > y0 ? ((x1 - x0) * (y1 - y0)) / page : 0;
}

let dataDir: string | null | undefined;

/** pdfjs-dist's folder, found from the working directory as in src/server/text/pdf.ts. */
function pdfjsDir(): string | null {
  if (dataDir === undefined) {
    try {
      dataDir = path.dirname(createRequire(path.join(process.cwd(), 'package.json')).resolve('pdfjs-dist/package.json'));
    } catch {
      dataDir = null;
    }
  }
  return dataDir;
}

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let loading: Promise<PdfJs> | undefined;

/**
 * The 2D part of DOMMatrix, which pdf.js's Node build otherwise takes from
 * @napi-rs/canvas, a native package only rendering needs and this function
 * doesn't ship. Without one, pdf.js fails to load at all ("DOMMatrix is not
 * defined": it builds one at load). Parsing uses it only to outline Type3
 * glyphs; nothing here renders.
 */
export class Matrix2D {
  a = 1;
  b = 0;
  c = 0;
  d = 1;
  e = 0;
  f = 0;
  constructor(init?: ArrayLike<number>) {
    if (init && init.length === 6) [this.a, this.b, this.c, this.d, this.e, this.f] = Array.from(init);
  }
  private set(m: Matrix) {
    [this.a, this.b, this.c, this.d, this.e, this.f] = m;
    return this;
  }
  private get m(): Matrix {
    return [this.a, this.b, this.c, this.d, this.e, this.f];
  }
  /** this x other: `other` applies first. */
  multiplySelf(other: Matrix2D) {
    return this.set(multiply(this.m, other.m));
  }
  preMultiplySelf(other: Matrix2D) {
    return this.set(multiply(other.m, this.m));
  }
  translateSelf(tx = 0, ty = 0) {
    return this.multiplySelf(new Matrix2D([1, 0, 0, 1, tx, ty]));
  }
  scaleSelf(sx = 1, sy = sx) {
    return this.multiplySelf(new Matrix2D([sx, 0, 0, sy, 0, 0]));
  }
  invertSelf() {
    const det = this.a * this.d - this.b * this.c;
    if (!det) return this.set([NaN, NaN, NaN, NaN, NaN, NaN]);
    const [a, b, c, d, e, f] = this.m;
    return this.set([d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det]);
  }
}

/**
 * pdfjs-dist, with its "fake worker" in this thread (this module runs in a
 * worker thread of its own; see pages-host.ts). It gets Matrix2D as DOMMatrix,
 * and its warning that @napi-rs/canvas can't be loaded is dropped. Run
 * in-process (tests, a failed spawn), the stand-in is removed again once
 * pdf.js has loaded, so nothing else in the server sees it.
 */
function loadPdfjs(): Promise<PdfJs> {
  loading ??= (async () => {
    const g = globalThis as { DOMMatrix?: unknown; pdfjsWorker?: unknown };
    const stubbed = !g.DOMMatrix;
    if (stubbed) g.DOMMatrix = Matrix2D;
    const warn = console.warn;
    console.warn = (...args: unknown[]) => {
      if (typeof args[0] === 'string' && /^Warning: Cannot (load "@napi-rs\/canvas"|polyfill `Path2D`)/.test(args[0])) return;
      warn(...args);
    };
    try {
      g.pdfjsWorker ??= await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
      return await import('pdfjs-dist/legacy/build/pdf.mjs');
    } finally {
      console.warn = warn;
      if (stubbed && isMainThread) delete g.DOMMatrix;
    }
  })();
  return loading;
}

type Candidate = { id: string; mask: boolean; width: number; height: number; ctm: Matrix; coverage: number };

/**
 * Walks a page's operator list for the images it paints, tracking the
 * transform (save/restore, cm, and form XObjects' matrices).
 */
function paintedImages(pdfjs: PdfJs, ops: { fnArray: number[]; argsArray: unknown[] }, view: number[]): Candidate[] {
  const { OPS } = pdfjs;
  const stack: Matrix[] = [];
  let ctm: Matrix = IDENTITY;
  const found: Candidate[] = [];
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i] as unknown[] | null;
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() ?? IDENTITY;
    else if (fn === OPS.transform) ctm = multiply(ctm, Array.from(args as number[]) as Matrix);
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      const m = args?.[0] as number[] | null | undefined;
      if (m && m.length === 6) ctm = multiply(ctm, Array.from(m) as Matrix);
    } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? IDENTITY;
    else if (fn === OPS.paintImageXObject) {
      const [id, width, height] = args as [string, number, number];
      found.push({ id, mask: false, width, height, ctm, coverage: coverage(ctm, view) });
    } else if (fn === OPS.paintImageMaskXObject) {
      const img = args?.[0] as { data?: unknown; width: number; height: number } | undefined;
      if (img && typeof img.data === 'string') found.push({ id: img.data, mask: true, width: img.width, height: img.height, ctm, coverage: coverage(ctm, view) });
    }
  }
  return found;
}

/** The decoded pixels behind an image id: document-wide ones start with "g_". */
function objectData(page: { objs: Objs; commonObjs: Objs }, id: string, timeoutMs: number): Promise<PdfImage | null> {
  const store = id.startsWith('g_') ? page.commonObjs : page.objs;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    store.get(id, (data: unknown) => {
      clearTimeout(timer);
      resolve((data as PdfImage | null) ?? null);
    });
  });
}
type Objs = { get(id: string, callback: (data: unknown) => void): unknown };

/**
 * Up to MAX_OCR_PAGES scanned pages of a PDF, upright and near 300 dpi.
 * Throws on a PDF pdf.js can't open.
 */
export async function scanPdf(data: Uint8Array): Promise<PdfScan> {
  const pdfjs = await loadPdfjs();
  const dir = pdfjsDir();
  // Options as in src/server/text/pdf.ts, plus the WebAssembly decoders and a
  // pixel cap. pdf.js detaches the buffer it's given, so it gets a copy.
  const task = pdfjs.getDocument({
    data: new Uint8Array(data),
    useSystemFonts: true,
    disableFontFace: true,
    maxImageSize: MAX_IMAGE_PIXELS,
    verbosity: 0,
    ...(dir
      ? { cMapUrl: `${dir}/cmaps/`, cMapPacked: true, standardFontDataUrl: `${dir}/standard_fonts/`, wasmUrl: `${dir}/wasm/` }
      : {}),
  });
  try {
    const doc = await task.promise;
    const result: PdfScan = { pages: doc.numPages, textChars: 0, scanned: [] };
    for (let n = 1; n <= Math.min(doc.numPages, MAX_EXAMINED_PAGES) && result.scanned.length < MAX_OCR_PAGES; n++) {
      const page = await doc.getPage(n);
      const text = await page.getTextContent();
      const textChars = text.items.reduce((sum, item) => sum + ('str' in item ? item.str.replace(/\s+/g, '').length : 0), 0);
      result.textChars += textChars;
      if (result.textChars >= DOC_TEXT_LIMIT) break; // a text document: nothing to OCR
      if (textChars >= PAGE_TEXT_LIMIT) continue;

      const view = page.view;
      const images = paintedImages(pdfjs, await page.getOperatorList(), view);
      const best = images.filter((image) => pageQualifies({ textChars, image })).sort((a, b) => b.coverage - a.coverage)[0];
      if (!best) {
        page.cleanup();
        continue;
      }
      const decoded = await objectData(page, best.id, 30_000);
      let gray = decoded ? grayFromPdfImage(decoded, best.mask) : null;
      page.cleanup();
      if (!gray) continue;

      // How the image shows on screen: the page's rotation and the image's own transform.
      const m = multiply(page.getViewport({ scale: 1 }).transform as Matrix, best.ctm);
      gray = orient(gray, [m[0], m[1]], [-m[2], -m[3]]);
      // Its resolution: pixels across over inches across (72 points each).
      const inches = Math.hypot(m[0], m[1]) / 72;
      let dpi = inches > 0 ? decoded!.width / inches : null;
      if (dpi && dpi > DOWNSCALE_ABOVE_DPI) {
        const factor = Math.round(dpi / 300);
        gray = downscale(gray, factor);
        dpi /= factor;
      }
      result.scanned.push({ page: n, gray, dpi: dpi && dpi >= 70 && dpi <= 2400 ? Math.round(dpi) : null });
    }
    return result;
  } finally {
    await task.destroy();
  }
}
