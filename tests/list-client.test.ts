import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ListPage, PipelineRow } from '@/lib/list-types';
import { applyListOp, type ListOp, type ListState } from '@/lib/list-client/list-ops';
import { appendPage, initialKeyset, mergeFirstPage } from '@/lib/list-client/use-keyset-list';
import { createRowCache } from '@/lib/list-client/row-cache';
import { inputFromKey, listHref, listKey, PIPELINE_KEYS } from '@/lib/list-client/list-key';

vi.mock('@/components/toaster', () => ({ toast: vi.fn() }));

const row = (id: string, stageId = 's1'): PipelineRow => ({
  id,
  contactId: `c-${id}`,
  name: id,
  headline: null,
  location: null,
  email: null,
  phone: null,
  link: null,
  stageId,
  daysInStage: '3d',
  days: 3,
});
const page = (ids: string[], endCursor: string | null = null): ListPage<{ id: string }> => ({
  rows: ids.map((id) => ({ id })),
  endCursor,
  hasMore: endCursor !== null,
});
const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

describe('applyListOp', () => {
  const hired = new Set(['s9']);
  const base: ListState = { rows: [row('a'), row('b'), row('c', 's2')], counts: { s1: 2, s2: 1 }, total: 3 };

  it('moves and removes, re-counting the tiles', () => {
    const moved = applyListOp(base, { type: 'move', ids: ['a'], stageId: 's2' }, 's1', false, hired);
    expect(ids(moved.rows)).toEqual(['b', 'c']);
    expect(moved.counts).toEqual({ s1: 1, s2: 2 });
    const removed = applyListOp(base, { type: 'remove', ids: ['b'] }, '', false, hired);
    expect(ids(removed.rows)).toEqual(['a', 'c']);
    expect(removed.total).toBe(2);
  });

  it('is idempotent: applying an op to rows that already carry it changes nothing', () => {
    const ops: ListOp[] = [
      { type: 'move', ids: ['a', 'c'], stageId: 's2' },
      { type: 'remove', ids: ['a'] },
    ];
    for (const op of ops) {
      const once = applyListOp(base, op, '', false, hired);
      const twice = applyListOp({ ...once, counts: once.counts, total: once.total }, op, '', false, hired);
      expect(twice.rows).toEqual(once.rows);
      expect(twice.counts).toEqual(once.counts);
      expect(twice.total).toBe(once.total);
    }
  });
});

describe('keyset store', () => {
  const s = (loadedIds: string[], firstIds: string[], pages: number) => ({
    ...initialKeyset('k', page(firstIds, 'c1')),
    rows: loadedIds.map((id) => ({ id })),
    pages,
    endCursor: 'tail',
    hasMore: true,
  });

  it('takes a new first page outright when only the first page was loaded', () => {
    const next = mergeFirstPage(s(['a', 'b'], ['a', 'b'], 1), page(['x', 'a'], 'c2'));
    expect(ids(next.rows)).toEqual(['x', 'a']);
    expect(next.endCursor).toBe('c2');
  });

  it('keeps the tail after the anchor, minus rows the new page has, and the tail cursor', () => {
    const loaded = s(['a', 'b', 'c', 'd', 'e', 'f'], ['a', 'b', 'c'], 2);
    // b left the list; x was inserted; d moved up into the first page.
    const next = mergeFirstPage(loaded, page(['x', 'a', 'c', 'd'], 'c9'));
    expect(ids(next.rows)).toEqual(['x', 'a', 'c', 'd', 'e', 'f']);
    expect(next.endCursor).toBe('tail');
    expect(next.hasMore).toBe(true);
  });

  it('keeps a row an insert pushed past the first page', () => {
    const loaded = s(['a', 'b', 'c', 'd', 'e'], ['a', 'b', 'c'], 2);
    const next = mergeFirstPage(loaded, page(['x', 'a', 'b'], 'c9'));
    expect(ids(next.rows)).toEqual(['x', 'a', 'b', 'c', 'd', 'e']);
  });

  it('drops rows before the anchor that are gone from the new page', () => {
    const loaded = s(['a', 'b', 'c', 'd', 'e'], ['a', 'b', 'c'], 2);
    const next = mergeFirstPage(loaded, page(['a', 'c', 'd'], 'c9'));
    expect(ids(next.rows)).toEqual(['a', 'c', 'd', 'e']);
  });

  it('starts over when the anchor is missing or the list fits one page', () => {
    const loaded = s(['a', 'b', 'c', 'd'], ['a', 'b'], 2);
    expect(ids(mergeFirstPage(loaded, page(['y', 'z'], 'c3')).rows)).toEqual(['y', 'z']);
    const small = mergeFirstPage(loaded, page(['a', 'b']));
    expect(ids(small.rows)).toEqual(['a', 'b']);
    expect(small.hasMore).toBe(false);
  });

  it('appends pages first-seen-wins', () => {
    const next = appendPage(s(['a', 'b'], ['a', 'b'], 1), page(['b', 'c'], 'c3'));
    expect(ids(next.rows)).toEqual(['a', 'b', 'c']);
    expect(next.pages).toBe(2);
    expect(next.endCursor).toBe('c3');
  });
});

