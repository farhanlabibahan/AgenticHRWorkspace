import type { Prisma, StageType } from '@prisma/client';
import { db } from '@/lib/db';
import { actorOf, emitEvent } from '@/server/events';
import type { SessionContext } from '@/lib/session';
import { invalidateListMeta } from '@/server/lists/cache';
import { nameKey } from '@/server/imports/mapping';
import { GROUP_RANK, stageGroup } from '@/lib/stage-types';

/**
 * A new stage goes at the end of its group: after the last lead, after the
 * last applicant, or at the end of the interview process just before Hired
 * (a new Hired stage goes last). Placing it by type instead would drop it
 * into the middle of a process someone has reordered.
 */
export async function createStage(ctx: SessionContext, name: string, type: StageType) {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Stage name is required');
  const result = await db.$transaction(async (tx) => {
    const current = await lockStages(tx, ctx.orgId);
    if (current.some((s) => nameKey(s.name) === nameKey(trimmed))) {
      throw new Error(`There’s already a stage called “${trimmed}”`);
    }
    const group = stageGroup(type);
    let at = current.length;
    if (group !== 'interview') {
      const last = current.findLastIndex((s) => GROUP_RANK[stageGroup(s.type)] <= GROUP_RANK[group]);
      at = last + 1;
    } else if (type !== 'HIRED') {
      const hired = current.findIndex((s) => s.type === 'HIRED');
      if (hired >= 0) at = hired;
    }
    for (const [i, s] of current.entries()) await tx.stage.update({ where: { id: s.id }, data: { order: -1 - i } });
    const stage = await tx.stage.create({ data: { orgId: ctx.orgId, name: trimmed, type, order: at } });
    for (const [i, s] of current.entries()) {
      await tx.stage.update({ where: { id: s.id }, data: { order: i < at ? i : i + 1 } });
    }
    await emitEvent(tx, {
      orgId: ctx.orgId,
      ...actorOf(ctx),
      verb: 'stage.created',
      subjectType: 'stage',
      subjectId: stage.id,
      payload: { name: trimmed, type },
    });
    return stage;
  });
  invalidateListMeta(ctx.orgId);
  return result;
}

/**
 * The org's stages in order, row-locked like insertStages does so a
 * concurrent add or reorder waits instead of colliding on @@unique([orgId, order]).
 */
async function lockStages(tx: Prisma.TransactionClient, orgId: string) {
  await tx.$queryRaw`SELECT id FROM "Stage" WHERE "orgId" = ${orgId} FOR NO KEY UPDATE`;
  return tx.stage.findMany({ where: { orgId }, orderBy: { order: 'asc' } });
}

export async function renameStage(ctx: SessionContext, stageId: string, name: string) {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Stage name is required');
  const result = await db.$transaction(async (tx) => {
    const stage = await tx.stage.findFirst({ where: { id: stageId, orgId: ctx.orgId } });
    if (!stage) throw new Error('Stage not found');
    if (stage.name === trimmed) return stage;
    const updated = await tx.stage.update({ where: { id: stage.id }, data: { name: trimmed } });
    await emitEvent(tx, {
      orgId: ctx.orgId,
      ...actorOf(ctx),
      verb: 'stage.renamed',
      subjectType: 'stage',
      subjectId: stage.id,
      payload: { from: stage.name, to: trimmed },
    });
    return updated;
  });
  invalidateListMeta(ctx.orgId);
  return result;
}

/**
 * The pipeline in a new order (a drag in the stage editor): `ids` is every
 * stage of the org. Leads stay before applicants and applicants before the
 * interview process whatever order arrives; within a group it's the caller's.
 */
export async function setStageOrder(ctx: SessionContext, ids: string[]) {
  await db.$transaction(async (tx) => {
    const stages = await lockStages(tx, ctx.orgId);
    const byId = new Map(stages.map((s) => [s.id, s]));
    if (ids.length !== stages.length || new Set(ids).size !== ids.length || ids.some((id) => !byId.has(id))) {
      throw new Error('The stages changed while you were editing. Reload and try again.');
    }
    const ordered = ids
      .map((id, i) => ({ stage: byId.get(id)!, i }))
      .sort((a, b) => GROUP_RANK[stageGroup(a.stage.type)] - GROUP_RANK[stageGroup(b.stage.type)] || a.i - b.i)
      .map((x) => x.stage);
    if (ordered.every((s, i) => s.id === stages[i].id)) return;
    // Through negative temporaries so @@unique([orgId, order]) never trips mid-way.
    for (const [i, s] of stages.entries()) await tx.stage.update({ where: { id: s.id }, data: { order: -1 - i } });
    for (const [order, s] of ordered.entries()) await tx.stage.update({ where: { id: s.id }, data: { order } });
  });
  invalidateListMeta(ctx.orgId);
}

export async function deleteStage(ctx: SessionContext, stageId: string) {
  const result = await db.$transaction(async (tx) => {
    const stage = await tx.stage.findFirst({ where: { id: stageId, orgId: ctx.orgId } });
    if (!stage) throw new Error('Stage not found');

    const stageCount = await tx.stage.count({ where: { orgId: ctx.orgId } });
    if (stageCount <= 1) throw new Error('At least one stage is required');

    const inUse = await tx.opportunity.count({ where: { stageId: stage.id } });
    if (inUse > 0) throw new Error(`Move the ${inUse} candidate(s) out of this stage first`);

    const history = await tx.stageTransition.count({
      where: { OR: [{ toStageId: stage.id }, { fromStageId: stage.id }] },
    });
    if (history > 0) throw new Error('This stage has candidate history and can only be renamed');

    await tx.stage.delete({ where: { id: stage.id } });
    await emitEvent(tx, {
      orgId: ctx.orgId,
      ...actorOf(ctx),
      verb: 'stage.deleted',
      subjectType: 'stage',
      subjectId: stage.id,
      payload: { name: stage.name },
    });
  });
  invalidateListMeta(ctx.orgId);
  return result;
}
