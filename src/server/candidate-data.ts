import { db } from '@/lib/db';
import { candidateStatus } from '@/server/portal';

/**
 * Candidate-facing data. Everything here is scoped to one candidate account
 * and shows only what a candidate may see: their own applications, friendly
 * status labels (never internal stage names or notes), and their interviews.
 */

/** Every published role across every company, for the public job list. */
export async function listAllPublishedJobs(filters: { q?: string; workplace?: string; type?: string } = {}) {
  const q = filters.q?.trim();
  const postings = await db.posting.findMany({
    where: {
      state: 'PUBLISHED',
      ...(q ? { OR: [{ title: { contains: q, mode: 'insensitive' } }, { location: { contains: q, mode: 'insensitive' } }] } : {}),
      ...(filters.workplace ? { workplaceType: filters.workplace as 'ONSITE' | 'HYBRID' | 'REMOTE' } : {}),
      ...(filters.type ? { commitment: filters.type as 'FULL_TIME' | 'PART_TIME' | 'CONTRACT' | 'INTERNSHIP' } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
    select: {
      id: true,
      slug: true,
      title: true,
      location: true,
      workplaceType: true,
      commitment: true,
      salaryMin: true,
      salaryMax: true,
      salaryCurrency: true,
      createdAt: true,
      org: { select: { slug: true, name: true } },
    },
  });
  return postings.map((p) => ({
    id: p.id,
    slug: p.slug,
    title: p.title,
    location: p.location,
    workplaceType: p.workplaceType,
    commitment: p.commitment,
    salaryMin: p.salaryMin,
    salaryMax: p.salaryMax,
    salaryCurrency: p.salaryCurrency,
    orgSlug: p.org.slug,
    companyName: p.org.name,
    postedAt: p.createdAt,
  }));
}

/** A candidate's applications across companies, with status and upcoming interviews. */
export async function listMyApplications(accountId: string) {
  const contacts = await db.contact.findMany({
    where: { candidateAccountId: accountId, isAnonymized: false },
    select: {
      id: true,
      orgId: true,
      org: { select: { name: true, slug: true } },
      opportunities: {
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          status: true,
          createdAt: true,
          posting: { select: { title: true, location: true } },
          stage: { select: { type: true } },
          interviews: {
            where: { state: 'SCHEDULED' },
            orderBy: { startAt: 'asc' },
            select: { id: true, title: true, startAt: true, durationMins: true, location: true },
          },
        },
      },
    },
  });

  const rows = contacts.flatMap((c) =>
    c.opportunities.map((o) => ({
      id: o.id,
      company: c.org.name,
      orgSlug: c.org.slug,
      title: o.posting?.title ?? 'General application',
      location: o.posting?.location ?? null,
      appliedAt: o.createdAt,
      status: candidateStatus(o.status, o.stage.type, null),
      interviews: o.interviews.map((i) => ({
        id: i.id,
        title: i.title,
        startAt: i.startAt,
        durationMins: i.durationMins,
        location: i.location,
      })),
    })),
  );
  return rows.sort((a, b) => b.appliedAt.getTime() - a.appliedAt.getTime());
}

/** Jobs the candidate was hired into, across companies. */
export async function listMyJobs(accountId: string) {
  const records = await db.employmentRecord.findMany({
    where: { candidateAccountId: accountId },
    orderBy: { startedAt: 'desc' },
    include: { org: { select: { name: true, slug: true } } },
  });
  return records.map((r) => ({
    id: r.id,
    title: r.title,
    company: r.org.name,
    orgSlug: r.org.slug,
    startedAt: r.startedAt,
  }));
}
