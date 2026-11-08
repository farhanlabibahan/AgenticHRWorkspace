import type { AgentKey } from '@prisma/client';
import { db } from '@/lib/db';
import type { SessionContext } from '@/lib/session';
import { actorOf, emitEvent } from '@/server/events';
import { attendanceStatus, checkInIsDue, workDateOf, type AttendanceStatus } from '@/lib/hr-policy';
import { dayKey } from '@/server/hr';

/**
 * HR agents. Each is a deterministic rule set over the database: it reads
 * real rows, produces findings, and never changes employee records or
 * decides anything. Every run is written to AgentRun, failures included.
 * Nothing here calls a language model, so nothing is labelled as AI output.
 */

export type Finding = {
  severity: 'info' | 'attention';
  message: string;
  userId?: string;
};

export type AgentResult = { summary: string; findings: Finding[] };

export const AGENT_META: Record<AgentKey, { name: string; description: string }> = {
  ATTENDANCE: {
    name: 'Attendance Agent',
    description:
      'Finds today’s missing check-ins after the start-plus-grace window, and open records left from earlier days. Flags only; it never marks anyone absent.',
  },
  LEAVE: {
    name: 'Leave Agent',
    description:
      'Watches the approval queue: how long requests have waited, and approved leave that overlaps the next 14 days. Recommends nothing it cannot back with a date.',
  },
  BRIEFING: {
    name: 'HR Briefing',
    description:
      'Builds a headcount, attendance and leave summary from current rows. Rule-based counts, not a model-written narrative.',
  },
};

const MAX_ATTEMPTS = 2;

/** Run an agent with retry, and write one AgentRun row for the outcome. */
export async function runAgent(ctx: SessionContext, agent: AgentKey, trigger = 'manual') {
  const startedAt = new Date();
  let attempts = 0;
  let lastError: unknown = null;
  let result: AgentResult | null = null;

  while (attempts < MAX_ATTEMPTS && !result) {
    attempts += 1;
    try {
      result = await AGENTS[agent](ctx.orgId);
    } catch (err) {
      lastError = err;
      if (attempts < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, 300 * attempts));
    }
  }

  const finishedAt = new Date();
  const durationMs = finishedAt.getTime() - startedAt.getTime();
  const failed = !result;
  const message = failed
    ? lastError instanceof Error
      ? lastError.message.slice(0, 500)
      : 'Unknown error'
    : null;

  const run = await db.$transaction(async (tx) => {
    const row = await tx.agentRun.create({
      data: {
        orgId: ctx.orgId,
        agent,
        status: failed ? 'FAILED' : 'SUCCEEDED',
        trigger,
        summary: result?.summary ?? '',
        findings: result ? (result.findings as unknown as object) : undefined,
        error: message,
        attempts,
        durationMs,
        startedAt,
        finishedAt,
      },
    });
    await emitEvent(tx, {
      orgId: ctx.orgId,
      ...actorOf(ctx),
      verb: failed ? 'agent.failed' : 'agent.ran',
      subjectType: 'agent',
      subjectId: row.id,
      payload: { agent, attempts, attention: result?.findings.filter((f) => f.severity === 'attention').length ?? 0 },
    });
    return row;
  });
  return run;
}

async function attendanceAgent(orgId: string): Promise<AgentResult> {
  const now = new Date();
  const today = workDateOf(now);
  const [people, records, openEarlier] = await Promise.all([
    db.user.findMany({ where: { orgId, deactivatedAt: null }, select: { id: true, name: true } }),
    db.attendance.findMany({ where: { orgId, workDate: dayKey(today) } }),
    db.attendance.findMany({
      where: { orgId, checkInAt: { not: null }, checkOutAt: null, workDate: { lt: dayKey(today) } },
      include: { user: { select: { name: true } } },
      take: 100,
    }),
  ]);

  const byUser = new Map(records.map((r) => [r.userId, r]));
  const findings: Finding[] = [];
  const counts: Record<AttendanceStatus, number> = {
    OFF_DAY: 0,
    NOT_CHECKED_IN: 0,
    CHECKED_IN: 0,
    LATE: 0,
    CHECKED_OUT: 0,
    INCOMPLETE: 0,
  };

  for (const p of people) {
    const rec = byUser.get(p.id);
    const status = attendanceStatus(
      rec ? { workDate: today, checkInAt: rec.checkInAt, checkOutAt: rec.checkOutAt } : null,
      now,
      today,
    );
    counts[status] += 1;
    if (status === 'NOT_CHECKED_IN' && checkInIsDue(now)) {
      findings.push({ severity: 'attention', userId: p.id, message: `${p.name} has not checked in today.` });
    }
  }
  for (const r of openEarlier) {
    findings.push({
      severity: 'attention',
      userId: r.userId,
      message: `${r.user.name} has no check-out for ${r.workDate.toISOString().slice(0, 10)}.`,
    });
  }
  if (counts.LATE) findings.push({ severity: 'info', message: `${counts.LATE} checked in after the grace period.` });

  const summary = checkInIsDue(now)
    ? `${counts.NOT_CHECKED_IN} not checked in, ${counts.LATE} late, ${counts.CHECKED_IN + counts.CHECKED_OUT} in on time.`
    : `Check-in window still open. ${counts.CHECKED_IN + counts.LATE + counts.CHECKED_OUT} checked in so far.`;
  return { summary, findings };
}

