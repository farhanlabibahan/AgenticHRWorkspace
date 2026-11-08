import { db } from '@/lib/db';
import type { SessionContext } from '@/lib/session';
import { isAdmin } from '@/lib/session';
import { actorOf, emitEvent } from '@/server/events';
import {
  hoursBetween,
  isLate,
  leaveBalance,
  leaveDays,
  rangesOverlap,
  workDateOf,
} from '@/lib/hr-policy';

/** Attendance: check-in/out for the signed-in person, and team views. */

export class HrError extends Error {}

export async function checkIn(ctx: SessionContext, now = new Date()) {
  if (!ctx.userId) throw new HrError('Sign in to check in');
  const workDate = workDateOf(now);
  const existing = await db.attendance.findUnique({
    where: { userId_workDate: { userId: ctx.userId, workDate: dayKey(workDate) } },
  });
  if (existing?.checkInAt) throw new HrError('You have already checked in today');
  const record = await db.$transaction(async (tx) => {
    const row = await tx.attendance.upsert({
      where: { userId_workDate: { userId: ctx.userId!, workDate: dayKey(workDate) } },
      create: {
        orgId: ctx.orgId,
        userId: ctx.userId!,
        workDate: dayKey(workDate),
        checkInAt: now,
      },
      update: { checkInAt: now },
    });
    await emitEvent(tx, {
      orgId: ctx.orgId,
      ...actorOf(ctx),
      verb: 'attendance.checked_in',
      subjectType: 'attendance',
      subjectId: row.id,
      payload: { late: isLate(now) },
    });
    return row;
  });
  return record;
}

export async function checkOut(ctx: SessionContext, now = new Date()) {
  if (!ctx.userId) throw new HrError('Sign in to check out');
  const workDate = dayKey(workDateOf(now));
  const record = await db.attendance.findUnique({
    where: { userId_workDate: { userId: ctx.userId, workDate } },
  });
  if (!record?.checkInAt) throw new HrError('Check in before you check out');
  if (record.checkOutAt) throw new HrError('You have already checked out today');
  return db.$transaction(async (tx) => {
    const row = await tx.attendance.update({
      where: { id: record.id },
      data: { checkOutAt: now },
    });
    await emitEvent(tx, {
      orgId: ctx.orgId,
      ...actorOf(ctx),
      verb: 'attendance.checked_out',
      subjectType: 'attendance',
      subjectId: row.id,
      payload: { hours: hoursBetween(record.checkInAt!, now) },
    });
    return row;
  });
}

/** A YYYY-MM-DD string as the @db.Date value Prisma expects. */
export function dayKey(workDate: string): Date {
  return new Date(`${workDate}T00:00:00.000Z`);
}

