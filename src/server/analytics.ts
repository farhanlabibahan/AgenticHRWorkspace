import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { sendEmail } from '@/server/email';

/**
 * Prebuilt analytics pack. Everything derives
 * from data already captured — StageTransition rows (written on creation and
 * every move) plus opportunity timestamps — so these are pure read models.
 *
 * Each report is one aggregate query: Postgres does the grouping and the
 * app receives a handful of summary rows, never the org's full history.
 * Rounding stays in TypeScript so the numbers match what the UI always showed.
 */

const DAY_MS = 86_400_000;
const round1 = (n: number) => Math.round(n * 10) / 10;
const secondsToDays = (s: number | null) => (s === null ? null : (s * 1000) / DAY_MS);

/** Opportunity id → furthest stage order it ever entered (org stages only). */
function furthestStageSql(orgId: string) {
  return Prisma.sql`
    SELECT t."opportunityId" AS id, MAX(s."order") AS ord
    FROM "StageTransition" t
    JOIN "Opportunity" o ON o.id = t."opportunityId"
    JOIN "Stage" s ON s.id = t."toStageId" AND s."orgId" = ${orgId}
    WHERE o."orgId" = ${orgId}
    GROUP BY t."opportunityId"`;
}

/** Cumulative "reached" counts per stage from a furthest-stage histogram. */
function cumulativeReached(stageOrders: number[], hist: Map<number, number>): number[] {
  return stageOrders.map((order) => {
    let n = 0;
    for (const [ord, count] of hist) if (ord >= order) n += count;
    return n;
  });
}

export type FunnelStage = { name: string; reached: number; conversion: number | null };

/**
 * Stage pass-through: how many opportunities ever reached each stage (by
 * stage order — skipping a stage still counts as passing it), plus the
 * stage-to-stage conversion rate.
 */
export async function stagePassThrough(orgId: string): Promise<FunnelStage[]> {
  const [stages, hist] = await Promise.all([
    db.stage.findMany({ where: { orgId }, orderBy: { order: 'asc' } }),
    db.$queryRaw<{ ord: number; n: number }[]>`
      SELECT f.ord, COUNT(*)::int AS n FROM (${furthestStageSql(orgId)}) f GROUP BY f.ord`,
  ]);
  if (!stages.length) return [];
  const reachedCounts = cumulativeReached(
    stages.map((s) => s.order),
    new Map(hist.map((h) => [h.ord, h.n])),
  );
  return stages.map((s, i) => ({
    name: s.name,
    reached: reachedCounts[i],
    conversion:
      i === 0 || reachedCounts[i - 1] === 0
        ? null
        : Math.round((reachedCounts[i] / reachedCounts[i - 1]) * 100),
  }));
}

export type GroupedFunnelRow = { group: string; reached: number[] };

/**
 * Pass-through matrix grouped by posting, department, or owner: one row per
 * group, one cell per stage with the count of opportunities that reached it.
 */
export async function stagePassThroughBy(
  orgId: string,
  by: 'posting' | 'department' | 'owner',
): Promise<{ stages: string[]; rows: GroupedFunnelRow[] }> {
  const [stages, hist] = await Promise.all([
    db.stage.findMany({ where: { orgId }, orderBy: { order: 'asc' } }),
    // ord is null for opportunities with no transitions: they still create
    // their group (a row of zeros), they just never reach a stage.
    db.$queryRaw<{ label: string; ord: number | null; n: number }[]>`
      SELECT
        CASE ${by}::text
          WHEN 'posting' THEN COALESCE(p.title, 'No posting')
          WHEN 'department' THEN COALESCE(d.name, 'No department')
          ELSE COALESCE(u.name, 'Unassigned')
        END AS label,
        f.ord,
        COUNT(*)::int AS n
      FROM "Opportunity" o
      LEFT JOIN (${furthestStageSql(orgId)}) f ON f.id = o.id
      LEFT JOIN "Posting" p ON p.id = o."postingId"
      LEFT JOIN "Department" d ON d.id = p."departmentId"
      LEFT JOIN "User" u ON u.id = o."ownerId"
      WHERE o."orgId" = ${orgId}
      GROUP BY 1, 2`,
  ]);

  const byGroup = new Map<string, Map<number, number>>();
  for (const h of hist) {
    if (!byGroup.has(h.label)) byGroup.set(h.label, new Map());
    if (h.ord !== null) byGroup.get(h.label)!.set(h.ord, h.n);
  }
  const orders = stages.map((s) => s.order);
  const rows = [...byGroup.entries()]
    .map(([group, groupHist]) => ({ group, reached: cumulativeReached(orders, groupHist) }))
    .sort((a, b) => (b.reached[0] ?? 0) - (a.reached[0] ?? 0) || a.group.localeCompare(b.group));
  return { stages: stages.map((s) => s.name), rows };
}

