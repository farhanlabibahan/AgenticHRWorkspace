'use client';

import { createContext, use } from 'react';
import { pipelineRowCache } from '@/lib/list-client/caches';
import { PIPELINE_KEYS, type ListInput } from '@/lib/list-client/list-key';
import { useListNav, type ListNav } from '@/lib/list-client/use-list-nav';

export type PipelineKey = (typeof PIPELINE_KEYS)[number];
export type PipelineNavInput = ListInput<PipelineKey>;
type PipelineNav = ListNav<PipelineKey> & { committed: PipelineNavInput };

const NavContext = createContext<PipelineNav | null>(null);

/** Params that change what the tiles count (the stage tab and sort don't). */
const SCOPE: PipelineKey[] = ['status', 'posting', 'client', 'q'];
export const sameScope = (a: PipelineNavInput, b: PipelineNavInput) =>
  SCOPE.every((k) => (a[k] ?? '').trim() === (b[k] ?? '').trim());

/**
 * One list navigation for the whole pipeline screen, so the header's
 * Posting/Client dropdowns and the list's tiles, rail, sort and search all
 * move the same optimistic state. A click also starts loading the target's
 * rows at once, in parallel with the server render.
 */
export function PipelineNavProvider({
  listInput,
  children,
}: {
  listInput: PipelineNavInput;
  children: React.ReactNode;
}) {
  const nav = useListNav(listInput, {
    basePath: '/pipeline',
    keys: PIPELINE_KEYS,
    onNavigate: (key, next, from) => void pipelineRowCache.ensure(key, { counts: !sameScope(next, from) }),
  });
  return <NavContext value={{ ...nav, committed: listInput }}>{children}</NavContext>;
}

export function usePipelineNav(): PipelineNav {
  const nav = use(NavContext);
  if (!nav) throw new Error('usePipelineNav needs a PipelineNavProvider');
  return nav;
}