export async function listAttendanceForDay(orgId: string, workDate: string) {
  const people = await db.user.findMany({
    where: { orgId, deactivatedAt: null },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
  const records = await db.attendance.findMany({
    where: { orgId, workDate: dayKey(workDate) },
  });
  const byUser = new Map(records.map((r) => [r.userId, r]));
  return people.map((p) => {
    const r = byUser.get(p.id);
    return {
      userId: p.id,
      name: p.name,
      checkInAt: r?.checkInAt ?? null,
      checkOutAt: r?.checkOutAt ?? null,
    };
  });
}

/* ---------------------------- Leave ---------------------------- */

export async function listLeaveTypes(orgId: string) {
  return db.leaveType.findMany({ where: { orgId }, orderBy: { name: 'asc' } });
}

export async function requestLeave(
  ctx: SessionContext,
  input: { leaveTypeId: string; startDate: string; endDate: string; reason?: string },
) {
  if (!ctx.userId) throw new HrError('Sign in to request leave');
  const days = leaveDays(input.startDate, input.endDate);
  if (days <= 0) throw new HrError('Choose a range with at least one working day');

  const type = await db.leaveType.findFirst({ where: { id: input.leaveTypeId, orgId: ctx.orgId } });
  if (!type) throw new HrError('Leave type not found');

  const [usedRows, overlapping] = await Promise.all([
    db.leaveRequest.findMany({
      where: { orgId: ctx.orgId, userId: ctx.userId, leaveTypeId: type.id, state: 'APPROVED' },
      select: { days: true },
    }),
    db.leaveRequest.findMany({
      where: {
        orgId: ctx.orgId,
        userId: ctx.userId,
        state: { in: ['PENDING', 'APPROVED'] },
        startDate: { lte: dayKey(input.endDate) },
        endDate: { gte: dayKey(input.startDate) },
      },
      select: { startDate: true, endDate: true },
    }),
  ]);

  const used = usedRows.reduce((sum, r) => sum + r.days, 0);
  if (days > leaveBalance(type.annualDays, used)) {
    throw new HrError(`Not enough ${type.name} balance (${leaveBalance(type.annualDays, used)} days left)`);
  }
  const clash = overlapping.find((o) =>
    rangesOverlap(
      input.startDate,
      input.endDate,
      o.startDate.toISOString().slice(0, 10),
      o.endDate.toISOString().slice(0, 10),
    ),
  );
  if (clash) throw new HrError('You already have leave requested or approved for these dates');

  return db.$transaction(async (tx) => {
    const row = await tx.leaveRequest.create({
      data: {
        orgId: ctx.orgId,
        userId: ctx.userId!,
        leaveTypeId: type.id,
        startDate: dayKey(input.startDate),
        endDate: dayKey(input.endDate),
        days,
        reason: input.reason?.trim() || null,
      },
    });
    await emitEvent(tx, {
      orgId: ctx.orgId,
      ...actorOf(ctx),
      verb: 'leave.requested',
      subjectType: 'leave',
      subjectId: row.id,
      payload: { days, type: type.name },
    });
    return row;
  });
}

/** Approve or reject. Only admins decide; the requester can't approve their own. */
export async function decideLeave(
  ctx: SessionContext,
  leaveId: string,
  decision: 'APPROVED' | 'REJECTED',
  note?: string,
) {
  if (!ctx.userId) throw new HrError('Sign in to decide leave');
  if (!isAdmin(ctx)) throw new HrError('Only admins can approve leave');
  const row = await db.leaveRequest.findFirst({ where: { id: leaveId, orgId: ctx.orgId } });
  if (!row) throw new HrError('Leave request not found');
  if (row.userId === ctx.userId) throw new HrError('You cannot decide your own leave');
  if (row.state !== 'PENDING') throw new HrError('This request was already decided');
  return db.$transaction(async (tx) => {
    const updated = await tx.leaveRequest.update({
      where: { id: row.id },
      data: {
        state: decision,
        reviewerId: ctx.userId,
        reviewedAt: new Date(),
        reviewNote: note?.trim() || null,
      },
    });
    await emitEvent(tx, {
      orgId: ctx.orgId,
      ...actorOf(ctx),
      verb: decision === 'APPROVED' ? 'leave.approved' : 'leave.rejected',
      subjectType: 'leave',
      subjectId: row.id,
      payload: { days: row.days },
    });
    return updated;
  });
}

/** Balance per leave type for one person: annual allowance minus approved days this year. */
export async function leaveBalanceFor(orgId: string, userId: string) {
  const types = await db.leaveType.findMany({ where: { orgId }, orderBy: { name: 'asc' } });
  const approved = await db.leaveRequest.findMany({
    where: { orgId, userId, state: 'APPROVED' },
    select: { leaveTypeId: true, days: true },
  });
  return types.map((t) => {
    const used = approved.filter((a) => a.leaveTypeId === t.id).reduce((s, a) => s + a.days, 0);
    return {
      name: t.name,
      annualDays: t.annualDays,
      used,
      left: leaveBalance(t.annualDays, used),
    };
  });
}

export async function listLeaveRequests(orgId: string, opts: { state?: 'PENDING' | 'APPROVED' | 'REJECTED'; userId?: string } = {}) {
  return db.leaveRequest.findMany({
    where: {
      orgId,
      ...(opts.state ? { state: opts.state } : {}),
      ...(opts.userId ? { userId: opts.userId } : {}),
    },
    include: {
      requester: { select: { name: true } },
      leaveType: { select: { name: true } },
    },
    orderBy: [{ state: 'asc' }, { startDate: 'asc' }],
    take: 200,
  });
}
