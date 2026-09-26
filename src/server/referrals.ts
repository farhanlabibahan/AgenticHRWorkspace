import type { Origin } from '@prisma/client';
import { capName } from '@/lib/utils';
import { db } from '@/lib/db';
import { actorOf, emitEvent } from '@/server/events';
import type { SessionContext } from '@/lib/session';
import { invalidateContactCounts, invalidatePipelineCounts } from '@/server/lists/cache';

export type SubmitReferralInput = {
  name: string;
  email: string;
  headline?: string;
  postingId?: string;
  relationship?: string;
  notes?: string;
};

/**
 * Employee referral portal. Creates (or reuses) a contact, opens an
 * opportunity with Origin.REFERRED, and records the Referral so the
 * submitter can track pipeline status.
 */
export async function submitReferral(ctx: SessionContext, input: SubmitReferralInput) {
  if (!ctx.userId) throw new Error('Sign in to submit a referral');
  const email = input.email.toLowerCase().trim();
  const name = capName(input.name.trim());
  if (!name) throw new Error('Name is required');
  if (!email || !email.includes('@')) throw new Error('A valid email is required');

  const referrer = await db.user.findFirst({
    where: { id: ctx.userId, orgId: ctx.orgId },
    select: { id: true, name: true },
  });
  if (!referrer) throw new Error('Referrer not found');

  const result = await db.$transaction(async (tx) => {
    if (input.postingId) {
      const posting = await tx.posting.findFirst({
        where: { id: input.postingId, orgId: ctx.orgId },
      });
      if (!posting) throw new Error('Posting not found');
    }

    const stages = await tx.stage.findMany({
      where: { orgId: ctx.orgId },
      orderBy: { order: 'asc' },
    });
    const stage =
      stages.find((s) => s.type === 'LEAD') ??
      stages.find((s) => s.type === 'APPLICANT') ??
      stages[0];
    if (!stage) throw new Error('No pipeline stages configured');

    let contact = await tx.contact.findFirst({
      where: { orgId: ctx.orgId, emails: { has: email } },
    });
    if (!contact) {
      contact = await tx.contact.create({
        data: {
          orgId: ctx.orgId,
          name,
          headline: input.headline?.trim() || null,
          emails: [email],
          tags: ['referred'],
        },
      });
      await emitEvent(tx, {
        orgId: ctx.orgId,
        ...actorOf(ctx),
        verb: 'contact.created',
        subjectType: 'contact',
        subjectId: contact.id,
        payload: { name: contact.name },
      });
    } else if (!contact.tags.includes('referred')) {
      await tx.contact.update({
        where: { id: contact.id },
        data: { tags: [...contact.tags, 'referred'] },
      });
    }

    const origin: Origin = 'REFERRED';
    const opportunity = await tx.opportunity.create({
      data: {
        orgId: ctx.orgId,
        contactId: contact.id,
        postingId: input.postingId || null,
        stageId: stage.id,
        origin,
        source: referrer.name,
        ownerId: ctx.userId,
      },
    });
    await tx.stageTransition.create({
      data: { opportunityId: opportunity.id, toStageId: stage.id, actorId: ctx.userId },
    });
    await emitEvent(tx, {
      orgId: ctx.orgId,
      ...actorOf(ctx),
      verb: 'opportunity.created',
      subjectType: 'opportunity',
      subjectId: opportunity.id,
      payload: { contactName: contact.name, stageName: stage.name, origin },
    });

    const referral = await tx.referral.create({
      data: {
        orgId: ctx.orgId,
        referringUserId: referrer.id,
        contactId: contact.id,
        opportunityId: opportunity.id,
        postingId: input.postingId || null,
        relationship: input.relationship?.trim() || null,
        notes: input.notes?.trim() || null,
      },
    });
    await emitEvent(tx, {
      orgId: ctx.orgId,
      ...actorOf(ctx),
      verb: 'referral.submitted',
      subjectType: 'opportunity',
      subjectId: opportunity.id,
      payload: {
        contactName: contact.name,
        referrerName: referrer.name,
        relationship: referral.relationship,
      },
    });
    return { referral, opportunityId: opportunity.id };
  });
  invalidatePipelineCounts(ctx.orgId);
  invalidateContactCounts(ctx.orgId);
  return result;
}

export function listReferrals(ctx: SessionContext) {
  return db.referral.findMany({
    where: { orgId: ctx.orgId },
    orderBy: { createdAt: 'desc' },
    include: {
      referringUser: { select: { id: true, name: true } },
      contact: { select: { id: true, name: true, emails: true, headline: true } },
      posting: { select: { id: true, title: true } },
      opportunity: {
        select: {
          id: true,
          status: true,
          stage: { select: { name: true } },
        },
      },
    },
  });
}
