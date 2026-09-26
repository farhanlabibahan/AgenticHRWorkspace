import type { Origin, StageType } from '@prisma/client';
import { db } from '@/lib/db';
import { actorOf, emitEvent } from '@/server/events';
import { buildOpportunityVars, sendEmail } from '@/server/email';
import { maybeAutoSendSchedulingLink } from '@/server/scheduling';
import { appBaseUrl } from '@/lib/base-url';
import type { SessionContext } from '@/lib/session';
import { capName } from '@/lib/utils';
import { invalidateContactCounts, invalidatePipelineCounts } from '@/server/lists/cache';

export type CreateCandidateInput = {
  name: string;
  email?: string;
  headline?: string;
  location?: string;
  postingId?: string;
  stageId: string;
  origin: Origin;
  source?: string;
};

/**
 * Add a candidate: reuses an existing contact when the email matches
 * (Lever model — one person, many opportunities), then opens a new
 * opportunity in the given stage.
 */
export async function createCandidate(ctx: SessionContext, input: CreateCandidateInput) {
  const email = input.email?.toLowerCase().trim() || null;

  const created = await db.$transaction(async (tx) => {
    const stage = await tx.stage.findFirst({ where: { id: input.stageId, orgId: ctx.orgId } });
    if (!stage) throw new Error('Stage not found');
    if (input.postingId) {
      const posting = await tx.posting.findFirst({
        where: { id: input.postingId, orgId: ctx.orgId },
      });
      if (!posting) throw new Error('Posting not found');
    }

    let contact = email
      ? await tx.contact.findFirst({ where: { orgId: ctx.orgId, emails: { has: email } } })
      : null;

    if (!contact) {
      contact = await tx.contact.create({
        data: {
          orgId: ctx.orgId,
          name: capName(input.name),
          headline: input.headline || null,
          location: input.location || null,
          emails: email ? [email] : [],
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
    }

    const opportunity = await tx.opportunity.create({
      data: {
        orgId: ctx.orgId,
        contactId: contact.id,
        postingId: input.postingId || null,
        stageId: stage.id,
        origin: input.origin,
        source: input.source || null,
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
      payload: { contactName: contact.name, stageName: stage.name },
    });
    return opportunity;
  });
  invalidatePipelineCounts(ctx.orgId);
  invalidateContactCounts(ctx.orgId);
  return created;
}

/**
 * Options for the write paths below. Bulk actions pass invalidate: false for
 * each item and expire the list caches once for the whole chunk, since an
 * expired tag also makes a Server Action send back a re-rendered page.
 */
export type WriteOptions = { invalidate?: boolean };

export async function moveStage(
  ctx: SessionContext,
  opportunityId: string,
  toStageId: string,
  { invalidate = true }: WriteOptions = {},
) {
  const result = await db.$transaction(async (tx) => {
    const opportunity = await tx.opportunity.findFirst({
      where: { id: opportunityId, orgId: ctx.orgId },
      include: { stage: true, contact: true, posting: true },
    });
    if (!opportunity) throw new Error('Opportunity not found');
    const toStage = await tx.stage.findFirst({ where: { id: toStageId, orgId: ctx.orgId } });
    if (!toStage) throw new Error('Stage not found');
    if (opportunity.stageId === toStage.id) return { updated: opportunity, toStage: null as { name: string; type: StageType } | null };

    // A hire fills a requisition opening via the posting linkage; the req
    // auto-closes when the last opening is filled (docs/02 §8).
    if (toStage.type === 'HIRED' && opportunity.status !== 'HIRED' && opportunity.posting?.requisitionId) {
      const req = await tx.requisition.update({
        where: { id: opportunity.posting.requisitionId },
        data: { filled: { increment: 1 } },
      });
      if (req.filled >= req.openings && req.state === 'OPEN') {
        await tx.requisition.update({ where: { id: req.id }, data: { state: 'CLOSED' } });
      }
    }

    const updated = await tx.opportunity.update({
      where: { id: opportunity.id },
      data: {
        stageId: toStage.id,
        stageChangedAt: new Date(),
        status: toStage.type === 'HIRED' ? 'HIRED' : opportunity.status,
      },
    });
    await tx.stageTransition.create({
      data: {
        opportunityId: opportunity.id,
        fromStageId: opportunity.stageId,
        toStageId: toStage.id,
        actorId: ctx.userId,
      },
    });
    await emitEvent(tx, {
      orgId: ctx.orgId,
      ...actorOf(ctx),
      verb: toStage.type === 'HIRED' ? 'opportunity.hired' : 'opportunity.stage_changed',
      subjectType: 'opportunity',
      subjectId: opportunity.id,
      payload: {
        contactName: opportunity.contact.name,
        from: opportunity.stage.name,
        to: toStage.name,
      },
    });
    return { updated, toStage: { name: toStage.name, type: toStage.type } };
  });
  if (invalidate) invalidatePipelineCounts(ctx.orgId);

  if (result.toStage) {
    await maybeAutoSendSchedulingLink(ctx, opportunityId, result.toStage, appBaseUrl());
  }
  return result.updated;
}

export async function archiveOpportunity(
  ctx: SessionContext,
  opportunityId: string,
  archiveReasonId: string,
  { invalidate = true }: WriteOptions = {},
) {
  const result = await db.$transaction(async (tx) => {
    const opportunity = await tx.opportunity.findFirst({
      where: { id: opportunityId, orgId: ctx.orgId },
      include: { contact: true },
    });
    if (!opportunity) throw new Error('Opportunity not found');
    const reason = await tx.archiveReason.findFirst({
      where: { id: archiveReasonId, orgId: ctx.orgId },
    });
    if (!reason) throw new Error('Archive reason not found');

    const updated = await tx.opportunity.update({
      where: { id: opportunity.id },
      data: { status: 'ARCHIVED', archiveReasonId: reason.id, archivedAt: new Date() },
    });
    await emitEvent(tx, {
      orgId: ctx.orgId,
      ...actorOf(ctx),
      verb: 'opportunity.archived',
      subjectType: 'opportunity',
      subjectId: opportunity.id,
      payload: { contactName: opportunity.contact.name, reason: reason.name },
    });
    return { updated, countsAsRejection: reason.countsAsRejection };
  });
  if (invalidate) invalidatePipelineCounts(ctx.orgId);

  // Automated rejection email, delayed so a mistaken archive can be undone
  if (result.countsAsRejection) {
    const org = await db.organization.findUnique({ where: { id: ctx.orgId } });
    if (org?.autoRejectTemplateId) {
      const template = await db.emailTemplate.findFirst({
        where: { id: org.autoRejectTemplateId, orgId: ctx.orgId },
      });
      const { vars, toEmail, contactId } = await buildOpportunityVars(opportunityId);
      if (template && toEmail) {
        await sendEmail({
          orgId: ctx.orgId,
          actorId: ctx.userId ?? undefined,
          contactId,
          opportunityId,
          templateId: template.id,
          toEmail,
          subject: template.subject,
          body: template.body,
          vars,
          scheduledAt: new Date(Date.now() + org.autoRejectDelayHours * 3_600_000),
        });
      }
    }
  }

  return result.updated;
}

export async function unarchiveOpportunity(ctx: SessionContext, opportunityId: string) {
  const updated = await db.$transaction(async (tx) => {
    const opportunity = await tx.opportunity.findFirst({
      where: { id: opportunityId, orgId: ctx.orgId },
      include: { contact: true },
    });
    if (!opportunity) throw new Error('Opportunity not found');

    const updated = await tx.opportunity.update({
      where: { id: opportunity.id },
      data: { status: 'ACTIVE', archiveReasonId: null, archivedAt: null },
    });
    await emitEvent(tx, {
      orgId: ctx.orgId,
      ...actorOf(ctx),
      verb: 'opportunity.unarchived',
      subjectType: 'opportunity',
      subjectId: opportunity.id,
      payload: { contactName: opportunity.contact.name },
    });
    return updated;
  });
  invalidatePipelineCounts(ctx.orgId);
  return updated;
}

export async function addNote(ctx: SessionContext, opportunityId: string, body: string) {
  if (!ctx.userId) throw new Error('Notes require a user author');
  const authorId = ctx.userId;
  return db.$transaction(async (tx) => {
    const opportunity = await tx.opportunity.findFirst({
      where: { id: opportunityId, orgId: ctx.orgId },
      include: { contact: true },
    });
    if (!opportunity) throw new Error('Opportunity not found');

    const note = await tx.note.create({
      data: { orgId: ctx.orgId, opportunityId: opportunity.id, authorId, body },
    });
    await emitEvent(tx, {
      orgId: ctx.orgId,
      ...actorOf(ctx),
      verb: 'note.added',
      subjectType: 'opportunity',
      subjectId: opportunity.id,
      payload: { contactName: opportunity.contact.name },
    });
    return note;
  });
}
