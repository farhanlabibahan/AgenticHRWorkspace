import type { OcrStatus } from '@prisma/client';
import { normalizeText } from '@/server/text/normalize';
import type { OcrEngine, Recognized } from './engine';
import { decodeBmp, imageInfo, rotate, toPgm, withReadableOrientation, type Gray, type QuarterTurn } from './image';
import { DOC_TEXT_LIMIT, MAX_IMAGE_PIXELS } from './pages';
import { findScannedPages, OcrTimeoutError } from './pages-host';
import { cleanOcrText, MIN_CONFIDENCE, passesGate, type PageReading } from './text';

/**
 * OCR for one stored resume: a scanned PDF's page images, or an image file,
 * through Tesseract, cleaned up and checked against the confidence bar.
 * Reports a status instead of throwing. Only the resume-ocr cron and the
 * self-test call it: never an application, which must stay fast.
 */

export { OCR_VERSION } from './status';
export { createOcrEngine, ocrLangs, type OcrEngine } from './engine';

export type OcrResult = {
  status: OcrStatus;
  /** Normalized text; non-null exactly when status is OK. */
  text: string | null;
  confidence: number | null;
  /** Pages (or images) read. */
  pages: number;
  /** An error code for SKIPPED, "<Name>: <message>" for FAILED; never document text. */
  error?: string;
  ms: number;
};

/** A page that reads this well isn't tried in other orientations. */
const UPRIGHT_ENOUGH = 70;
const DEFAULT_TIMEOUT_MS = 60_000;
/** The share of a file's time the page scan may take; the rest is for Tesseract. */
const SCAN_SHARE = 0.4;

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

/** Stored and logged, so never the applicant's address. */
function describeError(err: unknown): string {
  const e = err instanceof Error ? err : new Error(String(err));
  return `${e.name}: ${e.message}`.replace(EMAIL, '[email]').replace(/\s+/g, ' ').slice(0, 300);
}

class Deadline {
  constructor(private readonly at: number) {}
  left() {
    return this.at - Date.now();
  }
}

/**
 * Reads a page, and when it reads badly, reads it turned: a page scanned
 * upside down or sideways scored 29-37 and came out as garbage, and turned
 * the right way it scores like any other. Keeps the best reading.
 */
async function readPage(engine: OcrEngine, gray: Gray, dpi: number | null, deadline: Deadline): Promise<Recognized> {
  const read = (g: Gray) => engine.recognize(toPgm(g), { dpi, timeoutMs: deadline.left() });
  let best = await read(gray);
  // A landscape image of a portrait page is most likely on its side.
  const turns: QuarterTurn[] = gray.width > gray.height ? [90, 270, 180] : [180, 90, 270];
  for (const turn of turns) {
    if (best.confidence >= UPRIGHT_ENOUGH || deadline.left() < 1_000) break;
    const r = await read(rotate(gray, turn));
    if (r.confidence > best.confidence) best = r;
  }
  return best;
}

function finish(started: number, result: Omit<OcrResult, 'ms'>): OcrResult {
  return { ...result, ms: Date.now() - started };
}

export async function ocrDocument(
  data: Uint8Array,
  opts: { engine: OcrEngine; timeoutMs?: number; fileId?: string; source?: 'backfill' | 'selftest' },
): Promise<OcrResult> {
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = new Deadline(started + timeoutMs);
  const none = { text: null, confidence: null, pages: 0 };
  const readings: PageReading[] = [];

  try {
    const isPdf = new TextDecoder('latin1').decode(data.subarray(0, 1024)).includes('%PDF-');
    if (isPdf) {
      const scan = await findScannedPages(data, Math.round(timeoutMs * SCAN_SHARE));
      if (scan.textChars >= DOC_TEXT_LIMIT) return finish(started, { status: 'SKIPPED', ...none, error: 'has_text_layer' });
      if (!scan.scanned.length) return finish(started, { status: 'SKIPPED', ...none, error: 'no_scanned_pages' });
      for (const page of scan.scanned) {
        // Out of time with a page read: keep what there is rather than lose it all.
        if (readings.length && deadline.left() < 2_000) break;
        const r = await readPage(opts.engine, page.gray, page.dpi, deadline);
        readings.push({ text: cleanOcrText(r.text), confidence: r.confidence });
      }
    } else {
      const info = imageInfo(data);
      if (!info) return finish(started, { status: 'SKIPPED', ...none, error: 'unsupported' });
      if (info.type === 'heif') return finish(started, { status: 'SKIPPED', ...none, error: 'unsupported_image' });
      if (info.width && info.height && info.width * info.height > MAX_IMAGE_PIXELS) {
        return finish(started, { status: 'SKIPPED', ...none, error: 'too_large' });
      }
      let r: Recognized;
      if (info.type === 'bmp') {
        const gray = decodeBmp(data);
        if (!gray) return finish(started, { status: 'SKIPPED', ...none, error: 'unsupported_image' });
        r = await readPage(opts.engine, gray, null, deadline);
      } else {
        // Tesseract decodes the rest itself, and turns a JPEG upright from its EXIF.
        const bytes = info.type === 'jpeg' ? withReadableOrientation(data) : data;
        r = await opts.engine.recognize(bytes, { timeoutMs: deadline.left() });
      }
      readings.push({ text: cleanOcrText(r.text), confidence: r.confidence });
    }
  } catch (err) {
    const timedOut = err instanceof OcrTimeoutError;
    const error = describeError(err);
    const line = JSON.stringify({ source: opts.source, fileId: opts.fileId, error, ms: Date.now() - started, bytes: data.byteLength });
    if (timedOut) console.warn('[ocr] timeout', line);
    else console.error('[ocr] failed', line);
    // A timeout after a page was read still leaves that page.
    if (!readings.length) return finish(started, { status: 'FAILED', ...none, error });
  }

  const gate = passesGate(readings);
  const text = gate.ok ? normalizeText(gate.text) : null;
  return finish(started, {
    status: text ? 'OK' : 'LOW_CONFIDENCE',
    text,
    confidence: gate.confidence,
    pages: readings.length,
    ...(text ? {} : { error: readings.every((p) => p.confidence < MIN_CONFIDENCE) ? 'low_confidence' : 'too_little_text' }),
  });
}

export { runOcrSelfTest } from './selftest';
