import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { docToText } from '@/server/text/doc';
import { docxToText } from '@/server/text/docx';
import { htmlToText } from '@/server/text/html';
import { odtToText } from '@/server/text/odt';
import { rtfToText } from '@/server/text/rtf';
import { decodeText, txtToText } from '@/server/text/txt';
import { DocumentLimitError, EncryptedDocumentError } from '@/server/text/types';
import { ZipReader } from '@/server/text/zip';
import { cfb, zip } from './fixtures/containers.mjs';

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

const NAME = 'Rowan Q. Testperson';
const EMAIL = 'rowan.testperson@example.test';
const LINKEDIN = 'https://www.linkedin.com/in/rowan-testperson';

/** A minimal DOCX around a document.xml body (and any extra parts). */
function docx(body: string, extra: [string, string | Uint8Array, { store: boolean }?][] = [], ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main') {
  return zip([
    ['[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
    ['word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="${ns}"><w:body>${body}</w:body></w:document>`],
    ...extra,
  ]);
}

/** Text that appears in `text`, in this order. */
function expectInOrder(text: string, parts: string[]) {
  let at = -1;
  for (const part of parts) {
    const next = text.indexOf(part, at + 1);
    expect(next, `"${part}" after position ${at}`).toBeGreaterThan(at);
    at = next;
  }
}
const count = (text: string, part: string) => text.split(part).length - 1;

describe('plain resumes', () => {
  it.each([
    ['resume.docx', docxToText, [LINKEDIN]],
    ['resume.doc', docToText, []],
    ['resume.odt', odtToText, [LINKEDIN]],
    ['resume.rtf', rtfToText, [LINKEDIN]],
    ['resume.txt', txtToText, []],
    ['resume.html', htmlToText, [`mailto:${EMAIL}`, LINKEDIN]],
  ] as const)('%s', async (name, adapter, links) => {
    const out = await adapter(fixture(name));
    expect(out.text).toContain(NAME);
    expect(out.text).toContain('résumé');
    expect(out.text).toContain(EMAIL);
    expect(out.text).toContain(LINKEDIN);
    expect(out.links).toEqual(links);
  });
});

describe('docx', () => {
  it('reads the headers the sections use, first-page header first, footers last and once', () => {
    const { text } = docxToText(fixture('docx-header-footer.docx'));
    expectInOrder(text, [`${NAME} — ${EMAIL}`, `${NAME} (continued)`, 'Résumé', 'Publications', 'Portfolio: https://rowan.example.test · Page 1']);
    expect(count(text, 'Portfolio:')).toBe(1);
    expect(text).not.toContain('Stale header');
    expect(text).not.toContain('MERGEFORMAT');
  });

  it('keeps a text box once, after the paragraph it is anchored to', () => {
    const { text } = docxToText(fixture('docx-text-box.docx'));
    expectInOrder(text, [NAME, 'CONTACT', EMAIL, 'Skills: Elixir', 'Profile']);
    expect(count(text, 'Elixir')).toBe(1);
    expect(text).not.toContain('Decorative sidebar');
  });

  it('keeps hyperlink targets inline and in links', () => {
    const { text, links } = docxToText(fixture('docx-hyperlinks.docx'));
    expect(text).toContain(`LinkedIn (${LINKEDIN})`);
    expect(text).toContain('GitHub (https://github.com/rowan-testperson)');
    expect(text).toContain('Portfolio (https://rowan.example.test/)');
    expect(text).toContain(`Email me (${EMAIL})`);
    expect(count(text, 'quillfeather.example.test/team')).toBe(1);
    expect(text).toContain('Click here\n');
    expect(text).toContain('See experience below\n');
    expect(text).not.toMatch(/HYPERLINK|My code|javascript/);
    expect(links).toEqual([
      LINKEDIN,
      'https://github.com/rowan-testperson',
      'https://rowan.example.test/',
      `mailto:${EMAIL}?subject=Hello`,
      'https://quillfeather.example.test/team',
    ]);
  });

  it('puts footnotes and endnotes after the body', () => {
    const { text } = docxToText(fixture('docx-notes.docx'));
    expectInOrder(text, ['Certified Kubernetes Administrator, 2023.', 'Published 11 peer-reviewed papers.', 'Credential ID KX-4410', 'scholar.example.test']);
  });

  it('drops text Word does not show', () => {
    const { text } = docxToText(fixture('docx-hidden-content.docx'));
    for (const shown of ['Promoted to Principal Engineer in 2024.', 'Led the payments platform', 'Mentored six engineers. Visible run.', 'Updated September 2026', 'Portland, Oregon']) {
      expect(text).toContain(shown);
    }
    expect(count(text, 'Relocated sentence about Rust.')).toBe(1);
    for (const hidden of ['Globexcorp', 'Reviewer note', 'kubernetes', 'DATE', 'MMMM', 'Location', 'Click or tap here']) {
      expect(text).not.toContain(hidden);
    }
  });

  it('resolves namespaces by URI, not by prefix (Strict OOXML)', () => {
    const body = '<ns0:p><ns0:r><ns0:t>Strict résumé</ns0:t></ns0:r></ns0:p>';
    const strict = zip([
      ['[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'],
      ['word/document.xml', `<ns0:document xmlns:ns0="http://purl.oclc.org/ooxml/wordprocessingml/main"><ns0:body>${body}</ns0:body></ns0:document>`],
    ]);
    expect(docxToText(strict).text.trim()).toBe('Strict résumé');
  });

  it('reads an HTML altChunk, as export-to-Word tools write resumes', () => {
    const html = `<html><body><p>${NAME}</p><p><a href="${LINKEDIN}">LinkedIn</a></p></body></html>`;
    const doc = docx('<w:altChunk xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rIdA"/>', [
      ['word/_rels/document.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdA" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/aFChunk" Target="chunk.html"/></Relationships>'],
      ['word/chunk.html', html],
    ]);
    const { text, links } = docxToText(doc);
    expect(text).toContain(NAME);
    expect(text).toContain(`LinkedIn (${LINKEDIN})`);
    expect(links).toEqual([LINKEDIN]);
  });

  it('reads an altChunk part once, however many altChunks point at it', () => {
    const chunk = '<w:altChunk xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rIdA"/>';
    const doc = docx(chunk.repeat(3), [
      ['word/_rels/document.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdA" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/aFChunk" Target="chunk.html"/></Relationships>'],
      ['word/chunk.html', `<html><body><p>${NAME}</p></body></html>`],
    ]);
    expect(count(docxToText(doc).text, NAME)).toBe(1);
  });

  it('counts DOCX altChunks against the containing archive’s inflate budget', () => {
    // Each nested DOCX inflates to 25 MiB: three of them pass the 64 MiB archive budget.
    const inner = docx(`<w:p><w:r><w:t>${NAME}</w:t></w:r></w:p>${' '.repeat(25 * 1024 * 1024)}`);
    const ids = ['rIdA', 'rIdB', 'rIdC'];
    const doc = docx(ids.map((id) => `<w:altChunk xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="${id}"/>`).join(''), [
      ['word/_rels/document.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${ids.map((id) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/aFChunk" Target="${id}.docx"/>`).join('')}</Relationships>`],
      ...ids.map((id): [string, Uint8Array, { store: boolean }] => [`word/${id}.docx`, inner, { store: true }]),
    ]);
    expect(doc.length).toBeLessThan(200_000);
    expect(() => docxToText(doc)).toThrow(DocumentLimitError);
  });

  it('keeps link text linear when hyperlinks and fields nest', () => {
    const k = 20_000;
    const nested = [
      docx(`<w:p>${'<w:hyperlink><w:r><w:t>abcdefghij</w:t></w:r>'.repeat(k)}${'</w:hyperlink>'.repeat(k)}</w:p>`),
      docx(`<w:p>${'<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> HYPERLINK "https://x.example.test" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>abcdefghij</w:t></w:r>'.repeat(k)}${'<w:r><w:fldChar w:fldCharType="end"/></w:r>'.repeat(k)}</w:p>`),
    ];
    for (const doc of nested) {
      const started = performance.now();
      expect(docxToText(doc).text).toContain('abcdefghij');
      expect(performance.now() - started).toBeLessThan(2_000);
    }
  });

  it('refuses a zip bomb fast', () => {
    // 33 MiB of zeros deflates to about 33 KB; the per-entry cap is 32 MiB.
    const bomb = docx('<w:sectPr xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:headerReference w:type="default" r:id="rIdH"/></w:sectPr>', [
      ['word/_rels/document.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdH" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/></Relationships>'],
      ['word/header1.xml', new Uint8Array(33 * 1024 * 1024)],
    ]);
    expect(bomb.length).toBeLessThan(100_000);
    const started = performance.now();
    expect(() => docxToText(bomb)).toThrow(DocumentLimitError);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('caps the inflated total across the entries of one archive', () => {
    const chunk = new Uint8Array(300_000);
    const reader = ZipReader.open(zip([['a', chunk], ['b', chunk], ['c', chunk]]), { maxEntries: 10, maxEntryBytes: 500_000, maxTotalBytes: 800_000 })!;
    expect(reader.bytes('a')).toHaveLength(chunk.length);
    expect(reader.bytes('b')).toHaveLength(chunk.length);
    expect(() => reader.bytes('c')).toThrow(DocumentLimitError);
  });

  it('refuses archives with too many entries, and encrypted entries', () => {
    const many = docx('', Array.from({ length: 5_000 }, (_, i): [string, string, { store: boolean }] => [`junk/${i}.xml`, '<x/>', { store: true }]));
    expect(() => docxToText(many)).toThrow(DocumentLimitError);
    const encrypted = Buffer.from(docx('<w:p><w:r><w:t>Secret</w:t></w:r></w:p>'));
    // Set the "encrypted" flag on every central directory entry.
    for (let i = encrypted.indexOf('PK\x01\x02'); i >= 0; i = encrypted.indexOf('PK\x01\x02', i + 4)) encrypted[i + 8] |= 1;
    expect(() => docxToText(encrypted)).toThrow(EncryptedDocumentError);
  });

  it('reads 200,000 levels of nesting without overflowing the stack', () => {
    const depth = 200_000;
    const body = `${'<w:sdt><w:sdtContent>'.repeat(depth)}<w:p><w:r><w:t>Deep</w:t></w:r></w:p>${'</w:sdtContent></w:sdt>'.repeat(depth)}`;
    expect(docxToText(docx(body)).text.trim()).toBe('Deep');
  });

  it('never expands DTD entities (billion laughs)', () => {
    let dtd = '<!ENTITY lol "lol">';
    for (let i = 1; i <= 9; i++) dtd += `<!ENTITY lol${i} "${`&lol${i === 1 ? '' : i - 1};`.repeat(10)}">`;
    const xml = `<?xml version="1.0"?><!DOCTYPE w:document [${dtd}]><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Laughs &lol9;</w:t></w:r></w:p></w:body></w:document>`;
    const doc = docx('');
    const withDtd = zip([...['[Content_Types].xml', '_rels/.rels'].map((n): [string, Uint8Array] => [n, ZipReader.open(doc)!.bytes(n)!]), ['word/document.xml', xml]]);
    expect(docxToText(withDtd).text.trim()).toBe('Laughs &lol9;');
  });

  it('stays linear on a huge unterminated attribute', () => {
    const doc = docx(`<w:p><w:hyperlink r:id${'a'.repeat(1_000_000)}><w:r><w:t>Link</w:t></w:r></w:hyperlink></w:p>`);
    const started = performance.now();
    expect(docxToText(doc).text.trim()).toBe('Link');
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('throws on a truncated or foreign archive', () => {
    const whole = fixture('resume.docx');
    expect(() => docxToText(whole.subarray(0, whole.length - 30))).toThrow();
    expect(() => docxToText(zip([['readme.txt', 'hello']]))).toThrow('no main document part');
  });
});

describe('doc', () => {
  it('refuses a password-protected .doc', async () => {
    const fib = Buffer.alloc(4096);
    fib.writeUInt16LE(0xa5ec, 0);
    fib.writeUInt16LE(0x0100, 10); // fEncrypted
    await expect(docToText(cfb({ WordDocument: fib, '1Table': Buffer.alloc(16) }))).rejects.toThrow(EncryptedDocumentError);
  });

  it('rejects a malformed .doc instead of hanging', async () => {
    await expect(docToText(cfb({ WordDocument: Buffer.alloc(4096), '1Table': Buffer.alloc(16) }))).rejects.toThrow();
  });

  it('gives up when word-extractor never settles', async () => {
    vi.resetModules();
    vi.doMock('word-extractor', () => ({ default: class { extract = () => new Promise(() => {}); } }));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { docToText: hanging } = await import('@/server/text/doc');
      const result = hanging(fixture('resume.doc')).catch((e: Error) => e);
      await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
      vi.advanceTimersByTime(15_000);
      expect(await result).toMatchObject({ message: expect.stringContaining('did not finish') });
    } finally {
      vi.useRealTimers();
      vi.doUnmock('word-extractor');
      vi.resetModules();
    }
  });
});

describe('odt', () => {
  it('reads master-page headers and footers, frames, notes and links', () => {
    const { text, links } = odtToText(fixture('odt-header-footer.odt'));
    expectInOrder(text, [
      `${NAME} · ${EMAIL}`,
      'Résumé',
      'Summary: embedded engineer',
      'Sidebar skills: Rust, WebAssembly',
      'Certified Rust trainer, 2022.',
      'Led the firmware team of seven engineers.',
      'Credential RT-5512.',
      'Portfolio (https://rowan.example.test/portfolio) · Page 1',
    ]);
    expect(count(text, 'Sidebar skills')).toBe(1);
    for (const hidden of ['Globexcorp', 'Reviewer note', 'Decorative sidebar']) expect(text).not.toContain(hidden);
    expect(links).toEqual(['https://rowan.example.test/portfolio']);
  });

  it('keeps link text linear when links nest', () => {
    const k = 20_000;
    const content = `<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:xlink="http://www.w3.org/1999/xlink"><office:body><office:text><text:p>${'<text:a xlink:href="https://x.example.test/">abcdefghij'.repeat(k)}${'</text:a>'.repeat(k)}</text:p></office:text></office:body></office:document-content>`;
    const doc = zip([['mimetype', 'application/vnd.oasis.opendocument.text', { store: true }], ['content.xml', content]]);
    const started = performance.now();
    expect(odtToText(doc).text).toContain('abcdefghij');
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('keeps ODF spacing elements', () => {
    expect(odtToText(fixture('resume.odt')).text).toContain('Skills: TypeScript, Postgres,\tRust');
  });
});

describe('rtf', () => {
  it('decodes \\u escapes, code pages and fields, and orders notes and footers', () => {
    const { text, links } = rtfToText(fixture('rtf-unicode-fields.rtf'));
    expectInOrder(text, [
      `Header: ${EMAIL}`,
      'Zoë Müller — résumé',
      'Languages: 日本語 and Иван',
      'Rocket 🚀 launch',
      'Café “quoted” – dash',
      'GitHub (https://github.com/rowan-testperson) and https://rowan.example.test/\n',
      'Certified trainer, 2025.',
      'Sidebar: Rust, Go',
      'After the picture.',
      'Footnote: credential KX-4410.',
      'Footer: page 1',
    ]);
    expect(count(text, 'Sidebar')).toBe(1);
    expect(count(text, 'rowan.example.test/')).toBe(1);
    for (const hidden of ['Secret destination', 'Alt text', 'Hand-written', 'Times New Roman', 'HYPERLINK', '?']) expect(text).not.toContain(hidden);
    expect(links).toEqual(['https://github.com/rowan-testperson', 'https://rowan.example.test/']);
  });

  it('keeps link text linear when fields nest', () => {
    const field = `{\\field{\\*\\fldinst HYPERLINK "https://x.example.test"}{\\fldrslt ${'y'.repeat(9_000)}`;
    const started = performance.now();
    expect(rtfToText(new Uint8Array(Buffer.from(`{\\rtf1 ${field.repeat(990)}${'}}'.repeat(990)}}`))).text).toContain('yyy');
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('refuses groups nested deeper than 2,000 levels', () => {
    const deep = new Uint8Array(Buffer.from(`{\\rtf1 ${'{'.repeat(3000)}x${'}'.repeat(3000)}}`));
    expect(() => rtfToText(deep)).toThrow(DocumentLimitError);
  });

  it('throws on a file that is not RTF', () => {
    expect(() => rtfToText(new Uint8Array(Buffer.from('plain text')))).toThrow();
  });
});

describe('txt', () => {
  it.each(['resume-utf16le-bom.txt', 'resume-utf16be-bom.txt', 'resume-utf16le-no-bom.txt'])('decodes %s', (name) => {
    expect(decodeText(fixture(name))).toBe(decodeText(fixture('resume.txt')));
  });

  it('decodes Windows-1252 with its own table (Node 22 gets 0x80–0x9F wrong)', () => {
    expect(txtToText(fixture('resume-cp1252.txt')).text).toBe(
      `${NAME}\r\nStaff engineer · résumé\r\n“Pragmatic” — it’s true • Salary € negotiable – ${EMAIL}\r\n`,
    );
  });

  it('prefers UTF-8 when the bytes are valid UTF-8', () => {
    expect(decodeText(new Uint8Array(Buffer.from('Zoë — 日本語')))).toBe('Zoë — 日本語');
  });

  it('keeps UTF-8 text readable around a stray Windows-1252 byte', () => {
    const text = 'Zoë Ångström — résumé · 日本語 😀';
    const mixed = Buffer.concat([Buffer.from(text), Buffer.from([0x92]), Buffer.from('s CV')]);
    expect(decodeText(new Uint8Array(mixed))).toBe(`${text}’s CV`);
    // Windows-1252 in which two characters happen to form a UTF-8 sequence ("ß“" is DF 93) stays Windows-1252.
    const cp1252 = Buffer.from([...Buffer.from('Gru'), 0xdf, 0x93, 0x20, 0x97, ...Buffer.from(' caf'), 0xe9, 0x20, 0xe0, 0x20, 0xe8]);
    expect(decodeText(new Uint8Array(cp1252))).toBe('Gruß“ — café à è');
  });
});

describe('html', () => {
  it('drops head, scripts, styles and comments, and decodes entities', () => {
    const { text } = htmlToText(fixture('resume.html'));
    expectInOrder(text, [NAME, 'Staff engineer · résumé', `${EMAIL} · LinkedIn (${LINKEDIN}) · Portland, Oregon`, 'Staff Engineer, Quillfeather Labs\t2021 – Present', 'Led the search rewrite & cut p95', '1 < 2 — always']);
    for (const hidden of ['page title', 'styletext', 'scripttext', 'commented-out']) expect(text).not.toContain(hidden);
  });

  it('reads the HTML part of a Word single-file web page', () => {
    const { text, links } = htmlToText(fixture('resume.mht'));
    expectInOrder(text, [NAME, `Staff engineer · résumé – LinkedIn (${LINKEDIN})`, EMAIL]);
    expect(text).not.toContain('Private author');
    expect(links).toEqual([LINKEDIN]);
  });

  it('decodes a declared legacy charset', () => {
    const cyrillic = Buffer.concat([Buffer.from('<html><head><meta charset="windows-1251"></head><body><p>'), Buffer.from([0xc8, 0xe2, 0xe0, 0xed]), Buffer.from('</p></body></html>')]);
    expect(htmlToText(new Uint8Array(cyrillic)).text.trim()).toBe('Иван');
  });

  it('keeps the content when an optional end tag is missing', () => {
    expect(htmlToText(new Uint8Array(Buffer.from('<html><head><title>T</title><body><p>Kept</p>'))).text.trim()).toBe('Kept');
  });

  it('stays linear on hostile markup', () => {
    for (const html of ['<script>'.repeat(20_000), '<a href="x">'.repeat(20_000), '<!--'.repeat(50_000), '</td>'.repeat(100_000), `<a href='${'"'.repeat(50_000)}`]) {
      const started = performance.now();
      htmlToText(new Uint8Array(Buffer.from(html)));
      expect(performance.now() - started).toBeLessThan(500);
    }
  });

  it('keeps link text linear when links nest', () => {
    const k = 20_000;
    const started = performance.now();
    expect(htmlToText(new Uint8Array(Buffer.from(`${'<a href="https://x.example.test/">abcdefghij'.repeat(k)}${'</a>'.repeat(k)}`))).text).toContain('abcdefghij');
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
