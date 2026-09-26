import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hasDb } from '../../../../tests/setup';
import { pagedStep } from '@/server/imports/paging';
import type { Phase, ProviderModule } from '@/server/imports/types';

/**
 * End-to-end engine test against a real Postgres (DATABASE_URL). A fake
 * vendor serves a small, fully-featured account; the test drives the job
 * exactly as the app does — start, discover, review, confirm, load — and
 * then proves the guarantees that matter: re-runs add only what's new,
 * erased candidates stay erased, cancel stops work, and a job resumes
 * correctly across many tiny slices.
 */

// ---------- the fake vendor ----------

type Vendor = {
  candidates: { id: string; name: string; email: string; created: string }[];
  applications: {
    id: string;
    candidateId: string;
    jobId: string | null;
    stageId: string;
    status: 'active' | 'archived' | 'hired';
    reasonId?: string;
    history: { stageId: string; at: string; by?: string }[];
    created: string;
  }[];
};

const vendor: Vendor = {
  candidates: [
    { id: 'c1', name: 'Ada Lovelace', email: 'ada@example.test', created: '2025-01-05T10:00:00Z' },
    { id: 'c2', name: 'Grace Hopper', email: 'grace@example.test', created: '2025-02-05T10:00:00Z' },
    { id: 'c3', name: 'Existing Person', email: 'existing@example.test', created: '2025-03-05T10:00:00Z' },
  ],
  applications: [
    {
      id: 'a1',
      candidateId: 'c1',
      jobId: 'j1',
      stageId: 'j1-tech',
      status: 'active',
      history: [
        { stageId: 'j1-new', at: '2025-01-05T10:00:00Z' },
        { stageId: 'j1-phone', at: '2025-01-07T10:00:00Z', by: 'u-admin' },
        { stageId: 'j1-tech', at: '2025-01-09T10:00:00Z', by: 'u-admin' },
      ],
      created: '2025-01-05T10:00:00Z',
    },
    {
      id: 'a2',
      candidateId: 'c2',
      jobId: 'j2',
      stageId: 'j2-phone',
      status: 'archived',
      reasonId: 'r-fit',
      history: [{ stageId: 'j2-phone', at: '2025-02-06T10:00:00Z' }],
      created: '2025-02-05T10:00:00Z',
    },
    {
      id: 'a3',
      candidateId: 'c3',
      jobId: 'j1',
      stageId: 'j1-offer',
      status: 'hired',
      reasonId: 'r-hired',
      history: [{ stageId: 'j1-offer', at: '2025-03-10T10:00:00Z' }],
      created: '2025-03-05T10:00:00Z',
    },
    // References a candidate the vendor no longer returns
    { id: 'a4', candidateId: 'ghost', jobId: 'j1', stageId: 'j1-new', status: 'active', history: [], created: '2025-04-01T10:00:00Z' },
  ],
};

const stageName: Record<string, string> = {
  'j1-new': 'New Applicant',
  'j1-phone': 'Phone screen',
  'j1-tech': 'Tech Interview',
  'j1-offer': 'Offer',
  'j2-phone': 'Phone Screen',
};

let downloads = 0;

/** Slice a list into vendor "pages" of two, keyed by page number. */
function page<T>(list: T[], p: unknown) {
  const n = typeof p === 'number' ? p : 0;
  return { items: list.slice(n * 2, n * 2 + 2), next: n * 2 + 2 < list.length ? n + 1 : null };
}

