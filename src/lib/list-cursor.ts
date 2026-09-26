/**
 * Keyset cursors for the long lists: an opaque, versioned position — the
 * sort key of the last row a page returned. A cursor carries no filters and
 * no tenant: every query is scoped to the session's org, so a forged cursor
 * can only move within the caller's own rows.
 *
 * Times travel as text in the database's own format (to_char, millisecond
 * precision, UTC wall time) and go back into SQL as ::timestamp(3), so no JS
 * Date or session time zone ever shifts a comparison.
 */

/** Pipeline, time in stage (stageChangedAt ASC, id ASC). */
export type TimeCursor = { v: 1; s: 'time'; t: string; id: string };
/** Pipeline, by name (contact name, contact id, opportunity id — one contact can have several). */
export type NameCursor = { v: 1; s: 'name'; n: string; c: string; id: string };
/** Contacts, newest first (createdAt DESC, id DESC). */
export type CreatedCursor = { v: 1; s: 'created'; t: string; id: string };

type Cursor = TimeCursor | NameCursor | CreatedCursor;
type CursorOf<S extends Cursor['s']> = Extract<Cursor, { s: S }>;

/**
 * Sized for the longest name a cursor can carry: names are capped at 500
 * code points where they're written (capName), up to 4 UTF-8 bytes each, or
 * 6 as a JSON escape — ~4 KB as base64url. A cursor the server mints must
 * always decode, or Load more would stop dead on that row.
 */
const MAX_RAW = 8_192;
const MAX_ID = 64;
/** In UTF-16 code units: 500 code points is at most 1,000; older, longer names still page. */
const MAX_NAME = 2_048;
const TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z?$/;
/** NUL, or a surrogate half without its pair: Postgres rejects both in text. */
const BAD_TEXT = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max && !BAD_TEXT.test(v);
const isId = (v: unknown): v is string => isText(v, MAX_ID) && v.length > 0;

/**
 * A real calendar instant in the cursor time format (2026-02-30 is not), in
 * a year Postgres has (there is no year 0).
 */
function isTime(v: unknown): v is string {
  if (typeof v !== 'string' || !TIME.test(v) || v.startsWith('0000')) return false;
  const d = new Date(v.endsWith('Z') ? v : `${v}Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 23) === v.slice(0, 23);
}

/**
 * The cursor for `sort`, or null for anything else: malformed, oversized, a
 * different version, or a cursor minted for another sort order.
 */
export function decodeCursor<S extends Cursor['s']>(raw: unknown, sort: S): CursorOf<S> | null {
  if (typeof raw !== 'string' || !raw || raw.length > MAX_RAW) return null;
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const c = value as Record<string, unknown>;
  if (c.v !== 1 || c.s !== sort || !isId(c.id)) return null;
  switch (sort) {
    case 'time':
    case 'created':
      return isTime(c.t) ? ({ v: 1, s: sort, t: c.t, id: c.id } as CursorOf<S>) : null;
    case 'name':
      return isText(c.n, MAX_NAME) && isId(c.c)
        ? ({ v: 1, s: 'name', n: c.n, c: c.c, id: c.id } as CursorOf<S>)
        : null;
    default:
      return null;
  }
}
