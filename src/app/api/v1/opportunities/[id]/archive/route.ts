import { NextResponse } from 'next/server';
import { apiError, apiSessionContext, withApiAuth } from '@/lib/api';
import { archiveOpportunity } from '@/server/opportunities';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiAuth(request, async (ctx) => {
    const { id } = await params;
    const body = await request.json().catch(() => null);
    const reasonId = String(body?.archive_reason_id ?? '');
    if (!reasonId) return apiError(422, 'invalid', 'archive_reason_id is required');
    const updated = await archiveOpportunity(apiSessionContext(ctx), id, reasonId);
    return NextResponse.json({ data: { id: updated.id, status: updated.status.toLowerCase() } });
  });
}
