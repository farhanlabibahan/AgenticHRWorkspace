import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { normalizeText } from '../normalize';
import { pdfToText } from '../pdf';
import { EncryptedDocumentError } from '../types';

/**
 * The PDF adapter against synthetic fixtures (make-pdf-fixtures.mjs), one per
 * layout problem the line assembly solves. Word-level quality on realistic
 * resumes is measured by the bench-pdf corpus, not here.
 */

const fixture = (name: string) => new Uint8Array(readFileSync(path.join(__dirname, 'fixtures', name)));
const lines = (text: string) => text.split('\n');

describe('pdfToText', () => {
  it('reads a single-column resume with its contact details', async () => {
    const out = await pdfToText(fixture('resume.pdf'));
    for (const s of ['Rowan Q. Testperson', 'résumé', 'rowan.testperson@example.test', '+1 555 010 4477', 'https://rowan.example.test']) {
      expect(out.text).toContain(s);
    }
    expect(out.pages).toBe(1);
    expect(out.links).toEqual([]);
  });

  it('collapses letter-spaced headings, keeping the gap between words', async () => {
    const { text } = await pdfToText(fixture('resume.pdf'));
    expect(lines(text)).toContain('EXPERIENCE');
    expect(lines(text)).toContain('WORK HISTORY');
    expect(text).not.toContain('E X P');
  });

  it('joins words hyphenated at a line end but keeps compounds', async () => {
    const { text } = await pdfToText(fixture('resume.pdf'));
    expect(text).toContain('Led the development of a cross-functional résumé screening service');
  });

  it('spells out ligature glyphs', async () => {
    const { text } = await pdfToText(fixture('resume.pdf'));
    expect(text).toContain('Certified Kubernetes administrator; efficient release workflows.');
    expect(text).not.toMatch(/[\ufb00-\ufb06]/);
  });

  it('keeps a sidebar and the main column apart when the stream interleaves them', async () => {
    const { text } = await pdfToText(fixture('two-column.pdf'));
    const side = ['CONTACT', 'rowan.testperson@example.test', '+1 555 010 4477', 'SKILLS', 'TypeScript', 'LANGUAGES', 'English'];
    const main = ['PROFILE', 'Platform engineer with ten years of experience building', 'résumé screening and hiring teams.', 'EDUCATION', 'Trail running, film photography, open source'];
    const at = (s: string) => lines(text).indexOf(s);
    // Each line stands alone (nothing like "CONTACT PROFILE"), and the columns come out one after the other.
    for (const s of [...side, ...main]) expect(at(s), s).toBeGreaterThanOrEqual(0);
    const sideAt = side.map(at);
    const mainAt = main.map(at);
    expect(Math.max(...sideAt) < Math.min(...mainAt) || Math.max(...mainAt) < Math.min(...sideAt)).toBe(true);
    expect(sideAt).toEqual([...sideAt].sort((a, b) => a - b));
    expect(mainAt).toEqual([...mainAt].sort((a, b) => a - b));
  });

  it('returns web and mailto link annotations, and rejoins a wrapped URL', async () => {
    const { text, links } = await pdfToText(fixture('links.pdf'));
    // javascript: and in-document links are dropped.
    expect(links).toEqual(['https://www.linkedin.com/in/rowan-testperson', 'mailto:rowan.testperson@example.test?subject=Hello']);
    expect(lines(text)).toContain('https://code.example.test/rowan-testperson/resume-parser');
  });

  it('reads CJK text in a font that relies on a predefined CMap', async () => {
    const { text } = await pdfToText(fixture('cjk-cmap.pdf'));
    expect(text).toContain('日本語エンジニア');
    // The middle glyph is mapped to the Kangxi radical U+2F2F by its font.
    expect(text).toContain('人工知能');
    expect(text).not.toContain('\u2f2f');
  });

  it('reads Hebrew and Arabic lines from the right, keeping left-to-right runs in order', async () => {
    const { text } = await pdfToText(fixture('right-to-left.pdf'));
    // Arabic comes out as letters, not the presentation forms the font maps to.
    expect(lines(text)).toEqual(['\u062e\u0628\u0631\u0629', 'רזומה 2019 - 2024', 'רזומה Rowan Q.']);
  });

  it('keeps pdf.js warnings, which quote the document, out of the logs', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect((await pdfToText(fixture('noisy.pdf'))).text).toContain('Rowan Q. Testperson');
      expect([...log.mock.calls, ...warn.mock.calls]).toEqual([]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('returns no text for a scanned page', async () => {
    const out = await pdfToText(fixture('scanned.pdf'));
    expect(out.text.trim()).toBe('');
    expect(normalizeText(out.text)).toBeNull();
  });

  it('reads at most 20 pages but reports them all', async () => {
    const out = await pdfToText(fixture('pages.pdf'));
    expect(out.pages).toBe(21);
    expect(out.text).toContain('Rowan Q. Testperson, page 20');
    expect(out.text).not.toContain('Past the page limit');
  });

  it('throws on a truncated file', async () => {
    const result = pdfToText(fixture('truncated.pdf'));
    await expect(result).rejects.toThrow();
    await expect(result).rejects.not.toBeInstanceOf(EncryptedDocumentError);
  });

  it('reads an encrypted PDF whose user password is empty', async () => {
    const { text } = await pdfToText(fixture('encrypted-empty-password.pdf'));
    expect(text).toContain('Rowan Q. Testperson');
    expect(text).toContain('Protected résumé');
  });

  it('reports a PDF that needs a password as encrypted', async () => {
    await expect(pdfToText(fixture('encrypted.pdf'))).rejects.toBeInstanceOf(EncryptedDocumentError);
  });

  it("leaves the caller's buffer intact", async () => {
    // pdf.js detaches the buffer it's handed; the caller may still need its bytes.
    const data = fixture('resume.pdf');
    await pdfToText(data);
    expect(data.byteLength).toBeGreaterThan(0);
  });

  it('keeps its repairs through normalizeText', async () => {
    const resume = normalizeText((await pdfToText(fixture('resume.pdf'))).text) ?? '';
    const links = normalizeText((await pdfToText(fixture('links.pdf'))).text) ?? '';
    expect(lines(resume)).toContain('EXPERIENCE');
    expect(resume).toContain('development of a cross-functional');
    expect(lines(links)).toContain('https://code.example.test/rowan-testperson/resume-parser');
  });
});
