/**
 * RTF to text, in one pass over groups and control words:
 * - skips non-text destinations (font, colour and style tables, \info,
 *   pictures, \bin data, theme and datastore blobs, bookmarks, shape
 *   properties, fallbacks) and every unknown \* destination;
 * - decodes \'hh bytes in the current font's charset (or \ansicpg), and \uN
 *   with \ucN fallback skipping;
 * - keeps HYPERLINK field targets ("LinkedIn (https://…)"), puts footnotes and
 *   footers after the body, and keeps text-box (\shptxt) text once.
 * Group nesting is capped, so a hostile file can't grow the stack without bound.
 */
import { decodeBytes } from './txt';
import { collectLink, linkDisplay, linkSuffix, hyperlinkFromInstr } from './links';
import { DocumentLimitError, type AdapterOutput } from './types';

const MAX_DEPTH = 2_000;

type Target = 'main' | 'notes' | 'footer' | 'instr';
type Field = { instr: string; target: Target | null; start: number };
type State = {
  skip: boolean;
  uc: number;
  font: number;
  target: Target;
  field: Field | null;
  ownsField: boolean;
  fonttbl: boolean;
};

const SKIP_DEST = new Set([
  'fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'objdata', 'objclass', 'filetbl', 'revtbl', 'listtable',
  'listoverridetable', 'rsidtbl', 'xmlnstbl', 'themedata', 'colorschememapping', 'latentstyles', 'datastore',
  'pgdsctbl', 'mmathPr', 'xe', 'tc', 'txe', 'bkmkstart', 'bkmkend', 'pntxta', 'pntxtb', 'sp', 'shprslt',
  'nonshppict', 'shppict', 'do', 'falt', 'panose', 'generator', 'datafield', 'template', 'userprops',
  'docvar', 'fchars', 'lchars', 'author', 'operator', 'title', 'subject', 'keywords', 'comment', 'doccomm',
  'company', 'annotation', 'atnid', 'atnauthor', 'atndate', 'atnref', 'atrfstart', 'atrfend', 'defchp', 'defpap',
  'wgrffmtfilter', 'listpicture', 'htmltag', 'mhtmltag', 'blipuid', 'passwordhash', 'protusertbl', 'aftnsep',
  'aftnsepc', 'aftncn', 'ftnsep', 'ftnsepc', 'ftncn', 'ud',
]);
const KNOWN_STAR = new Set(['fldinst', 'shpinst', 'shptxt']);
const CHAR: Record<string, string> = {
  par: '\n', line: '\n', sect: '\n', page: '\n', row: '\n', lbr: '\n', softline: '\n', cell: '\t', nestcell: '\t',
  tab: '\t', emdash: '—', endash: '–', emspace: ' ', enspace: ' ', qmspace: ' ', bullet: '•',
  lquote: '‘', rquote: '’', ldblquote: '“', rdblquote: '”', zwj: '', zwnj: '', zwbo: '',
  zwnbo: '', ltrmark: '', rtlmark: '',
};
const CHARSET_CP: Record<number, string> = {
  2: 'symbol', 77: 'macintosh', 128: 'shift_jis', 129: 'euc-kr', 134: 'gbk', 136: 'big5', 161: 'windows-1253',
  162: 'windows-1254', 163: 'windows-1258', 177: 'windows-1255', 178: 'windows-1256', 186: 'windows-1257',
  204: 'windows-1251', 222: 'windows-874', 238: 'windows-1250',
};
function cpLabel(n: number): string {
  if (n >= 1250 && n <= 1258) return `windows-${n}`;
  return ({ 874: 'windows-874', 932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5', 10000: 'macintosh', 65001: 'utf-8' } as Record<number, string>)[n] ?? 'windows-1252';
}

export function rtfToText(data: Uint8Array): AdapterOutput {
  const links = new Set<string>();
  return { text: readRtf(data, links), links: [...links] };
}

export function readRtf(input: Uint8Array, links: Set<string>): string {
  // RTF is 7-bit; latin1 keeps every byte (including \bin payloads) addressable as one char.
  const s = Buffer.from(input.buffer, input.byteOffset, input.byteLength).toString('latin1');
  const startAt = s.indexOf('{\\rtf');
  if (startAt < 0 || startAt > 16) throw new Error('rtf: no {\\rtf header');

  const out: Record<Exclude<Target, 'instr'>, string[]> = { main: [], notes: [], footer: [] };
  const fontCharset = new Map<number, number>();
  let defaultCp = 'windows-1252';
  let deff = 0;
  let fontDef = -1;
  let st: State = { skip: false, uc: 1, font: 0, target: 'main', field: null, ownsField: false, fonttbl: false };
  const stack: State[] = [];
  let star = false;
  let ucSkip = 0;
  let bytes: number[] = [];

  const cpFor = (font: number) => {
    const cs = fontCharset.get(font);
    return cs === undefined || cs === 0 || cs === 1 ? defaultCp : CHARSET_CP[cs] ?? defaultCp;
  };
  const write = (t: string) => {
    if (st.skip || !t) return;
    if (st.target === 'instr') {
      if (st.field) st.field.instr += t;
      return;
    }
    out[st.target].push(t);
  };
  const flushBytes = () => {
    if (!bytes.length) return;
    const cp = cpFor(st.font);
    write(cp === 'symbol' ? ' ' : decodeBytes(Uint8Array.from(bytes), cp));
    bytes = [];
  };
  const endGroup = () => {
    flushBytes();
    const closing = st;
    st = stack.pop() ?? st;
    if (closing.ownsField && closing.field && !closing.skip) {
      const f = closing.field;
      if (f.target && f.target !== 'instr') {
        const buf = out[f.target];
        const url = hyperlinkFromInstr(f.instr);
        collectLink(links, url);
        buf.push(linkSuffix(linkDisplay(buf, f.start, url), url));
      }
    }
    ucSkip = 0;
  };

  let i = startAt;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 0x7b /* { */) {
      flushBytes();
      stack.push(st);
      st = { ...st, ownsField: false };
      star = false;
      ucSkip = 0;
      i++;
      if (stack.length > MAX_DEPTH) throw new DocumentLimitError(`RTF groups nest deeper than ${MAX_DEPTH} levels`);
      continue;
    }
    if (c === 0x7d /* } */) {
      endGroup();
      i++;
      if (stack.length === 0) break;
      continue;
    }
    if (c === 0x0d || c === 0x0a) {
      i++;
      continue;
    }
    if (c !== 0x5c /* \ */) {
      // A plain text run up to the next special character.
      let j = i;
      while (j < n) {
        const d = s.charCodeAt(j);
        if (d === 0x5c || d === 0x7b || d === 0x7d || d === 0x0d || d === 0x0a) break;
        j++;
      }
      flushBytes();
      let run = s.slice(i, j);
      if (ucSkip) {
        const k = Math.min(ucSkip, run.length);
        run = run.slice(k);
        ucSkip -= k;
      }
      if (!st.fonttbl) write(run);
      i = j;
      continue;
    }
    // Backslash: a control symbol, a hex byte, or a control word.
    const nx = s[i + 1];
    if (nx === "'") {
      const b = parseInt(s.substr(i + 2, 2), 16);
      i += 4;
      if (ucSkip) {
        ucSkip--;
        continue;
      }
      if (!Number.isNaN(b) && !st.skip && !st.fonttbl) bytes.push(b);
      continue;
    }
    if (nx === undefined) break;
    if (!/[A-Za-z]/.test(nx)) {
      flushBytes();
      i += 2;
      ucSkip = 0;
      switch (nx) {
        case '\\': case '{': case '}': write(nx); break;
        case '~': write(' '); break;
        case '_': write('-'); break;
        case '-': break;
        case '*': star = true; break;
        case '\n': case '\r': write('\n'); break;
      }
      continue;
    }
    // A control word: letters, an optional signed number, an optional space delimiter.
    let j = i + 1;
    while (j < n && j - i <= 33 && /[A-Za-z]/.test(s[j])) j++;
    const word = s.slice(i + 1, j);
    let param: number | null = null;
    let k = j;
    if (s[k] === '-' || (s[k] >= '0' && s[k] <= '9')) {
      k++;
      while (k < n && s[k] >= '0' && s[k] <= '9' && k - j < 11) k++;
      param = parseInt(s.slice(j, k), 10);
    }
    if (s[k] === ' ') k++;
    i = k;

    if (word === 'bin') {
      // A raw binary payload: skip it whole, whatever the group.
      flushBytes();
      i += Math.max(0, param ?? 0);
      continue;
    }
    if (word === 'u') {
      flushBytes();
      if (param !== null && !st.fonttbl) write(String.fromCharCode(param < 0 ? param + 65536 : param));
      ucSkip = st.uc;
      continue;
    }
    if (ucSkip) {
      // A control word inside the fallback text of a \u counts as one fallback character.
      ucSkip--;
      continue;
    }
    flushBytes();

    if (star) {
      star = false;
      if (!KNOWN_STAR.has(word)) {
        st.skip = true;
        continue;
      }
    }
    if (st.skip) continue;
    if (st.fonttbl) {
      if (word === 'f' && param !== null) fontDef = param;
      else if (word === 'fcharset' && param !== null && fontDef >= 0) fontCharset.set(fontDef, param);
      else if (word === 'cpg' && param !== null && fontDef >= 0 && !fontCharset.has(fontDef)) {
        fontCharset.set(fontDef, param === 1251 ? 204 : param === 1250 ? 238 : param === 932 ? 128 : 0);
      } else if (SKIP_DEST.has(word) && word !== 'fonttbl') st.skip = true;
      continue;
    }
    if (word in CHAR) {
      write(CHAR[word]);
      continue;
    }
    switch (word) {
      case 'fonttbl':
        st.fonttbl = true;
        break;
      case 'ansicpg':
        if (param !== null) defaultCp = cpLabel(param);
        break;
      case 'mac':
        defaultCp = 'macintosh';
        break;
      case 'deff':
        if (param !== null) deff = param;
        st.font = deff;
        break;
      case 'f':
        if (param !== null) st.font = param;
        break;
      case 'plain':
        st.font = deff;
        break;
      case 'uc':
        if (param !== null) st.uc = Math.max(0, param);
        break;
      case 'field':
        st.field = { instr: '', target: null, start: 0 };
        st.ownsField = true;
        break;
      case 'fldinst':
        st.target = 'instr';
        break;
      case 'fldrslt':
        if (st.field) {
          // The result goes wherever the field itself sits (a nested field's
          // result inside another field's instruction stays in that instruction).
          const tgt = stack[stack.length - 1]?.target ?? 'main';
          st.target = tgt;
          st.field.target = tgt;
          st.field.start = tgt === 'instr' ? 0 : out[tgt].length;
        }
        break;
      case 'footnote':
        st.target = 'notes';
        break;
      case 'footer': case 'footerl': case 'footerr': case 'footerf':
        st.target = 'footer';
        break;
      default:
        if (SKIP_DEST.has(word)) st.skip = true;
    }
  }
  flushBytes();
  return [out.main, out.notes, out.footer]
    .map((b) => b.join('').trim())
    .filter(Boolean)
    .join('\n');
}
