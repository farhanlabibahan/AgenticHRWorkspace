import { NextResponse } from 'next/server';
import { apiSessionContext, withApiAuth } from '@/lib/api';
import { setPostingState } from '@/server/postings';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiAuth(request, async (ctx) => {
    const { id } = await params;
    const updated = await setPostingState(apiSessionContext(ctx), id, 'PUBLISHED');
    return NextResponse.json({ data: { id: updated.id, state: updated.state.toLowerCase() } });
  });
}
