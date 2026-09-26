import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { scanPdf } from './pages';

/**
 * The worker thread that finds a PDF's scanned pages (see pages-host.ts). It
 * answers one message, then exits when the host terminates it.
 */

// Only when pages-host.ts started us: imported in-process, or by a test
// runner's own worker thread, this module must stay passive.
if (!isMainThread && (workerData as { ocrPages?: boolean } | null)?.ocrPages === true) {
  const port = parentPort!;
  port.once('message', async ({ data }: { data: Uint8Array }) => {
    try {
      const scan = await scanPdf(data);
      // Hand the pixels over rather than copying them.
      port.postMessage({ ok: true, scan }, scan.scanned.map((p) => p.gray.data.buffer as ArrayBuffer));
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      port.postMessage({ ok: false, name: e.name, message: e.message });
    }
  });
}
