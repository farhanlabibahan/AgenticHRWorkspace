'use client';

import { createContext, use, useEffect, useState } from 'react';
import { contactRowCache } from '@/lib/list-client/caches';
import { CONTACT_KEYS, type ListInput } from '@/lib/list-client/list-key';
import { useListNav, type ListNav } from '@/lib/list-client/use-list-nav';

export type ContactsKey = (typeof CONTACT_KEYS)[number];
export type ContactsNavInput = ListInput<ContactsKey>;
type ContactsNav = ListNav<ContactsKey> & { committed: ContactsNavInput };

const NavContext = createContext<ContactsNav | null>(null);

/**
 * One list navigation for the contacts screen: pools, tags and search all
 * move the same optimistic state, and a click starts loading the target's
 * first page alongside the server render (see usePipelineNav).
 */
export function ContactsNavProvider({
  listInput,
  children,
}: {
  listInput: ContactsNavInput;
  children: React.ReactNode;
}) {
  const nav = useListNav(listInput, {
    basePath: '/contacts',
    keys: CONTACT_KEYS,
    onNavigate: (key) => void contactRowCache.ensure(key),
  });
  return <NavContext value={{ ...nav, committed: listInput }}>{children}</NavContext>;
}

export function useContactsNav(): ContactsNav {
  const nav = use(NavContext);
  if (!nav) throw new Error('useContactsNav needs a ContactsNavProvider');
  return nav;
}

/**
 * A server promise's value once it lands (null until then, or if it fails).
 * Resolved in an effect rather than with use(): a count the list shows must
 * never hold up rows, and use() inside an already-shown Suspense boundary
 * would make a navigation wait for it.
 *
 * With `key` (the list the value describes), a value is only returned for
 * that key: after a switch to another list, null until its own lands, so a
 * total never describes the list before. A new promise for the same key (a
 * refresh) keeps the last value on show until it lands. Without a key the
 * last value always stays on show (the rail's pool counts).
 */
export function useLanded<T>(promise: Promise<T> | null, key?: string): T | null {
  const [landed, setLanded] = useState<{ key: string | undefined; value: T | null }>({ key: undefined, value: null });
  useEffect(() => {
    if (!promise) return;
    let live = true;
    promise.then(
      (value) => live && setLanded({ key, value }),
      () => live && setLanded({ key, value: null }),
    );
    return () => {
      live = false;
    };
  }, [promise, key]);
  return landed.key === key ? landed.value : null;
}
