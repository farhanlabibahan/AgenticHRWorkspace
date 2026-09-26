import { NextResponse } from 'next/server';
import { apiError, apiSessionContext, withApiAuth } from '@/lib/api';
import { moveStage } from '@/server/opportunities';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiAuth(request, async (ctx) => {
    const { id } = await params;
    const body = await request.json().catch(() => null);
    const stageId = String(body?.stage_id ?? '');
    if (!stageId) return apiError(422, 'invalid', 'stage_id is required');
    const updated = await moveStage(apiSessionContext(ctx), id, stageId);
    return NextResponse.json({ data: { id: updated.id, stage_id: updated.stageId } });
  });
}
