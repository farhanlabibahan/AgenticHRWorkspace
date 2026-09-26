import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import type { SessionContext } from '@/lib/session';
import { cleanCriteria, type MatchCriterion } from '@/lib/match-criteria';
import { actorOf, emitEvent } from '@/server/events';

/** Replace a role's criteria (the editor). Past evaluations keep their own copy. */
export async function saveMatchCriteria(ctx: SessionContext, postingId: string, raw: unknown): Promise<MatchCriterion[]> {
  const criteria = cleanCriteria(raw);
  await db.$transaction(async (tx) => {
    const posting = await tx.posting.findFirst({ where: { id: postingId, orgId: ctx.orgId }, select: { id: true } });
    if (!posting) throw new Error('Posting not found');
    await tx.posting.update({
      where: { id: posting.id },
      // An emptied list is stored as [] (not null), so it isn't drafted again.
      data: { matchCriteria: criteria as Prisma.InputJsonValue },
    });
    await emitEvent(tx, {
      orgId: ctx.orgId,
      ...actorOf(ctx),
      verb: 'posting.criteria_updated',
      subjectType: 'posting',
      subjectId: posting.id,
      payload: { count: criteria.length },
    });
  });
  return criteria;
}

/**
 * Store criteria drafted from the posting, only if the role still has none:
 * of several evaluations drafting at once, the first write wins and every
 * one of them returns what was stored.
 */
export async function storeDraftedCriteria(ctx: SessionContext, postingId: string, drafted: MatchCriterion[]): Promise<MatchCriterion[]> {
  await db.$transaction(async (tx) => {
    const { count } = await tx.posting.updateMany({
      where: { id: postingId, orgId: ctx.orgId, matchCriteria: { equals: Prisma.DbNull } },
      data: { matchCriteria: drafted as Prisma.InputJsonValue },
    });
    if (count) {
      await emitEvent(tx, {
        orgId: ctx.orgId,
        ...actorOf(ctx),
        verb: 'posting.criteria_drafted',
        subjectType: 'posting',
        subjectId: postingId,
        payload: { count: drafted.length },
      });
    }
  });
  const posting = await db.posting.findFirst({ where: { id: postingId, orgId: ctx.orgId }, select: { matchCriteria: true } });
  return cleanCriteria(posting?.matchCriteria);
}
