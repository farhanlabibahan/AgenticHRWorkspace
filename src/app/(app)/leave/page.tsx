import { Suspense } from 'react';
import { CalendarRange } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { PageSkeleton } from '@/components/page-skeleton';
import { EmptyState } from '@/components/empty-state';
import { surface } from '@/components/form-controls';
import { Badge, SectionHeader, type Tone } from '@/components/ui/primitives';
import { DecideButtons, LeaveRequestForm } from '@/components/hr-controls';
import { requireSession, isAdmin } from '@/lib/session';
import { listLeaveRequests, listLeaveTypes, leaveBalanceFor } from '@/server/hr';

export const metadata = { title: 'Leave — Source' };

const STATE_TONE: Record<string, { text: string; tone?: Tone }> = {
  PENDING: { text: 'Pending', tone: 'caution' },
  APPROVED: { text: 'Approved', tone: 'positive' },
  REJECTED: { text: 'Rejected', tone: 'critical' },
  CANCELLED: { text: 'Cancelled' },
};

async function LeaveContent() {
  const ctx = await requireSession();
  const admin = isAdmin(ctx);
  const [types, requests, balances] = await Promise.all([
    listLeaveTypes(ctx.orgId),
    listLeaveRequests(ctx.orgId, admin ? {} : { userId: ctx.userId! }),
    ctx.userId ? leaveBalanceFor(ctx.orgId, ctx.userId) : Promise.resolve([]),
  ]);
  const pending = requests.filter((r) => r.state === 'PENDING');

  return (
    <div className="t-reveal">
      <PageHeader
        title="Leave"
        subtitle={admin ? 'Approve requests and see who is away' : 'Request time off and track your balance'}
      />
      <div className="mx-6 mt-4 flex max-w-4xl flex-col gap-8 pb-10">
        {balances.length ? (
          <section className="grid gap-3 sm:grid-cols-3">
            {balances.filter((b) => b.annualDays > 0).map((b) => (
              <div key={b.name} className={`${surface} p-4`}>
                <p className="text-xs text-ink-2">{b.name}</p>
                <p className="mt-1 text-xl font-medium">
                  {b.left} <span className="text-sm font-normal text-ink-2">of {b.annualDays} days left</span>
                </p>
              </div>
            ))}
          </section>
        ) : null}

        <section className={`${surface} p-5`}>
          <h2 className="text-md font-medium">Request leave</h2>
          <p className="mb-5 mt-1 text-sm text-ink-2">Weekends are not counted. Overlapping requests are refused.</p>
          <LeaveRequestForm types={types.map((t) => ({ id: t.id, name: t.name }))} />
        </section>

        {admin && pending.length ? (
          <section>
            <SectionHeader title={`Awaiting decision · ${pending.length}`} />
            <div className={`${surface} divide-y divide-line overflow-hidden`}>
              {pending.map((r) => (
                <div key={r.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{r.requester.name}</p>
                    <p className="text-xs text-ink-2">
                      {r.leaveType.name} · {r.days} day{r.days === 1 ? '' : 's'} · {r.startDate.toISOString().slice(0, 10)} to{' '}
                      {r.endDate.toISOString().slice(0, 10)}
                      {r.reason ? ` · ${r.reason}` : ''}
                    </p>
                  </div>
                  <DecideButtons id={r.id} />
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <section>
          <SectionHeader title={admin ? 'All requests' : 'Your requests'} />
          {requests.length === 0 ? (
            <EmptyState
              icon={CalendarRange}
              title="No leave requests"
              description="Requests you send appear here with their status."
            />
          ) : (
            <div className={`${surface} divide-y divide-line overflow-hidden`}>
              {requests.map((r) => {
                const s = STATE_TONE[r.state] ?? { text: r.state };
                return (
                  <div key={r.id} className="flex items-center justify-between gap-3 px-4 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {admin ? r.requester.name : r.leaveType.name}
                      </p>
                      <p className="text-xs text-ink-2">
                        {admin ? `${r.leaveType.name} · ` : ''}
                        {r.startDate.toISOString().slice(0, 10)} to {r.endDate.toISOString().slice(0, 10)} · {r.days}{' '}
                        day{r.days === 1 ? '' : 's'}
                        {r.reviewNote ? ` · “${r.reviewNote}”` : ''}
                      </p>
                    </div>
                    <Badge tone={s.tone}>{s.text}</Badge>
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

export default function LeavePage() {
  return (
    <Suspense fallback={<PageSkeleton title="Leave" subtitle="Requests, balances and approvals" />}>
      <LeaveContent />
    </Suspense>
  );
}
