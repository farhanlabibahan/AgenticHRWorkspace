'use client';

import { startTransition, useOptimistic } from 'react';
import { useRouter } from 'next/navigation';
import { inputFromKey, listHref, listKey, type ListInput } from '@/lib/list-client/list-key';

/**
 * Navigation between a list's views (stage tiles, filters, search, sort)
 * that answers in the click's own frame. The target filters and a pending
 * flag are optimistic state set in the same transition as router.push, so
 * the tile lights up at once — React paints optimistic updates urgently,
 * even while another edit's transition is still pending — and both hold
 * until the server's render of the new URL commits.
 *
 * Links keep real hrefs (shareable, cmd-click for a new tab, back/forward,
 * no-JS); go() only takes over a plain left click.
 */
export function useListNav<K extends string>(
  committed: ListInput<K>,
  {
    basePath,
    keys,
    onNavigate,
  }: {
    basePath: string;
    keys: readonly K[];
    /** Called with the target's key as the click happens (start loading its rows). */
    onNavigate?: (key: string, input: ListInput<K>, from: ListInput<K>) => void;
  },
) {
  const router = useRouter();
  const [input, setInput] = useOptimistic(committed);
  const [pending, setPending] = useOptimistic(false);
  const current = listKey(input, keys);

  const keyFor = (over: ListInput<K>) => listKey({ ...input, ...over }, keys);
  const hrefFor = (over: ListInput<K>) => listHref(basePath, keyFor(over));

  function go(
    over: ListInput<K>,
    event?: { preventDefault(): void; defaultPrevented?: boolean } & Partial<MouseEventish>,
    { replace = false }: { replace?: boolean } = {},
  ) {
    if (event) {
      if (event.defaultPrevented) return;
      // Modified or middle clicks open a new tab: leave them to the browser.
      if (event.button !== undefined && event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
    }
    const nextKey = keyFor(over);
    if (nextKey === current) return;
    const next = inputFromKey(nextKey, keys);
    onNavigate?.(nextKey, next, input);
    startTransition(() => {
      setInput(next);
      setPending(true);
      // live search replaces the entry, so Back doesn't step through keystrokes
      const href = listHref(basePath, nextKey);
      if (replace) router.replace(href, { scroll: false });
      else router.push(href, { scroll: false });
    });
  }

  return {
    /** The filters on screen: the target's while a navigation is pending. */
    input,
    pending,
    /** The list key of `input`. */
    key: current,
    /** The list key the server rendered. */
    committedKey: listKey(committed, keys),
    keyFor,
    hrefFor,
    go,
  };
}

type MouseEventish = { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean };

export type ListNav<K extends string> = ReturnType<typeof useListNav<K>>;
