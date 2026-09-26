import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EXTRACTOR_VERSION,
  extractText,
  FORMAT_EXT,
  FORMAT_MIME,
  MAX_EXTRACT_BYTES,
  RESUME_UPLOAD_FORMATS,
  runSelfTest,
  textFields,
} from '@/server/text';
import { sniffFormat } from '@/server/text/sniff';
import { MAX_TEXT_ATTEMPTS, textPending } from '@/server/text/status';
import { txtToText } from '@/server/text/txt';
import { DocumentLimitError, EncryptedDocumentError, type AdapterOutput } from '@/server/text/types';

// Real sniffing and adapters (in-process: tests/setup.ts sets TEXT_EXTRACT_WORKER=0),
// wrapped in spies so a test can make one misbehave.
vi.mock('@/server/text/sniff', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/text/sniff')>();
  return { ...actual, sniffFormat: vi.fn(actual.sniffFormat) };
});
vi.mock('@/server/text/txt', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/text/txt')>();
  return { ...actual, txtToText: vi.fn(actual.txtToText) };
});

const bytes = (s: string) => new TextEncoder().encode(s);
const RESUME = 'Rowan Q. Testperson\nrowan.testperson@example.test\nSenior engineer, r\u00e9sum\u00e9 attached\n';

afterEach(() => {
  vi.mocked(txtToText).mockClear();
  vi.mocked(sniffFormat).mockClear();
  vi.restoreAllMocks();
});

describe('extractText', () => {
  it('extracts and normalizes text', async () => {
    const r = await extractText({ data: bytes(`\ufeff${RESUME}\r\n\r\n\r\n\u00a0`), source: 'apply' });
    expect(r).toMatchObject({ status: 'OK', format: 'txt', links: [], version: EXTRACTOR_VERSION });
    expect(r.text).toBe(RESUME.trim());
    expect(r.ms).toBeGreaterThanOrEqual(0);
  });

  it('reports EMPTY for no bytes or no readable text', async () => {
    expect(await extractText({ data: new Uint8Array(0), source: 'import' })).toMatchObject({ status: 'EMPTY', format: null, text: null });
    vi.mocked(txtToText).mockReturnValueOnce({ text: '\u200b \u0000\n', links: ['https://example.test/'] });
    const blank = await extractText({ data: bytes('readable to the sniffer'), source: 'import' });
    expect(blank).toMatchObject({ status: 'EMPTY', format: 'txt', text: null });
  });

  it('reports UNSUPPORTED for formats it does not read', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
    expect(await extractText({ data: png, source: 'apply' })).toMatchObject({ status: 'UNSUPPORTED', format: null, text: null });
    const elf = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0x3e, 0]);
    expect(await extractText({ data: elf, source: 'apply' })).toMatchObject({ status: 'UNSUPPORTED' });
  });

  it('reports ENCRYPTED from the sniffer or the adapter', async () => {
    vi.mocked(sniffFormat).mockReturnValueOnce({ format: null, reason: 'encrypted' });
    expect(await extractText({ data: bytes('x'), source: 'import' })).toMatchObject({ status: 'ENCRYPTED', text: null });
    vi.mocked(txtToText).mockImplementationOnce(() => {
      throw new EncryptedDocumentError();
    });
    const r = await extractText({ data: bytes(RESUME), source: 'import' });
    expect(r).toMatchObject({ status: 'ENCRYPTED', format: 'txt', text: null, error: 'EncryptedDocumentError: The document is password-protected' });
  });

  it('reports TOO_LARGE without parsing, and for documents that trip a safety limit', async () => {
    const huge = new Uint8Array(MAX_EXTRACT_BYTES + 1).fill(0x61); // valid text, if it were read
    expect(await extractText({ data: huge, source: 'backfill' })).toMatchObject({ status: 'TOO_LARGE', format: null, text: null });
    expect(sniffFormat).not.toHaveBeenCalled();
    expect(txtToText).not.toHaveBeenCalled();

    vi.mocked(txtToText).mockImplementationOnce(() => {
      throw new DocumentLimitError('Entry inflates past 50 MB');
    });
    expect(await extractText({ data: bytes(RESUME), source: 'import' })).toMatchObject({
      status: 'TOO_LARGE',
      error: 'DocumentLimitError: Entry inflates past 50 MB',
    });
  });

  it('reports FAILED with a short, address-free error, logs it, and never throws', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(txtToText).mockImplementationOnce(() => {
      throw new TypeError(`Bad byte near "Contact: rowan.testperson@example.test"${' and more'.repeat(100)}`);
    });
    const r = await extractText({ data: bytes(RESUME), source: 'backfill', fileId: 'file_1' });
    expect(r).toMatchObject({ status: 'FAILED', format: 'txt', text: null, links: [] });
    expect(r.error).toMatch(/^TypeError: Bad byte near "Contact: \[email\]" and more/);
    expect(r.error!.length).toBeLessThanOrEqual(300);
    expect(r.error).not.toContain('@');

    expect(logged).toHaveBeenCalledTimes(1);
    const [tag, line] = logged.mock.calls[0];
    expect(tag).toBe('[text-extract] failed');
    expect(JSON.parse(line)).toEqual({
      source: 'backfill',
      fileId: 'file_1',
      format: 'txt',
      status: 'FAILED',
      error: r.error,
      ms: r.ms,
      bytes: bytes(RESUME).byteLength,
    });
    expect(line).not.toContain('@');
    expect(line).not.toContain('Senior engineer');
  });

  it('turns a sniffer crash into FAILED', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(sniffFormat).mockImplementationOnce(() => {
      throw new RangeError('offset out of bounds');
    });
    expect(await extractText({ data: bytes(RESUME), source: 'apply' })).toMatchObject({
      status: 'FAILED',
      format: null,
      error: 'RangeError: offset out of bounds',
    });
  });

  it('reports a timeout as FAILED and logs it as a warning', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errored = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(txtToText).mockImplementationOnce(() => new Promise<AdapterOutput>(() => {}) as unknown as AdapterOutput);
    const r = await extractText({ data: bytes(RESUME), source: 'apply', timeoutMs: 50 });
    expect(r).toMatchObject({ status: 'FAILED', error: 'TimeoutError: No result after 50 ms' });
    expect(warned).toHaveBeenCalledWith('[text-extract] timeout', expect.stringContaining('"status":"FAILED"'));
    expect(errored).not.toHaveBeenCalled();
  });

  it('keeps web and mailto links only, deduped, at most 10', async () => {
    const links = [
      'https://linkedin.example.test/in/rowan',
      'https://linkedin.example.test/in/rowan',
      'mailto:rowan.testperson@example.test',
      'javascript:alert(1)',
      'file:///etc/passwd',
      ...Array.from({ length: 20 }, (_, i) => `https://rowan.example.test/${i}`),
    ];
    vi.mocked(txtToText).mockReturnValueOnce({ text: RESUME, links });
    const r = await extractText({ data: bytes(RESUME), source: 'apply' });
    expect(r.links).toHaveLength(10);
    expect(r.links.slice(0, 3)).toEqual([
      'https://linkedin.example.test/in/rowan',
      'mailto:rowan.testperson@example.test',
      'https://rowan.example.test/0',
    ]);
  });
});

