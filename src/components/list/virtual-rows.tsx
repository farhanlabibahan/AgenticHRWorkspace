'use client';

import { useEffect, useMemo, useState, type RefObject } from 'react';
import { defaultRangeExtractor, useVirtualizer, type Range } from '@tanstack/react-virtual';

/**
 * Windowing for long tables, engaged only past VIRTUALIZE_AT loaded rows. A
 * first page and ordinary use stay plain DOM — nothing to hydrate
 * differently, and find-in-page and screen-reader browse mode see every
 * row. Past it only the rows near the viewport (plus the focused one, so
 * Tab never falls out of the table) are in the DOM; spacer rows stand in
 * for the rest.
 */
export const VIRTUALIZE_AT = 300;
/**
 * Below it, rows mount a few at a time: a new list mounts what fits on a tall
 * screen in its first frame, and every addition (a list switch, an appended
 * page) mounts CHUNK rows per task after that — so no mount holds the main
 * thread long enough to stall a click or a scroll. (A 100-row page in one
 * commit took 70-175 ms on a busy machine.)
 */
export const FIRST_ROWS = 30;
export const CHUNK = 25;

export type Slot<R> = { kind: 'row'; row: R; index: number } | { kind: 'gap'; key: string; height: number };

export function useWindowedRows<R extends { id: string }>({
  rows,
  listKey,
  scrollerRef,
  rowHeight,
  headerHeight,
  focusedId,
}: {
  rows: R[];
  /** Which list `rows` belong to: a new one mounts from the top again. */
  listKey: string;
  scrollerRef: RefObject<HTMLElement | null>;
  rowHeight: number;
  /** Height of the sticky header above the first row, inside the scroller. */
  headerHeight: number;
  /** The row holding focus, kept rendered wherever it is. */
  focusedId: string | null;
}) {
  const windowed = rows.length > VIRTUALIZE_AT;
  // How many rows (from the top) are mounted, for plain-DOM lists. The first
  // render mounts everything: that's the server's page, hydrating.
  const [mount, setMount] = useState({ key: listKey, n: rows.length });
  let mounted = mount.n;
  if (mount.key !== listKey) {
    mounted = Math.min(rows.length, FIRST_ROWS);
    setMount({ key: listKey, n: mounted });
  }
  const complete = windowed || mounted >= rows.length;
  useEffect(() => {
    if (complete) return;
    // After this frame paints, the next few rows, in a task of their own.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const frame = requestAnimationFrame(() => {
      timer = setTimeout(() =>
        setMount((m) => (m.key === listKey ? { key: listKey, n: Math.max(m.n, mounted) + CHUNK } : m)),
      );
    });
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [complete, mounted, listKey]);

  const focusedIndex = useMemo(
    () => (windowed && focusedId ? rows.findIndex((r) => r.id === focusedId) : -1),
    [windowed, focusedId, rows],
  );
  const virtualizer = useVirtualizer({
    count: rows.length,
    enabled: windowed,
    getScrollElement: () => scrollerRef.current,
    estimateSize: () => rowHeight,
    overscan: 10,
    paddingStart: headerHeight,
    getItemKey: (i) => rows[i]?.id ?? i,
    useFlushSync: false,
    rangeExtractor: (range: Range) => {
      const out = defaultRangeExtractor(range);
      if (focusedIndex >= 0 && !out.includes(focusedIndex)) {
        out.push(focusedIndex);
        out.sort((a, b) => a - b);
      }
      return out;
    },
  });

  let slots: Slot<R>[];
  if (!windowed) {
    const n = Math.min(rows.length, mounted);
    slots = [];
    for (let index = 0; index < n; index++) slots.push({ kind: 'row', row: rows[index], index });
  } else {
    slots = [];
    let end = headerHeight;
    for (const item of virtualizer.getVirtualItems()) {
      const row = rows[item.index];
      if (!row) continue;
      if (item.start > end) slots.push({ kind: 'gap', key: `gap-${item.index}`, height: item.start - end });
      slots.push({ kind: 'row', row, index: item.index });
      end = item.end;
    }
    const rest = virtualizer.getTotalSize() - end;
    if (rest > 0) slots.push({ kind: 'gap', key: 'gap-end', height: rest });
  }

  return {
    windowed,
    slots,
    /** Every row that should be in the DOM is (nothing left to mount). */
    complete,
    /** Scroll a row into the window (before focusing it). */
    scrollToIndex: (index: number) => {
      if (windowed) virtualizer.scrollToIndex(index, { align: 'center' });
    },
  };
}
