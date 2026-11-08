import { db } from '@/lib/db';
import { isWorkday, workDateOf } from '@/lib/hr-policy';
import { dayKey } from '@/server/hr';

/**
 * Sample HR data for the demo org: leave types, a few weeks of attendance,
 * and leave requests in each state. Idempotent: it does nothing once a leave
 * type exists. Runs inside the demo sign-in path, so it never throws.
 */
export async function seedHrDemo(orgId: string): Promise<void> {
  const existing = await db.leaveType.count({ where: { orgId } });
  if (existing > 0) return;

  const people = await db.user.findMany({
    where: { orgId, deactivatedAt: null },
    select: { id: true, name: true, accessRole: true },
    orderBy: { createdAt: 'asc' },
  });
  if (!people.length) return;

  const types = await db.$transaction(async (tx) => {
    const created = [];
    for (const t of [
      { name: 'Annual', annualDays: 20, paid: true },
      { name: 'Sick', annualDays: 10, paid: true },
      { name: 'Unpaid', annualDays: 0, paid: false },
    ]) {
      created.push(await tx.leaveType.create({ data: { orgId, ...t } }));
    }
    return created;
  });
  const [annual, sick] = types;

  // Attendance for the past 10 days, skipping weekends. Each person gets a
  // deterministic pattern so the page shows on-time, late and missing rows.
  const now = new Date();
  const days: string[] = [];
  for (let i = 10; i >= 1; i -= 1) {
    const d = new Date(now.getTime() - i * 86_400_000);
    const key = workDateOf(d);
    if (isWorkday(key)) days.push(key);
  }
  const rows: {
    orgId: string;
    userId: string;
    workDate: Date;
    checkInAt: Date | null;
    checkOutAt: Date | null;
  }[] = [];
  people.forEach((p, pi) => {
    days.forEach((day, di) => {
      const seed = (pi * 7 + di * 3) % 10;
      if (seed === 4) return; // a missing record: the agent should notice
      const late = seed === 1 || seed === 8;
      const inMin = late ? 10 * 60 + 5 : 9 * 60 + 10 + (seed % 3) * 4;
      const checkInAt = new Date(`${day}T${pad(inMin)}:00+06:00`);
      const checkOutAt = seed === 6 ? null : new Date(`${day}T${pad(inMin + 8 * 60 + 15)}:00+06:00`);
      rows.push({ orgId, userId: p.id, workDate: dayKey(day), checkInAt, checkOutAt });
    });
  });
  await db.attendance.createMany({ data: rows, skipDuplicates: true });

  const requests = people.slice(0, 4).flatMap((p, i) => {
    const base = new Date(now.getTime() + (i + 2) * 86_400_000 * 3);
    const start = workDateOf(base);
    const end = workDateOf(new Date(base.getTime() + 86_400_000));
    return [
      {
        orgId,
        userId: p.id,
        leaveTypeId: i % 2 === 0 ? annual.id : sick.id,
        startDate: dayKey(start),
        endDate: dayKey(end),
        days: 2,
        reason: i % 2 === 0 ? 'Family visit' : 'Medical appointment',
        state: i === 0 ? ('APPROVED' as const) : i === 3 ? ('REJECTED' as const) : ('PENDING' as const),
      },
    ];
  });
  await db.leaveRequest.createMany({ data: requests });
}

function pad(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
