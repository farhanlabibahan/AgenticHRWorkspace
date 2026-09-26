import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { withApiAuth } from '@/lib/api';

export async function GET(request: Request) {
  return withApiAuth(request, async (ctx) => {
    const stages = await db.stage.findMany({
      where: { orgId: ctx.orgId },
      orderBy: { order: 'asc' },
    });
    return NextResponse.json({
      data: stages.map((s) => ({
        id: s.id,
        name: s.name,
        type: s.type.toLowerCase(),
        order: s.order,
      })),
    });
  });
}
