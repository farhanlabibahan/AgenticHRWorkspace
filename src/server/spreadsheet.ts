import { parseCsv } from '@/lib/csv';
import { decodeText } from '@/server/text/txt';
import { parseRels, scanXmlNs } from '@/server/text/xml';
import { ZipReader } from '@/server/text/zip';

/**
 * The cells of the first sheet of an uploaded spreadsheet: CSV, TSV or
 * semicolon CSV in any common text encoding, or Excel .xlsx. The ZIP and XML
 * readers are the resume extractor's: size-capped inflation, no entity
 * expansion, no recursion. Returns null when the file is neither.
 */

const MAX_ROWS = 5_000;
const MAX_COLUMNS = 50;

export function readSpreadsheet(data: Uint8Array): string[][] | null {
  const zip = ZipReader.open(data);
  if (zip) return zip.has('xl/workbook.xml') ? readXlsx(zip) : null;
  // Binary that isn't a ZIP (an old .xls, an image) has NULs; text never does.
  if (data.subarray(0, 4096).includes(0) && !isUtf16(data)) return null;
  const text = decodeText(data);
  const firstLine = text.slice(0, text.search(/\r|\n|$/));
  const delimiter = [',', ';', '\t'].reduce((best, d) => (count(firstLine, d) > count(firstLine, best) ? d : best), ',');
  return parseCsv(text, delimiter).slice(0, MAX_ROWS).map((row) => row.slice(0, MAX_COLUMNS));
}

const count = (s: string, ch: string) => s.split(ch).length - 1;
const isUtf16 = (b: Uint8Array) => (b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff);

const NS: Record<string, string> = {
  'http://schemas.openxmlformats.org/spreadsheetml/2006/main': 'x',
  'http://purl.oclc.org/ooxml/spreadsheetml/main': 'x',
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships': 'r',
  'http://purl.oclc.org/ooxml/officeDocument/relationships': 'r',
};

function readXlsx(zip: ZipReader): string[][] {
  const strings = sharedStrings(zip.text('xl/sharedStrings.xml'));
  const sheet = zip.text(firstSheetPath(zip)) ?? zip.text('xl/worksheets/sheet1.xml');
  if (!sheet) return [];

  const rows: string[][] = [];
  let row: string[] | null = null;
  let cell: { col: number; type: string } | null = null;
  let value = '';
  let inValue = false;
  let nextCol = 0;
  scanXmlNs(sheet, NS, {
    open(name, attr) {
      if (name === 'x:row') {
        if (rows.length >= MAX_ROWS) return;
        row = [];
        nextCol = 0;
      } else if (name === 'x:c' && row) {
        const col = columnIndex(attr('r')) ?? nextCol;
        nextCol = col + 1;
        cell = { col, type: attr('t') ?? 'n' };
        value = '';
      } else if (cell && (name === 'x:v' || name === 'x:t')) {
        inValue = true;
      }
    },
    close(name) {
      if (name === 'x:v' || name === 'x:t') inValue = false;
      else if (name === 'x:c' && row && cell) {
        const text =
          cell.type === 's'
            ? (strings[Number(value)] ?? '')
            : cell.type === 'e' // #N/A, #REF!: a broken formula, not a value
              ? ''
              : cell.type === 'b'
                ? (value === '1' ? 'TRUE' : 'FALSE')
                : value;
        if (cell.col < MAX_COLUMNS && text) row[cell.col] = text;
        cell = null;
      } else if (name === 'x:row' && row) {
        rows.push(Array.from(row, (c) => c ?? ''));
        row = null;
      }
    },
    text(text) {
      if (inValue) value += text;
    },
  });
  return rows;
}

/** The first sheet in the workbook's order, through its relationship; sheet1.xml when that fails. */
function firstSheetPath(zip: ZipReader): string {
  let id: string | null = null;
  scanXmlNs(zip.text('xl/workbook.xml') ?? '', NS, {
    open(name, attr) {
      if (name === 'x:sheet' && id === null) id = attr('r:id');
    },
    close() {},
    text() {},
  });
  const target = id ? parseRels(zip.text('xl/_rels/workbook.xml.rels')).get(id)?.target : null;
  if (!target) return 'xl/worksheets/sheet1.xml';
  return target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
}

/** Shared strings in order: the text runs of each <si>, without phonetic guides. */
function sharedStrings(xml: string | null): string[] {
  const out: string[] = [];
  if (!xml) return out;
  let current: string | null = null;
  let inText = false;
  let phonetic = 0;
  scanXmlNs(xml, NS, {
    open(name) {
      if (name === 'x:si') current = '';
      else if (name === 'x:rPh') phonetic++;
      else if (name === 'x:t' && current !== null && !phonetic) inText = true;
    },
    close(name) {
      if (name === 'x:t') inText = false;
      else if (name === 'x:rPh') phonetic--;
      else if (name === 'x:si' && current !== null) {
        out.push(current);
        current = null;
      }
    },
    text(text) {
      if (inText && current !== null) current += text;
    },
  });
  return out;
}

/** "C12" → 2. */
function columnIndex(ref: string | null): number | null {
  const letters = ref?.match(/^[A-Z]+/i)?.[0];
  if (!letters) return null;
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
