// Writes the Word-format fixtures for formats.test.ts:
//
//   node src/server/text/__tests__/fixtures/make-word-fixtures.mjs
//
// DOCX and ODT parts are written by hand, the way Word and LibreOffice write
// them, so each file exercises one thing the extractors handle. resume.doc
// needs macOS textutil (there is no free .doc writer for Node); elsewhere it is
// left as committed. The people are fictional.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zip } from './containers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const write = (name, bytes) => {
  writeFileSync(path.join(here, name), bytes);
  console.log(`${name.padEnd(28)} ${String(bytes.length).padStart(6)} bytes`);
};
const x = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const NAME = 'Rowan Q. Testperson';
const EMAIL = 'rowan.testperson@example.test';
const LINKEDIN = 'https://www.linkedin.com/in/rowan-testperson';

// ------------------------------------------------------------------ DOCX

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS = `xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:r="${R}" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:w="${W}" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" mc:Ignorable="w14"`;
const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
const REL = {
  document: `${R}/officeDocument`,
  header: `${R}/header`,
  footer: `${R}/footer`,
  footnotes: `${R}/footnotes`,
  endnotes: `${R}/endnotes`,
  comments: `${R}/comments`,
  hyperlink: `${R}/hyperlink`,
  glossary: `${R}/glossaryDocument`,
};
const CT = {
  document: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
  header: 'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml',
  footer: 'application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml',
  footnotes: 'application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml',
  endnotes: 'application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml',
  comments: 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml',
  glossary: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.glossary+xml',
};

