// Writes the PDF fixtures for pdf.test.ts: node src/server/text/__tests__/fixtures/make-pdf-fixtures.mjs
//
// A tiny PDF writer with no dependencies, so every byte is deterministic and
// each file exercises one thing pdf.ts handles. Text uses the standard-14
// Helvetica fonts (not embedded, WinAnsi encoding); the people are fictional.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const here = new URL('.', import.meta.url);

// ------------------------------------------------------------------ writer

// The one character the fixtures use that WinAnsi puts outside Latin-1.
const WIN_ANSI = { '–': 0x96 };

/**
 * A PDF literal string in WinAnsi. Characters up to U+00FF are written as
 * that byte, so "\x80" reaches slot 128 of a font with its own encoding.
 */
function str(text) {
  let out = '';
  for (const ch of text) {
    const code = WIN_ANSI[ch] ?? ch.codePointAt(0);
    if (code > 0xff) throw new Error(`not in WinAnsi: ${ch}`);
    if (ch === '(' || ch === ')' || ch === '\\') out += `\\${ch}`;
    else if (code < 0x20 || code > 0x7e) out += `\\${code.toString(8).padStart(3, '0')}`;
    else out += ch;
  }
  return `(${out})`;
}

const HELVETICA = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
const HELVETICA_BOLD = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';

/** One line of text: BT … ET at (x, y). `tc` is character spacing, how Word and InDesign track headings. */
const line = (font, size, x, y, text, tc = 0) => `BT /${font} ${size} Tf ${tc} Tc ${x} ${y} Td ${str(text)} Tj ET`;

class Pdf {
  objects = [];

  /** Adds an object (a dictionary, or a dictionary plus stream bytes) and returns its number. */
  add(dict, stream) {
    this.objects.push({ dict, stream: stream === undefined ? undefined : Buffer.from(stream) });
    return this.objects.length;
  }

  /** Reserves a number for an object whose dictionary needs references made later. */
  reserve() {
    this.objects.push(null);
    return this.objects.length;
  }

  set(num, dict, stream) {
    this.objects[num - 1] = { dict, stream: stream === undefined ? undefined : Buffer.from(stream) };
  }

  /**
   * One page per content stream, all sharing `fonts`. The page tree comes
   * after fonts and contents in the file; `extra` adds page keys like /Annots.
   */
  pages(contents, fonts, extra = '') {
    const fontRefs = Object.entries(fonts).map(([name, dict]) => `/${name} ${this.add(dict)} 0 R`).join(' ');
    const contentNums = contents.map((content) => this.add('<< >>', content));
    const pagesNum = this.reserve();
    const kids = contentNums.map((c) =>
      this.add(`<< /Type /Page /Parent ${pagesNum} 0 R /MediaBox [0 0 612 792] /Contents ${c} 0 R /Resources << /Font << ${fontRefs} >> >>${extra} >>`),
    );
    this.set(pagesNum, `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`);
    return kids;
  }

  /** Serializes with the catalog written last, so a truncated copy loses it. */
  save({ encrypt } = {}) {
    const pagesNum = this.objects.findIndex((o) => o?.dict.startsWith('<< /Type /Pages')) + 1;
    const root = this.add(`<< /Type /Catalog /Pages ${pagesNum} 0 R >>`);
    const id = createHash('md5').update(JSON.stringify(this.objects.map((o) => o.dict))).digest();
    const security = encrypt ? standardSecurity(id, encrypt) : null;
    const encryptNum = security ? this.add(security.dict) : 0;
    const parts = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
    const offsets = [];
    let length = parts[0].length;
    const push = (b) => {
      parts.push(b);
      length += b.length;
    };
    this.objects.forEach((o, i) => {
      const num = i + 1;
      offsets.push(length);
      if (o.stream === undefined) return push(Buffer.from(`${num} 0 obj\n${o.dict}\nendobj\n`, 'latin1'));
      // Only stream bytes are encrypted: the fixtures keep strings out of dictionaries when encrypting.
      const data = security && num !== encryptNum ? rc4(security.objectKey(num), o.stream) : o.stream;
      push(Buffer.from(`${num} 0 obj\n${o.dict.replace(/ >>$/, '')} /Length ${data.length} >>\nstream\n`, 'latin1'));
      push(data);
      push(Buffer.from('\nendstream\nendobj\n', 'latin1'));
    });
    const xref = length;
    const rows = offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
    const hex = id.toString('hex');
    const trailer = `<< /Size ${offsets.length + 1} /Root ${root} 0 R /ID [<${hex}> <${hex}>]${encryptNum ? ` /Encrypt ${encryptNum} 0 R` : ''} >>`;
    push(Buffer.from(`xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n${rows}trailer\n${trailer}\nstartxref\n${xref}\n%%EOF\n`, 'latin1'));
    return Buffer.concat(parts);
  }
}

