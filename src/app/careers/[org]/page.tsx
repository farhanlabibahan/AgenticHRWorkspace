import { db } from '@/lib/db';
import { JobBoard } from '@/components/job-board';
import { knownFilters, readBoardFilters, type BoardPosting } from '@/lib/job-board';

export default async function CareersPage({
  params,
  searchParams,
}: {
  params: Promise<{ org: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { org: orgSlug } = await params;
  const org = await db.organization.findUnique({ where: { slug: orgSlug } });
  if (!org) return null; // layout already 404s

  const postings = await db.posting.findMany({
    where: { orgId: org.id, state: 'PUBLISHED' },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      slug: true,
      title: true,
      location: true,
      workplaceType: true,
      commitment: true,
      department: { select: { name: true } },
      clientCompany: { select: { name: true } },
    },
  });

  const isAgency = org.kind === 'AGENCY';
  const board: BoardPosting[] = postings.map((p) => ({
    id: p.id,
    slug: p.slug,
    title: p.title,
    location: p.location,
    workplaceType: p.workplaceType,
    commitment: p.commitment,
    group: (isAgency ? p.clientCompany?.name : p.department?.name) ?? (isAgency ? 'Other clients' : 'Other roles'),
  }));
  const groupKey = isAgency ? 'client' : 'team';

  return (
    <div>
      <h1 className="text-3xl">Open positions</h1>
      {board.length === 0 ? (
        <p className="mt-2 text-sm text-ink-2">No open roles right now — check back soon.</p>
      ) : (
        <JobBoard
          orgSlug={orgSlug}
          postings={board}
          groupKey={groupKey}
          groupLabel={isAgency ? 'Client' : 'Team'}
          initial={knownFilters(board, readBoardFilters(await searchParams, groupKey))}
        />
      )}
    </div>
  );
}
