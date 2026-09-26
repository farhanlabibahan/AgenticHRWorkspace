import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiError, apiSessionContext, paginated, parsePagination, withApiAuth } from '@/lib/api';
import { serializeOpportunity, opportunityInclude } from '@/app/api/v1/opportunities/serialize';
import { createCandidate } from '@/server/opportunities';

const ORIGINS = ['APPLIED', 'SOURCED', 'REFERRED', 'AGENCY', 'INTERNAL', 'UNIVERSITY'];

export async function GET(request: Request) {
  return withApiAuth(request, async (ctx) => {
    const { limit, cursor } = parsePagination(request.url);
    const url = new URL(request.url);
    const status = url.searchParams.get('status')?.toUpperCase();
    const postingId = url.searchParams.get('posting_id');

    const opportunities = await db.opportunity.findMany({
      where: {
        orgId: ctx.orgId,
        ...(status && ['ACTIVE', 'ARCHIVED', 'HIRED'].includes(status)
          ? { status: status as 'ACTIVE' | 'ARCHIVED' | 'HIRED' }
          : {}),
        ...(postingId ? { postingId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: opportunityInclude,
    });
    return paginated(opportunities.map(serializeOpportunity), limit);
  });
}

export async function POST(request: Request) {
  return withApiAuth(request, async (ctx) => {
    const body = await request.json().catch(() => null);
    const name = String(body?.name ?? '').trim();
    if (!name) return apiError(422, 'invalid', 'name is required');

    const origin = String(body?.origin ?? 'sourced').toUpperCase();
    if (!ORIGINS.includes(origin)) return apiError(422, 'invalid', 'invalid origin');

    let stageId = String(body?.stage_id ?? '');
    if (!stageId) {
      const first = await db.stage.findFirst({
        where: { orgId: ctx.orgId },
        orderBy: { order: 'asc' },
      });
      if (!first) return apiError(422, 'invalid', 'organization has no stages');
      stageId = first.id;
    }

    const opportunity = await createCandidate(apiSessionContext(ctx), {
      name,
      email: String(body?.email ?? '').trim() || undefined,
      headline: String(body?.headline ?? '').trim() || undefined,
      location: String(body?.location ?? '').trim() || undefined,
      postingId: String(body?.posting_id ?? '') || undefined,
      stageId,
      origin: origin as never,
      source: String(body?.source ?? '').trim() || undefined,
    });

    const full = await db.opportunity.findUnique({
      where: { id: opportunity.id },
      include: opportunityInclude,
    });
    return NextResponse.json({ data: serializeOpportunity(full!) }, { status: 201 });
  });
}
