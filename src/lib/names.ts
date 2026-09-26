/**
 * Turning a pasted list or a spreadsheet column into names: client companies
 * and departments. Shared by the form (browser) and the upload action.
 */

export const MAX_NAMES = 500;
export const MAX_NAME_LENGTH = 120;

// "Acme, Inc." is one company: a fragment that is only a legal suffix joins the name before it.
const LEGAL_SUFFIX =
  /^(?:inc|incorporated|llc|l\.l\.c|ltd|limited|co|company|corp|corporation|plc|llp|lp|gmbh|ag|sa|s\.a|sas|sarl|srl|s\.r\.l|spa|s\.p\.a|bv|b\.v|nv|n\.v|ab|as|a\/s|oy|kk|pty\.? ?ltd|pte\.? ?ltd)\.?$/i;

// A first row that labels the column rather than naming anyone.
const HEADER =
  /^(?:names?|compan(?:y|ies)(?: names?)?|clients?(?: names?| compan(?:y|ies))?|customers?|accounts?|organi[sz]ations?|departments?|teams?)$/i;

const hasLetter = (s: string) => /\p{L}/u.test(s);

/**
 * Names typed or pasted into one field. A pasted spreadsheet column (one name
 * per line) or row (tabs) splits on those; a typed line splits on semicolons
 * if it has any, else on commas.
 */
export function splitNames(input: string): string[] {
  const text = input.replace(/\r\n?/g, '\n');
  if (/[\n\t]/.test(text)) {
    const rows = text.split('\n').map((line) => line.split('\t'));
    // One row: every cell is a name. Several: a table, so the first cell with a word in it.
    return namesFromRows(rows.length === 1 ? rows[0].map((cell) => [cell]) : rows);
  }
  const parts = text.includes(';') ? text.split(';') : joinSuffixes(text.split(','));
  return cleanNames(parts);
}

function joinSuffixes(parts: string[]): string[] {
  const out: string[] = [];
  for (const part of parts) {
    if (out.length && LEGAL_SUFFIX.test(part.trim())) out[out.length - 1] += `,${part}`;
    else out.push(part);
  }
  return out;
}

/**
 * The names in a table (a spreadsheet or pasted cells): the column under a
 * header like "Company" or "Client name" if there is one, else the first
 * column with words in it.
 */
export function namesFromRows(rows: string[][]): string[] {
  const first = rows[0] ?? [];
  const headed = first.findIndex((cell) => HEADER.test(clean(cell)));
  if (headed >= 0) return cleanNames(rows.slice(1).map((row) => row[headed] ?? ''));
  const sample = rows.slice(0, 20);
  const width = Math.max(0, ...sample.map((row) => row.length));
  let column = 0;
  while (column < width && !sample.some((row) => hasLetter(row[column] ?? ''))) column++;
  return cleanNames(rows.map((row) => row[column] ?? ''));
}

function clean(name: string): string {
  return name
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Trimmed, unquoted, with a letter in them, deduped ignoring case, clipped and capped. */
export function cleanNames(parts: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    const name = clean(part).slice(0, MAX_NAME_LENGTH).trim();
    if (!name || !hasLetter(name)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length === MAX_NAMES) break;
  }
  return out;
}
