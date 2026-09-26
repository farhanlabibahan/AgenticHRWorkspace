import { NextResponse } from 'next/server';
import { apiSessionContext, withApiAuth } from '@/lib/api';
import { unarchiveOpportunity } from '@/server/opportunities';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiAuth(request, async (ctx) => {
    const { id } = await params;
    const updated = await unarchiveOpportunity(apiSessionContext(ctx), id);
    return NextResponse.json({ data: { id: updated.id, status: updated.status.toLowerCase() } });
  });
}
