import { Worker } from 'node:worker_threads';
import type { PdfScan } from './pages';

/**
 * Finds a PDF's scanned pages in a worker thread of its own, so the image
 * decoding pdf.js does synchronously (up to 40 megapixels a page) never holds
 * this thread, which on a self-hosted server also serves the careers page,
 * and a file that takes too long is stopped. One short-lived worker per
 * file; the resume-ocr cron reads a handful of files a run. TEXT_EXTRACT_WORKER=0
 * (and a failed spawn) runs it in-process instead, as for text extraction.
 */

export class OcrTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OcrTimeoutError';
  }
}

const HEAP_LIMIT_MB = 512;

/** The exact shape Turbopack bundles a worker from; see src/server/text/host.ts. */
function startWorker(): Worker {
  return new Worker(new URL('./pages.worker.ts', import.meta.url), {
    workerData: { ocrPages: true },
    resourceLimits: { maxOldGenerationSizeMb: HEAP_LIMIT_MB },
  });
}

let lastMode: 'thread' | 'in-process' = 'thread';
/** How the last scan ran, for the self-test's report. */
export const pagesMode = () => (process.env.TEXT_EXTRACT_WORKER === '0' ? 'in-process' : lastMode);

async function inProcess(data: Uint8Array, timeoutMs: number): Promise<PdfScan> {
  const { scanPdf } = await import('./pages');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new OcrTimeoutError(`No scanned pages after ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    return await Promise.race([scanPdf(data), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function findScannedPages(data: Uint8Array, timeoutMs: number): Promise<PdfScan> {
  if (process.env.TEXT_EXTRACT_WORKER === '0') return inProcess(data, timeoutMs);
  let worker: Worker;
  try {
    worker = startWorker();
    lastMode = 'thread';
  } catch (err) {
    lastMode = 'in-process';
    console.warn('[ocr] worker unavailable, reading pages in-process:', err instanceof Error ? err.message : err);
    return inProcess(data, timeoutMs);
  }
  worker.unref();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<PdfScan>((resolve, reject) => {
      timer = setTimeout(() => reject(new OcrTimeoutError(`No scanned pages after ${timeoutMs} ms`)), timeoutMs);
      type Reply = { ok: true; scan: PdfScan } | { ok: false; name: string; message: string };
      worker.once('message', (msg: Reply) => {
        if (msg.ok) return resolve(msg.scan);
        const err = new Error(msg.message);
        err.name = msg.name;
        reject(err);
      });
      worker.once('error', (err: Error & { code?: string }) =>
        reject(err.code === 'ERR_WORKER_OUT_OF_MEMORY' ? Object.assign(new Error(`Out of heap (${HEAP_LIMIT_MB} MB)`), { name: 'MemoryLimitError' }) : err),
      );
      worker.once('exit', (code) => reject(Object.assign(new Error(`The worker exited with code ${code}`), { name: 'WorkerCrashError' })));
      // Transfer a copy: the caller's buffer stays usable.
      const copy = new Uint8Array(data);
      worker.postMessage({ data: copy }, [copy.buffer]);
    });
  } finally {
    clearTimeout(timer);
    await worker.terminate().catch(() => undefined);
  }
}
