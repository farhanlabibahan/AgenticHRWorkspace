import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { namesFromRows } from '@/lib/names';
import { readSpreadsheet } from '@/server/spreadsheet';
import { DocumentLimitError } from '@/server/text/types';
import { zip } from '../src/server/text/__tests__/fixtures/containers.mjs';

/** Reading an uploaded list of clients or departments. */

const bytes = (s: string) => new TextEncoder().encode(s);
const names = (data: Uint8Array) => namesFromRows(readSpreadsheet(data)!);

describe('readSpreadsheet', () => {
  it('reads a CSV, a semicolon CSV from European Excel, and a TSV', () => {
    expect(names(bytes('Company,Owner\n"Acme, Inc.",Rowan\nGlobex,Rowan\n'))).toEqual(['Acme, Inc.', 'Globex']);
    expect(names(bytes('﻿Company;Owner\r\nZoë Studio;Rowan\r\nGlobex;Rowan\r\n'))).toEqual(['Zoë Studio', 'Globex']);
    expect(names(bytes('Company\tOwner\nAcme\tRowan\n'))).toEqual(['Acme']);
  });

  it('reads Windows-1252 and UTF-16 exports', () => {
    const cp1252 = Uint8Array.from([...bytes('Company\nZo'), 0xeb, ...bytes(' Studio\n')]);
    expect(names(cp1252)).toEqual(['Zoë Studio']);
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Company\r\nAcme\r\n', 'utf16le')]);
    expect(names(utf16)).toEqual(['Acme']);
  });

  it('reads an Excel workbook written by openpyxl: first sheet, heading column, shared and rich strings', () => {
    const data = readFileSync(path.join(__dirname, 'support/clients.xlsx'));
    expect(names(data)).toEqual(['Acme, Inc.', 'Zoë Studio GmbH', 'Initech Labs']);
  });

  it('reads inline strings, sparse cells and a sheet the workbook names in its relationships', () => {
    const main = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
    const rels = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
    const data = zip([
      ['xl/workbook.xml', `<workbook ${main} ${rels}><sheets><sheet name="Clients" sheetId="7" r:id="rId3"/></sheets></workbook>`],
      [
        'xl/_rels/workbook.xml.rels',
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId3" Type="x" Target="/xl/worksheets/clients.xml"/></Relationships>',
      ],
      [
        'xl/worksheets/clients.xml',
        `<worksheet ${main}><sheetData>` +
          '<row r="1"><c r="C1" t="inlineStr"><is><t>Client</t></is></c></row>' +
          '<row r="2"><c r="C2" t="inlineStr"><is><r><t>Acme</t></r><r><t xml:space="preserve"> Labs</t></r></is></c></row>' +
          '<row r="3"><c r="C3" t="e"><v>#N/A</v></c></row>' +
          '<row r="4"><c r="C4" t="str"><f>A1&amp;"x"</f><v>Globex &amp; Sons</v></c></row>' +
          '</sheetData></worksheet>',
      ],
    ]);
    expect(names(data)).toEqual(['Acme Labs', 'Globex & Sons']);
  });

  it('refuses what isn’t a spreadsheet, and a workbook that inflates past the limit', () => {
    expect(readSpreadsheet(Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0]))).toBeNull(); // old .xls
    expect(readSpreadsheet(zip([['word/document.xml', '<w:document/>']]))).toBeNull();
    const bomb = zip([
      ['xl/workbook.xml', '<workbook/>'],
      ['xl/worksheets/sheet1.xml', '<worksheet>' + ' '.repeat(40 * 1024 * 1024) + '</worksheet>'],
    ]);
    expect(() => readSpreadsheet(bomb)).toThrow(DocumentLimitError);
  });
});
