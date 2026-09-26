import { db } from '@/lib/db';
import { paginated, parsePagination, withApiAuth } from '@/lib/api';

/** The org activity stream — integration-friendly change feed (?since=ISO). */
export async function GET(request: Request) {
  return withApiAuth(request, async (ctx) => {
    const { limit, cursor } = parsePagination(request.url);
    const since = new URL(request.url).searchParams.get('since');

    const events = await db.event.findMany({
      where: {
        orgId: ctx.orgId,
        ...(since ? { occurredAt: { gte: new Date(since) } } : {}),
      },
      orderBy: { occurredAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    return paginated(
      events.map((e) => ({
        id: e.id,
        type: e.verb,
        actor_type: e.actorType,
        subject_type: e.subjectType,
        subject_id: e.subjectId,
        payload: e.payload,
        occurred_at: e.occurredAt.toISOString(),
      })),
      limit,
    );
  });
}
