import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiError, withApiAuth } from '@/lib/api';
import { serializeOpportunity, opportunityInclude } from '@/app/api/v1/opportunities/serialize';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiAuth(request, async (ctx) => {
    const { id } = await params;
    const opportunity = await db.opportunity.findFirst({
      where: { id, orgId: ctx.orgId },
      include: opportunityInclude,
    });
    if (!opportunity) return apiError(404, 'not_found', 'Opportunity not found');
    return NextResponse.json({ data: serializeOpportunity(opportunity) });
  });
}
