import { cache } from 'react';
import { revalidateTag, unstable_cache } from 'next/cache';
import type { Prisma } from '@prisma/client';
import type { BoundedCount, StageCounts } from '@/lib/list-types';
import { loadListMeta, type ListMeta } from '@/server/list-meta';
import { pipelineCounts, type PipelineFilter } from '@/server/lists/pipeline';
import { contactsTotal, poolCounts, type ContactsInput, type PoolRef } from '@/server/lists/contacts';

/**
 * The lists' data-cache entries, and the one place that expires them.
 *
 * Tile counts depend on the scope (view, postings, search), not the stage
 * tab, so with these cached a stage switch runs one query: its rows. Every
 * write path that changes what they count calls the matching invalidate*
 * from the server layer, so Server Actions and API routes both expire them
 * before their response renders: you always see your own edits. Writers that
 * can't (another instance's in-memory cache, the CLI importers) are covered
 * by the short TTLs.
 */

export const listMetaTag = (orgId: string) => `list-meta:${orgId}`;
export const pipelineCountsTag = (orgId: string) => `pipeline-counts:${orgId}`;
export const contactCountsTag = (orgId: string) => `contact-counts:${orgId}`;

function expire(tag: string) {
  try {
    revalidateTag(tag, { expire: 0 });
  } catch {
    // Outside a request (cron, CLI, tests): nothing to expire in this process; the TTL covers it.
  }
}

/** Stages, postings, clients, departments, archive reasons or org kind changed. */
export const invalidateListMeta = (orgId: string) => expire(listMetaTag(orgId));
/** An opportunity was created, deleted, or changed status, stage, snooze, posting or contact. */
export const invalidatePipelineCounts = (orgId: string) => expire(pipelineCountsTag(orgId));
/** Contacts were created, changed, merged or removed, or pool membership changed. */
export const invalidateContactCounts = (orgId: string) => expire(contactCountsTag(orgId));

/** Everything a list shows (imports, merges). */
export function invalidateLists(orgId: string) {
  invalidateListMeta(orgId);
  invalidatePipelineCounts(orgId);
  invalidateContactCounts(orgId);
}

/** The pipeline's meta, from the data cache (5 min, expired on any change to it). */
export const getListMeta = cache(
  (orgId: string): Promise<ListMeta> =>
    unstable_cache(() => loadListMeta(orgId), ['list-meta', orgId], {
      revalidate: 300,
      tags: [listMetaTag(orgId)],
    })(),
);

/**
 * Tile counts for a scope. Keyed on everything that changes them — never the
 * stage tab — with the search normalized the way ILIKE compares it.
 */
export function cachedPipelineCounts(f: PipelineFilter): Promise<StageCounts> {
  const q = f.q?.trim().toLowerCase() ?? '';
  const scope = { view: f.view, postingIds: f.postingIds ?? null, q };
  return unstable_cache(
    () => pipelineCounts({ orgId: f.orgId, view: f.view, postingIds: f.postingIds ?? null, q: q || undefined }),
    ['pipeline-counts', f.orgId, JSON.stringify(scope)],
    { revalidate: 20, tags: [pipelineCountsTag(f.orgId)] },
  )();
}

/** The total under the contacts list (60 s). */
export function cachedContactsTotal(orgId: string, input: ContactsInput, pool: PoolRef): Promise<BoundedCount> {
  const key = JSON.stringify({ q: input.q?.trim().toLowerCase() ?? '', tag: input.tag ?? '', pool: pool?.id ?? '' });
  return unstable_cache(() => contactsTotal(orgId, input, pool), ['contacts-total', orgId, key], {
    revalidate: 60,
    tags: [contactCountsTag(orgId)],
  })();
}

/** Members per pool for the rail (2 min; dynamic segments are the expensive part). */
export function cachedPoolCounts(
  orgId: string,
  pools: { id: string; kind: 'STATIC' | 'DYNAMIC'; rules: Prisma.JsonValue }[],
): Promise<Record<string, BoundedCount>> {
  const key = JSON.stringify(pools.map((p) => [p.id, p.kind, p.rules]));
  return unstable_cache(() => poolCounts(orgId, pools), ['pool-counts', orgId, key], {
    revalidate: 120,
    tags: [contactCountsTag(orgId)],
  })();
}