describe('textFields', () => {
  it('maps a result onto the StoredFile columns', async () => {
    const at = new Date('2026-09-24T12:00:00Z');
    const ok = await extractText({ data: bytes(RESUME), source: 'apply' });
    expect(textFields(ok, at)).toEqual({ textStatus: 'OK', textVersion: EXTRACTOR_VERSION, textAttempts: 1, textCheckedAt: at, textError: null });
    vi.mocked(txtToText).mockImplementationOnce(() => {
      throw new EncryptedDocumentError();
    });
    const locked = await extractText({ data: bytes(RESUME), source: 'apply' });
    expect(textFields(locked, at)).toMatchObject({ textStatus: 'ENCRYPTED', textError: 'EncryptedDocumentError: The document is password-protected' });
  });
});

describe('textPending', () => {
  const file = (textStatus: 'OK' | 'EMPTY' | 'FAILED' | null, textAttempts: number, textVersion: number | null = EXTRACTOR_VERSION) => ({ textStatus, textAttempts, textVersion });

  it('holds until the backfill has used its attempts for this extractor version', () => {
    expect(textPending(file(null, 0, null))).toBe(true); // never read
    expect(textPending(file('FAILED', 1))).toBe(true);
    expect(textPending(file('FAILED', MAX_TEXT_ATTEMPTS))).toBe(false);
    expect(textPending(file(null, MAX_TEXT_ATTEMPTS))).toBe(false); // the last try died mid-file
    expect(textPending(file('EMPTY', 1))).toBe(false);
    expect(textPending(file('EMPTY', 1, EXTRACTOR_VERSION - 1))).toBe(true); // a newer extractor tries again
  });
});

describe('formats', () => {
  it('has a MIME type and extension for every format', () => {
    for (const format of RESUME_UPLOAD_FORMATS) {
      expect(FORMAT_MIME[format]).toMatch(/^[a-z]+\/[\w.+-]+$/);
      expect(FORMAT_EXT[format]).toBe(`.${format}`);
    }
  });
});

describe('runSelfTest', () => {
  it('extracts every built-in fixture', async () => {
    const r = await runSelfTest();
    expect(r.worker).toBe('in-process');
    expect(r.results.length).toBeGreaterThan(0);
    for (const result of r.results) expect(result, result.format).toMatchObject({ status: 'OK', match: true });
    expect(r.ok).toBe(true);
  });
});
