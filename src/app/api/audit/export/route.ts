import { NextResponse } from 'next/server';
import type { Event, Prisma } from '@prisma/client';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { csvLine, EXPORT_BATCH, streamReadOnly } from '@/lib/csv-stream';

export const maxDuration = 300;

/**
 * Audit log as CSV (admin-only), honoring the same verb filter as the UI.
 * Every matching event, newest first, streamed in keyset batches on
 * (occurredAt DESC, id DESC). It used to stop silently at 10,000.
 */
export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.orgId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const role = String(session.user.accessRole);
  if (role !== 'SUPER_ADMIN' && role !== 'ADMIN') {
    return NextResponse.json({ error: 'admin only' }, { status: 403 });
  }
  const orgId = session.user.orgId;
  const verb = new URL(request.url).searchParams.get('verb')?.trim() ?? '';
  const users = await db.user.findMany({ where: { orgId }, select: { id: true, name: true } });
  const names = new Map(users.map((u) => [u.id, u.name]));

  async function* lines(tx: Prisma.TransactionClient): AsyncGenerator<string> {
    yield 'occurred_at,actor_type,actor,verb,subject_type,subject_id,payload\n';
    let after: { occurredAt: Date; id: string } | null = null;
    for (;;) {
      const batch: Event[] = await tx.event.findMany({
        where: {
          orgId,
          ...(verb ? { verb: { contains: verb, mode: 'insensitive' } } : {}),
          ...(after
            ? { AND: [{ occurredAt: { lte: after.occurredAt } }, { OR: [{ occurredAt: { lt: after.occurredAt } }, { id: { lt: after.id } }] }] }
            : {}),
        },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: EXPORT_BATCH,
      });
      if (!batch.length) return;
      yield batch
        .map(
          (e) =>
            `${csvLine([
              e.occurredAt.toISOString(),
              e.actorType,
              e.actorType === 'user' ? (names.get(e.actorId ?? '') ?? e.actorId ?? '') : (e.actorId ?? ''),
              e.verb,
              e.subjectType,
              e.subjectId,
              e.payload ? JSON.stringify(e.payload) : '',
            ])}\n`,
        )
        .join('');
      if (batch.length < EXPORT_BATCH) return;
      const last = batch[batch.length - 1];
      after = { occurredAt: last.occurredAt, id: last.id };
    }
  }

  return new Response(streamReadOnly(lines, { timeoutMs: maxDuration * 1000 }), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="source-audit-log.csv"',
      'Cache-Control': 'no-store',
    },
  });
}
