import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { Worker as TesseractWorker } from 'tesseract.js';
import { OcrTimeoutError } from './pages-host';

/**
 * Tesseract (tesseract.js 7, Apache-2.0): OCR compiled to WebAssembly, run in
 * a worker thread tesseract.js starts. No model service, no API key, and no
 * download: the language data ships in node_modules
 * (@tesseract.js-data/<lang>, the 4.0.0_best_int models), so a self-hosted
 * server reads scans exactly as the hosted one does.
 *
 * Worker options, and why:
 * - langPath: a local folder. The default downloads from a CDN.
 * - cacheMethod 'none': the default writes ./eng.traineddata, and Vercel's
 *   working directory is read-only.
 * - errorHandler: without one, a failed job is thrown as an uncaught
 *   exception.
 * - OEM LSTM_ONLY. tesseract.js 7.0.0 in Node compares a boolean with OEM
 *   values when it picks a core, so it always loads the full (non-LSTM-only)
 *   core; next.config.ts traces those files.
 * - Page segmentation AUTO. tesseract.js defaults to SINGLE_BLOCK, which
 *   dropped a resume's name set in large type above the rest.
 *
 * OCR_LANGS picks the languages ("eng", or "eng+fra"); each needs its package
 * installed. See docs/03-architecture.md.
 */

export type Recognized = { text: string; confidence: number };

export type OcrEngine = {
  readonly langs: string;
  /** Reads one image (PGM, PNG, JPEG, WebP, GIF, TIFF). A timeout kills the worker; the next call starts another. */
  recognize(image: Uint8Array, opts: { dpi?: number | null; timeoutMs: number }): Promise<Recognized>;
  close(): Promise<void>;
};

const LANG = /^[a-z]{3}(?:_[a-z]+)?$/i;
const MODEL = '4.0.0_best_int';

/** OCR_LANGS as Tesseract language codes. Anything malformed falls back to English. */
export function ocrLangs(env: Record<string, string | undefined> = process.env): string[] {
  const langs = (env.OCR_LANGS ?? '')
    .split(/[+,\s]+/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!langs.length || !langs.every((l) => LANG.test(l))) return ['eng'];
  return [...new Set(langs)];
}

/** Resolved from the working directory, as src/server/text/pdf.ts finds pdfjs-dist. */
const appRequire = () => createRequire(path.join(process.cwd(), 'package.json'));

/**
 * The folder holding every language's <lang>.traineddata.gz. One language is
 * read where npm put it; several are copied side by side into the temp
 * directory once (the only writable place on Vercel), since tesseract.js
 * takes one folder.
 */
export function languageFolder(langs: string[]): string {
  const files = langs.map((lang) => {
    let dir: string;
    try {
      dir = path.dirname(appRequire().resolve(`@tesseract.js-data/${lang}/package.json`));
    } catch {
      throw new Error(`OCR_LANGS: "${lang}" isn't installed (npm install @tesseract.js-data/${lang}@1.0.0)`);
    }
    const file = path.join(dir, MODEL, `${lang}.traineddata.gz`);
    if (!existsSync(file)) throw new Error(`OCR_LANGS: ${path.relative(process.cwd(), file)} is missing`);
    return file;
  });
  if (files.length === 1) return path.dirname(files[0]);
  const dir = path.join(os.tmpdir(), 'source-ocr-langs');
  mkdirSync(dir, { recursive: true });
  for (const file of files) {
    const to = path.join(dir, path.basename(file));
    if (!existsSync(to)) copyFileSync(file, to);
  }
  return dir;
}

/**
 * The modules tesseract.js's worker thread loads. The worker is started from
 * a path, so file tracing sees its entry but not what it requires (a build
 * failed with "Cannot find module 'tesseract.js-core/tesseract-core-relaxedsimd'"),
 * and a module missing there is an 'error' on a Worker nobody listens to: an
 * uncaught exception. Checking first turns it into an ordinary error.
 */
const WORKER_MODULES = [
  'tesseract.js/src/worker-script/node/index.js',
  'tesseract.js-core/tesseract-core.js',
  'tesseract.js-core/tesseract-core-simd.js',
  'tesseract.js-core/tesseract-core-relaxedsimd.js',
  'regenerator-runtime/runtime',
  'is-url',
  'bmp-js',
  'wasm-feature-detect',
];

function checkInstall() {
  const req = appRequire();
  const tesseractDir = path.dirname(req.resolve('tesseract.js/package.json'));
  const fromTesseract = createRequire(path.join(tesseractDir, 'package.json'));
  for (const id of WORKER_MODULES) {
    try {
      const file = fromTesseract.resolve(id);
      if (file.endsWith('.js') && id.startsWith('tesseract.js-core/') && !existsSync(file.replace(/\.js$/, '.wasm'))) {
        throw new Error(`${id.replace(/\.js$/, '.wasm')} is missing`);
      }
    } catch (err) {
      throw new Error(`OCR is not installed completely: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
    }
  }
}

function timeout(ms: number): { promise: Promise<never>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new OcrTimeoutError(`No OCR result after ${ms} ms`)), ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

/** tesseract.js rejects with strings. */
function asError(err: unknown): Error {
  if (err instanceof Error) return err;
  const e = new Error(String(err));
  e.name = 'TesseractError';
  return e;
}

export function createOcrEngine(opts: { langs?: string[]; startTimeoutMs?: number } = {}): OcrEngine {
  const langs = opts.langs ?? ocrLangs();
  let worker: Promise<TesseractWorker> | null = null;

  async function start(): Promise<TesseractWorker> {
    checkInstall();
    const langPath = languageFolder(langs);
    const { createWorker, OEM, PSM } = await import('tesseract.js');
    const w = await createWorker(langs, OEM.LSTM_ONLY, { langPath, gzip: true, cacheMethod: 'none', errorHandler: () => {} });
    // debug_file: Tesseract's progress chatter ("Estimating resolution as …") goes nowhere.
    await w.setParameters({ tessedit_pageseg_mode: PSM.AUTO, debug_file: '/dev/null' });
    return w;
  }

  async function stop() {
    const w = worker;
    worker = null;
    await w?.then((x) => x.terminate()).catch(() => undefined);
  }

  return {
    langs: langs.join('+'),
    async recognize(image, { dpi, timeoutMs }) {
      if (!worker) {
        worker = start();
        // A failed start is retried by the next call.
        worker.catch(() => (worker = null));
      }
      const limit = timeout(Math.max(timeoutMs, 1));
      try {
        const w = await Promise.race([worker, limit.promise]).catch((err) => {
          throw asError(err);
        });
        // Buffer: what tesseract.js's loadImage accepts as bytes.
        // Tesseract parameters for this call only; the typings list just tesseract.js's own options.
        const params = (dpi ? { user_defined_dpi: String(dpi) } : {}) as Parameters<TesseractWorker['recognize']>[1];
        const result = await Promise.race([w.recognize(Buffer.from(image.buffer, image.byteOffset, image.byteLength), params), limit.promise]);
        return { text: result.data.text ?? '', confidence: result.data.confidence ?? 0 };
      } catch (err) {
        // A job still running (or a worker stuck starting) is stopped rather than waited for.
        if (err instanceof OcrTimeoutError) await stop();
        throw asError(err);
      } finally {
        limit.cancel();
      }
    },
    close: stop,
  };
}
