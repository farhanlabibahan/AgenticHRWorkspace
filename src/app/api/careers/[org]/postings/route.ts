import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

export function OPTIONS() {
  return new NextResponse(null, { headers: CORS });
}

/**
 * Public postings feed for careers-page embeds (docs/02 §3 "Embeddable
 * postings"): fetch this from your own site and render open roles, linking
 * back to the hosted apply flow. Unauthenticated, published postings only,
 * CORS-open by design.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ org: string }> }) {
  const { org: orgSlug } = await params;
  const org = await db.organization.findUnique({ where: { slug: orgSlug } });
  if (!org) return NextResponse.json({ error: 'not found' }, { status: 404, headers: CORS });

  const postings = await db.posting.findMany({
    where: { orgId: org.id, state: 'PUBLISHED' },
    orderBy: { createdAt: 'desc' },
    include: { department: true, clientCompany: true },
  });

  return NextResponse.json(
    {
      organization: { name: org.name, slug: org.slug },
      postings: postings.map((p) => ({
        id: p.id,
        title: p.title,
        slug: p.slug,
        department: p.department?.name ?? null,
        hiring_for: p.clientCompany?.name ?? null,
        location: p.location,
        workplace_type: p.workplaceType.toLowerCase(),
        commitment: p.commitment.toLowerCase(),
        salary_min: p.salaryMin,
        salary_max: p.salaryMax,
        salary_currency: p.salaryCurrency,
        tags: p.tags,
        url: `/careers/${org.slug}/${p.slug}`,
        published_at: p.createdAt.toISOString(),
      })),
    },
    { headers: { ...CORS, 'Cache-Control': 'public, max-age=300' } },
  );
}
