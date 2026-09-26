/**
 * Legacy Word 97–2003 .doc to text, via word-extractor (MIT, pure JS). It is
 * loaded only when a .doc arrives. Its promise has been seen never to settle
 * on malformed input, so a timer bounds it.
 */
import { sniffFormat } from './sniff';
import { EncryptedDocumentError, type AdapterOutput } from './types';

const TIMEOUT_MS = 15_000;

export async function docToText(data: Uint8Array): Promise<AdapterOutput> {
  // word-extractor would return the encrypted bytes as garbage text.
  if (sniffFormat(data).reason === 'encrypted') throw new EncryptedDocumentError();
  const WordExtractor = (await import('word-extractor')).default;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`word-extractor did not finish in ${TIMEOUT_MS / 1000} s`)), TIMEOUT_MS);
  });
  try {
    const doc = await Promise.race([
      new WordExtractor().extract(Buffer.from(data.buffer, data.byteOffset, data.byteLength)),
      timeout,
    ]);
    // filterUnicode: false keeps smart quotes and dashes as written.
    const o = { filterUnicode: false };
    const text = [
      doc.getHeaders({ ...o, includeFooters: false }),
      doc.getBody(o),
      doc.getTextboxes(o),
      doc.getFootnotes(o),
      doc.getEndnotes(o),
      doc.getFooters(o),
    ]
      .map((s) => s.trim())
      .filter(Boolean)
      .join('\n');
    // .doc hyperlinks are field codes, which word-extractor drops: only visible URLs survive, in the text.
    return { text, links: [] };
  } finally {
    clearTimeout(timer);
  }
}
