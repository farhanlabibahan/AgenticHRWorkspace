import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';

/**
 * Full organization export as JSON — the portability half of the
 * self-hosted ↔ managed migration path (docs/07-migration.md). Everything
 * tenant-owned, no password hashes or other credentials.
 *
 * Streamed: each collection is read in id-ordered batches and written as it
 * goes, so memory stays flat and the download has no size ceiling (Vercel's
 * 4.5MB response cap doesn't apply to streamed bodies). The document shape is
 * identical to the old all-at-once export, so scripts/import-org.mjs reads it
 * unchanged.
 *
 * All batches run in one read-only REPEATABLE READ transaction, so every
 * collection sees the same moment: a candidate added mid-export is either
 * wholly in the file or wholly absent, never an opportunity without its
 * contact (which import-org would reject).
 */

export const maxDuration = 300;

type Tx = Prisma.TransactionClient;

const BATCH = 1_000;

type Batch = (cursor: string | undefined) => Promise<{ id: string }[]>;

/** Page through a table by primary key: `take` rows after `cursor`. */
const page = (cursor: string | undefined) =>
  ({
    take: BATCH,
    orderBy: { id: 'asc' as const },
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  }) as const;

function collections(db: Tx, orgId: string): [string, Batch][] {
  const org = { orgId };
  return [
    [
      'users',
      (c) =>
        db.user.findMany({
          where: org,
          select: { id: true, email: true, name: true, accessRole: true, deactivatedAt: true, createdAt: true },
          ...page(c),
        }),
    ],
    ['departments', (c) => db.department.findMany({ where: org, ...page(c) })],
    ['clientCompanies', (c) => db.clientCompany.findMany({ where: org, ...page(c) })],
    ['stages', (c) => db.stage.findMany({ where: org, ...page(c) })],
    ['archiveReasons', (c) => db.archiveReason.findMany({ where: org, ...page(c) })],
    ['contacts', (c) => db.contact.findMany({ where: org, ...page(c) })],
    ['postings', (c) => db.posting.findMany({ where: org, ...page(c) })],
    ['opportunities', (c) => db.opportunity.findMany({ where: org, ...page(c) })],
    ['stageTransitions', (c) => db.stageTransition.findMany({ where: { opportunity: org }, ...page(c) })],
    [
      'interviews',
      (c) => db.interview.findMany({ where: org, include: { panelists: { select: { id: true }, orderBy: { id: 'asc' } } }, ...page(c) }),
    ],
    ['feedback', (c) => db.feedbackSubmission.findMany({ where: org, ...page(c) })],
    ['notes', (c) => db.note.findMany({ where: org, ...page(c) })],
    ['emailTemplates', (c) => db.emailTemplate.findMany({ where: org, ...page(c) })],
    ['emailMessages', (c) => db.emailMessage.findMany({ where: org, ...page(c) })],
    ['consents', (c) => db.consentRecord.findMany({ where: org, ...page(c) })],
    ['events', (c) => db.event.findMany({ where: org, ...page(c) })],
    ['tasks', (c) => db.task.findMany({ where: org, ...page(c) })],
    ['offers', (c) => db.offer.findMany({ where: org, ...page(c) })],
    ['requisitions', (c) => db.requisition.findMany({ where: org, ...page(c) })],
    ['customFieldDefs', (c) => db.customFieldDef.findMany({ where: org, ...page(c) })],
    ['planSteps', (c) => db.interviewPlanStep.findMany({ where: org, ...page(c) })],
    ['transcripts', (c) => db.transcript.findMany({ where: org, ...page(c) })],
    ['savedReports', (c) => db.savedReport.findMany({ where: org, ...page(c) })],
    ['eeoResponses', (c) => db.eeoResponse.findMany({ where: org, ...page(c) })],
    // Which records came from another ATS, so a re-run after moving editions
    // skips them (and keeps erased candidates erased). Jobs and their
    // credentials never leave the instance.
    [
      'importRefs',
      (c) =>
        db.importRef.findMany({
          // File binaries don't travel in the export, so their refs mustn't either:
          // a re-import on the other side should fetch those files again.
          where: { ...org, kind: { not: 'file' } },
          select: { id: true, provider: true, kind: true, externalId: true, internalId: true, created: true, createdAt: true },
          ...page(c),
        }),
    ],
  ];
}

async function* exportDocument(db: Tx, orgId: string, organization: unknown): AsyncGenerator<string> {
  // v2 adds tasks/offers/requisitions/custom fields/plan steps/
  // transcripts/saved reports/EEO; the importer accepts v1 too.
  yield `{"exportVersion":2,"exportedAt":${JSON.stringify(new Date().toISOString())},`;
  yield `"organization":${JSON.stringify(organization)}`;
  for (const [key, next] of collections(db, orgId)) {
    yield `,${JSON.stringify(key)}:[`;
    let cursor: string | undefined;
    let first = true;
    for (;;) {
      const rows = await next(cursor);
      if (!rows.length) break;
      yield (first ? '' : ',') + rows.map((r) => JSON.stringify(r)).join(',');
      first = false;
      if (rows.length < BATCH) break;
      cursor = rows[rows.length - 1].id;
    }
    yield ']';
  }
  yield '}\n';
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.orgId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const role = String(session.user.accessRole);
  if (role !== 'SUPER_ADMIN' && role !== 'ADMIN') {
    return NextResponse.json({ error: 'admin only' }, { status: 403 });
  }

  const orgId = session.user.orgId;
  const organization = await db.organization.findUnique({ where: { id: orgId } });
  const encoder = new TextEncoder();

  // The transaction stays open while the client downloads: its callback only
  // returns once the stream finishes or is cancelled. Each pull reads the
  // next chunk inside it, so the reader's pace sets the pace of the queries.
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => (finish = resolve));
  const chunks = new Promise<AsyncGenerator<string>>((resolve, reject) => {
    db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        resolve(exportDocument(tx, orgId, organization));
        await finished;
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        maxWait: 10_000,
        timeout: maxDuration * 1000,
      },
    ).catch(reject);
  });

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await (await chunks).next();
        if (done) {
          controller.close();
          finish();
        } else controller.enqueue(encoder.encode(value));
      } catch (error) {
        // Headers are already sent — abort so the download fails visibly
        // instead of saving a truncated file that looks complete.
        controller.error(error);
        finish();
      }
    },
    async cancel() {
      finish();
      // If the transaction never opened there's no generator to close.
      await chunks.then((gen) => gen.return(undefined)).catch(() => {});
    },
  });

  return new Response(body, {
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="source-export-${organization?.slug ?? 'org'}.json"`,
      'Cache-Control': 'no-store',
    },
  });
}