describe('row cache', () => {
  let calls: string[] = [];
  let hold: ((body: unknown) => void)[] = [];
  beforeEach(() => {
    calls = [];
    hold = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init: RequestInit) => {
        calls.push(url);
        return new Promise((resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          hold.push((body) => resolve(new Response(JSON.stringify(body), { status: 200 })));
        });
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  const settle = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };

  it('dedupes requests in flight and serves the landed page', async () => {
    const cache = createRowCache<{ id: string }>('/api/lists/pipeline');
    const a = cache.ensure('stage=x');
    const b = cache.prefetch('stage=x');
    await settle();
    expect(calls).toEqual(['/api/lists/pipeline?stage=x&limit=100']);
    hold[0](page(['r1']));
    expect(await a).toEqual(page(['r1']));
    expect(await b).toEqual(page(['r1']));
    expect(cache.get('stage=x')?.rows).toEqual([{ id: 'r1' }]);
  });

  it('asks for counts only when told to', async () => {
    const cache = createRowCache<{ id: string }>('/api/lists/pipeline');
    void cache.ensure('', { counts: true });
    await settle();
    expect(calls).toEqual(['/api/lists/pipeline?limit=100&counts=1']);
  });

  it('runs at most two background requests, but a click goes at once', async () => {
    const cache = createRowCache<{ id: string }>('/api/lists/pipeline');
    for (const k of ['a=1', 'a=2', 'a=3', 'a=4']) void cache.prefetch(k);
    await settle();
    expect(calls).toHaveLength(2);
    void cache.ensure('a=4');
    await settle();
    expect(calls.at(-1)).toContain('a=4');
    expect(calls).toHaveLength(3);
    // The click counts toward the two: a=3 starts once two have finished.
    hold[0](page([]));
    await settle();
    await settle();
    expect(calls).toHaveLength(3);
    hold[1](page([]));
    await settle();
    await settle();
    expect(calls).toHaveLength(4);
    expect(calls.at(-1)).toContain('a=3');
  });

  it('forgets entries after the TTL', async () => {
    vi.useFakeTimers();
    const cache = createRowCache<{ id: string }>('/x', { ttl: 1_000 });
    cache.put('k', page(['a']));
    expect(cache.get('k')).toBeDefined();
    vi.advanceTimersByTime(1_001);
    expect(cache.get('k')).toBeUndefined();
  });

  it('keeps a stale page to show while a switch is pending, and while it loads again', async () => {
    vi.useFakeTimers();
    const cache = createRowCache<{ id: string }>('/api/lists/pipeline', { ttl: 1_000, maxStale: 10_000 });
    cache.put('k=1', page(['old']));
    vi.advanceTimersByTime(5_000);
    // Stale: not fresh enough to skip a request, still fine to show.
    expect(cache.get('k=1')).toBeUndefined();
    expect(cache.peek('k=1')?.rows).toEqual([{ id: 'old' }]);
    const next = cache.ensure('k=1');
    await settle();
    expect(calls).toEqual(['/api/lists/pipeline?k=1&limit=100']);
    expect(cache.peek('k=1')?.rows).toEqual([{ id: 'old' }]); // on show while it loads
    hold[0](page(['new']));
    await next;
    expect(cache.get('k=1')?.rows).toEqual([{ id: 'new' }]);
    expect(cache.peek('k=1')?.rows).toEqual([{ id: 'new' }]);
    // Too old to show at all.
    vi.advanceTimersByTime(10_001);
    expect(cache.peek('k=1')).toBeUndefined();
  });

  it('keeps the stale page when loading it again fails', async () => {
    vi.useFakeTimers();
    const cache = createRowCache<{ id: string }>('/x', { ttl: 1_000, maxStale: 10_000 });
    cache.put('k=1', page(['old']));
    vi.advanceTimersByTime(2_000);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
    expect(await cache.prefetch('k=1')).toBeUndefined();
    expect(cache.peek('k=1')?.rows).toEqual([{ id: 'old' }]);
    expect(cache.get('k=1')).toBeUndefined();
  });

  it('evicts the least recently used past its size', () => {
    const cache = createRowCache<{ id: string }>('/x', { max: 24 });
    for (let i = 0; i < 25; i++) cache.put(`k=${i}`, page([String(i)]));
    expect(cache.get('k=0')).toBeUndefined();
    expect(cache.get('k=1')).toBeDefined();
    cache.get('k=1');
    cache.put('k=25', page(['25']));
    expect(cache.get('k=2')).toBeUndefined();
  });

  it('clear() aborts requests in flight and drops everything', async () => {
    const cache = createRowCache<{ id: string }>('/x');
    const p = cache.ensure('k');
    cache.put('j', page(['j']));
    const gen = cache.generation();
    cache.clear();
    expect(await p).toBeUndefined();
    expect(cache.get('j')).toBeUndefined();
    expect(cache.generation()).toBe(gen + 1);
  });

  it('backs off after a server error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
    const cache = createRowCache<{ id: string }>('/x');
    expect(await cache.prefetch('k')).toBeUndefined();
    expect(cache.backedOff()).toBe(true);
  });

  it('is cleared by any settled edit (mutationBus)', async () => {
    const { pipelineRowCache } = await import('@/lib/list-client/caches');
    const { mutationBus } = await import('@/lib/optimistic');
    pipelineRowCache.put('stage=x', page(['a']) as never);
    mutationBus.emit();
    expect(pipelineRowCache.get('stage=x')).toBeUndefined();
  });
});

describe('list keys', () => {
  it('orders params, drops empties, trims the search, and matches the href', () => {
    const input = { sort: 'name', stage: 's1', q: '  ada ', posting: '', status: 'archived', after: 'cursor' } as Record<string, string>;
    const key = listKey(input, PIPELINE_KEYS);
    expect(key).toBe('status=archived&stage=s1&q=ada&sort=name');
    expect(listHref('/pipeline', key)).toBe(`/pipeline?${key}`);
    expect(listKey(inputFromKey(key, PIPELINE_KEYS), PIPELINE_KEYS)).toBe(key);
    expect(listHref('/pipeline', listKey({}, PIPELINE_KEYS))).toBe('/pipeline');
  });
});