async function leaveAgent(orgId: string): Promise<AgentResult> {
  const now = new Date();
  const horizon = new Date(now.getTime() + 14 * 86_400_000);
  const [pending, upcoming] = await Promise.all([
    db.leaveRequest.findMany({
      where: { orgId, state: 'PENDING' },
      include: { requester: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'asc' },
      take: 200,
    }),
    db.leaveRequest.findMany({
      where: { orgId, state: 'APPROVED', startDate: { lte: horizon }, endDate: { gte: now } },
      include: { requester: { select: { name: true } } },
      take: 200,
    }),
  ]);

  const findings: Finding[] = [];
  for (const r of pending) {
    const waitingDays = Math.floor((now.getTime() - r.createdAt.getTime()) / 86_400_000);
    if (waitingDays >= 2) {
      findings.push({
        severity: 'attention',
        userId: r.userId,
        message: `${r.requester.name}'s ${r.days}-day request has waited ${waitingDays} days.`,
      });
    }
  }
  for (const u of upcoming) {
    findings.push({
      severity: 'info',
      userId: u.userId,
      message: `${u.requester.name} is on approved leave ${u.startDate.toISOString().slice(0, 10)} to ${u.endDate.toISOString().slice(0, 10)}.`,
    });
  }
  return {
    summary: `${pending.length} awaiting decision, ${upcoming.length} approved in the next 14 days.`,
    findings,
  };
}

async function briefingAgent(orgId: string): Promise<AgentResult> {
  const now = new Date();
  const today = workDateOf(now);
  const [headcount, open, pending, approvedToday, checkedIn] = await Promise.all([
    db.user.count({ where: { orgId, deactivatedAt: null } }),
    db.opportunity.count({ where: { orgId, status: 'ACTIVE' } }),
    db.leaveRequest.count({ where: { orgId, state: 'PENDING' } }),
    db.leaveRequest.count({
      where: { orgId, state: 'APPROVED', startDate: { lte: dayKey(today) }, endDate: { gte: dayKey(today) } },
    }),
    db.attendance.count({ where: { orgId, workDate: dayKey(today), checkInAt: { not: null } } }),
  ]);
  const absent = Math.max(0, headcount - checkedIn - approvedToday);
  const findings: Finding[] = [
    { severity: 'info', message: `${headcount} active people, ${checkedIn} checked in today.` },
    { severity: 'info', message: `${approvedToday} on approved leave today.` },
    { severity: 'info', message: `${open} candidates in active pipeline.` },
  ];
  if (pending > 0) findings.push({ severity: 'attention', message: `${pending} leave requests need a decision.` });
  return {
    summary: `${headcount} people · ${checkedIn} in today · ${absent} unaccounted for · ${pending} leave pending`,
    findings,
  };
}

const AGENTS: Record<AgentKey, (orgId: string) => Promise<AgentResult>> = {
  ATTENDANCE: attendanceAgent,
  LEAVE: leaveAgent,
  BRIEFING: briefingAgent,
};

export async function listAgentRuns(orgId: string, agent?: AgentKey, take = 20) {
  return db.agentRun.findMany({
    where: { orgId, ...(agent ? { agent } : {}) },
    orderBy: { startedAt: 'desc' },
    take,
  });
}

/** Last run and totals for each agent, for the monitor page. */
export async function agentStats(orgId: string) {
  const runs = await db.agentRun.findMany({
    where: { orgId },
    orderBy: { startedAt: 'desc' },
    take: 500,
    select: { agent: true, status: true, durationMs: true, startedAt: true, summary: true },
  });
  return (Object.keys(AGENT_META) as AgentKey[]).map((key) => {
    const mine = runs.filter((r) => r.agent === key);
    const ok = mine.filter((r) => r.status === 'SUCCEEDED');
    return {
      key,
      ...AGENT_META[key],
      total: mine.length,
      succeeded: ok.length,
      failed: mine.length - ok.length,
      avgDurationMs: ok.length ? Math.round(ok.reduce((s, r) => s + r.durationMs, 0) / ok.length) : 0,
      last: mine[0] ?? null,
    };
  });
}
