'use client';

import { useRef, type ComponentProps } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { PrefetchKind } from 'next/dist/client/components/router-reducer/router-reducer-types';
import { OPEN_CANDIDATE_EVENT } from '@/components/drawer-host';

/** How long the pointer rests on a row before its profile loads: skips rows it only passes over. */
const INTENT_MS = 80;

/**
 * A link to a candidate's profile, which opens in the drawer over lists.
 *
 * Two things make that open fast:
 * - Resting the pointer on a link loads the whole profile, so it's usually
 *   there by the click. Next's own hover prefetch (dynamicOnHover) never
 *   fires for this intercepted route. Not inside an open drawer, though:
 *   there the prefetch goes out with the wrong Next-Url and the click can't
 *   use it, so it would only add requests.
 * - While a drawer is open, links behind it don't auto-prefetch. Opening the
 *   drawer changes the URL, and Next re-prefetches every visible link for
 *   the new URL. On the pipeline that was ~9 server requests fired at the
 *   moment of the click, racing the one the drawer needs (1.6s to content).
 *
 * `lazy` is for long, scrolling lists (pipeline, contacts): no prefetch as
 * rows scroll into view at all, only on pointer intent or keyboard focus.
 *
 * A plain click also tells the drawer (DrawerHost) to open right away with
 * the skeleton, so nothing waits on the server to show that it worked.
 */
export function CandidateLink({
  id,
  lazy = false,
  onPointerEnter,
  onPointerLeave,
  onFocus,
  onClick,
  ...props
}: Omit<ComponentProps<typeof Link>, 'href' | 'prefetch'> & { id: string; lazy?: boolean }) {
  const router = useRouter();
  const drawerOpen = usePathname().startsWith('/candidates/');
  const href = `/candidates/${id}`;
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const loaded = useRef(false);
  const load = () => {
    loaded.current = true;
    router.prefetch(href, { kind: PrefetchKind.FULL });
  };

  return (
    <Link
      {...props}
      href={href}
      prefetch={lazy || drawerOpen ? false : undefined}
      onPointerEnter={(e) => {
        onPointerEnter?.(e);
        if (loaded.current || drawerOpen) return;
        timer.current = setTimeout(load, INTENT_MS);
      }}
      onPointerLeave={(e) => {
        onPointerLeave?.(e);
        clearTimeout(timer.current);
      }}
      onFocus={(e) => {
        onFocus?.(e);
        if (!loaded.current && !drawerOpen) load();
      }}
      onClick={(e) => {
        onClick?.(e);
        // new tab / window, or already in the drawer (switching applications): no instant open
        if (e.defaultPrevented || drawerOpen || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        window.dispatchEvent(new Event(OPEN_CANDIDATE_EVENT));
      }}
    />
  );
}
