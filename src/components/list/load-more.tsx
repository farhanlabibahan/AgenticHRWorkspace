'use client';

import { useEffect, useEffectEvent, useRef, useSyncExternalStore, type RefObject } from 'react';
import { buttonClass } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** Past this many loaded rows, scrolling stops loading on its own; the button still works. */
export const AUTO_LOAD_LIMIT = 5_000;
/** Pages loaded automatically in a row before the reader has to scroll again. */
const BURST = 3;
/** How far below the visible area the next page starts loading. */
const LEAD_PX = 1_200;
/** Scrolling at least this far since the last automatic page starts a new burst. */
const RESCROLL_PX = 400;

const subscribeNoop = () => () => {};
const fmt = (n: number) => n.toLocaleString('en-US');

/**
 * The end of a long list: "Showing 300 of 5,101" and a real Load more
 * control (a link to ?after= before JavaScript runs, a button after). It
 * doubles as the infinite-scroll sentinel: when it comes within 1,200 px of
 * the bottom of the list's scroller, the next page loads — up to three in a
 * row until the reader scrolls again, never past 5,000 rows, never again
 * after a failure until Retry is pressed.
 */
export function LoadMore({
  scrollerRef,
  hasMore,
  status,
  loaded,
  total,
  capped = false,
  noun,
  href,
  onLoad,
  disabled = false,
}: {
  scrollerRef: RefObject<HTMLElement | null>;
  hasMore: boolean;
  status: 'idle' | 'loading' | 'error';
  loaded: number;
  /** The list's total, when known. */
  total: number | null;
  /** `total` is a floor ("10,000+"). */
  capped?: boolean;
  /** Plural, lower case: "candidates". */
  noun: string;
  /** The next page as a URL, for browsers without JavaScript. */
  href: string | null;
  onLoad: (reason: 'auto' | 'user') => void;
  /** A navigation to another list is pending: don't load this one's pages. */
  disabled?: boolean;
}) {
  const hydrated = useSyncExternalStore(subscribeNoop, () => true, () => false);
  const sentinel = useRef<HTMLDivElement>(null);
  const burst = useRef(0);
  const burstTop = useRef(0);
  const paused = loaded >= AUTO_LOAD_LIMIT;

  const auto = useEffectEvent(() => {
    const top = scrollerRef.current?.scrollTop ?? 0;
    // The reader scrolled since the last automatic page: a new burst.
    if (Math.abs(top - burstTop.current) > RESCROLL_PX) burst.current = 0;
    if (!hasMore || status !== 'idle' || disabled || paused || burst.current >= BURST) return;
    burst.current += 1;
    burstTop.current = top;
    onLoad('auto');
  });
  const onVisible = useEffectEvent((visible: boolean) => {
    if (visible) auto();
  });

  useEffect(() => {
    const el = sentinel.current;
    const root = scrollerRef.current;
    if (!el || !root || !hasMore) return;
    const io = new IntersectionObserver((entries) => onVisible(entries.some((e) => e.isIntersecting)), {
      root,
      rootMargin: `0px 0px ${LEAD_PX}px 0px`,
      threshold: 0,
    });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, scrollerRef]);

  // The observer only reports crossings, and a page landing in the same
  // frame as a scroll can hide one. So also check after each page lands and
  // on scroll (once per frame) whether the sentinel is inside the lead
  // distance.
  const recheck = useEffectEvent(() => {
    const el = sentinel.current;
    const root = scrollerRef.current;
    if (!el || !root) return;
    if (el.getBoundingClientRect().top < root.getBoundingClientRect().bottom + LEAD_PX) auto();
  });
  useEffect(() => {
    // Also when a pending switch settles: a reader already at the bottom
    // scrolls no further, so nothing else would start the next page.
    if (status === 'idle' && hasMore && !disabled) recheck();
  }, [loaded, status, hasMore, disabled]);
  useEffect(() => {
    const root = scrollerRef.current;
    if (!root || !hasMore) return;
    let frame = 0;
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(() => ((frame = 0), recheck()));
    };
    root.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      root.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(frame);
    };
  }, [hasMore, scrollerRef]);

  if (!hasMore) {
    return loaded > 0 ? (
      <p className="px-4 py-4 text-xs tabular-nums text-ink-2">
        {loaded === 1 ? `1 ${noun.replace(/s$/, '')} shown` : `All ${fmt(loaded)} shown`}
      </p>
    ) : null;
  }

  const of = total === null ? '' : ` of ${fmt(total)}${capped ? '+' : ''}`;
  const label =
    status === 'loading' ? 'Loading…' : status === 'error' ? "Couldn't load more. Retry" : 'Load 100 more';
  const cls = buttonClass({ variant: 'secondary', size: 'sm' });
  // aria-disabled, not disabled: a disabled button drops keyboard focus to the page.
  const inactive = disabled || status === 'loading';

  return (
    <div ref={sentinel} className="flex items-center justify-between gap-3 px-4 py-4">
      <span className="text-xs tabular-nums text-ink-2">
        Showing {fmt(loaded)}
        {of}
        {paused ? '. Load more, or narrow with search' : ''}
      </span>
      {hydrated ? (
        <button
          type="button"
          onClick={() => {
            if (inactive) return;
            burst.current = 0;
            burstTop.current = scrollerRef.current?.scrollTop ?? 0;
            onLoad('user');
          }}
          aria-disabled={inactive || undefined}
          className={cn(cls, inactive && 'opacity-60')}
        >
          {label}
        </button>
      ) : href ? (
        <a href={href} className={cls}>
          Load 100 more
        </a>
      ) : null}
    </div>
  );
}
