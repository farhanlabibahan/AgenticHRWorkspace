/**
 * Page data loaders. Server components call these directly, so each page's
 * data arrives in the same response as its HTML — no client-side fetch. The
 * long lists' later pages come from the GET routes under /api/lists, which
 * reuse the same keyset functions (src/server/lists).
 */
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { decodeCursor } from '@/lib/list-cursor';
import { getAuthSession, isAdmin, requireSession } from '@/lib/session';
import { readOrgNavCookie } from '@/lib/org-nav-cookie';
import { aiConfigured } from '@/server/ai';
import { searchAll } from '@/server/contacts';
import { listPostings } from '@/server/postings';
import { listReferrals } from '@/server/referrals';
import { listPendingApprovals } from '@/server/approvals';
import { meetingsToReview } from '@/server/notetakers/review';
import type { ListMeta } from '@/server/list-meta';
import { cachedContactsTotal, cachedPipelineCounts, cachedPoolCounts, getListMeta } from '@/server/lists/cache';
import {
  PAGE_SIZE,
  pipelineFilterFor,
  pipelineHasAny,
  pipelinePage,
  type PipelineParams,
} from '@/server/lists/pipeline';
import {
  contactsPage,
  normalizeContactsInput,
  resolvePool,
  type ContactsInput as ContactsFilterInput,
} from '@/server/lists/contacts';

/** Rows per page for the long lists (contacts, pipeline, review). */
export { PAGE_SIZE };

const dashboardInterviewSelect = {
  id: true,
  title: true,
  startAt: true,
  durationMins: true,
  panelists: { select: { name: true }, orderBy: { name: 'asc' } },
  opportunity: {
    select: {
      contact: { select: { name: true } },
      posting: { select: { title: true, clientCompany: { select: { name: true } } } },
    },
  },
} satisfies Prisma.InterviewSelect;

/** The next 20 interviews plus the 10 most recent — never the whole calendar. */
async function dashboardInterviews(orgId: string) {
  const now = new Date();
  const [upcoming, recent] = await Promise.all([
    db.interview.findMany({
      where: { orgId, state: { not: 'CANCELED' }, startAt: { gte: now } },
      orderBy: { startAt: 'asc' },
      take: 20,
      select: dashboardInterviewSelect,
    }),
    db.interview.findMany({
      where: { orgId, state: { not: 'CANCELED' }, startAt: { lt: now } },
      orderBy: { startAt: 'desc' },
      take: 10,
      select: dashboardInterviewSelect,
    }),
  ]);
  return [...upcoming, ...recent];
}

export async function loadDashboardPage() {
  const ctx = await requireSession();
  const session = await getAuthSession();
  const [interviews, org, postingCount, pendingApprovals, contactCount, transcriptCount, upcomingCount] =
    await Promise.all([
      dashboardInterviews(ctx.orgId),
      session?.user.orgName != null
        ? Promise.resolve({
            name: session.user.orgName,
            logoFileId: session.user.orgLogoFileId ?? null,
          })
        : readOrgNavCookie(),
      db.posting.count({ where: { orgId: ctx.orgId } }),
      isAdmin(ctx) ? listPendingApprovals(ctx.orgId) : Promise.resolve([]),
      db.contact.count({ where: { orgId: ctx.orgId } }),
      db.transcript.count({ where: { orgId: ctx.orgId } }),
      db.interview.count({
        where: { orgId: ctx.orgId, state: { not: 'CANCELED' }, startAt: { gte: new Date() } },
      }),
    ]);

  return {
    firstName: (session?.user.name ?? '').trim().split(/\s+/)[0] || 'there',
    orgName: org?.name ?? '',
    logoFileId: org?.logoFileId ?? null,
    postingCount,
    contactCount,
    upcomingCount,
    transcriptCount,
    aiEnabled: aiConfigured(),
    isAdmin: isAdmin(ctx),
    pendingApprovals: pendingApprovals.map((a) => ({
      id: a.id,
      subjectType: a.subjectType,
      title: a.title,
      href: a.href,
      requestedByName: a.requestedByName,
    })),
    interviews: interviews.map((iv) => ({
      id: iv.id,
      title: iv.title,
      startAt: iv.startAt.toISOString(),
      durationMins: iv.durationMins,
      contactName: iv.opportunity.contact.name,
      postingTitle: iv.opportunity.posting?.title ?? null,
      clientName: iv.opportunity.posting?.clientCompany?.name ?? null,
      panelistNames: iv.panelists.map((p) => p.name),
    })),
  };
}

export type PipelineInput = PipelineParams & {
  /** Keyset cursor: render the page after it (Load more without JavaScript). */
  after?: string;
};

