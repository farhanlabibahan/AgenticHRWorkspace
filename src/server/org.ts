import type { OrgKind } from '@prisma/client';
import { db } from '@/lib/db';
import { actorOf, emitEvent } from '@/server/events';
import type { SessionContext } from '@/lib/session';
import { invalidateListMeta } from '@/server/lists/cache';

export async function setOrgKind(ctx: SessionContext, kind: OrgKind) {
  const result = await db.$transaction(async (tx) => {
    const org = await tx.organization.update({ where: { id: ctx.orgId }, data: { kind } });
    await emitEvent(tx, {
      orgId: ctx.orgId,
      ...actorOf(ctx),
      verb: 'org.kind_set',
      subjectType: 'organization',
      subjectId: ctx.orgId,
      payload: { kind },
    });
    return org;
  });
  invalidateListMeta(ctx.orgId);
  return result;
}

export async function completeOnboarding(ctx: SessionContext) {
  return db.organization.update({
    where: { id: ctx.orgId },
    data: { onboardedAt: new Date() },
  });
}

export async function removeDepartment(ctx: SessionContext, departmentId: string) {
  const dept = await db.department.findFirst({
    where: { id: departmentId, orgId: ctx.orgId },
  });
  if (!dept) throw new Error('Department not found');
  await db.department.delete({ where: { id: dept.id } }); // postings keep null via SetNull
  invalidateListMeta(ctx.orgId);
}

export type GroupKind = 'department' | 'client';

/**
 * Several departments or client companies at once (a pasted list, a
 * spreadsheet). A name the org already has, in any capitalization, is left
 * alone. Returns the ids created, so the form can offer to undo them.
 */
export async function addGroups(
  ctx: SessionContext,
  kind: GroupKind,
  names: string[],
): Promise<{ created: { id: string; name: string }[]; existing: number }> {
  const current =
    kind === 'client'
      ? await db.clientCompany.findMany({ where: { orgId: ctx.orgId }, select: { name: true } })
      : await db.department.findMany({ where: { orgId: ctx.orgId }, select: { name: true } });
  const have = new Set(current.map((g) => g.name.toLowerCase()));
  const wanted = new Map<string, string>(); // lowercased → as written, first one wins
  for (const n of names) {
    const name = n.trim();
    if (name && !wanted.has(name.toLowerCase())) wanted.set(name.toLowerCase(), name);
  }
  const fresh = [...wanted].filter(([key]) => !have.has(key)).map(([, name]) => name);
  const existing = wanted.size - fresh.length;
  if (!fresh.length) return { created: [], existing };

  const created = await db.$transaction(async (tx) => {
    const data = fresh.map((name) => ({ orgId: ctx.orgId, name }));
    const rows =
      kind === 'client'
        ? await tx.clientCompany.createManyAndReturn({ data, skipDuplicates: true, select: { id: true, name: true } })
        : await tx.department.createManyAndReturn({ data, skipDuplicates: true, select: { id: true, name: true } });
    for (const row of rows) {
      await emitEvent(tx, {
        orgId: ctx.orgId,
        ...actorOf(ctx),
        verb: kind === 'client' ? 'client_company.created' : 'department.created',
        subjectType: kind === 'client' ? 'client_company' : 'department',
        subjectId: row.id,
        payload: { name: row.name },
      });
    }
    return rows;
  });
  invalidateListMeta(ctx.orgId);
  return { created, existing: existing + (fresh.length - created.length) };
}

/** Undo a bulk add: postings tied to them keep working, ungrouped (SetNull). */
export async function removeGroups(ctx: SessionContext, kind: GroupKind, ids: string[]) {
  const where = { orgId: ctx.orgId, id: { in: ids.slice(0, 500) } };
  if (kind === 'client') await db.clientCompany.deleteMany({ where });
  else await db.department.deleteMany({ where });
  invalidateListMeta(ctx.orgId);
}

export async function removeClientCompany(ctx: SessionContext, clientId: string) {
  const client = await db.clientCompany.findFirst({
    where: { id: clientId, orgId: ctx.orgId },
  });
  if (!client) throw new Error('Client not found');
  await db.clientCompany.delete({ where: { id: client.id } });
  invalidateListMeta(ctx.orgId);
}
