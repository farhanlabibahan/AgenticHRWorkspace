import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sniffFormat } from '@/server/text/sniff';
import type { SniffResult } from '@/server/text/types';
import { cfb, zip } from './fixtures/containers.mjs';

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const bytes = (s: string, encoding: BufferEncoding = 'latin1') => new Uint8Array(Buffer.from(s, encoding));
const none = (reason: SniffResult['reason']): SniffResult => ({ format: null, reason });

const PDF = '%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n';
const contentTypes = (partName: string, type: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="${partName}" ContentType="${type}"/></Types>`;
const odf = (mimetype: string) => zip([['mimetype', mimetype, { store: true }], ['content.xml', '<x/>']]);
const ole = (...names: string[]) => cfb(Object.fromEntries(names.map((n) => [n, Buffer.from('fictional stream data')])));
/** A Word FIB with the fEncrypted flag, as Word writes a password-protected .doc. */
const encryptedFib = () => {
  const fib = Buffer.alloc(4096);
  fib.writeUInt16LE(0xa5ec, 0); // wIdent
  fib.writeUInt16LE(0x00c1, 2); // nFib: Word 97
  fib.writeUInt16LE(0x0100, 10); // fEncrypted
  return fib;
};

describe('sniffFormat', () => {
  it.each<[string, Uint8Array, SniffResult]>([
    ['a PDF', bytes(PDF), { format: 'pdf' }],
    ['a PDF behind HTTP junk', bytes(`HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\n\r\n${' '.repeat(300)}${PDF}`), { format: 'pdf' }],
    ['text with a PDF header past 1 KB', bytes('A'.repeat(1100) + PDF), { format: 'txt' }],
    ['a DOCX', fixture('resume.docx'), { format: 'docx' }],
    ['a macro-enabled DOCM', zip([['[Content_Types].xml', contentTypes('/word/document.xml', 'application/vnd.ms-word.document.macroEnabled.main+xml')], ['word/document.xml', '<w:document/>']]), { format: 'docx' }],
    ['a DOTX template', zip([['[Content_Types].xml', contentTypes('/word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml')], ['word/document.xml', '<w:document/>']]), { format: 'docx' }],
    ['a DOCX without [Content_Types].xml', zip([['word/document.xml', '<w:document/>']]), { format: 'docx' }],
    ['a truncated DOCX', fixture('resume.docx').subarray(0, 1000), { format: 'docx' }],
    ['an XLSX', zip([['[Content_Types].xml', contentTypes('/xl/workbook.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml')], ['xl/workbook.xml', '<workbook/>']]), none('zip-other')],
    ['a PPTX', zip([['[Content_Types].xml', contentTypes('/ppt/presentation.xml', 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml')], ['ppt/presentation.xml', '<p/>']]), none('zip-other')],
    ['an ODT', fixture('resume.odt'), { format: 'odt' }],
    ['an OTT template', odf('application/vnd.oasis.opendocument.text-template'), { format: 'odt' }],
    ['an ODS', odf('application/vnd.oasis.opendocument.spreadsheet'), none('zip-other')],
    ['an ODP', odf('application/vnd.oasis.opendocument.presentation'), none('zip-other')],
    ['an EPUB', odf('application/epub+zip'), none('zip-other')],
    ['a plain ZIP', zip([['readme.txt', 'hello']]), none('zip-other')],
    ['a .doc from textutil', fixture('resume.doc'), { format: 'doc' }],
    ['an OLE2 file with a WordDocument stream', ole('WordDocument', '1Table', '\u0005SummaryInformation'), { format: 'doc' }],
    ['a password-protected .doc', cfb({ WordDocument: encryptedFib(), '1Table': Buffer.alloc(16) }), none('encrypted')],
    ['a password-protected DOCX', ole('EncryptionInfo', 'EncryptedPackage'), none('encrypted')],
    ['an XLS', ole('Workbook', '\u0005SummaryInformation'), none('ole2-other')],
    ['an Excel 95 XLS', ole('Book'), none('ole2-other')],
    ['a PPT', ole('PowerPoint Document', 'Current User'), none('ole2-other')],
    ['an Outlook MSG', ole('__substg1.0_0037001F', '__properties_version1.0'), none('ole2-other')],
    ['another OLE2 file', ole('SomethingElse'), none('ole2-other')],
    ['a broken OLE2 header', bytes('\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1' + '\0'.repeat(100)), none('ole2-other')],
    ['an RTF', fixture('resume.rtf'), { format: 'rtf' }],
    ['an RTF after a BOM and whitespace', bytes('\xef\xbb\xbf\r\n  {\\rtf1\\ansi hi}'), { format: 'rtf' }],
    ['plain UTF-8 text', fixture('resume.txt'), { format: 'txt' }],
    ['UTF-16LE text with a BOM', fixture('resume-utf16le-bom.txt'), { format: 'txt' }],
    ['UTF-16BE text with a BOM', fixture('resume-utf16be-bom.txt'), { format: 'txt' }],
    ['UTF-16LE text without a BOM', fixture('resume-utf16le-no-bom.txt'), { format: 'txt' }],
    ['Windows-1252 text', fixture('resume-cp1252.txt'), { format: 'txt' }],
    ['HTML', fixture('resume.html'), { format: 'html' }],
    ['a Word web page renamed to .doc', bytes('\ufeff<html xmlns:o="urn:schemas-microsoft-com:office:office"><head><meta charset="utf-8"></head><body>Resume</body></html>', 'utf8'), { format: 'html' }],
    ['a page saved by a browser', bytes('<!-- saved from url=(0014)about:internet -->\n<html><body>Resume</body></html>'), { format: 'html' }],
    ['XHTML', bytes('<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "x"><html><body>Resume</body></html>'), { format: 'html' }],
    ['a Word single-file web page (MHTML)', fixture('resume.mht'), { format: 'html' }],
    ['WordML 2003', bytes('<?xml version="1.0"?><?mso-application progid="Word.Document"?><w:wordDocument xmlns:w="http://schemas.microsoft.com/office/word/2003/wordml"><w:body><w:p><w:r><w:t>Resume</w:t></w:r></w:p></w:body></w:wordDocument>'), none('unknown')],
    ['SVG', bytes('<svg xmlns="http://www.w3.org/2000/svg"><text>Resume</text></svg>'), none('unknown')],
    ['a PNG', bytes('\x89PNG\r\n\x1a\n\0\0\0\rIHDR'), none('image')],
    ['a JPEG', bytes('\xff\xd8\xff\xe0\0\x10JFIF'), none('image')],
    ['a GIF', bytes('GIF89a\x01\0\x01\0'), none('image')],
    ['a WebP', bytes('RIFF$\0\0\0WEBPVP8 '), none('image')],
    ['a TIFF', bytes('II*\0\x08\0\0\0'), none('image')],
    ['a HEIC photo', bytes('\0\0\0\x18ftypheic\0\0\0\0mif1heic'), none('image')],
    ['zero bytes', new Uint8Array(0), none('empty')],
    ['only whitespace', bytes(' \r\n\t \n'), none('empty')],
    ['a UTF-16 BOM and spaces', bytes('\xff\xfe \0\n\0'), none('empty')],
    ['an executable', bytes('MZ\x90\0\x03\0\0\0\x04\0\0\0\xff\xff\0\0' + '\0'.repeat(200)), none('binary')],
  ])('%s', (_, data, expected) => {
    expect(sniffFormat(data)).toEqual(expected);
  });

  it('calls random bytes binary', () => {
    let seed = 7;
    const random = Uint8Array.from({ length: 4096 }, () => (seed = (seed * 1103515245 + 12345) >>> 0) & 0xff);
    expect(sniffFormat(random)).toEqual(none('binary'));
  });

  it('sniffs every committed fixture as the format of its extension', () => {
    const cases: [string, string][] = [
      ['resume.docx', 'docx'], ['docx-header-footer.docx', 'docx'], ['docx-text-box.docx', 'docx'],
      ['docx-hyperlinks.docx', 'docx'], ['docx-notes.docx', 'docx'], ['docx-hidden-content.docx', 'docx'],
      ['resume.doc', 'doc'], ['resume.odt', 'odt'], ['odt-header-footer.odt', 'odt'], ['resume.rtf', 'rtf'],
      ['rtf-unicode-fields.rtf', 'rtf'], ['resume.html', 'html'], ['resume.mht', 'html'], ['resume.pdf', 'pdf'],
    ];
    for (const [name, format] of cases) expect(sniffFormat(fixture(name)).format, name).toBe(format);
  });

  it('never throws on truncated or oversized containers', () => {
    const docx = fixture('resume.docx');
    for (const cut of [2, 4, 10, 30, 100, docx.length - 30]) expect(() => sniffFormat(docx.subarray(0, cut))).not.toThrow();
    const doc = fixture('resume.doc');
    for (const cut of [8, 512, 600, 2048, 9000]) expect(() => sniffFormat(doc.subarray(0, cut))).not.toThrow();
    // Over the entry limit: still recognisably a DOCX, so the extractor can report TOO_LARGE.
    const many = zip([
      ['[Content_Types].xml', contentTypes('/word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml')],
      ...Array.from({ length: 5_001 }, (_, i): [string, string, { store: boolean }] => [`junk/${i}.xml`, '<x/>', { store: true }]),
    ]);
    expect(sniffFormat(many)).toEqual({ format: 'docx' });
  });

  it('calls an OLE2 file whose directory chain loops back broken, not Word', () => {
    // Five directory entries take two sectors, 1 and 2; point sector 2 back at 1.
    const doc = Buffer.from(ole('WordDocument', '1Table', 'Data', 'CompObj'));
    expect(sniffFormat(doc)).toEqual({ format: 'doc' });
    const fatEntry = (sector: number) => 512 + sector * 4;
    expect(doc.readUInt32LE(fatEntry(1))).toBe(2);
    doc.writeUInt32LE(1, fatEntry(2));
    expect(sniffFormat(doc)).toEqual(none('ole2-other'));
    doc.writeUInt32LE(2, fatEntry(2)); // a sector that points at itself
    expect(sniffFormat(doc)).toEqual(none('ole2-other'));
  });

  it('is fast on a 5 MB buffer', () => {
    const big = new Uint8Array(5 * 1024 * 1024).fill(0x61);
    const started = performance.now();
    for (let i = 0; i < 20; i++) sniffFormat(big);
    expect((performance.now() - started) / 20).toBeLessThan(5);
  });
});