/** Rail groups: postings under their client (agencies) or department. */
function postingGroupsFor(meta: ListMeta, client: string | undefined) {
  const groupsMap = new Map<string | null, { id: string; title: string }[]>();
  for (const p of meta.postings) {
    if (client && p.clientCompanyId !== client) continue;
    const label = p.clientName ?? p.departmentName ?? null;
    if (!groupsMap.has(label)) groupsMap.set(label, []);
    groupsMap.get(label)!.push({ id: p.id, title: p.title });
  }
  return [...groupsMap.entries()]
    .sort(([a], [b]) => (a ?? '').localeCompare(b ?? ''))
    .map(([label, postings]) => ({ label, postings }));
}

export async function loadPipelinePage(input: PipelineInput) {
  const ctx = await requireSession();
  const q = input.q ?? '';
  const archived = input.status === 'archived';
  const sort = input.sort === 'name' ? 'name' : 'time';
  // Meta and counts come from the data cache, so a stage switch usually runs
  // one query: its rows. Only a client filter needs the meta up front.
  const metaP = getListMeta(ctx.orgId);
  const f = pipelineFilterFor(ctx.orgId, input, input.client ? await metaP : null);
  const after = decodeCursor(input.after, sort);

  const [meta, counts, page, hasAny] = await Promise.all([
    metaP,
    cachedPipelineCounts(f),
    pipelinePage(f, sort, { after }),
    // "Pipeline is empty" means nothing in scope — not "no search results".
    !archived && f.q ? pipelineHasAny(f) : Promise.resolve(null),
  ]);

  return {
    empty: !archived && (hasAny === null ? counts.total === 0 : !hasAny),
    archived,
    q,
    sort: input.sort === 'name' ? 'name' : '',
    stageFilter: input.stage ?? '',
    postingFilter: input.posting ?? '',
    clientFilter: input.client ?? '',
    /** The cursor this page was rendered after ('' for the first page). */
    after: after ? (input.after ?? '') : '',
    fallbackGroupLabel: meta.kind === 'AGENCY' ? 'Other clients' : 'Roles',
    stages: meta.stages,
    counts,
    page,
    postingGroups: postingGroupsFor(meta, input.client),
    archiveReasons: meta.archiveReasons,
    clients: meta.clients,
  };
}

export type ContactsInput = ContactsFilterInput & { after?: string };

export async function loadContactsPage(input: ContactsInput) {
  const ctx = await requireSession();
  // The same list the client's key and Load more describe: search trimmed.
  const filter = normalizeContactsInput(input);
  const q = filter.q ?? '';
  const tag = filter.tag ?? '';
  const poolId = filter.pool ?? '';
  const after = decodeCursor(input.after, 'created');

  const [pools, activePool] = await Promise.all([
    db.talentPool.findMany({
      where: { orgId: ctx.orgId },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, kind: true, rules: true },
    }),
    resolvePool(ctx.orgId, filter.pool),
  ]);
  // The rows are the page; the rail's pool counts and the total under the
  // list stream in after them (a segment's count is a text search over every
  // contact, 0.7-4 s cold at 300k), so they are handed over as promises.
  const poolCounts = cachedPoolCounts(ctx.orgId, pools).catch(() => null);
  const total = cachedContactsTotal(ctx.orgId, filter, activePool).catch(() => null);
  const page = await contactsPage(ctx.orgId, filter, { after, pool: activePool });

  return {
    q,
    tag,
    poolId,
    after: after ? (input.after ?? '') : '',
    pools: pools.map((p) => ({ id: p.id, name: p.name, kind: p.kind })),
    poolCounts,
    page,
    total,
    staticPools: pools.filter((p) => p.kind === 'STATIC').map((p) => ({ id: p.id, name: p.name })),
    currentPoolId: activePool?.id ?? null,
    currentPoolStatic: activePool?.kind === 'STATIC',
  };
}

const interviewListSelect = {
  id: true,
  title: true,
  startAt: true,
  state: true,
  location: true,
  panelists: { select: { name: true }, orderBy: { name: 'asc' } },
  opportunity: {
    select: {
      contact: { select: { name: true } },
      posting: { select: { title: true } },
    },
  },
} satisfies Prisma.InterviewSelect;

type InterviewListRow = Prisma.InterviewGetPayload<{ select: typeof interviewListSelect }>;

function interviewRow(iv: InterviewListRow) {
  return {
    id: iv.id,
    title: iv.title,
    startAt: iv.startAt.toISOString(),
    state: iv.state,
    location: iv.location,
    panelistNames: iv.panelists.map((p) => p.name),
    contactName: iv.opportunity.contact.name,
    postingTitle: iv.opportunity.posting?.title ?? null,
  };
}