// ------------------------------------------------------------------ encryption (standard security handler, RC4 128-bit, revision 3)

const PAD = Buffer.from('28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a', 'hex');
const md5 = (...bufs) => createHash('md5').update(Buffer.concat(bufs)).digest();
const padded = (password) => Buffer.concat([Buffer.from(password, 'latin1'), PAD]).subarray(0, 32);

function rc4(key, data) {
  const s = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = Buffer.alloc(data.length);
  for (let k = 0, i = 0, j = 0; k < data.length; k++) {
    i = (i + 1) & 255;
    j = (j + s[i]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
    out[k] = data[k] ^ s[(s[i] + s[j]) & 255];
  }
  return out;
}

/** RC4 applied 20 times with the key XORed by 0…19 (algorithms 3 and 5 of the PDF spec). */
function rc4x20(key, data) {
  for (let i = 0; i < 20; i++) data = rc4(key.map((b) => b ^ i), data);
  return data;
}

function standardSecurity(id, { user, owner }) {
  const P = -3904; // grants nothing, not even copying text; pdf.js (rightly) ignores permissions
  let ownerKey = md5(padded(owner));
  for (let i = 0; i < 50; i++) ownerKey = md5(ownerKey);
  const O = rc4x20(ownerKey, padded(user));
  const p = Buffer.alloc(4);
  p.writeInt32LE(P);
  let key = md5(padded(user), O, p, id);
  for (let i = 0; i < 50; i++) key = md5(key);
  const U = Buffer.concat([rc4x20(key, md5(PAD, id)), Buffer.alloc(16)]);
  return {
    dict: `<< /Filter /Standard /V 2 /R 3 /Length 128 /O <${O.toString('hex')}> /U <${U.toString('hex')}> /P ${P} >>`,
    objectKey: (num) => md5(key, Buffer.from([num & 255, (num >> 8) & 255, (num >> 16) & 255, 0, 0])),
  };
}

// ------------------------------------------------------------------ fixtures

const write = (name, bytes) => {
  writeFileSync(new URL(name, here), bytes);
  console.log(name, bytes.length, 'bytes');
};

/** Single column: contact line, tracked headings, line-end hyphens, ligature glyphs. */
function resume() {
  const pdf = new Pdf();
  const content = [
    line('F2', 20, 72, 730, 'Rowan Q. Testperson'),
    line('F1', 11, 72, 708, 'Staff Platform Engineer · résumé'),
    line('F1', 10, 72, 692, 'rowan.testperson@example.test · +1 555 010 4477 · https://rowan.example.test'),
    line('F2', 11, 72, 660, 'EXPERIENCE', 4),
    line('F1', 10, 72, 642, 'Staff Engineer, Fictional Widgets Inc. (2021 – present)'),
    line('F1', 10, 72, 628, 'Led the devel-'),
    line('F1', 10, 72, 616, 'opment of a cross-'),
    line('F1', 10, 72, 604, 'functional résumé screening service used by forty hiring teams.'),
    line('F2', 11, 72, 572, 'WORK HISTORY', 4),
    line('F1', 10, 72, 554, 'Software Engineer, Imaginary Analytics (2016 – 2021)'),
    // \x80 and \x81 are the fi and fl ligature glyphs in F3's encoding.
    line('F3', 10, 72, 540, 'Certi\x80ed Kubernetes administrator; ef\x80cient release work\x81ows.'),
  ].join('\n');
  pdf.pages([content], {
    F1: HELVETICA,
    F2: HELVETICA_BOLD,
    F3: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences [128 /fi /fl] >> >>',
  });
  return pdf;
}

/**
 * Sidebar and main column written row by row (sidebar line, main line, …),
 * so stream order interleaves them and only the layout pass can separate them.
 */
function twoColumn() {
  const side = ['CONTACT', 'rowan.testperson@example.test', '+1 555 010 4477', 'Lisbon, Portugal', 'SKILLS', 'TypeScript', 'PostgreSQL', 'Kubernetes', 'LANGUAGES', 'Portuguese', 'English'];
  const main = [
    'PROFILE',
    'Platform engineer with ten years of experience building',
    'developer tooling and resilient data pipelines for',
    'résumé screening and hiring teams.',
    'EXPERIENCE',
    'Staff Engineer, Fictional Widgets Inc. (2021 to present)',
    'Senior Engineer, Imaginary Analytics (2016 to 2021)',
    'EDUCATION',
    'BSc Computer Science, Example University (2012)',
    'INTERESTS',
    'Trail running, film photography, open source',
  ];
  const rows = side.flatMap((s, i) => {
    const y = 670 - i * 15;
    const bold = (t) => /^[A-Z]{4,}$/.test(t);
    return [line(bold(s) ? 'F2' : 'F1', 8.5, 50, y, s), line(bold(main[i]) ? 'F2' : 'F1', 10, 220, y, main[i])];
  });
  const pdf = new Pdf();
  pdf.pages([[line('F2', 22, 50, 730, 'Rowan Q. Testperson'), line('F1', 11, 50, 706, 'Platform Engineer · résumé'), ...rows].join('\n')], {
    F1: HELVETICA,
    F2: HELVETICA_BOLD,
  });
  return pdf;
}

/** Link annotations behind words, plus a URL that wrapped in a narrow column. */
function links() {
  const pdf = new Pdf();
  const annots = [pdf.reserve(), pdf.reserve(), pdf.reserve(), pdf.reserve()];
  const content = [
    line('F2', 16, 50, 730, 'Rowan Q. Testperson'),
    line('F1', 10, 50, 706, 'LinkedIn'),
    line('F1', 10, 50, 692, 'Email me'),
    line('F1', 10, 50, 678, 'Portfolio'),
    line('F1', 10, 50, 664, 'Back to top'),
    line('F1', 9, 50, 636, 'https://code.example.test/rowan-'),
    line('F1', 9, 50, 625, 'testperson/resume-parser'),
  ].join('\n');
  const link = (y, action) => `<< /Type /Annot /Subtype /Link /Rect [50 ${y - 2} 110 ${y + 9}] /Border [0 0 0] ${action} >>`;
  const [page] = pdf.pages([content], { F1: HELVETICA, F2: HELVETICA_BOLD }, ` /Annots [${annots.map((a) => `${a} 0 R`).join(' ')}]`);
  pdf.set(annots[0], link(706, '/A << /S /URI /URI (https://www.linkedin.com/in/rowan-testperson) >>'));
  pdf.set(annots[1], link(692, '/A << /S /URI /URI (mailto:rowan.testperson@example.test?subject=Hello) >>'));
  pdf.set(annots[2], link(678, '/A << /S /URI /URI (javascript:alert\\(1\\)) >>')); // not a web link: dropped
  pdf.set(annots[3], link(664, `/Dest [${page} 0 R /XYZ 0 792 0]`)); // a jump inside the document: dropped
  return pdf;
}

/**
 * Japanese in a CJK font that isn't embedded and uses a predefined CMap
 * (UniJIS-UCS2-H): pdf.js can only decode it with pdfjs-dist's cmaps/. The
 * middle glyph of 人工知能 comes from a font whose ToUnicode maps it to the
 * Kangxi radical U+2F2F, as some real CJK fonts do.
 */
function cjk() {
  const toUnicode = [
    '/CIDInit /ProcSet findresource begin 12 dict begin begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def /CMapType 2 def',
    '1 begincodespacerange <00> <FF> endcodespacerange',
    '1 beginbfchar <41> <2F2F> endbfchar',
    'endcmap CMapName currentdict /CMap defineresource pop end end',
  ].join('\n');
  const pdf = new Pdf();
  const descendant = pdf.add(
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /KozMinPr6N-Regular /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 6 >> /FontDescriptor ' +
      `${pdf.add('<< /Type /FontDescriptor /FontName /KozMinPr6N-Regular /Flags 4 /FontBBox [0 -120 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 /StemV 80 >>')} 0 R /DW 1000 >>`,
  );
  const radicalWidth = (667 / 1000) * 12; // Helvetica "A"
  const content = [
    line('F2', 12, 72, 730, 'Rowan Q. Testperson · résumé'),
    'BT /F1 16 Tf 72 700 Td <65E5672C8A9E30A830F330B830CB30A2> Tj ET', // 日本語エンジニア
    'BT /F1 12 Tf 72 676 Td <4EBA> Tj ET', // 人
    `BT /F3 12 Tf 84 676 Td ${str('A')} Tj ET`, // ⼯ (U+2F2F)
    `BT /F1 12 Tf ${84 + radicalWidth} 676 Td <77E580FD> Tj ET`, // 知能
  ].join('\n');
  pdf.pages([content], {
    F1: `<< /Type /Font /Subtype /Type0 /BaseFont /KozMinPr6N-Regular /Encoding /UniJIS-UCS2-H /DescendantFonts [${descendant} 0 R] >>`,
    F2: HELVETICA,
    F3: `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding /ToUnicode ${pdf.add('<< >>', toUnicode)} 0 R >>`,
  });
  return pdf;
}

/** A page that is only an image, like a scanned resume: no text layer at all. */
function scanned() {
  const size = 48;
  const pixels = Buffer.alloc(size * size);
  for (let i = 0; i < pixels.length; i++) pixels[i] = 200 + ((i * 7919) % 55); // paper-ish noise
  const pdf = new Pdf();
  const image = pdf.add(`<< /Type /XObject /Subtype /Image /Width ${size} /Height ${size} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode >>`, deflateSync(pixels));
  const contents = pdf.add('<< >>', 'q 612 0 0 792 0 0 cm /Im1 Do Q');
  const pagesNum = pdf.reserve();
  const page = pdf.add(`<< /Type /Page /Parent ${pagesNum} 0 R /MediaBox [0 0 612 792] /Contents ${contents} 0 R /Resources << /XObject << /Im1 ${image} 0 R >> >> >>`);
  pdf.set(pagesNum, `<< /Type /Pages /Kids [${page} 0 R] /Count 1 >>`);
  return pdf;
}

/** More pages than pdf.ts reads: the last says so. */
function manyPages() {
  const pdf = new Pdf();
  const contents = Array.from({ length: 21 }, (_, i) => line('F1', 12, 72, 720, i === 20 ? 'Past the page limit' : `Rowan Q. Testperson, page ${i + 1}`));
  pdf.pages(contents, { F1: HELVETICA });
  return pdf;
}

/**
 * Hebrew and Arabic written the way Chrome writes them: glyph runs in visual
 * (left-to-right) order, split by marked content, and Arabic as positional
 * presentation forms with a run per glyph cluster. pdf.js puts each run in
 * logical order, but not the runs of a line.
 */
function rightToLeft() {
  // F2's codes 0xC0 and up stand for Hebrew and Arabic letters through its ToUnicode map (Helvetica widths, all 667).
  const letters = { 0xc0: 0xfe94, 0xc1: 0xfeae, 0xc2: 0xfe92, 0xc3: 0xfea7, 0xc4: 0x05d4, 0xc5: 0x05de, 0xc8: 0x05d5, 0xc9: 0x05d6, 0xca: 0x05e8 };
  const hex = (n, width) => n.toString(16).padStart(width, '0').toUpperCase();
  const toUnicode = [
    '/CIDInit /ProcSet findresource begin 12 dict begin begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def /CMapType 2 def',
    '1 begincodespacerange <00> <FF> endcodespacerange',
    `${Object.keys(letters).length} beginbfchar`,
    ...Object.entries(letters).map(([code, unicode]) => `<${hex(Number(code), 2)}> <${hex(unicode, 4)}>`),
    'endbfchar',
    'endcmap CMapName currentdict /CMap defineresource pop end end',
  ].join('\n');
  const span = (op) => `/Span BMC ${op} EMC`;
  const hebrew = '<C4C5C8C9CA> Tj'; // רזומה, leftmost glyph first
  const content = [
    // خبرة: ة and ر share a run, then ب, then خ.
    `BT /F2 12 Tf 300 730 Td ${span('<C0C1> Tj')} ${span('<C2> Tj')} ${span('<C3> Tj')} ET`,
    // רזומה 2019 - 2024: the numbers sit left of the word, the later year leftmost.
    `BT /F1 12 Tf 300 710 Td (2024) Tj ${span('( - ) Tj')} (2019) Tj ${span('( ) Tj')} /F2 12 Tf ${hebrew} ET`,
    // רזומה Rowan Q.: a left-to-right name in two runs keeps its order.
    `BT /F1 12 Tf 300 690 Td ${span('(Rowan) Tj')} ( ) Tj ${span('(Q.) Tj')} ( ) Tj /F2 12 Tf ${hebrew} ET`,
  ].join('\n');
  const pdf = new Pdf();
  pdf.pages([content], {
    F1: HELVETICA,
    F2: `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding /ToUnicode ${pdf.add('<< >>', toUnicode)} 0 R >>`,
  });
  return pdf;
}

/** An unknown operator made of an address: pdf.js warns about it, quoting it. */
function noisy() {
  const pdf = new Pdf();
  pdf.pages([`${line('F1', 12, 72, 720, 'Rowan Q. Testperson')}\nBT /F1 12 Tf 72 700 Td rowan.testperson@example.test Tj ET`], { F1: HELVETICA });
  return pdf;
}

/** A short resume for the encrypted variants. */
function locked() {
  const pdf = new Pdf();
  const content = [line('F2', 18, 72, 720, 'Rowan Q. Testperson'), line('F1', 11, 72, 700, 'Protected résumé · rowan.testperson@example.test')].join('\n');
  pdf.pages([content], { F1: HELVETICA, F2: HELVETICA_BOLD });
  return pdf;
}

const resumeBytes = resume().save();
write('resume.pdf', resumeBytes);
write('two-column.pdf', twoColumn().save());
write('links.pdf', links().save());
write('cjk-cmap.pdf', cjk().save());
write('scanned.pdf', scanned().save());
write('right-to-left.pdf', rightToLeft().save());
write('noisy.pdf', noisy().save());
write('pages.pdf', manyPages().save());
// Cut before the page tree: no pages, no catalog, no xref.
write('truncated.pdf', resumeBytes.subarray(0, resumeBytes.indexOf('/Type /Page')));
// Opens without a prompt (only the owner password is set), like most "protected" PDFs.
write('encrypted-empty-password.pdf', locked().save({ encrypt: { user: '', owner: 'owner-demo-pw' } }));
write('encrypted.pdf', locked().save({ encrypt: { user: 'rowan-demo-pw', owner: 'owner-demo-pw' } }));
