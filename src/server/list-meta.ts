import type { OrgKind, StageType } from '@prisma/client';
import { db } from '@/lib/db';

/**
 * What the pipeline needs besides its rows and counts: the org's kind,
 * stages, postings, clients and archive reasons. None of it depends on the
 * stage tab or the search, so a stage switch shouldn't re-read it.
 */
export type ListMeta = {
  kind: OrgKind;
  stages: { id: string; name: string; type: StageType }[];
  postings: {
    id: string;
    title: string;
    clientCompanyId: string | null;
    clientName: string | null;
    departmentName: string | null;
  }[];
  clients: { id: string; name: string }[];
  archiveReasons: { id: string; name: string }[];
};

/** Straight from the database. JSON-safe, so it can sit in the data cache. */
export async function loadListMeta(orgId: string): Promise<ListMeta> {
  const [org, stages, postings, clients, archiveReasons] = await Promise.all([
    db.organization.findUnique({ where: { id: orgId }, select: { kind: true } }),
    db.stage.findMany({
      where: { orgId },
      orderBy: { order: 'asc' },
      select: { id: true, name: true, type: true },
    }),
    db.posting.findMany({
      where: { orgId },
      orderBy: { title: 'asc' },
      select: {
        id: true,
        title: true,
        clientCompanyId: true,
        clientCompany: { select: { name: true } },
        department: { select: { name: true } },
      },
    }),
    db.clientCompany.findMany({
      where: { orgId },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    }),
    db.archiveReason.findMany({
      where: { orgId },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    }),
  ]);
  return {
    kind: org?.kind ?? 'COMPANY',
    stages,
    postings: postings.map((p) => ({
      id: p.id,
      title: p.title,
      clientCompanyId: p.clientCompanyId,
      clientName: p.clientCompany?.name ?? null,
      departmentName: p.department?.name ?? null,
    })),
    clients,
    archiveReasons,
  };
}