const fakeModule: ProviderModule = {
  id: 'acme',
  minIntervalMs: 0,
  auth: () => ({ hosts: ['api.acme.test'], headers: { authorization: 'Bearer test' } }),
  create(creds) {
    const discover: Phase[] = [
      {
        id: 'users',
        label: 'Team',
        async run(ctx) {
          ctx.catalog.user({ externalId: 'u-admin', name: 'Importing Admin', email: 'ADMIN@acme.test' });
          ctx.catalog.user({ externalId: 'u-gone', name: 'Former Recruiter', email: 'former@acme.test' });
          return null;
        },
      },
      {
        id: 'stages',
        label: 'Pipeline',
        async run(ctx) {
          Object.entries(stageName).forEach(([externalId, name], position) =>
            ctx.catalog.stage({ externalId, name, position, typeHint: name === 'Offer' ? 'OFFER' : null }),
          );
          ctx.catalog.reason({ externalId: 'r-fit', name: 'Not a fit', kind: 'rejection' });
          ctx.catalog.reason({ externalId: 'r-hired', name: 'Hired', kind: 'hired' });
          return null;
        },
      },
    ];
    const load: Phase[] = [
      {
        id: 'postings',
        label: 'Jobs',
        async run(ctx) {
          await ctx.load.posting({ externalId: 'j1', title: 'Staff Engineer', state: 'open', department: 'Engineering', description: 'Build things' });
          await ctx.load.posting({ externalId: 'j2', title: 'Designer', state: 'closed' });
          return null;
        },
      },
      {
        id: 'candidates',
        label: 'Candidates',
        run: (ctx, cursor) =>
          pagedStep(ctx, cursor, async (p) => page(vendor.candidates, p), (c) =>
            ctx.load.candidate({ externalId: c.id, name: c.name, emails: [c.email], phones: [], links: [], tags: ['imported'], createdAt: new Date(c.created) }),
          ),
      },
      {
        id: 'applications',
        label: 'Applications',
        run: (ctx, cursor) =>
          pagedStep(ctx, cursor, async (p) => page(vendor.applications, p), (a) =>
            ctx.load.application({
              externalId: a.id,
              candidateExternalId: a.candidateId,
              postingExternalId: a.jobId,
              stage: { externalId: a.stageId, name: stageName[a.stageId] },
              status: a.status,
              archiveReason: a.reasonId ? { externalId: a.reasonId } : null,
              archivedAt: a.status === 'active' ? null : new Date('2025-06-01T00:00:00Z'),
              origin: 'SOURCED',
              source: 'LinkedIn',
              ownerExternalUserId: 'u-admin',
              createdAt: new Date(a.created),
              history: a.history.map((h) => ({ stage: { externalId: h.stageId }, at: new Date(h.at), actorExternalUserId: h.by })),
            }),
          ),
      },
      {
        id: 'activity',
        label: 'Notes & feedback',
        enabled: (o) => o.activity,
        async run(ctx) {
          await ctx.load.note({ externalId: 'n1', applicationExternalId: 'a1', authorExternalUserId: 'u-admin', body: 'Strong systems background.' });
          await ctx.load.note({ externalId: 'n2', candidateExternalId: 'c2', authorExternalUserId: 'u-gone', authorName: 'Former Recruiter', body: 'Portfolio is great.' });
          await ctx.load.interview({
            externalId: 'i1',
            applicationExternalId: 'a1',
            title: 'Systems design',
            startAt: new Date('2025-01-09T15:00:00Z'),
            durationMins: 45,
            panelistExternalUserIds: ['u-admin', 'u-gone'],
          });
          await ctx.load.feedback({
            externalId: 'f1',
            applicationExternalId: 'a1',
            interviewExternalId: 'i1',
            authorExternalUserId: 'u-admin',
            rating: 4,
            summary: 'Hire.',
            answers: [{ label: 'Architecture', value: 'Excellent' }],
          });
          await ctx.load.feedback({ externalId: 'f2', applicationExternalId: 'a2', authorName: 'Former Recruiter', rating: null, summary: 'No decision yet — needs a second look.' });
          return null;
        },
      },
      {
        id: 'offers',
        label: 'Offers',
        enabled: (o) => o.offers,
        async run(ctx) {
          await ctx.load.offer({ externalId: 'o1', applicationExternalId: 'a3', status: 'ACCEPTED', salaryAmount: 185000, salaryCurrency: 'usd', startDate: new Date('2025-04-01') });
          return null;
        },
      },
      {
        id: 'files',
        label: 'Resumes',
        enabled: (o) => o.files,
        async run(ctx) {
          await ctx.load.file({
            externalId: 'file-1',
            candidateExternalId: 'c1',
            filename: 'ada.txt',
            kind: 'resume',
            download: async () => {
              downloads++;
              return { data: Buffer.from('Ada resume'), contentType: 'text/plain' };
            },
          });
          return null;
        },
      },
    ];
    return {
      async verify() {
        if (creds.apiKey === 'bad') {
          const { ImportAuthError } = await import('@/server/imports/http');
          throw new ImportAuthError(401, 'GET api.acme.test/me');
        }
        return { accountName: 'Acme Corp' };
      },
      discover,
      load,
    };
  },
};

