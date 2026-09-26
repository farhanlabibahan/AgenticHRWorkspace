import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { docToText } from './doc';
import { docxToText } from './docx';
import { htmlToText } from './html';
import { normalizeLinks, normalizeText } from './normalize';
import { odtToText } from './odt';
import { pdfToText } from './pdf';
import { rtfToText } from './rtf';
import { txtToText } from './txt';
import type { Adapter, TextFormat } from './types';

/**
 * The extraction worker (see host.ts). The same module is the in-process
 * fallback: host.ts imports runAdapter from it when threads are unavailable,
 * so both paths dispatch and normalize identically.
 */

const ADAPTERS: Record<TextFormat, Adapter> = {
  pdf: pdfToText,
  docx: docxToText,
  doc: docToText,
  odt: odtToText,
  rtf: rtfToText,
  txt: txtToText,
  html: htmlToText,
};

export type JobOutput = { text: string | null; links: string[]; pages?: number };

/** Normalizing here keeps the main thread from ever handling megabytes of raw text. */
export async function runAdapter(format: TextFormat, data: Uint8Array): Promise<JobOutput> {
  const out = await ADAPTERS[format](data);
  return { text: normalizeText(out.text), links: normalizeLinks(out.links), pages: out.pages };
}

// Only answer messages when host.ts started us: imported in-process, or by a
// test runner's own worker thread, this module must stay passive.
if (!isMainThread && (workerData as { textExtract?: boolean } | null)?.textExtract === true) {
  const port = parentPort!;
  port.on('message', async ({ id, format, data }: { id: number; format: TextFormat; data: Uint8Array }) => {
    try {
      port.postMessage({ id, ok: true, ...(await runAdapter(format, data)) });
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      port.postMessage({ id, ok: false, name: e.name, message: e.message });
    }
  });
}
