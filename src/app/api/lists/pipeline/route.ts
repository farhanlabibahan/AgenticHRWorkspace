import type { NextRequest } from 'next/server';
import { decodeCursor } from '@/lib/list-cursor';
import { getSessionContext } from '@/lib/session';
import { cachedPipelineCounts, getListMeta } from '@/server/lists/cache';
import { pipelineFilterFor, pipelinePage } from '@/server/lists/pipeline';
import { limitParam, listJson, listParams } from '@/app/api/lists/params';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KEYS = ['posting', 'client', 'stage', 'q', 'status', 'sort'] as const;

/**
 * One page of the pipeline: the same filters as /pipeline's URL, plus
 * ?after (the previous page's endCursor), ?limit (1-100) and ?counts=1 to
 * include the stage tile counts for a new scope.
 */
export async function GET(request: NextRequest) {
  const ctx = await getSessionContext();
  if (!ctx) return listJson({ error: 'unauthorized' }, 401);
  const params = request.nextUrl.searchParams;
  const input = listParams(params, KEYS);
  const sort = input.sort === 'name' ? 'name' : 'time';
  const rawAfter = params.get('after');
  const after = rawAfter ? decodeCursor(rawAfter, sort) : null;
  if (rawAfter && !after) return listJson({ error: 'bad_cursor' }, 400);

  const meta = input.client ? await getListMeta(ctx.orgId) : null;
  const f = pipelineFilterFor(ctx.orgId, input, meta);
  const [page, counts] = await Promise.all([
    pipelinePage(f, sort, { after, limit: limitParam(params) }),
    params.get('counts') === '1' ? cachedPipelineCounts(f) : null,
  ]);
  return listJson(counts ? { ...page, counts } : page);
}