vi.mock('@/server/imports/providers', () => ({ getProvider: (id: string) => (id === 'acme' ? fakeModule : undefined) }));
vi.mock('@/lib/import-providers', () => ({
  providerMeta: (id: string) =>
    id === 'acme'
      ? { id: 'acme', name: 'Acme ATS', domain: 'acme.test', fields: [{ key: 'apiKey', label: 'API key', kind: 'secret' }] }
      : undefined,
}));
vi.mock('@/lib/session', () => ({ isAdmin: (ctx: { accessRole: string }) => ['ADMIN', 'SUPER_ADMIN'].includes(ctx.accessRole) }));

const { db } = await import('@/lib/db');
const jobs = await import('@/server/imports/jobs');
const { runSlice } = await import('@/server/imports/runner');

// ---------- fixtures ----------

let orgId = '';
let ctx: { userId: string; orgId: string; accessRole: string };
const created: string[] = [];

async function drive(jobId: string, opts: { budgetMs?: number; now?: () => number } = {}) {
  for (let i = 0; i < 500; i++) {
    const job = await db.importJob.findUniqueOrThrow({ where: { id: jobId } });
    if (!['DISCOVERING', 'RUNNING'].includes(job.status)) return job;
    const r = await runSlice(jobId, opts.budgetMs ?? 20_000, { now: opts.now });
    if (r === 'failed') throw new Error(`slice failed: ${(await db.importJob.findUniqueOrThrow({ where: { id: jobId } })).error}`);
  }
  throw new Error('job did not settle');
}

async function startAndConfirm() {
  const started = await jobs.startImport(ctx, 'acme', { apiKey: 'good' }, { archived: true, activity: true, offers: true, files: true });
  if (!started.ok) throw new Error(started.error);
  const reviewed = await drive(started.jobId);
  expect(reviewed.status).toBe('REVIEW');
  const view = await jobs.getImportJob(ctx, started.jobId);
  const mapping = {
    stages: Object.fromEntries(view!.review!.stages.map((s) => [s.key, s.target])),
    reasons: Object.fromEntries(view!.review!.reasons.map((r) => [r.key, r.target])),
  };
  await jobs.confirmImportMapping(ctx, started.jobId, mapping);
  return { jobId: started.jobId, view: view! };
}