const run = (text, rPr = '') => `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t xml:space="preserve">${x(text)}</w:t></w:r>`;
const para = (inner, pPr = '') => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${inner}</w:p>`;
const P = (text) => para(run(text));
const H = (text) => para(run(text), '<w:pStyle w:val="Heading1"/>');
const hyperlink = (rid, text) => `<w:hyperlink r:id="${rid}" w:history="1">${run(text, '<w:rStyle w:val="Hyperlink"/>')}</w:hyperlink>`;
const field = (instr, result) =>
  `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> ${x(instr)} </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${run(result)}<w:r><w:fldChar w:fldCharType="end"/></w:r>`;
const fldSimple = (instr, result) => `<w:fldSimple w:instr=" ${x(instr)} ">${run(result)}</w:fldSimple>`;
const sectPr = (refs = '', extra = '') =>
  `<w:sectPr>${refs}<w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>${extra}</w:sectPr>`;
const part = (root, body) => `${DECL}<w:${root} ${NS}>${body}</w:${root}>`;
const rels = (list) =>
  `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list
    .map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${x(r.target)}"${r.external ? ' TargetMode="External"' : ''}/>`)
    .join('')}</Relationships>`;

/**
 * A .docx: `parts` maps a path under word/ to { kind, xml, id }; `links` are
 * external hyperlink relationships { id, url }.
 */
function docx(body, { parts = {}, links = [] } = {}) {
  const overrides = [['document.xml', 'document'], ...Object.entries(parts).map(([p, d]) => [p, d.kind])];
  const docRels = [
    ...Object.entries(parts).map(([p, d]) => ({ id: d.id, type: REL[d.kind], target: p })),
    ...links.map((l) => ({ id: l.id, type: REL.hyperlink, target: l.url, external: true })),
  ];
  return zip([
    [
      '[Content_Types].xml',
      `${DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${overrides
        .map(([p, kind]) => `<Override PartName="/word/${p}" ContentType="${CT[kind]}"/>`)
        .join('')}</Types>`,
    ],
    ['_rels/.rels', rels([{ id: 'rId1', type: REL.document, target: 'word/document.xml' }])],
    ['word/document.xml', part('document', `<w:body>${body}</w:body>`)],
    ['word/_rels/document.xml.rels', rels(docRels)],
    ...Object.entries(parts).map(([p, d]) => [`word/${p}`, d.xml]),
  ]);
}

write(
  'resume.docx',
  docx(
    para(run(NAME, '<w:b/>'), '<w:pStyle w:val="Title"/>') +
      P('Staff engineer · résumé') +
      para(run(`${EMAIL} · Portland, Oregon · `) + hyperlink('rIdL1', 'LinkedIn')) +
      H('Experience') +
      P('Staff Engineer, Quillfeather Labs, 2021 – Present') +
      P('Led the search rewrite and cut p95 latency by 40%.') +
      P('Skills: TypeScript, Postgres, Rust') +
      sectPr(),
    { links: [{ id: 'rIdL1', url: LINKEDIN }] },
  ),
);

// Contact details in the headers: Word shows the first-page header on page 1
// and the default one after; a header no section references is stale.
write(
  'docx-header-footer.docx',
  docx(
    H('Résumé') +
      P('Research engineer in computer vision; nine years across academia and industry.') +
      para(run('Postdoc, Jagiellonian University, 2017 – 2020'), sectPr(
        '<w:headerReference w:type="default" r:id="rIdH2"/><w:headerReference w:type="first" r:id="rIdH1"/><w:footerReference w:type="default" r:id="rIdF1"/>',
        '<w:titlePg/>',
      )) +
      H('Publications') +
      P('Testperson, R. et al. “Sparse Optical Flow at Scale.” 2022.') +
      sectPr('<w:headerReference w:type="default" r:id="rIdH2"/><w:footerReference w:type="default" r:id="rIdF1"/>'),
    {
      parts: {
        'header1.xml': { kind: 'header', id: 'rIdH1', xml: part('hdr', P(`${NAME} — ${EMAIL} — +1 555 0100`)) },
        'header2.xml': { kind: 'header', id: 'rIdH2', xml: part('hdr', P(`${NAME} (continued)`)) },
        'header3.xml': { kind: 'header', id: 'rIdH3', xml: part('hdr', P('Stale header from an old template')) },
        'footer1.xml': {
          kind: 'footer',
          id: 'rIdF1',
          xml: part('ftr', para(run('Portfolio: https://rowan.example.test · Page ') + fldSimple('PAGE \\* MERGEFORMAT', '1'))),
        },
      },
    },
  ),
);

// A sidebar text box as Word 2010+ writes it: the DrawingML shape and a VML
// fallback holding the same text, anchored in the name paragraph.
{
  const box = `<w:txbxContent>${P('CONTACT')}${P(EMAIL)}${P('Skills: Elixir, Phoenix, Postgres')}</w:txbxContent>`;
  const textbox = `<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wp:anchor distT="0" distB="0" distL="114300" distR="114300" simplePos="0" relativeHeight="251659264" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="page"><wp:posOffset>4800600</wp:posOffset></wp:positionH><wp:positionV relativeFrom="page"><wp:posOffset>457200</wp:posOffset></wp:positionV><wp:extent cx="2286000" cy="3200400"/><wp:wrapSquare wrapText="bothSides"/><wp:docPr id="1" name="Text Box 1" descr="Decorative sidebar"/><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:cNvSpPr txBox="1"/><wps:txbx>${box}</wps:txbx><wps:bodyPr/></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></mc:Choice><mc:Fallback><w:pict><v:shape id="Text Box 1" type="#_x0000_t202" style="position:absolute;margin-left:378pt;margin-top:36pt;width:180pt;height:252pt" filled="f" stroked="f"><v:textbox>${box}</v:textbox></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:r>`;
  write(
    'docx-text-box.docx',
    docx(
      para(run(NAME) + textbox, '<w:pStyle w:val="Title"/>') +
        H('Profile') +
        P('Backend engineer focused on real-time systems.') +
        sectPr(),
    ),
  );
}

// Every way Word stores a hyperlink: a relationship, a HYPERLINK field, a
// simple field, mailto, a link whose text is its URL, a bookmark, a script.
write(
  'docx-hyperlinks.docx',
  docx(
    P(NAME) +
      para(
        hyperlink('rIdL1', 'LinkedIn') +
          run(' · ') +
          field('HYPERLINK "https://github.com/rowan-testperson" \\o "My code"', 'GitHub') +
          run(' · ') +
          fldSimple('HYPERLINK "https://rowan.example.test/"', 'Portfolio') +
          run(' · ') +
          hyperlink('rIdL2', 'Email me') +
          run(' · ') +
          hyperlink('rIdL4', 'Click here'),
      ) +
      para(run('Team page: ') + hyperlink('rIdL3', 'https://quillfeather.example.test/team')) +
      para(`<w:hyperlink w:anchor="_Experience" w:history="1">${run('See experience below')}</w:hyperlink>`) +
      '<w:bookmarkStart w:id="0" w:name="_Experience"/>' +
      H('Experience') +
      '<w:bookmarkEnd w:id="0"/>' +
      P('Principal Designer, Emberline Studios, 2018 – Present') +
      sectPr(),
    {
      links: [
        { id: 'rIdL1', url: LINKEDIN },
        { id: 'rIdL2', url: `mailto:${EMAIL}?subject=Hello` },
        { id: 'rIdL3', url: 'https://quillfeather.example.test/team' },
        { id: 'rIdL4', url: 'javascript:alert(1)' },
      ],
    },
  ),
);

write(
  'docx-notes.docx',
  docx(
    P(NAME) +
      para(run('Certified Kubernetes Administrator') + '<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="1"/></w:r>' + run(', 2023.')) +
      para(run('Published 11 peer-reviewed papers') + '<w:r><w:endnoteReference w:id="1"/></w:r>' + run('.')) +
      sectPr(),
    {
      parts: {
        'footnotes.xml': {
          kind: 'footnotes',
          id: 'rIdFn',
          xml: part(
            'footnotes',
            `<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote><w:footnote w:id="1">${para('<w:r><w:footnoteRef/></w:r>' + run(' Credential ID KX-4410, verifiable online.'))}</w:footnote>`,
          ),
        },
        'endnotes.xml': {
          kind: 'endnotes',
          id: 'rIdEn',
          xml: part(
            'endnotes',
            `<w:endnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:endnote><w:endnote w:id="1">${para('<w:r><w:endnoteRef/></w:r>' + run(' Publication list at scholar.example.test.'))}</w:endnote>`,
          ),
        },
      },
    },
  ),
);

// Text Word doesn't show: tracked deletions and moves, comments, hidden runs,
// field instructions, content-control properties, the glossary.
write(
  'docx-hidden-content.docx',
  docx(
    P(NAME) +
      para(
        run('Staff Engineer, Sablewood Finance. ') +
          `<w:ins w:id="1" w:author="Rowan" w:date="2026-09-02T10:00:00Z">${run('Promoted to Principal Engineer in 2024. ')}</w:ins>` +
          '<w:del w:id="2" w:author="Rowan" w:date="2026-09-02T10:00:00Z"><w:r><w:delText xml:space="preserve">Let go from Globexcorp after a reorganization. </w:delText></w:r></w:del>',
      ) +
      para('<w:commentRangeStart w:id="0"/>' + run('Led the payments platform, 2019 – 2024') + '<w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r>') +
      para(`<w:moveFrom w:id="3" w:author="Rowan" w:date="2026-09-02T10:00:00Z">${run('Relocated sentence about Rust.')}</w:moveFrom>`) +
      P('Skills: Go, Rust, PostgreSQL') +
      para(`<w:moveTo w:id="4" w:author="Rowan" w:date="2026-09-02T10:00:00Z">${run('Relocated sentence about Rust.')}</w:moveTo>`) +
      para(run('Keywords: kubernetes kubernetes kubernetes', '<w:vanish/>') + run('Mentored six engineers.') + run(' Visible run.', '<w:vanish w:val="0"/>')) +
      para(run('Updated ') + field('DATE \\@ "MMMM yyyy"', 'September 2026')) +
      `<w:sdt><w:sdtPr><w:alias w:val="Location"/><w:tag w:val="location"/><w:placeholder><w:docPart w:val="DefaultPlaceholder"/></w:placeholder></w:sdtPr><w:sdtContent>${P('Portland, Oregon')}</w:sdtContent></w:sdt>` +
      sectPr(),
    {
      parts: {
        'comments.xml': {
          kind: 'comments',
          id: 'rIdCm',
          xml: part('comments', `<w:comment w:id="0" w:author="Reviewer" w:initials="RV">${P('Reviewer note: double-check these dates')}</w:comment>`),
        },
        'glossary/document.xml': {
          kind: 'glossary',
          id: 'rIdGl',
          xml: part('glossaryDocument', `<w:docParts><w:docPart><w:docPartBody>${P('Click or tap here to enter text.')}</w:docPartBody></w:docPart></w:docParts>`),
        },
      },
    },
  ),
);

// ------------------------------------------------------------------ ODT

const ODF_NS = [
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"',
  'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"',
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"',
  'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"',
  'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"',
  'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"',
  'xmlns:xlink="http://www.w3.org/1999/xlink"',
  'xmlns:dc="http://purl.org/dc/elements/1.1/"',
  'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"',
  'office:version="1.3"',
].join(' ');
const tp = (inner) => `<text:p text:style-name="Standard">${inner}</text:p>`;
const ta = (url, text) => `<text:a xlink:type="simple" xlink:href="${x(url)}">${x(text)}</text:a>`;

function odt(body, masterPage = '') {
  return zip([
    ['mimetype', 'application/vnd.oasis.opendocument.text', { store: true }],
    [
      'content.xml',
      `<?xml version="1.0" encoding="UTF-8"?>\n<office:document-content ${ODF_NS}><office:automatic-styles/><office:body><office:text>${body}</office:text></office:body></office:document-content>`,
    ],
    [
      'styles.xml',
      `<?xml version="1.0" encoding="UTF-8"?>\n<office:document-styles ${ODF_NS}><office:styles><style:style style:name="Standard" style:family="paragraph"/></office:styles><office:master-styles><style:master-page style:name="Standard" style:page-layout-name="pm1">${masterPage}</style:master-page></office:master-styles></office:document-styles>`,
    ],
    [
      'META-INF/manifest.xml',
      '<?xml version="1.0" encoding="UTF-8"?>\n<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/></manifest:manifest>',
    ],
  ]);
}

write(
  'resume.odt',
  odt(
    `<text:h text:outline-level="1">${NAME}</text:h>` +
      tp('Staff engineer · résumé') +
      tp(`${EMAIL} · Portland, Oregon · ${ta(LINKEDIN, 'LinkedIn')}`) +
      '<text:h text:outline-level="2">Experience</text:h>' +
      tp('Staff Engineer, Quillfeather Labs, 2021 – Present') +
      tp('Skills: TypeScript,<text:s/>Postgres,<text:tab/>Rust'),
  ),
);

// ODF keeps page headers and footers in styles.xml, not with the body.
write(
  'odt-header-footer.odt',
  odt(
    '<text:tracked-changes text:track-changes="false"><text:changed-region xml:id="ct1" text:id="ct1"><text:deletion><office:change-info><dc:creator>Rowan</dc:creator></office:change-info><text:p>Let go from Globexcorp</text:p></text:deletion></text:changed-region></text:tracked-changes>' +
      tp('Résumé') +
      tp(
        '<draw:frame draw:name="Sidebar" text:anchor-type="paragraph" svg:width="2in"><draw:text-box><text:p>Sidebar skills: Rust, WebAssembly</text:p></draw:text-box><svg:title>Decorative sidebar</svg:title></draw:frame>Summary: embedded engineer, eight years.',
      ) +
      tp(
        'Certified Rust trainer<text:note text:id="ftn1" text:note-class="footnote"><text:note-citation>1</text:note-citation><text:note-body><text:p>Credential RT-5512.</text:p></text:note-body></text:note>, 2022.',
      ) +
      tp('Led the firmware team<office:annotation><dc:creator>Reviewer</dc:creator><text:p>Reviewer note: check this</text:p></office:annotation> of seven engineers.'),
    `<style:header>${tp(`${NAME} · ${EMAIL}`)}</style:header><style:footer>${tp(`${ta('https://rowan.example.test/portfolio', 'Portfolio')} · Page <text:page-number text:select-page="current">1</text:page-number>`)}</style:footer>`,
  ),
);

// ------------------------------------------------------------------ RTF

write(
  'resume.rtf',
  Buffer.from(
    String.raw`{\rtf1\ansi\ansicpg1252\deff0{\fonttbl{\f0\fswiss\fcharset0 Helvetica;}}
{\colortbl;\red0\green0\blue0;}
{\info{\author Rowan Q. Testperson}{\title Private title}}
\pard\f0\fs32\b Rowan Q. Testperson\b0\fs22\par
Staff engineer \'b7 r\'e9sum\'e9\par
rowan.testperson@example.test \'b7 Portland, Oregon \'b7 {\field{\*\fldinst{HYPERLINK "https://www.linkedin.com/in/rowan-testperson"}}{\fldrslt{\ul LinkedIn}}}\par
\par
{\b Experience}\par
Staff Engineer, Quillfeather Labs, 2021 \endash  Present\par
Skills: TypeScript, Postgres, Rust\par
}`,
    'latin1',
  ),
);

// Unicode escapes, legacy code pages, fields, notes, a text box and binary data.
write(
  'rtf-unicode-fields.rtf',
  Buffer.from(
    String.raw`{\rtf1\ansi\ansicpg1252\uc1\deff0{\fonttbl{\f0\froman\fcharset0 Times New Roman;}{\f1\fnil\fcharset204 Arial Cyr;}{\f2\fnil\fcharset2 Symbol;}}
{\*\generator Hand-written for the tests;}
{\header \pard\plain Header: rowan.testperson@example.test\par}
{\footer \pard\plain Footer: page 1\par}
\pard\plain\f0 Zo\u235? M\u252?ller \u8212? r\'e9sum\'e9\par
Languages: \u26085?\u26412?\u35486? and {\f1 \'c8\'e2\'e0\'ed}\par
Rocket \u-10179?\u-8576? launch\par
Caf\'e9 \'93quoted\'94 \'96 dash {\f2 \'b7}\par
{\field{\*\fldinst{HYPERLINK "https://github.com/rowan-testperson" \\o "My code"}}{\fldrslt{GitHub}}} and {\field{\*\fldinst HYPERLINK "https://rowan.example.test/"}{\fldrslt https://rowan.example.test/}}\par
{\*\bkmkstart exp}{\*\bkmkend exp}{\*\unknowndestination Secret destination text}Certified trainer{\super\chftn}{\footnote\pard\plain{\super\chftn} Footnote: credential KX-4410.\par}, 2025.\par
{\shp{\*\shpinst\shpleft0\shptop0\shpright3000\shpbottom1000{\sp{\sn wzDescription}{\sv Alt text}}{\shptxt\pard\plain Sidebar: Rust, Go\par}}{\shprslt{\*\do\dobxcolumn{\dptxbxtext\pard\plain Sidebar: Rust, Go\par}}}}\par
{\pict\wmetafile8\picw10\pich10\bin8 {}\}{\\{}After the picture.\par
}`,
    'latin1',
  ),
);

// ------------------------------------------------------------------ TXT

const TEXT = [NAME, 'Staff engineer · résumé', `${EMAIL} · Portland, Oregon`, `LinkedIn: ${LINKEDIN}`, '', 'Experience', 'Staff Engineer, Quillfeather Labs, 2021 – Present', ''].join('\n');
write('resume.txt', Buffer.from(TEXT, 'utf8'));
const utf16be = (s) => Buffer.from(s, 'utf16le').swap16();
write('resume-utf16le-bom.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(TEXT, 'utf16le')]));
write('resume-utf16be-bom.txt', Buffer.concat([Buffer.from([0xfe, 0xff]), utf16be(TEXT)]));
write('resume-utf16le-no-bom.txt', Buffer.from(TEXT, 'utf16le'));
// Windows-1252 bytes 0x80–0x9F: the smart quotes, dashes and bullets Notepad writes.
{
  const CP1252 = { '€': 0x80, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97 };
  const text = `${NAME}\r\nStaff engineer · résumé\r\n“Pragmatic” — it’s true • Salary € negotiable – ${EMAIL}\r\n`;
  write('resume-cp1252.txt', Buffer.from([...text].map((c) => CP1252[c] ?? c.charCodeAt(0))));
}

// ------------------------------------------------------------------ HTML

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Rowan's r&eacute;sum&eacute; (page title)</title>
<style>body { font-family: Georgia; } .x::after { content: "styletext"; }</style>
<script>var tracking = "scripttext";</script>
</head>
<body>
<h1>${NAME}</h1>
<p>Staff engineer &middot; r&eacute;sum&eacute;</p>
<p><a href="mailto:${EMAIL}">${EMAIL}</a> &middot; <a href="${LINKEDIN}">LinkedIn</a> &middot; Portland, Oregon</p>
<h2>Experience</h2>
<table><tr><td>Staff Engineer, Quillfeather Labs</td><td>2021 &ndash; Present</td></tr></table>
<ul><li>Led the search rewrite &amp; cut p95 latency by 40%.</li><li>1 &lt; 2 &#8212; always</li></ul>
<!-- <p>commented-out text</p> -->
</body>
</html>
`;
write('resume.html', Buffer.from(HTML, 'utf8'));

// Word's "Single File Web Page": MIME, quoted-printable, Windows-1252, plus an image part.
{
  const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office"><head><meta http-equiv=3DContent-Type content=3D"text/html; charset=3Dwindows-1252"><!--[if gte mso 9]><xml><o:DocumentProperties><o:Author>Private author</o:Author></o:DocumentProperties></xml><![endif]--></head><body lang=3DEN-US><div class=3DWordSection1><p class=3DMsoTitle>${NAME}</p><p class=3DMsoNormal>Staff engineer =B7 r=E9sum=E9 =96 <a href=3D"${LINKEDIN}">LinkedIn</a></p><p class=3DMsoNormal>${EMAIL}</p></div></body></html>`;
  const qp = html.match(/.{1,74}/g).join('=\r\n');
  const mht = [
    'MIME-Version: 1.0',
    'Content-Type: multipart/related; boundary="----=_NextPart_01DB0000.00000000"',
    '',
    'This document is a Single File Web Page, also known as a Web Archive file.',
    '',
    '------=_NextPart_01DB0000.00000000',
    'Content-Location: file:///C:/D0000000/resume.htm',
    'Content-Transfer-Encoding: quoted-printable',
    'Content-Type: text/html; charset="windows-1252"',
    '',
    qp,
    '',
    '------=_NextPart_01DB0000.00000000',
    'Content-Location: file:///C:/D0000000/resume_files/image001.png',
    'Content-Transfer-Encoding: base64',
    'Content-Type: image/png',
    '',
    Buffer.from('not really a picture').toString('base64'),
    '',
    '------=_NextPart_01DB0000.00000000--',
    '',
  ].join('\r\n');
  write('resume.mht', Buffer.from(mht, 'latin1'));
}

// ------------------------------------------------------------------ DOC

if (process.platform === 'darwin') {
  const dir = mkdtempSync(path.join(tmpdir(), 'word-fixtures-'));
  try {
    const source = path.join(dir, 'resume.html');
    writeFileSync(
      source,
      `<html><head><meta charset="utf-8"></head><body><p><b>${NAME}</b></p><p>Staff engineer · résumé</p><p>${EMAIL} · Portland, Oregon</p><p>LinkedIn: ${LINKEDIN}</p><p><b>Experience</b></p><p>Staff Engineer, Quillfeather Labs, 2021 – Present</p><p>Skills: TypeScript, Postgres, Rust</p></body></html>`,
    );
    execFileSync('textutil', ['-convert', 'doc', '-output', path.join(here, 'resume.doc'), source]);
    console.log('resume.doc                   (textutil)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
} else {
  console.log('resume.doc skipped: it needs macOS textutil; keeping the committed file');
}
