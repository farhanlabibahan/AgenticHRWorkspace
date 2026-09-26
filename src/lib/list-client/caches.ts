import type { ContactRow, PipelineRow } from '@/lib/list-types';
import { mutationBus } from '@/lib/optimistic';
import { createRowCache } from '@/lib/list-client/row-cache';

/** One row cache per list, shared by every mount for the life of the tab. */
export const pipelineRowCache = createRowCache<PipelineRow>('/api/lists/pipeline');
export const contactRowCache = createRowCache<ContactRow>('/api/lists/contacts');

const caches = [pipelineRowCache, contactRowCache];
const clearAll = () => caches.forEach((c) => c.clear());

// An edit may change any list: drop what we hold rather than show it stale.
mutationBus.subscribe(clearAll);

if (typeof document !== 'undefined') {
  // So may other people's edits while the tab sat in the background.
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) hiddenAt = Date.now();
    else if (hiddenAt && Date.now() - hiddenAt > 30_000) clearAll();
  });
}

/**
 * Whether background prefetching is off for this viewer: data saver, the
 * NEXT_PUBLIC_LIST_PREFETCH=off build switch, or localStorage listPrefetch
 * = off (used when measuring the uncached path).
 */
export function listPrefetchDisabled(): boolean {
  if (process.env.NEXT_PUBLIC_LIST_PREFETCH === 'off') return true;
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  if (connection?.saveData) return true;
  try {
    return window.localStorage.getItem('listPrefetch') === 'off';
  } catch {
    return false;
  }
}