export type StageDwell = { name: string; avgDays: number | null; samples: number };

/**
 * Average completed dwell time per stage: for every consecutive pair of
 * transitions on an opportunity, the gap is time spent in the earlier
 * transition's target stage. Current (incomplete) dwells are excluded.
 */
export async function timeInStage(orgId: string): Promise<StageDwell[]> {
  const [stages, dwell] = await Promise.all([
    db.stage.findMany({ where: { orgId }, orderBy: { order: 'asc' } }),
    db.$queryRaw<{ stageId: string; samples: number; avgSeconds: number }[]>`
      SELECT seq."toStageId" AS "stageId",
             COUNT(*)::int AS samples,
             AVG(EXTRACT(EPOCH FROM seq.next_at - seq."occurredAt"))::float8 AS "avgSeconds"
      FROM (
        SELECT t."toStageId", t."occurredAt",
               LEAD(t."occurredAt") OVER (PARTITION BY t."opportunityId" ORDER BY t."occurredAt") AS next_at
        FROM "StageTransition" t
        JOIN "Opportunity" o ON o.id = t."opportunityId"
        WHERE o."orgId" = ${orgId}
      ) seq
      WHERE seq.next_at > seq."occurredAt"
      GROUP BY seq."toStageId"`,
  ]);
  const byStage = new Map(dwell.map((d) => [d.stageId, d]));
  return stages.map((s) => {
    const d = byStage.get(s.id);
    return {
      name: s.name,
      samples: d?.samples ?? 0,
      avgDays: d ? round1(secondsToDays(d.avgSeconds)!) : null,
    };
  });
}

export type PostingVelocity = {
  posting: string;
  active: number;
  hired: number;
  avgDaysToHire: number | null;
};

/** Per-posting velocity: active pipeline, hires, and average days to hire. */
export async function velocityByPosting(orgId: string): Promise<PostingVelocity[]> {
  const rows = await db.$queryRaw<
    { posting: string; active: number; hired: number; hireSeconds: number | null }[]
  >`
    SELECT COALESCE(p.title, 'No posting') AS posting,
           COUNT(*) FILTER (WHERE o.status = 'ACTIVE')::int AS active,
           COUNT(*) FILTER (WHERE o.status = 'HIRED')::int AS hired,
           AVG(EXTRACT(EPOCH FROM o."stageChangedAt" - o."createdAt"))
             FILTER (WHERE o.status = 'HIRED')::float8 AS "hireSeconds"
    FROM "Opportunity" o
    LEFT JOIN "Posting" p ON p.id = o."postingId"
    WHERE o."orgId" = ${orgId}
    GROUP BY 1`;
  return rows
    .map((r) => {
      const days = secondsToDays(r.hireSeconds);
      return {
        posting: r.posting,
        active: r.active,
        hired: r.hired,
        avgDaysToHire: days === null ? null : Math.round(days),
      };
    })
    .sort((a, b) => b.active + b.hired - (a.active + a.hired) || a.posting.localeCompare(b.posting));
}

export type InterviewerRow = {
  name: string;
  scheduled: number;
  completed: number;
  feedbacks: number;
  feedbackRate: number | null;
  avgRating: number | null;
};

