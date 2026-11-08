import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Briefcase, CalendarClock, FileText, LogOut, Trophy } from 'lucide-react';
import { SourceLockup } from '@/components/powered-by';
import { Badge, SectionHeader, type Tone } from '@/components/ui/primitives';
import { surface } from '@/components/form-controls';
import { LocalTime } from '@/components/local-time';
import { currentCandidate } from '@/server/candidate-accounts';
import { listMyApplications, listMyJobs } from '@/server/candidate-data';
import { candidateSignOut } from '@/app/candidate/actions';

export const metadata = { title: 'My jobs · Orqestra' };
export const dynamic = 'force-dynamic';

const TONE: Record<string, Tone> = {
  Hired: 'positive',
  'Not selected': 'critical',
  Closed: 'neutral',
  Interviewing: 'info',
  'Offer stage': 'caution',
  'In review': 'info',
};

export default async function CandidateHome() {
  const me = await currentCandidate();
  if (!me) redirect('/candidate/signin');
  const [applications, jobs] = await Promise.all([listMyApplications(me.id), listMyJobs(me.id)]);
  const upcoming = applications
    .flatMap((a) => a.interviews.map((i) => ({ ...i, company: a.company, role: a.title })))
    .sort((a, b) => a.startAt.getTime() - b.startAt.getTime());

  return (
    <div className="min-h-screen bg-canvas text-ink">
      <header className="mx-auto flex max-w-5xl items-center justify-between px-6 py-5">
        <SourceLockup href="/" />
        <div className="flex items-center gap-2">
          <Link href="/jobs" className="rounded-full px-4 py-2 text-sm font-medium text-ink-2 hover:text-ink">Find jobs</Link>
          <form action={candidateSignOut}>
            <button type="submit" className="inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-medium text-ink-2 hover:text-ink">
              <LogOut size={14} /> Sign out
            </button>
          </form>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 pb-24">
        <section className="pb-8 pt-6">
          <h1 className="text-2xl font-semibold tracking-[-0.02em]">Hi {me.name.split(' ')[0]}</h1>
          <p className="mt-1 text-sm text-ink-2">Your applications, interviews and jobs, across every company.</p>
        </section>

        {jobs.length ? (
          <section className="pb-10">
            <SectionHeader title="My jobs" />
            <div className="grid gap-3 md:grid-cols-2">
              {jobs.map((j) => (
                <div key={j.id} className={`${surface} flex items-start gap-3 p-5`}>
                  <Trophy size={18} className="mt-0.5 shrink-0 text-ink-2" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{j.title}</p>
                    <p className="text-sm text-ink-2">{j.company} · started <LocalTime date={j.startedAt.toISOString()} options={{ month: 'short', day: 'numeric', year: 'numeric' }} /></p>
                  </div>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {upcoming.length ? (
          <section className="pb-10">
            <SectionHeader title="Upcoming interviews" />
            <div className={`${surface} divide-y divide-line overflow-hidden`}>
              {upcoming.map((i) => (
                <div key={i.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
                  <div className="flex items-start gap-3">
                    <CalendarClock size={16} className="mt-0.5 text-ink-2" />
                    <div>
                      <p className="text-sm font-medium">{i.title}</p>
                      <p className="text-sm text-ink-2">{i.company} · {i.role}{i.location ? ` · ${i.location}` : ''}</p>
                    </div>
                  </div>
                  <p className="text-sm text-ink-2">
                    <LocalTime date={i.startAt.toISOString()} options={{ weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }} />
                  </p>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <section>
          <SectionHeader title="My applications" />
          {applications.length === 0 ? (
            <div className={`${surface} flex flex-col items-start gap-3 p-6`}>
              <FileText size={18} className="text-ink-2" />
              <p className="text-sm text-ink-2">You haven&apos;t applied to anything yet.</p>
              <Link href="/jobs" className="inline-flex items-center rounded-full bg-brand px-4 py-2 text-sm font-medium text-on-brand">
                Browse jobs
              </Link>
            </div>
          ) : (
            <div className={`${surface} divide-y divide-line overflow-hidden`}>
              {applications.map((a) => (
                <div key={a.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
                  <div className="flex min-w-0 items-start gap-3">
                    <Briefcase size={16} className="mt-0.5 shrink-0 text-ink-2" />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{a.title}</p>
                      <p className="text-sm text-ink-2">
                        {a.company}
                        {a.location ? ` · ${a.location}` : ''} · applied{' '}
                        <LocalTime date={a.appliedAt.toISOString()} options={{ month: 'short', day: 'numeric' }} />
                      </p>
                    </div>
                  </div>
                  <Badge tone={TONE[a.status]}>{a.status}</Badge>
                </div>
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