describe.skipIf(!hasDb)('import engine', () => {
  beforeAll(async () => {
    process.env.AUTH_SECRET ||= 'test-secret';
    const org = await db.organization.create({ data: { slug: `import-test-${randomUUID().slice(0, 8)}`, name: 'Import Test', onboardedAt: new Date() } });
    orgId = org.id;
    const admin = await db.user.create({ data: { orgId, email: 'admin@acme.test', name: 'Importing Admin', accessRole: 'ADMIN' } });
    ctx = { userId: admin.id, orgId, accessRole: 'ADMIN' };
    await db.stage.createMany({
      data: [
        { orgId, name: 'New applicant', type: 'APPLICANT', order: 0 },
        { orgId, name: 'Phone screen', type: 'SCREEN', order: 1 },
        { orgId, name: 'On-site', type: 'ONSITE', order: 2 },
        { orgId, name: 'Offer', type: 'OFFER', order: 3 },
        { orgId, name: 'Hired', type: 'HIRED', order: 4 },
      ],
    });
    await db.archiveReason.create({ data: { orgId, name: 'Withdrew', countsAsRejection: false } });
    // Someone who already applied directly — must be linked, not duplicated.
    await db.contact.create({ data: { orgId, name: 'Existing Person', emails: ['existing@example.test'], phones: [], links: [], tags: ['direct'] } });
  });

  afterAll(async () => {
    // Leave the throwaway org in place for inspection; the local DB is disposable.
    await db.$disconnect();
  });

  it('rejects bad credentials without creating a job', async () => {
    const res = await jobs.startImport(ctx, 'acme', { apiKey: 'bad' });
    expect(res).toEqual({ ok: false, error: expect.stringContaining('rejected') });
    expect(await db.importJob.count({ where: { orgId } })).toBe(0);
  });

  it('discovers, pauses for review with sensible defaults, then imports everything', async () => {
    const { jobId, view } = await startAndConfirm();
    created.push(jobId);

    // Review defaults: same-named stages map, new ones are created with inferred types.
    const byKey = Object.fromEntries(view.review!.stages.map((s) => [s.key, s]));
    expect(byKey['phone screen'].count).toBe(2); // j1-phone + j2-phone grouped
    expect(byKey['phone screen'].target).toHaveProperty('stageId');
    expect(byKey['tech interview'].target).toEqual({ create: { name: 'Tech Interview', type: 'SCREEN' } });
    expect(view.review!.users).toMatchObject({ total: 2, matched: 1 });

    const done = await drive(jobId);
    expect(done.status).toBe('SUCCEEDED');
    expect(done.credentials).toBeNull(); // wiped when the job ends
    expect(done.error).toBeNull();

    const contacts = await db.contact.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' } });
    expect(contacts.map((c) => c.name).sort()).toEqual(['Ada Lovelace', 'Existing Person', 'Grace Hopper']);
    expect(contacts.find((c) => c.name === 'Existing Person')!.tags.sort()).toEqual(['direct', 'imported']);
    expect(contacts.find((c) => c.name === 'Ada Lovelace')!.createdAt.toISOString()).toBe('2025-01-05T10:00:00.000Z');

    const opps = await db.opportunity.findMany({
      where: { orgId },
      include: { stage: true, archiveReason: true, posting: true, stageTransitions: { orderBy: { occurredAt: 'asc' }, include: { toStage: true } } },
    });
    expect(opps).toHaveLength(3); // a4's candidate is missing → skipped
    const a1 = opps.find((o) => (o.customFields as { imported: { id: string } }).imported.id === 'a1')!;
    expect(a1.stage.name).toBe('Tech Interview');
    expect(a1.status).toBe('ACTIVE');
    expect(a1.origin).toBe('SOURCED');
    expect(a1.ownerId).toBe(ctx.userId);
    expect(a1.posting!.state).toBe('DRAFT'); // open role, not auto-published
    expect(a1.stageTransitions.map((t) => t.toStage.name)).toEqual(['New applicant', 'Phone screen', 'Tech Interview']);
    expect(a1.stageTransitions[0].fromStageId).toBeNull();
    expect(a1.stageTransitions[1].actorId).toBe(ctx.userId);
    expect(a1.stageChangedAt.toISOString()).toBe('2025-01-09T10:00:00.000Z');

    const a2 = opps.find((o) => (o.customFields as { imported: { id: string } }).imported.id === 'a2')!;
    expect(a2.status).toBe('ARCHIVED');
    expect(a2.archiveReason!.name).toBe('Not a fit');
    expect(a2.archiveReason!.countsAsRejection).toBe(true);
    expect(a2.posting!.state).toBe('CLOSED');

    const a3 = opps.find((o) => (o.customFields as { imported: { id: string } }).imported.id === 'a3')!;
    expect(a3.status).toBe('HIRED');
    expect(a3.contactId).toBe(contacts.find((c) => c.name === 'Existing Person')!.id);

    const notes = await db.note.findMany({ where: { orgId } });
    expect(notes.map((n) => n.body).sort()).toEqual([
      'Strong systems background.', // matched teammate — no byline
      '[Acme ATS · Former Recruiter] No decision yet — needs a second look.', // scorecard without decision → note
      '[Acme ATS · Former Recruiter] Portfolio is great.', // candidate-level note, unmatched author
    ]);

    const interview = await db.interview.findFirstOrThrow({ where: { orgId }, include: { panelists: true } });
    expect(interview.state).toBe('COMPLETED');
    expect(interview.durationMins).toBe(45);
    expect(interview.panelists.map((p) => p.id)).toEqual([ctx.userId]);

    const fb = await db.feedbackSubmission.findFirstOrThrow({ where: { orgId } });
    expect(fb.overallRating).toBe(4);
    expect(fb.interviewId).toBe(interview.id);
    expect(fb.answers).toEqual({ 'imported-0': { label: 'Architecture', kind: 'TEXT', value: 'Excellent' } });

    const offer = await db.offer.findFirstOrThrow({ where: { orgId } });
    expect(offer).toMatchObject({ status: 'ACCEPTED', salaryAmount: 185000, salaryCurrency: 'USD', jobTitle: 'Staff Engineer' });

    const ada = contacts.find((c) => c.name === 'Ada Lovelace')!;
    expect(ada.resumeFileId).not.toBeNull();
    expect(downloads).toBe(1);

    const events = await db.event.findMany({ where: { orgId }, select: { verb: true } });
    expect(events.map((e) => e.verb).sort()).toEqual(['import.completed', 'import.started']);

    const view2 = await jobs.getImportJob(ctx, jobId);
    expect(view2!.created).toMatchObject({ contact: 2, opportunity: 3, note: 2, feedback: 2, interview: 1, offer: 1, file: 1, posting: 2 });
    expect(view2!.linked.contact).toBe(1);
    expect(view2!.phases.every((p) => p.state === 'done')).toBe(true);
  });

  it('re-running adds only what is new and never resurrects an erased candidate', async () => {
    // Grace gets erased in Source; the vendor gains a new candidate + application.
    const grace = await db.contact.findFirstOrThrow({ where: { orgId, name: 'Grace Hopper' } });
    await db.contact.update({ where: { id: grace.id }, data: { name: 'Anonymized candidate', emails: [], isAnonymized: true } });
    vendor.candidates.push({ id: 'c4', name: 'Katherine Johnson', email: 'kj@example.test', created: '2025-05-01T10:00:00Z' });
    vendor.applications.push({ id: 'a5', candidateId: 'c4', jobId: 'j2', stageId: 'j2-phone', status: 'active', history: [], created: '2025-05-01T10:00:00Z' });

    const before = await db.opportunity.count({ where: { orgId } });
    const { jobId, view } = await startAndConfirm();
    // The second run's review remembers the first run's choices.
    expect(view.review!.stages.every((s) => 'stageId' in s.target)).toBe(true);
    const done = await drive(jobId);
    expect(done.status).toBe('SUCCEEDED');

    expect(await db.opportunity.count({ where: { orgId } })).toBe(before + 1);
    expect(await db.contact.count({ where: { orgId } })).toBe(4);
    expect(await db.contact.count({ where: { orgId, name: 'Grace Hopper' } })).toBe(0);
    expect(await db.note.count({ where: { orgId } })).toBe(3);
    expect(await db.feedbackSubmission.count({ where: { orgId } })).toBe(1);
    expect(await db.interview.count({ where: { orgId } })).toBe(1);
    expect(await db.offer.count({ where: { orgId } })).toBe(1);
    expect(await db.stage.count({ where: { orgId } })).toBe(6); // only "Tech Interview" was ever added
    expect(downloads).toBe(1); // already-imported files are not fetched again

    const view2 = await jobs.getImportJob(ctx, jobId);
    expect(view2!.created).toMatchObject({ contact: 1, opportunity: 1 });
  });

  it('resumes correctly across many tiny slices', async () => {
    vendor.candidates.push(
      ...Array.from({ length: 7 }, (_, i) => ({ id: `bulk-${i}`, name: `Bulk ${i}`, email: `bulk${i}@example.test`, created: '2025-07-01T00:00:00Z' })),
    );
    vendor.applications.push(
      ...Array.from({ length: 7 }, (_, i) => ({
        id: `bulk-app-${i}`,
        candidateId: `bulk-${i}`,
        jobId: 'j1',
        stageId: 'j1-new',
        status: 'active' as const,
        history: [],
        created: '2025-07-01T00:00:00Z',
      })),
    );
    const { jobId } = await startAndConfirm();
    // A clock that jumps 2s per read: every slice runs out of time after its first step.
    let t = Date.now();
    const done = await drive(jobId, { budgetMs: 4_000, now: () => (t += 2_000) });
    expect(done.status).toBe('SUCCEEDED');
    expect(await db.contact.count({ where: { orgId, name: { startsWith: 'Bulk ' } } })).toBe(7);
    const bulk = await db.opportunity.findMany({
      where: { orgId, contact: { name: { startsWith: 'Bulk ' } } },
      include: { stageTransitions: true },
    });
    expect(bulk).toHaveLength(7);
    // No vendor history still leaves the funnel a transition into the current stage.
    for (const o of bulk) expect(o.stageTransitions.map((t) => t.toStageId)).toEqual([o.stageId]);
  });

  it('keeps finding a candidate after they are merged into another contact', async () => {
    const { mergeContacts } = await import('@/server/contacts');
    const imported = await db.contact.findFirstOrThrow({ where: { orgId, name: 'Katherine Johnson' } });
    const keeper = await db.contact.create({ data: { orgId, name: 'K. Johnson', emails: ['kj.personal@example.test'], phones: [], links: [], tags: [] } });
    await mergeContacts(ctx, keeper.id, imported.id);

    vendor.applications.push({ id: 'a6', candidateId: 'c4', jobId: 'j1', stageId: 'j1-new', status: 'active', history: [], created: '2025-08-01T10:00:00Z' });
    const { jobId } = await startAndConfirm();
    expect((await drive(jobId)).status).toBe('SUCCEEDED');
    const a6 = await db.opportunity.findFirstOrThrow({ where: { orgId, customFields: { path: ['imported', 'id'], equals: 'a6' } } });
    expect(a6.contactId).toBe(keeper.id);
  });

  it('never sends feedback reminders for interviews that came from an import', async () => {
    const { processFeedbackReminders } = await import('@/server/feedback');
    const opp = await db.opportunity.findFirstOrThrow({ where: { orgId, feedback: { none: {} } } });
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000);
    const imported = await db.interview.create({
      data: { orgId, opportunityId: opp.id, title: 'From the old ATS', startAt: threeDaysAgo, state: 'COMPLETED', panelists: { connect: [{ id: ctx.userId }] } },
    });
    await db.importRef.create({ data: { orgId, provider: 'acme', kind: 'interview', externalId: 'recent-i', internalId: imported.id } });
    const native = await db.interview.create({
      data: { orgId, opportunityId: opp.id, title: 'Scheduled in Source', startAt: threeDaysAgo, state: 'COMPLETED', panelists: { connect: [{ id: ctx.userId }] } },
    });

    await processFeedbackReminders();
    const reminded = await db.event.findMany({ where: { orgId, verb: 'feedback.reminder_sent' }, select: { subjectId: true } });
    expect(reminded.map((e) => e.subjectId)).toEqual([native.id]);
  });

  it('cancel stops the job and wipes its credentials', async () => {
    const started = await jobs.startImport(ctx, 'acme', { apiKey: 'good' });
    if (!started.ok) throw new Error(started.error);
    await jobs.cancelImport(ctx, started.jobId);
    const job = await db.importJob.findUniqueOrThrow({ where: { id: started.jobId } });
    expect(job.status).toBe('CANCELED');
    expect(job.credentials).toBeNull();
    expect(await runSlice(started.jobId, 5_000)).toBe('idle');
  });

  it('only admins can import', async () => {
    await expect(jobs.listImportJobs({ ...ctx, accessRole: 'TEAM_MEMBER' })).rejects.toThrow(/admins/);
  });
});

