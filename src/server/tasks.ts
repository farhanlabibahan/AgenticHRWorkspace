import { db } from '@/lib/db';
import { actorOf, emitEvent } from '@/server/events';
import type { SessionContext } from '@/lib/session';
import { invalidatePipelineCounts } from '@/server/lists/cache';

/** Tasks (assignable to-dos) and candidate snooze. */

export async function createTask(
  ctx: SessionContext,
  input: { title: string; opportunityId?: string; assigneeId?: string; dueAt?: Date },
) {
  return db.$transaction(async (tx) => {
    if (input.opportunityId) {
      const opp = await tx.opportunity.findFirst({
        where: { id: input.opportunityId, orgId: ctx.orgId },
        select: { id: true },
      });
      if (!opp) throw new Error('Opportunity not found');
    }
    if (input.assigneeId) {
      const assignee = await tx.user.findFirst({
        where: { id: input.assigneeId, orgId: ctx.orgId },
        select: { id: true },
      });
      if (!assignee) throw new Error('Assignee not found');
    }
    const task = await tx.task.create({
      data: {
        orgId: ctx.orgId,
        opportunityId: input.opportunityId ?? null,
        assigneeId: input.assigneeId ?? ctx.userId,
        creatorId: ctx.userId,
        title: input.title,
        dueAt: input.dueAt ?? null,
      },
    });
    await emitEvent(tx, {
      orgId: ctx.orgId,
      ...actorOf(ctx),
      verb: 'task.created',
      subjectType: input.opportunityId ? 'opportunity' : 'task',
      subjectId: input.opportunityId ?? task.id,
      payload: { title: input.title },
    });
    return task;
  });
}

export async function setTaskCompleted(ctx: SessionContext, taskId: string, completed: boolean) {
  return db.$transaction(async (tx) => {
    const task = await tx.task.findFirst({ where: { id: taskId, orgId: ctx.orgId } });
    if (!task) throw new Error('Task not found');
    const updated = await tx.task.update({
      where: { id: task.id },
      data: { completedAt: completed ? new Date() : null },
    });
    if (completed) {
      await emitEvent(tx, {
        orgId: ctx.orgId,
        ...actorOf(ctx),
        verb: 'task.completed',
        subjectType: task.opportunityId ? 'opportunity' : 'task',
        subjectId: task.opportunityId ?? task.id,
        payload: { title: task.title },
      });
    }
    return updated;
  });
}

export async function snoozeOpportunity(
  ctx: SessionContext,
  opportunityId: string,
  until: Date | null,
) {
  const updated = await db.$transaction(async (tx) => {
    const opportunity = await tx.opportunity.findFirst({
      where: { id: opportunityId, orgId: ctx.orgId },
      include: { contact: true },
    });
    if (!opportunity) throw new Error('Opportunity not found');
    const updated = await tx.opportunity.update({
      where: { id: opportunity.id },
      data: { snoozedUntil: until },
    });
    await emitEvent(tx, {
      orgId: ctx.orgId,
      ...actorOf(ctx),
      verb: until ? 'opportunity.snoozed' : 'opportunity.unsnoozed',
      subjectType: 'opportunity',
      subjectId: opportunity.id,
      payload: {
        contactName: opportunity.contact.name,
        ...(until ? { until: until.toISOString() } : {}),
      },
    });
    return updated;
  });
  invalidatePipelineCounts(ctx.orgId);
  return updated;
}