/** Interviewer load, feedback completion, and rating distribution. */
export async function interviewerLoad(orgId: string): Promise<InterviewerRow[]> {
  // A panelist's feedback for an interview is their earliest submission on it.
  const rows = await db.$queryRaw<
    { name: string; scheduled: number; completed: number; feedbacks: number; avgRating: number | null }[]
  >`
    SELECT u.name,
           COUNT(*)::int AS scheduled,
           COUNT(*) FILTER (WHERE i.state = 'COMPLETED')::int AS completed,
           COUNT(f."overallRating")::int AS feedbacks,
           AVG(f."overallRating")::float8 AS "avgRating"
    FROM "_InterviewPanelists" ip
    JOIN "Interview" i ON i.id = ip."A"
    JOIN "User" u ON u.id = ip."B"
    LEFT JOIN (
      SELECT DISTINCT ON ("interviewId", "authorId") "interviewId", "authorId", "overallRating"
      FROM "FeedbackSubmission"
      WHERE "orgId" = ${orgId} AND "interviewId" IS NOT NULL
      ORDER BY "interviewId", "authorId", "createdAt"
    ) f ON f."interviewId" = i.id AND f."authorId" = u.id
    WHERE i."orgId" = ${orgId} AND i.state <> 'CANCELED'
    GROUP BY u.id, u.name`;
  return rows
    .map((r) => ({
      name: r.name,
      scheduled: r.scheduled,
      completed: r.completed,
      feedbacks: r.feedbacks,
      feedbackRate: r.completed === 0 ? null : Math.round((r.feedbacks / r.completed) * 100),
      avgRating: r.avgRating === null ? null : round1(r.avgRating),
    }))
    .sort((a, b) => b.scheduled - a.scheduled || a.name.localeCompare(b.name));
}

export type RecruiterRow = {
  name: string;
  active: number;
  hired: number;
  archived: number;
  avgDaysToHire: number | null;
};

/** Recruiter productivity from opportunity ownership. */
export async function recruiterProductivity(orgId: string): Promise<RecruiterRow[]> {
  const rows = await db.$queryRaw<
    { name: string; active: number; hired: number; archived: number; hireSeconds: number | null }[]
  >`
    SELECT u.name,
           COUNT(*) FILTER (WHERE o.status = 'ACTIVE')::int AS active,
           COUNT(*) FILTER (WHERE o.status = 'HIRED')::int AS hired,
           COUNT(*) FILTER (WHERE o.status = 'ARCHIVED')::int AS archived,
           AVG(EXTRACT(EPOCH FROM o."stageChangedAt" - o."createdAt"))
             FILTER (WHERE o.status = 'HIRED')::float8 AS "hireSeconds"
    FROM "Opportunity" o
    JOIN "User" u ON u.id = o."ownerId"
    WHERE o."orgId" = ${orgId}
    GROUP BY u.id, u.name`;
  return rows
    .map((r) => {
      const days = secondsToDays(r.hireSeconds);
      return {
        name: r.name,
        active: r.active,
        hired: r.hired,
        archived: r.archived,
        avgDaysToHire: days === null ? null : Math.round(days),
      };
    })
    .sort((a, b) => b.hired + b.active - (a.hired + a.active) || a.name.localeCompare(b.name));
}

/** Average days from opportunity creation to hire, across the whole org. */
export async function avgDaysToHire(orgId: string): Promise<number | null> {
  const [row] = await db.$queryRaw<{ hireSeconds: number | null }[]>`
    SELECT AVG(EXTRACT(EPOCH FROM "stageChangedAt" - "createdAt"))::float8 AS "hireSeconds"
    FROM "Opportunity"
    WHERE "orgId" = ${orgId} AND status = 'HIRED'`;
  return secondsToDays(row?.hireSeconds ?? null);
}

export type BuilderGroupBy = 'stage' | 'origin' | 'source' | 'posting' | 'archiveReason' | 'owner' | 'month';
export type BuilderFilters = {
  status?: 'ACTIVE' | 'ARCHIVED' | 'HIRED';
  origin?: string;
  postingId?: string;
  from?: Date;
  to?: Date;
};

/**
 * Custom report builder: opportunity counts grouped by one dimension. Counts
 * every matching row — the old in-memory version stopped at 20k and quietly
 * under-reported larger orgs.
 */
