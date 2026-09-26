import type { NextRequest } from 'next/server';
import { decodeCursor } from '@/lib/list-cursor';
import { getSessionContext } from '@/lib/session';
import { contactsPage } from '@/server/lists/contacts';
import { limitParam, listJson, listParams } from '@/app/api/lists/params';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KEYS = ['q', 'tag', 'pool'] as const;

/** One page of contacts: /contacts' filters plus ?after and ?limit (1-100). */
export async function GET(request: NextRequest) {
  const ctx = await getSessionContext();
  if (!ctx) return listJson({ error: 'unauthorized' }, 401);
  const params = request.nextUrl.searchParams;
  const rawAfter = params.get('after');
  const after = rawAfter ? decodeCursor(rawAfter, 'created') : null;
  if (rawAfter && !after) return listJson({ error: 'bad_cursor' }, 400);
  const page = await contactsPage(ctx.orgId, listParams(params, KEYS), { after, limit: limitParam(params) });
  return listJson(page);
}
