import type { ListPage, StageCounts } from '@/lib/list-types';
import { fetchListPage, ListFetchError } from '@/lib/list-client/fetch-page';

/**
 * First pages of lists the user is likely to open next — the other stage
 * tiles, whatever they point at — so a switch can paint the right rows the
 * moment it's clicked. It only ever speeds up what's displayed: the URL and
 * the server render stay the source of truth, and every navigation still
 * confirms against the server.
 *
 * Keys are list keys (list-key.ts). An entry is fresh for 30 s, and at most
 * 24 are kept; requests are deduped, and background ones run two at a time.
 * Any edit (mutationBus) clears it, as does coming back to a tab hidden for
 * 30 s.
 *
 * Past 30 s an entry is stale, not gone: for up to 5 minutes it can still be
 * shown while a switch to it is pending (peek), and loading it again keeps
 * the old page on show until the new one lands. The server's render of the
 * switch replaces it within a round trip either way, so a page someone has
 * been reading for a minute still switches at once.
 */

export type CachedPage<R> = ListPage<R> & { counts?: StageCounts };

type Entry<R> = {
  status: 'pending' | 'ready' | 'error';
  /** The latest page that landed for this key (kept while a new request runs). */
  page?: CachedPage<R>;
  /** When `page` landed. */
  pageAt: number;
  /** When this entry's request started (or its page was put). */
  at: number;
  ctrl: AbortController;
  promise: Promise<CachedPage<R> | undefined>;
  withCounts: boolean;
  /** Set while the request waits in the background queue. */
  start?: () => void;
};

export type RowCache<R> = {
  /** A fresh, loaded page for `key`, if there is one. */
  get(key: string): CachedPage<R> | undefined;
  /**
   * A page for `key` to show while a switch to it is pending: fresh, or up
   * to `maxStale` old (even while it's being loaded again).
   */
  peek(key: string): CachedPage<R> | undefined;
  /** Start loading `key` now (a click); resolves when it lands, undefined if it failed. */
  ensure(key: string, opts?: { counts?: boolean }): Promise<CachedPage<R> | undefined>;
  /** Load `key` in the background: queued behind at most two others. */
  prefetch(key: string, opts?: { counts?: boolean }): Promise<CachedPage<R> | undefined>;
  /** Remember a page the server rendered. */
  put(key: string, page: CachedPage<R>): void;
  /** Forget everything (aborting requests in flight). */
  clear(): void;
  /** True after a 429 or 5xx: background loading should stop. */
  backedOff(): boolean;
  subscribe(listener: () => void): () => void;
  /** Changes whenever an entry lands or the cache is cleared (for useSyncExternalStore). */
  version(): number;
  /** Changes only on clear(). */
  generation(): number;
};

export function createRowCache<R>(
  endpoint: string,
  {
    ttl = 30_000,
    maxStale = 300_000,
    max = 24,
    concurrency = 2,
  }: { ttl?: number; maxStale?: number; max?: number; concurrency?: number } = {},
): RowCache<R> {
  const entries = new Map<string, Entry<R>>();
  const listeners = new Set<() => void>();
  const queue: (() => void)[] = [];
  let running = 0;
  let version = 0;
  let generation = 0;
  let backoff = false;

  const notify = () => {
    version++;
    for (const fn of listeners) fn();
  };
  const fresh = (e: Entry<R>) => Date.now() - e.at < ttl;
  const freshPage = (e: Entry<R>) => e.page !== undefined && Date.now() - e.pageAt < ttl;
  const touch = (key: string, e: Entry<R>) => {
    entries.delete(key);
    entries.set(key, e);
    while (entries.size > max) {
      const [oldest, old] = entries.entries().next().value as [string, Entry<R>];
      old.ctrl.abort();
      entries.delete(oldest);
    }
  };
  const drain = () => {
    while (running < concurrency && queue.length) queue.shift()!();
  };

  function load(key: string, withCounts: boolean, background: boolean): Promise<CachedPage<R> | undefined> {
    const existing = entries.get(key);
    if (existing && fresh(existing) && existing.status !== 'error' && (existing.withCounts || !withCounts)) {
      if (!background && existing.start) {
        // Queued behind background work, and now it's a click: go now.
        const i = queue.indexOf(existing.start);
        if (i >= 0) queue.splice(i, 1);
        existing.start();
      }
      touch(key, existing);
      return existing.promise;
    }
    const ctrl = new AbortController();
    const url = `${endpoint}?${key}${key ? '&' : ''}limit=100${withCounts ? '&counts=1' : ''}`;
    let release!: () => void;
    const started = new Promise<void>((resolve) => (release = resolve));
    let begun = false;
    // Counted as running the moment it starts, so drain() never over-starts.
    const start = () => {
      if (begun) return;
      begun = true;
      running++;
      release();
    };
    const entry: Entry<R> = {
      status: 'pending',
      // The page on show until this request lands, if there was one.
      page: existing?.page,
      pageAt: existing?.pageAt ?? 0,
      at: Date.now(),
      ctrl,
      withCounts,
      promise: started.then(async () => {
        entry.start = undefined;
        try {
          if (ctrl.signal.aborted) return undefined;
          const page = await fetchListPage<CachedPage<R>>(url, { signal: ctrl.signal, redirectOn401: false });
          if (entries.get(key) !== entry) return page; // replaced or cleared meanwhile
          entry.status = 'ready';
          entry.page = page;
          entry.at = entry.pageAt = Date.now();
          notify();
          return page;
        } catch (error) {
          if (error instanceof ListFetchError && (error.status === 429 || error.status >= 500)) backoff = true;
          if (entries.get(key) === entry) {
            entry.status = 'error';
            notify();
          }
          return undefined;
        } finally {
          running--;
          drain();
        }
      }),
    };
    touch(key, entry);
    if (background) {
      entry.start = start;
      queue.push(start);
      drain();
    } else {
      start(); // a click doesn't wait its turn
    }
    return entry.promise;
  }

  return {
    get(key) {
      const e = entries.get(key);
      if (!e || !freshPage(e)) return undefined;
      touch(key, e); // a read counts as use
      return e.page;
    },
    peek(key) {
      const e = entries.get(key);
      if (!e?.page || Date.now() - e.pageAt >= maxStale) return undefined;
      touch(key, e);
      return e.page;
    },
    ensure: (key, opts) => load(key, opts?.counts ?? false, false),
    prefetch: (key, opts) => load(key, opts?.counts ?? false, true),
    put(key, page) {
      const ctrl = new AbortController();
      const now = Date.now();
      const e: Entry<R> = {
        status: 'ready',
        page,
        pageAt: now,
        at: now,
        ctrl,
        withCounts: Boolean(page.counts),
        promise: Promise.resolve(page),
      };
      const prev = entries.get(key);
      if (prev?.status === 'pending') prev.ctrl.abort();
      touch(key, e);
      notify();
    },
    clear() {
      for (const e of entries.values()) e.ctrl.abort();
      entries.clear();
      // Let queued requests settle (as aborted) so nothing awaits them forever.
      for (const start of queue.splice(0)) start();
      backoff = false;
      generation++;
      notify();
    },
    backedOff: () => backoff,
    subscribe(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    version: () => version,
    generation: () => generation,
  };
}
