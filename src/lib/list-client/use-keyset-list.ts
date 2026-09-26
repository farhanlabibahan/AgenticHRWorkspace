'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ListPage } from '@/lib/list-types';
import { fetchListPage } from '@/lib/list-client/fetch-page';

/**
 * The rows a list has loaded: the server's first page plus every page the
 * user has scrolled in since, by keyset cursor. Appends are plain state
 * updates, never transitions, so a page loading never holds up a click
 * elsewhere (React entangles pending async transitions).
 */

export type KeysetState<R> = {
  key: string;
  first: ListPage<R>;
  rows: R[];
  endCursor: string | null;
  hasMore: boolean;
  pages: number;
  status: 'idle' | 'loading' | 'error';
};

export function initialKeyset<R>(key: string, first: ListPage<R>): KeysetState<R> {
  return {
    key,
    first,
    rows: first.rows,
    endCursor: first.endCursor,
    hasMore: first.hasMore,
    pages: 1,
    status: 'idle',
  };
}

/**
 * A fresh first page from the server (an edit re-rendered the page) merged
 * into what's loaded, anchored on ids rather than positions:
 *
 * - Only the first page loaded, or the list now fits in one page: take it.
 * - Otherwise find the new first page's last row in the loaded rows and keep
 *   everything after it (minus rows the new page already has). Rows before
 *   it that the new page lacks have left the list; a row an insert pushed
 *   past the first page sits after the anchor, so it stays. The cursor and
 *   hasMore still describe the loaded tail.
 * - Anchor gone (it was edited out): start again from the new first page.
 */
export function mergeFirstPage<R extends { id: string }>(s: KeysetState<R>, first: ListPage<R>): KeysetState<R> {
  const restart = { ...initialKeyset(s.key, first) };
  if (s.pages === 1 || !first.hasMore) return restart;
  const anchor = first.rows[first.rows.length - 1];
  const at = anchor ? s.rows.findIndex((r) => r.id === anchor.id) : -1;
  if (at < 0) return restart;
  const inFirst = new Set(first.rows.map((r) => r.id));
  const tail = s.rows.slice(at + 1).filter((r) => !inFirst.has(r.id));
  return { ...s, first, rows: [...first.rows, ...tail] };
}

/** Rows appended from a later page: first seen wins, so a row never shows twice. */
export function appendPage<R extends { id: string }>(s: KeysetState<R>, page: ListPage<R>): KeysetState<R> {
  const seen = new Set(s.rows.map((r) => r.id));
  return {
    ...s,
    rows: [...s.rows, ...page.rows.filter((r) => !seen.has(r.id))],
    endCursor: page.endCursor,
    hasMore: page.hasMore,
    pages: s.pages + 1,
    status: 'idle',
  };
}

export function useKeysetList<R extends { id: string }>({
  listKey,
  first,
  endpoint,
}: {
  /** The list's canonical query string (list-key.ts): a new key starts over. */
  listKey: string;
  /** The first page the server rendered for it. */
  first: ListPage<R>;
  endpoint: string;
}) {
  const [stored, setStored] = useState(() => initialKeyset(listKey, first));
  let state = stored;
  if (stored.key !== listKey) state = initialKeyset(listKey, first);
  else if (stored.first !== first) state = mergeFirstPage(stored, first);
  if (state !== stored) setStored(state);

  const latest = useRef(state);
  useEffect(() => {
    latest.current = state;
  });
  const inFlight = useRef<AbortController | null>(null);
  // A new list (or unmount) abandons the page in flight for the old one.
  useEffect(() => () => inFlight.current?.abort(), [listKey]);

  /** Load the next page. Resolves true once its rows are in state. */
  const loadMore = useCallback(async (): Promise<boolean> => {
    const s = latest.current;
    if (inFlight.current || !s.hasMore || !s.endCursor) return false;
    const ctrl = new AbortController();
    inFlight.current = ctrl;
    const key = s.key;
    setStored((prev) => (prev.key === key ? { ...prev, status: 'loading' } : prev));
    try {
      const page = await fetchListPage<ListPage<R>>(
        `${endpoint}?${key}${key ? '&' : ''}after=${encodeURIComponent(s.endCursor)}&limit=100`,
        { signal: ctrl.signal },
      );
      if (ctrl.signal.aborted) return false;
      setStored((prev) => (prev.key === key ? appendPage(prev, page) : prev));
      return true;
    } catch {
      if (!ctrl.signal.aborted) setStored((prev) => (prev.key === key ? { ...prev, status: 'error' } : prev));
      return false;
    } finally {
      if (inFlight.current === ctrl) inFlight.current = null;
    }
  }, [endpoint]);

  /**
   * Apply a saved edit to the loaded rows (the server's re-render only
   * covers the first page). Call it inside the edit's transition so it
   * commits together with that re-render.
   */
  const applyCommitted = useCallback((update: (rows: R[]) => R[]) => {
    setStored((prev) => ({ ...prev, rows: update(prev.rows) }));
  }, []);

  return {
    rows: state.rows,
    hasMore: state.hasMore,
    endCursor: state.endCursor,
    status: state.status,
    pages: state.pages,
    loadMore,
    applyCommitted,
  };
}
