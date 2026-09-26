import type { Prisma, StageType } from '@prisma/client';
import { nameKey, TYPE_RANK } from '@/server/imports/mapping';

/**
 * Add stages to an org's pipeline where their type belongs — before the
 * first existing stage of a later type — rather than after "Hired", which
 * would make reports read every imported candidate as having got past it.
 *
 * Runs inside the caller's transaction. Row-locks the org's stages first so
 * a concurrent insert waits instead of colliding, then rewrites `order` for
 * the whole pipeline through negative temporaries so @@unique([orgId,
 * order]) never trips mid-way. Stages whose name already exists are reused.
 * `wanted` should already be in pipeline order (see orderNewStages); items
 * of the same type keep their relative order.
 *
 * Returns normalized name → stage id for every wanted stage.
 */
export async function insertStages(
  tx: Prisma.TransactionClient,
  orgId: string,
  wanted: { name: string; type: StageType }[],
): Promise<Map<string, string>> {
  // NO KEY UPDATE: excludes concurrent stage edits without blocking inserts
  // that merely reference a stage (new applications, stage moves).
  await tx.$queryRaw`SELECT id FROM "Stage" WHERE "orgId" = ${orgId} FOR NO KEY UPDATE`;
  const existing = await tx.stage.findMany({ where: { orgId }, orderBy: { order: 'asc' } });
  const ids = new Map(existing.map((s) => [nameKey(s.name), s.id]));
  const pipeline: { id?: string; name: string; type: StageType }[] = existing.map((s) => ({ ...s }));

  let added = false;
  for (const stage of wanted) {
    const key = nameKey(stage.name);
    if (ids.has(key) || pipeline.some((p) => !p.id && nameKey(p.name) === key)) continue;
    const at = pipeline.findIndex((p) => TYPE_RANK[p.type] > TYPE_RANK[stage.type]);
    pipeline.splice(at < 0 ? pipeline.length : at, 0, { name: stage.name, type: stage.type });
    added = true;
  }
  if (!added) return ids;

  for (const [i, s] of existing.entries()) {
    await tx.stage.update({ where: { id: s.id }, data: { order: -1 - i } });
  }
  for (const [order, p] of pipeline.entries()) {
    if (p.id) {
      await tx.stage.update({ where: { id: p.id }, data: { order } });
    } else {
      const created = await tx.stage.create({ data: { orgId, name: p.name, type: p.type, order } });
      ids.set(nameKey(p.name), created.id);
    }
  }
  return ids;
}
