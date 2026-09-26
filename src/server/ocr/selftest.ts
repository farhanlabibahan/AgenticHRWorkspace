import { createOcrEngine, type OcrEngine } from './engine';
import { ocrDocument } from './index';
import { pagesMode } from './pages-host';
import { SCANNED_RESUME_PDF } from './selftest-fixture';

/**
 * OCRs a small built-in scan (a fictional resume, CCITT-compressed in a PDF
 * with no text layer) and checks what came back, without touching the
 * database. It proves the deployed bundle has everything OCR loads at run
 * time: pdfjs-dist and its WebAssembly image decoders, the page worker,
 * Tesseract's core (.js and .wasm) and the language data. The resume-ocr
 * cron runs it before claiming files, so a broken deploy doesn't burn their
 * attempts.
 */

/** Words the fixture must come back with; the address checks the cleanup too. */
const EXPECT = ['TESTPERSON', 'Senior Data Engineer', 'rowan.testperson@example.com', 'linkedin.com/in/rowan-testperson', 'streaming ingestion platform'];

export type OcrSelfTest = {
  ok: boolean;
  status: string;
  confidence: number | null;
  /** Expected phrases that were read. */
  found: number;
  expected: number;
  missing: string[];
  langs: string;
  pagesWorker: 'thread' | 'in-process';
  ms: number;
  error?: string;
};

export async function runOcrSelfTest(engine?: OcrEngine): Promise<OcrSelfTest> {
  const own = engine ? null : createOcrEngine();
  const e = engine ?? own!;
  try {
    const r = await ocrDocument(Buffer.from(SCANNED_RESUME_PDF, 'base64'), { engine: e, source: 'selftest', timeoutMs: 60_000 });
    const text = r.text ?? '';
    const missing = EXPECT.filter((phrase) => !text.includes(phrase));
    return {
      ok: r.status === 'OK' && !missing.length,
      status: r.status,
      confidence: r.confidence,
      found: EXPECT.length - missing.length,
      expected: EXPECT.length,
      missing,
      langs: e.langs,
      pagesWorker: pagesMode(),
      ms: r.ms,
      ...(r.error ? { error: r.error } : {}),
    };
  } finally {
    await own?.close();
  }
}