describe.skipIf(!hasDb)('import into a brand-new workspace', () => {
  let fresh: { userId: string; orgId: string; accessRole: string };

  const stageNames = async () =>
    (await db.stage.findMany({ where: { orgId: fresh.orgId }, orderBy: { order: 'asc' } })).map((s) => s.name);

  async function toReview() {
    const started = await jobs.startImport(fresh, 'acme', { apiKey: 'good' }, { archived: true, activity: true, offers: true, files: false });
    if (!started.ok) throw new Error(started.error);
    expect((await drive(started.jobId)).status).toBe('REVIEW');
    const view = (await jobs.getImportJob(fresh, started.jobId))!;
    const mapping = {
      stages: Object.fromEntries(view.review!.stages.map((s) => [s.key, s.target])),
      reasons: Object.fromEntries(view.review!.reasons.map((r) => [r.key, r.target])),
    };
    return { jobId: started.jobId, view, mapping };
  }

  beforeAll(async () => {
    process.env.AUTH_SECRET ||= 'test-secret';
    const { DEFAULT_STAGES } = await import('@/server/org-defaults');
    const org = await db.organization.create({ data: { slug: `import-fresh-${randomUUID().slice(0, 8)}`, name: 'Fresh Start' } });
    const admin = await db.user.create({ data: { orgId: org.id, email: 'admin@acme.test', name: 'Importing Admin', accessRole: 'ADMIN' } });
    fresh = { userId: admin.id, orgId: org.id, accessRole: 'ADMIN' };
    await db.stage.createMany({ data: DEFAULT_STAGES.map((s) => ({ ...s, orgId: org.id })) });
  });

  it("swaps the starter stages no vendor stage lands in for the vendor's pipeline", async () => {
    const { jobId, view, mapping } = await toReview();
    expect(view.review!.canReplaceStarters).toBe(true);

    await jobs.confirmImportMapping(fresh, jobId, { ...mapping, replaceStarters: true });
    // New applicant, Phone screen and Offer are vendor targets; Tech Interview is new;
    // the leads and On-site go; Hired stays, since a move into it records a hire.
    expect(await stageNames()).toEqual(['New applicant', 'Phone screen', 'Tech Interview', 'Offer', 'Hired']);
    const deleted = await db.event.findMany({ where: { orgId: fresh.orgId, verb: 'stage.deleted' } });
    expect(deleted.map((e) => (e.payload as { name: string }).name).sort()).toEqual(['New lead', 'On-site', 'Reached out', 'Responded']);

    expect((await drive(jobId)).status).toBe('SUCCEEDED');
    // (earlier tests grew the fake vendor, so no exact count)
    expect(await db.opportunity.count({ where: { orgId: fresh.orgId } })).toBeGreaterThan(0);
  });

  it('never removes a stage once the workspace has applications', async () => {
    await db.stage.create({ data: { orgId: fresh.orgId, name: 'Take-home', type: 'SCREEN', order: 99 } });
    const { jobId, view, mapping } = await toReview();
    expect(view.review!.canReplaceStarters).toBe(false);

    // Even if a stale page still asks for it.
    await jobs.confirmImportMapping(fresh, jobId, { ...mapping, replaceStarters: true });
    expect(await stageNames()).toContain('Take-home');
    await drive(jobId);
  });
});