export async function reportBuilderCounts(
  orgId: string,
  groupBy: BuilderGroupBy,
  filters: BuilderFilters,
): Promise<{ name: string; count: number }[]> {
  const key = {
    stage: Prisma.sql`s.name`,
    origin: Prisma.sql`o.origin::text`,
    source: Prisma.sql`COALESCE(o.source, 'Unknown')`,
    posting: Prisma.sql`COALESCE(p.title, 'No posting')`,
    archiveReason: Prisma.sql`COALESCE(r.name, 'Not archived')`,
    owner: Prisma.sql`COALESCE(u.name, 'Unassigned')`,
    month: Prisma.sql`to_char(o."createdAt", 'YYYY-MM')`, // timestamp(3) holds UTC already
  }[groupBy];
  const where = [Prisma.sql`o."orgId" = ${orgId}`];
  if (filters.status) where.push(Prisma.sql`o.status = ${filters.status}::"OpportunityStatus"`);
  if (filters.origin) where.push(Prisma.sql`o.origin::text = ${filters.origin}`);
  if (filters.postingId) where.push(Prisma.sql`o."postingId" = ${filters.postingId}`);
  // Columns are timestamp(3) holding UTC, but a Date binds as timestamptz —
  // comparing those directly reinterprets the column in the session's
  // timezone. Convert the bound value to UTC wall-clock time instead.
  if (filters.from) where.push(Prisma.sql`o."createdAt" >= (${filters.from}::timestamptz AT TIME ZONE 'UTC')`);
  if (filters.to) where.push(Prisma.sql`o."createdAt" <= (${filters.to}::timestamptz AT TIME ZONE 'UTC')`);

  const rows = await db.$queryRaw<{ name: string; count: number }[]>`
    SELECT ${key} AS name, COUNT(*)::int AS count
    FROM "Opportunity" o
    JOIN "Stage" s ON s.id = o."stageId"
    LEFT JOIN "Posting" p ON p.id = o."postingId"
    LEFT JOIN "ArchiveReason" r ON r.id = o."archiveReasonId"
    LEFT JOIN "User" u ON u.id = o."ownerId"
    WHERE ${Prisma.join(where, ' AND ')}
    GROUP BY 1`;
  return rows.sort((a, b) =>
    groupBy === 'month' ? a.name.localeCompare(b.name) : b.count - a.count || a.name.localeCompare(b.name),
  );
}

// ---------- scheduled digest delivery (#4) ----------

/** Plain-text digest of the headline numbers, for scheduled email delivery. */
export async function buildReportDigest(orgId: string): Promise<string> {
  const [org, total, active, hired, archived, openPostings, funnel, velocity] = await Promise.all([
    db.organization.findUnique({ where: { id: orgId }, select: { name: true } }),
    db.opportunity.count({ where: { orgId } }),
    db.opportunity.count({ where: { orgId, status: 'ACTIVE' } }),
    db.opportunity.count({ where: { orgId, status: 'HIRED' } }),
    db.opportunity.count({ where: { orgId, status: 'ARCHIVED' } }),
    db.posting.count({ where: { orgId, state: 'PUBLISHED' } }),
    stagePassThrough(orgId),
    velocityByPosting(orgId),
  ]);

  const lines = [
    `Hiring digest — ${org?.name ?? 'your organization'}`,
    '',
    `Candidates: ${total} total · ${active} in process · ${hired} hired · ${archived} archived`,
    `Open roles: ${openPostings}`,
    '',
    'Stage pass-through:',
    ...funnel.map(
      (f) =>
        `  ${f.name}: ${f.reached} reached${f.conversion !== null ? ` (${f.conversion}% from previous)` : ''}`,
    ),
    '',
    'Velocity by posting:',
    ...velocity
      .slice(0, 8)
      .map(
        (v) =>
          `  ${v.posting}: ${v.active} active · ${v.hired} hired${v.avgDaysToHire !== null ? ` · ${v.avgDaysToHire} days avg to hire` : ''}`,
      ),
    '',
    'Full reports: /reports',
  ];
  return lines.join('\n');
}

const CADENCE_MS: Record<string, number> = {
  DAILY: 24 * 60 * 60 * 1000,
  WEEKLY: 7 * 24 * 60 * 60 * 1000,
};

/**
 * Send due report digests. Runs on the email cron; a schedule is due when it
 * has never sent or its cadence period has elapsed (minus 5min slack so a
 * 10-minute cron doesn't drift the send time later every cycle).
 */
export async function processReportSchedules(): Promise<number> {
  const now = Date.now();
  const schedules = await db.reportSchedule.findMany({ where: { active: true } });
  let sent = 0;

  for (const schedule of schedules) {
    const period = CADENCE_MS[schedule.cadence] ?? CADENCE_MS.WEEKLY;
    if (schedule.lastSentAt && schedule.lastSentAt.getTime() > now - period + 5 * 60 * 1000)
      continue;
    if (!schedule.recipients.length) continue;

    const digest = await buildReportDigest(schedule.orgId);
    const subject = `Hiring digest — ${new Date(now).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
    for (const toEmail of schedule.recipients) {
      await sendEmail({
        orgId: schedule.orgId,
        toEmail,
        subject,
        body: digest,
      });
      sent += 1;
    }
    await db.reportSchedule.update({
      where: { id: schedule.id },
      data: { lastSentAt: new Date(now) },
    });
  }
  return sent;
}
