import { NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { auth } from '@/lib/auth';
import { csvLine, EXPORT_BATCH, streamReadOnly } from '@/lib/csv-stream';

export const maxDuration = 300;

/**
 * The "CSV export everywhere" enabler (docs/02 §9): every opportunity with
 * its contact, role, stage, source, status, and dates — ready for a
 * spreadsheet or BI tool. The REST API remains the richer machine surface.
 *
 * All of them: streamed newest first in keyset batches of 1,000 on
 * (createdAt DESC, id DESC). It used to stop silently at 50,000.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.orgId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const orgId = session.user.orgId;

  async function* lines(tx: Prisma.TransactionClient): AsyncGenerator<string> {
    yield 'candidate,email,role,stage,status,origin,source,owner,archive_reason,tags,created_at,stage_changed_at,archived_at\n';
    let after: { createdAt: Date; id: string } | null = null;
    for (;;) {
      const batch: Prisma.OpportunityGetPayload<{
        include: {
          contact: { select: { name: true; emails: true; tags: true } };
          posting: { select: { title: true } };
          stage: { select: { name: true } };
          archiveReason: { select: { name: true } };
          owner: { select: { name: true } };
        };
      }>[] = await tx.opportunity.findMany({
        where: {
          orgId,
          ...(after
            ? { AND: [{ createdAt: { lte: after.createdAt } }, { OR: [{ createdAt: { lt: after.createdAt } }, { id: { lt: after.id } }] }] }
            : {}),
        },
        include: {
          contact: { select: { name: true, emails: true, tags: true } },
          posting: { select: { title: true } },
          stage: { select: { name: true } },
          archiveReason: { select: { name: true } },
          owner: { select: { name: true } },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: EXPORT_BATCH,
      });
      if (!batch.length) return;
      yield batch
        .map(
          (o) =>
            `${csvLine([
              o.contact.name,
              o.contact.emails[0] ?? '',
              o.posting?.title ?? '',
              o.stage.name,
              o.status,
              o.origin,
              o.source ?? '',
              o.owner?.name ?? '',
              o.archiveReason?.name ?? '',
              o.contact.tags.join(';'),
              o.createdAt.toISOString(),
              o.stageChangedAt.toISOString(),
              o.archivedAt?.toISOString() ?? '',
            ])}\n`,
        )
        .join('');
      if (batch.length < EXPORT_BATCH) return;
      const last = batch[batch.length - 1];
      after = { createdAt: last.createdAt, id: last.id };
    }
  }

  return new Response(streamReadOnly(lines, { timeoutMs: maxDuration * 1000 }), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="source-candidates.csv"',
      'Cache-Control': 'no-store',
    },
  });
}
