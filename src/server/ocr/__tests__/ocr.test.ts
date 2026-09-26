import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createOcrEngine, ocrDocument, runOcrSelfTest } from '@/server/ocr';
import { findScannedPages } from '@/server/ocr/pages-host';

/**
 * Real Tesseract on the committed fixtures (make-ocr-fixtures.py): a fictional
 * resume scanned to a bilevel CCITT image in a PDF with no text layer, and a
 * phone photo of its header as a JPEG.
 */

const fixture = (name: string) => readFileSync(path.join(__dirname, 'fixtures', name));

describe('OCR with Tesseract', () => {
  const engine = createOcrEngine({ langs: ['eng'] });
  afterAll(() => engine.close());

  it('reads a scanned PDF: the name, the words and the email address', async () => {
    const r = await ocrDocument(fixture('scan-letter.pdf'), { engine });
    expect(r).toMatchObject({ status: 'OK', pages: 1 });
    expect(r.confidence).toBeGreaterThanOrEqual(80);
    expect(r.text).toContain('ROWAN Q. TESTPERSON');
    expect(r.text).toContain('Senior Data Engineer');
    // "rowan. testperson@…" as Tesseract reads the speck of a dot, rejoined.
    expect(r.text).toContain('rowan.testperson@example.com');
    expect(r.text).toContain('linkedin.com/in/rowan-testperson');
    expect(r.text).toContain('Designed a streaming ingestion platform processing 40 million shipment events a day.');
    // Bullets and rules are dropped, not read as words.
    expect(r.text).not.toMatch(/^[-|]/m);
  });

  it('decodes CCITT page images, which the pdf.js bundled with unpdf cannot', async () => {
    const scan = await findScannedPages(fixture('scan-letter.pdf'), 30_000);
    expect(scan).toMatchObject({ pages: 1, textChars: 0 });
    expect(scan.scanned).toHaveLength(1);
    const [page] = scan.scanned;
    expect(page).toMatchObject({ page: 1, dpi: 300 });
    expect([page.gray.width, page.gray.height]).toEqual([2550, 1650]);
    // Paper, not ink: the polarity is right.
    const dark = page.gray.data.reduce((n, v) => n + (v < 128 ? 1 : 0), 0);
    expect(dark / page.gray.data.length).toBeLessThan(0.1);
  });

  it('reads an image file (a phone photo)', async () => {
    const r = await ocrDocument(fixture('scan-photo.jpg'), { engine });
    expect(r).toMatchObject({ status: 'OK', pages: 1 });
    expect(r.text).toContain('rowan.testperson@example.com');
    expect(r.text).toContain('TESTPERSON');
  });

  it('skips a PDF with a text layer, and what is not a PDF or an image', async () => {
    const textPdf = readFileSync(path.join(__dirname, '../../text/__tests__/fixtures/resume.pdf'));
    expect(await ocrDocument(textPdf, { engine })).toMatchObject({ status: 'SKIPPED', error: 'has_text_layer', text: null });
    expect(await ocrDocument(Buffer.from('plain text, not a scan'), { engine })).toMatchObject({ status: 'SKIPPED', error: 'unsupported' });
  });

  it('passes its self-test', async () => {
    const r = await runOcrSelfTest(engine);
    expect(r).toMatchObject({ ok: true, status: 'OK', missing: [], langs: 'eng' });
  });
});
