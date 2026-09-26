import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from '@/lib/list-cursor';

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

describe('list cursors', () => {
  it('round-trips each kind', () => {
    const time = { v: 1, s: 'time', t: '2026-01-05T09:30:00.123', id: 'opp-1' } as const;
    const name = { v: 1, s: 'name', n: 'Ada Lovelace', c: 'contact-1', id: 'opp-2' } as const;
    const created = { v: 1, s: 'created', t: '2026-01-05T09:30:00.123Z', id: 'c-1' } as const;
    expect(decodeCursor(encodeCursor(time), 'time')).toEqual(time);
    expect(decodeCursor(encodeCursor(name), 'name')).toEqual(name);
    expect(decodeCursor(encodeCursor(created), 'created')).toEqual(created);
  });

  it('keeps names with unicode, quotes and backslashes intact', () => {
    for (const n of ['Zoë “Z” O\'Brien', 'back\\slash', '李小龍', '🙂 emoji', '%_\\', '']) {
      const c = { v: 1, s: 'name', n, c: 'contact-1', id: 'opp-1' } as const;
      expect(decodeCursor(encodeCursor(c), 'name')).toEqual(c);
    }
  });

  it('decodes every cursor the server can mint: the longest names, in any script', () => {
    // capName keeps 500 code points; a cursor for such a name must still page.
    const id = 'c'.repeat(25);
    for (const n of ['a'.repeat(500), '漢'.repeat(500), '🙂'.repeat(500), '\u0001'.repeat(500), 'Ω"\\'.repeat(166)]) {
      const c = { v: 1, s: 'name', n, c: id, id: 'o'.repeat(25) } as const;
      expect(decodeCursor(encodeCursor(c), 'name'), `${n.slice(0, 4)}…`).toEqual(c);
    }
  });

  it('rejects text Postgres cannot store: NUL, lone surrogates, year 0', () => {
    const t = '2026-01-05T09:30:00.123';
    for (const bad of ['a\u0000b', '\ud800', 'x\udc00', '\udc00\ud800']) {
      expect(decodeCursor(b64({ v: 1, s: 'name', n: bad, c: 'c', id: 'o' }), 'name'), JSON.stringify(bad)).toBeNull();
      expect(decodeCursor(b64({ v: 1, s: 'name', n: 'n', c: bad, id: 'o' }), 'name')).toBeNull();
      expect(decodeCursor(b64({ v: 1, s: 'time', t, id: bad }), 'time')).toBeNull();
      expect(decodeCursor(b64({ v: 1, s: 'created', t: `${t}Z`, id: bad }), 'created')).toBeNull();
    }
    expect(decodeCursor(b64({ v: 1, s: 'name', n: '🙂', c: 'c', id: 'o' }), 'name')).not.toBeNull();
    expect(decodeCursor(b64({ v: 1, s: 'time', t: '0000-01-01T00:00:00.000', id: 'o' }), 'time')).toBeNull();
    expect(decodeCursor(b64({ v: 1, s: 'created', t: '0000-01-01T00:00:00.000Z', id: 'o' }), 'created')).toBeNull();
    expect(decodeCursor(b64({ v: 1, s: 'time', t: '0001-01-01T00:00:00.000', id: 'o' }), 'time')).not.toBeNull();
  });

  it('rejects anything malformed', () => {
    expect(decodeCursor(undefined, 'time')).toBeNull();
    expect(decodeCursor('', 'time')).toBeNull();
    expect(decodeCursor(42, 'time')).toBeNull();
    expect(decodeCursor({ t: 'x' }, 'time')).toBeNull();
    expect(decodeCursor('!!!not base64!!!', 'time')).toBeNull();
    expect(decodeCursor(Buffer.from('not json').toString('base64url'), 'time')).toBeNull();
    expect(decodeCursor(b64(null), 'time')).toBeNull();
    expect(decodeCursor(b64([1, 2]), 'time')).toBeNull();
    expect(decodeCursor('a'.repeat(8_193), 'time')).toBeNull();
  });

  it('rejects oversized fields', () => {
    const t = '2026-01-05T09:30:00.123';
    expect(decodeCursor(b64({ v: 1, s: 'time', t, id: 'x'.repeat(65) }), 'time')).toBeNull();
    expect(decodeCursor(b64({ v: 1, s: 'time', t, id: '' }), 'time')).toBeNull();
    expect(decodeCursor(b64({ v: 1, s: 'name', n: 'x'.repeat(2_049), c: 'c', id: 'o' }), 'name')).toBeNull();
    expect(decodeCursor(b64({ v: 1, s: 'name', n: 'x', c: 'c'.repeat(65), id: 'o' }), 'name')).toBeNull();
    expect(decodeCursor(b64({ v: 1, s: 'name', n: 1, c: 'c', id: 'o' }), 'name')).toBeNull();
  });

  it('rejects a cursor minted for another sort or version', () => {
    const name = encodeCursor({ v: 1, s: 'name', n: 'A', c: 'c', id: 'o' });
    expect(decodeCursor(name, 'time')).toBeNull();
    expect(decodeCursor(name, 'created')).toBeNull();
    const time = encodeCursor({ v: 1, s: 'time', t: '2026-01-05T09:30:00.123', id: 'o' });
    expect(decodeCursor(time, 'name')).toBeNull();
    expect(decodeCursor(b64({ v: 2, s: 'time', t: '2026-01-05T09:30:00.123', id: 'o' }), 'time')).toBeNull();
  });

  it('rejects times that are not real instants in the cursor format', () => {
    for (const t of [
      '2026-01-05 09:30:00.123',
      '2026-01-05T09:30:00',
      '2026-01-05T09:30:00.12',
      '2026-02-30T00:00:00.000',
      '2026-13-01T00:00:00.000',
      '2026-01-05T25:00:00.000',
      "2026-01-05T09:30:00.123'; DROP TABLE x; --",
    ]) {
      expect(decodeCursor(b64({ v: 1, s: 'time', t, id: 'o' }), 'time')).toBeNull();
    }
  });
});
