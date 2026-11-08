import { Suspense } from 'react';
import { Clock } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { PageSkeleton } from '@/components/page-skeleton';
import { EmptyState } from '@/components/empty-state';
import { surface } from '@/components/form-controls';
import { Badge, SectionHeader, type Tone } from '@/components/ui/primitives';
import { LocalTime } from '@/components/local-time';
import { CheckButtons } from '@/components/hr-controls';
import { requireSession } from '@/lib/session';
import { db } from '@/lib/db';
import { attendanceStatus, workDateOf, type AttendanceStatus } from '@/lib/hr-policy';
import { dayKey, listAttendanceForDay } from '@/server/hr';

export const metadata = { title: 'Attendance — Source' };

const LABEL: Record<AttendanceStatus, { text: string; tone?: Tone }> = {
  OFF_DAY: { text: 'Off day' },
  NOT_CHECKED_IN: { text: 'Not checked in', tone: 'caution' },
  CHECKED_IN: { text: 'In', tone: 'positive' },
  LATE: { text: 'Late', tone: 'caution' },
  CHECKED_OUT: { text: 'Done' },
  INCOMPLETE: { text: 'No check-out', tone: 'critical' },
};

async function AttendanceContent() {
  const ctx = await requireSession();
  const now = new Date();
  const today = workDateOf(now);
  const [rows, mine] = await Promise.all([
    listAttendanceForDay(ctx.orgId, today),
    db.attendance.findUnique({
      where: { userId_workDate: { userId: ctx.userId!, workDate: dayKey(today) } },
    }),
  ]);

  const myStatus = attendanceStatus(
    mine ? { workDate: today, checkInAt: mine.checkInAt, checkOutAt: mine.checkOutAt } : null,
    now,
    today,
  );
  const checkedIn = rows.filter((r) => r.checkInAt).length;

  return (
    <div className="t-reveal">
      <PageHeader title="Attendance" subtitle={`Today, ${today} · ${checkedIn} of ${rows.length} checked in`} />
      <div className="mx-6 mt-4 flex max-w-4xl flex-col gap-8 pb-10">
        <section className={`${surface} flex flex-wrap items-center justify-between gap-4 p-5`}>
          <div>
            <h2 className="text-md font-medium">Your day</h2>
            <p className="mt-1 text-sm text-ink-2">
              {LABEL[myStatus].text}
              {mine?.checkInAt ? (
                <>
                  {' · in '}
                  <LocalTime date={mine.checkInAt.toISOString()} options={{ hour: 'numeric', minute: '2-digit' }} />
                </>
              ) : null}
              {mine?.checkOutAt ? (
                <>
                  {' · out '}
                  <LocalTime date={mine.checkOutAt.toISOString()} options={{ hour: 'numeric', minute: '2-digit' }} />
                </>
              ) : null}
            </p>
          </div>
          <CheckButtons
            canIn={!mine?.checkInAt && myStatus !== 'OFF_DAY'}
            canOut={!!mine?.checkInAt && !mine?.checkOutAt}
          />
        </section>

        <section>
          <SectionHeader title="Team today" />
          {rows.length === 0 ? (
            <EmptyState icon={Clock} title="No people yet" description="Add people in Settings and their attendance appears here." />
          ) : (
            <div className={`${surface} divide-y divide-line overflow-hidden`}>
              {rows.map((r) => {
                const rec = { workDate: today, checkInAt: r.checkInAt, checkOutAt: r.checkOutAt };
                const status = attendanceStatus(r.checkInAt ? rec : null, now, today);
                const l = LABEL[status];
                return (
                  <div key={r.userId} className="flex items-center justify-between gap-3 px-4 py-3">
                    <span className="truncate text-sm font-medium">{r.name}</span>
                    <div className="flex items-center gap-3">
                      {r.checkInAt ? (
                        <span className="text-xs text-ink-2">
                          <LocalTime date={r.checkInAt.toISOString()} options={{ hour: 'numeric', minute: '2-digit' }} />
                        </span>
                      ) : null}
                      <Badge tone={l.tone}>{l.text}</Badge>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

export default function AttendancePage() {
  return (
    <Suspense fallback={<PageSkeleton title="Attendance" subtitle="Check-ins and today's team status" />}>
      <AttendanceContent />
    </Suspense>
  );
}