/** Scheduled interviews from an hour ago on (soonest first), plus the 20 most recent others. */
export async function loadInterviewsPage() {
  const ctx = await requireSession();
  const cutoff = new Date(Date.now() - 3_600_000);
  const [upcoming, past, suggested] = await Promise.all([
    db.interview.findMany({
      where: { orgId: ctx.orgId, state: 'SCHEDULED', startAt: { gte: cutoff } },
      orderBy: { startAt: 'asc' },
      take: 100,
      select: interviewListSelect,
    }),
    db.interview.findMany({
      where: {
        orgId: ctx.orgId,
        OR: [{ state: { not: 'SCHEDULED' } }, { startAt: { lt: cutoff } }],
      },
      orderBy: { startAt: 'desc' },
      take: 20,
      select: interviewListSelect,
    }),
    // The signed-in person's notetaker meetings waiting for them (only
    // theirs), each with who it could have been with.
    meetingsToReview(ctx),
  ]);
  return { upcoming: upcoming.map(interviewRow), past: past.map(interviewRow), suggested };
}

export async function loadTasksPage() {
  const ctx = await requireSession();
  const now = new Date();
  const [tasks, snoozed] = await Promise.all([
    db.task.findMany({
      where: { orgId: ctx.orgId, completedAt: null },
      orderBy: [{ dueAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
      include: {
        assignee: { select: { name: true } },
        opportunity: { include: { contact: { select: { name: true } } } },
      },
      take: 200,
    }),
    db.opportunity.findMany({
      where: { orgId: ctx.orgId, status: 'ACTIVE', snoozedUntil: { gt: now } },
      orderBy: { snoozedUntil: 'asc' },
      include: { contact: { select: { name: true } } },
      take: 50,
    }),
  ]);
  return {
    now: now.toISOString(),
    tasks: tasks.map((t) => ({
      id: t.id,
      title: t.title,
      dueAt: t.dueAt?.toISOString() ?? null,
      assigneeName: t.assignee?.name ?? null,
      opportunityId: t.opportunityId,
      contactName: t.opportunity?.contact.name ?? null,
    })),
    snoozed: snoozed.map((o) => ({
      id: o.id,
      name: o.contact.name,
      snoozedUntil: o.snoozedUntil?.toISOString() ?? null,
    })),
  };
}

export async function loadSearchPage(q: string) {
  const ctx = await requireSession();
  const results = await searchAll(ctx.orgId, q);
  return { q, aiEnabled: aiConfigured(), results };
}

export async function loadReviewPage(postingFilter: string) {
  const ctx = await requireSession();
  const queueWhere: Prisma.OpportunityWhereInput = {
    orgId: ctx.orgId,
    status: 'ACTIVE',
    stage: { type: { in: ['LEAD', 'APPLICANT'] } },
    ...(postingFilter ? { postingId: postingFilter } : {}),
  };
  // Rank in SQL: latest AI recommendation first (unreviewed last), then the
  // match against the role's criteria, then oldest application — so a
  // 10k-deep queue still returns its true top rows.
  const ranked = await db.$queryRaw<{ id: string }[]>`
    SELECT o.id
    FROM "Opportunity" o
    JOIN "Stage" s ON s.id = o."stageId"
    LEFT JOIN LATERAL (
      SELECT e.recommendation, e."matchScore" FROM "AiEvaluation" e
      WHERE e."opportunityId" = o.id
      ORDER BY e."createdAt" DESC
      LIMIT 1
    ) ev ON true
    WHERE o."orgId" = ${ctx.orgId}
      AND o.status = 'ACTIVE'
      AND s.type IN ('LEAD', 'APPLICANT')
      AND (${postingFilter} = '' OR o."postingId" = ${postingFilter})
    ORDER BY COALESCE(ev.recommendation, 0) DESC, COALESCE(ev."matchScore", -1) DESC, o."createdAt" ASC, o.id ASC
    LIMIT ${PAGE_SIZE}`;

  const [stages, archiveReasons, postings, queueLength, unevaluated, queue] = await Promise.all([
    db.stage.findMany({ where: { orgId: ctx.orgId }, orderBy: { order: 'asc' } }),
    db.archiveReason.findMany({ where: { orgId: ctx.orgId }, orderBy: { name: 'asc' } }),
    db.posting.findMany({
      where: { orgId: ctx.orgId, state: { in: ['PUBLISHED', 'INTERNAL'] } },
      orderBy: { title: 'asc' },
      select: { id: true, title: true },
    }),
    db.opportunity.count({ where: queueWhere }),
    db.opportunity.count({ where: { ...queueWhere, aiEvaluations: { none: {} } } }),
    db.opportunity.findMany({
      where: { id: { in: ranked.map((r) => r.id) } },
      include: {
        contact: { select: { name: true, headline: true, location: true } },
        posting: { select: { title: true } },
        stage: true,
        aiEvaluations: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    }),
  ]);
  const byId = new Map(queue.map((o) => [o.id, o]));
  const rejectReason =
    archiveReasons.find((r) => r.countsAsRejection) ?? archiveReasons[0] ?? null;
  const rows = ranked
    .map((r) => byId.get(r.id))
    .filter((o): o is NonNullable<typeof o> => Boolean(o))
    .map((o) => {
      const ev = o.aiEvaluations[0] ?? null;
      const next = stages.find((s) => s.order > o.stage.order) ?? null;
      return {
        id: o.id,
        name: o.contact.name,
        headline: o.contact.headline,
        location: o.contact.location,
        postingTitle: o.posting?.title ?? null,
        stageName: o.stage.name,
        nextStageId: next?.id ?? null,
        nextStageName: next?.name ?? null,
        // Advancing into another lead/applicant stage keeps them in this queue.
        advanceLeavesQueue: !next || !['LEAD', 'APPLICANT'].includes(next.type),
        evaluation: ev
          ? {
              recommendation: ev.recommendation,
              matchScore: ev.matchScore,
              summary: ev.summary,
              strengths: ev.strengths,
              concerns: ev.concerns,
            }
          : null,
      };
    });
  return {
    postingFilter,
    aiEnabled: aiConfigured(),
    postings,
    rejectReasonId: rejectReason?.id ?? null,
    unevaluated,
    queueLength,
    rows,
  };
}

export async function loadReferralsPage() {
  const ctx = await requireSession();
  const [referrals, postings] = await Promise.all([
    listReferrals(ctx),
    db.posting.findMany({
      where: { orgId: ctx.orgId, state: { in: ['PUBLISHED', 'INTERNAL'] } },
      orderBy: { title: 'asc' },
      select: { id: true, title: true },
    }),
  ]);
  return {
    postings,
    referrals: referrals.map((r) => ({
      id: r.id,
      opportunityId: r.opportunity.id,
      opportunityStatus: r.opportunity.status,
      stageName: r.opportunity.stage.name,
      contactName: r.contact.name,
      headline: r.contact.headline,
      email: r.contact.emails[0] ?? null,
      postingTitle: r.posting?.title ?? null,
      referrerName: r.referringUser.name,
      relationship: r.relationship,
      notes: r.notes,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}

export async function loadPostingsPage(input: { status?: string; state?: string; q?: string }) {
  const ctx = await requireSession();
  const archived = input.status === 'archived';
  const stateFilter = input.state ?? '';
  const q = input.q ?? '';
  const [postings, org, requisitions] = await Promise.all([
    listPostings(ctx),
    db.organization.findUnique({
      where: { id: ctx.orgId },
      select: { kind: true, slug: true, logoFileId: true, name: true, requirePostingApproval: true },
    }),
    db.requisition.findMany({
      where: { orgId: ctx.orgId },
      orderBy: [{ state: 'asc' }, { createdAt: 'desc' }],
      include: { _count: { select: { postings: true } } },
    }),
  ]);
  const isAgency = org?.kind === 'AGENCY';
  const needle = q.trim().toLowerCase();
  const rows = postings.filter((p) => {
    if (archived ? p.state !== 'CLOSED' : p.state === 'CLOSED') return false;
    if (!archived && stateFilter && p.state !== stateFilter) return false;
    if (!needle) return true;
    return [p.title, p.clientCompany?.name, p.department?.name, p.location]
      .filter(Boolean)
      .some((v) => String(v).toLowerCase().includes(needle));
  });
  return {
    archived,
    stateFilter,
    q,
    isAgency,
    isAdmin: ctx.accessRole === 'SUPER_ADMIN' || ctx.accessRole === 'ADMIN',
    org: org
      ? {
          kind: org.kind,
          slug: org.slug,
          logoFileId: org.logoFileId,
          name: org.name,
          requirePostingApproval: org.requirePostingApproval,
        }
      : null,
    drafts: postings
      .filter((p) => p.state === 'DRAFT' || p.state === 'PENDING_APPROVAL')
      .map((p) => ({ id: p.id, title: p.title })),
    rows: rows.map((p) => ({
      id: p.id,
      title: p.title,
      slug: p.slug,
      state: p.state,
      workplaceType: p.workplaceType,
      commitment: p.commitment,
      location: p.location,
      logoFileId: p.logoFileId,
      requisitionId: p.requisitionId,
      orgLabel: (isAgency ? p.clientCompany?.name : p.department?.name) ?? org?.name ?? '—',
    })),
    openReqs: requisitions
      .filter((r) => r.state !== 'CLOSED')
      .map((r) => ({ id: r.id, code: r.code })),
    requisitions: requisitions.map((r) => ({
      id: r.id,
      code: r.code,
      title: r.title,
      state: r.state,
      openings: r.openings,
      filled: r.filled,
      backfill: r.backfill,
      postingCount: r._count.postings,
    })),
  };
}
