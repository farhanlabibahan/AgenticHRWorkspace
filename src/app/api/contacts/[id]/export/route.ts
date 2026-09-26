import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';

/**
 * GDPR Subject Access Request export: one candidate's complete record as
 * JSON. Admin-only — this is the "give the person their data" artifact.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.orgId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const role = String(session.user.accessRole);
  if (role !== 'SUPER_ADMIN' && role !== 'ADMIN') {
    return NextResponse.json({ error: 'admin only' }, { status: 403 });
  }

  const { id } = await params;
  const orgId = session.user.orgId;
  // Resume files by name, date and what parsing read from them; never the storage key.
  const fileFields = { id: true, filename: true, createdAt: true, parseStatus: true, parseModel: true, parsed: true } as const;
  const contact = await db.contact.findFirst({
    where: { id, orgId },
    include: {
      resumeFile: { select: fileFields },
      files: { select: fileFields, orderBy: { createdAt: 'asc' } },
      opportunities: {
        include: {
          stage: true,
          posting: { select: { title: true } },
          archiveReason: { select: { name: true } },
          stageTransitions: { orderBy: { occurredAt: 'asc' } },
          notes: { select: { body: true, createdAt: true } },
          feedback: { select: { overallRating: true, summary: true, createdAt: true } },
          interviews: { select: { title: true, startAt: true, state: true } },
          offers: true,
          transcripts: { select: { title: true, content: true, source: true, createdAt: true } },
        },
      },
    },
  });
  if (!contact) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const [emails, consents, events] = await Promise.all([
    db.emailMessage.findMany({
      where: { orgId, contactId: contact.id },
      select: { toEmail: true, subject: true, body: true, status: true, sentAt: true },
    }),
    db.consentRecord.findMany({ where: { orgId, contactId: contact.id } }),
    db.event.findMany({
      where: {
        orgId,
        OR: [
          { subjectType: 'contact', subjectId: contact.id },
          { subjectType: 'opportunity', subjectId: { in: contact.opportunities.map((o) => o.id) } },
        ],
      },
      orderBy: { occurredAt: 'asc' },
    }),
  ]);

  return new NextResponse(
    JSON.stringify({ exportedAt: new Date().toISOString(), contact, emails, consents, events }, null, 2),
    {
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="sar-${contact.id}.json"`,
      },
    },
  );
}
