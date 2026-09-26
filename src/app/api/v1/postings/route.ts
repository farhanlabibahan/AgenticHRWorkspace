import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiError, apiSessionContext, paginated, parsePagination, withApiAuth } from '@/lib/api';
import { createPosting } from '@/server/postings';

const WORKPLACES = ['ONSITE', 'HYBRID', 'REMOTE'];
const COMMITMENTS = ['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERNSHIP'];

export async function GET(request: Request) {
  return withApiAuth(request, async (ctx) => {
    const { limit, cursor } = parsePagination(request.url);
    const postings = await db.posting.findMany({
      where: { orgId: ctx.orgId },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: { department: true, clientCompany: true },
    });
    return paginated(
      postings.map((p) => ({
        id: p.id,
        slug: p.slug,
        title: p.title,
        state: p.state.toLowerCase(),
        department: p.department?.name ?? null,
        client_company: p.clientCompany?.name ?? null,
        location: p.location,
        workplace_type: p.workplaceType.toLowerCase(),
        commitment: p.commitment.toLowerCase(),
        salary_min: p.salaryMin,
        salary_max: p.salaryMax,
        salary_currency: p.salaryCurrency,
        created_at: p.createdAt.toISOString(),
      })),
      limit,
    );
  });
}

export async function POST(request: Request) {
  return withApiAuth(request, async (ctx) => {
    const body = await request.json().catch(() => null);
    const title = String(body?.title ?? '').trim();
    if (!title) return apiError(422, 'invalid', 'title is required');

    const workplace = String(body?.workplace_type ?? 'onsite').toUpperCase();
    const commitment = String(body?.commitment ?? 'full_time').toUpperCase();
    if (!WORKPLACES.includes(workplace)) return apiError(422, 'invalid', 'invalid workplace_type');
    if (!COMMITMENTS.includes(commitment)) return apiError(422, 'invalid', 'invalid commitment');

    const posting = await createPosting(apiSessionContext(ctx), {
      title,
      departmentId: String(body?.department_id ?? '') || undefined,
      clientCompanyId: String(body?.client_company_id ?? '') || undefined,
      location: String(body?.location ?? '').trim() || undefined,
      workplaceType: workplace as never,
      commitment: commitment as never,
      salaryMin: Number.isFinite(body?.salary_min) ? body.salary_min : undefined,
      salaryMax: Number.isFinite(body?.salary_max) ? body.salary_max : undefined,
      salaryCurrency: String(body?.salary_currency ?? '').trim() || undefined,
      description: String(body?.description ?? '').trim() || undefined,
    });
    return NextResponse.json(
      { data: { id: posting.id, slug: posting.slug, title: posting.title, state: 'draft' } },
      { status: 201 },
    );
  });
}
