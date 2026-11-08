import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowRight, Bot, CalendarCheck, CalendarRange, Briefcase, ShieldCheck, Users, Sparkles } from 'lucide-react';
import { Orb } from '@/components/ui/orb';
import { SourceLockup } from '@/components/powered-by';
import { demoEnabled } from '@/server/demo-accounts';
import { getAuthSession } from '@/lib/session';

export const metadata = { title: 'Orqestra — hiring and HR in one place' };
export const dynamic = 'force-dynamic';

const FEATURES = [
  { icon: Briefcase, title: 'Hiring pipeline', body: 'Postings, a kanban pipeline with custom stages, scorecards, interviews and offers.' },
  { icon: CalendarCheck, title: 'Attendance', body: 'Check in and out from the web. Late and missing records are flagged, not judged.' },
  { icon: CalendarRange, title: 'Leave', body: 'Requests, balances, weekend-aware day counts and an approval queue for admins.' },
  { icon: Bot, title: 'HR agents', body: 'Attendance, leave and briefing agents read real records, retry on failure and log every run.' },
  { icon: Users, title: 'People and referrals', body: 'Contacts, referrals from your team, and a clear record of who did what.' },
  { icon: ShieldCheck, title: 'People decide', body: 'Agents recommend and report. Admins approve, and every decision is recorded.' },
];

const at = (i: number) => ({ '--i': i }) as React.CSSProperties;

export default async function LandingPage() {
  // Signed-in visitors go straight to the app.
  const session = await getAuthSession();
  if (session?.user?.orgId) redirect('/dashboard');
  const demo = demoEnabled();

  return (
    <div className="relative min-h-screen overflow-hidden bg-canvas text-ink">
      {/* One slow drifting wash behind the hero; still under reduced motion. */}
      <div aria-hidden className="landing-wash pointer-events-none absolute inset-x-0 top-0 h-[75vh]" />

      <header className="relative z-10 mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <SourceLockup href="/" />
        <nav className="flex items-center gap-1">
          <Link href="/login" className="rounded-full px-4 py-2 text-sm font-medium text-ink-2 transition-colors hover:text-ink">
            Sign in
          </Link>
          <Link href="/signup" className="rounded-full bg-brand px-4 py-2 text-sm font-medium text-on-brand transition-transform active:scale-[0.98]">
            Create workspace
          </Link>
        </nav>
      </header>

      <main className="relative z-10 mx-auto max-w-6xl px-6">
        <section className="flex flex-col items-center pb-16 pt-12 text-center md:pt-20">
          <div className="t-rise" style={at(0)}>
            <Orb seed="source-hero" size={112} animate>
              <Sparkles size={26} strokeWidth={1.6} className="text-ink/70" />
            </Orb>
          </div>
          <h1 className="t-rise mt-8 max-w-3xl text-4xl font-semibold leading-[1.08] tracking-[-0.03em] md:text-6xl" style={at(1)}>
            Hire, track and run people in one calm place.
          </h1>
          <p className="t-rise mt-5 max-w-xl text-md text-ink-2" style={at(2)}>
            Recruiting and day-to-day HR together. AI agents report what needs a person, and every
            decision stays with one.
          </p>

          <div className="t-rise mt-10 flex flex-col items-center gap-3 sm:flex-row" style={at(3)}>
            {demo ? (
              <>
                <a href="/demo/manager" className="group inline-flex items-center gap-2 rounded-full bg-brand px-6 py-3 text-sm font-medium text-on-brand transition-transform active:scale-[0.98]">
                  Open as manager / recruiter
                  <ArrowRight size={16} className="transition-transform group-hover:translate-x-0.5" />
                </a>
                <a href="/demo/employee" className="group inline-flex items-center gap-2 rounded-full bg-surface px-6 py-3 text-sm font-medium text-ink shadow-lift transition-transform active:scale-[0.98]">
                  Open as employee
                  <ArrowRight size={16} className="transition-transform group-hover:translate-x-0.5" />
                </a>
              </>
            ) : (
              <Link href="/login" className="inline-flex items-center gap-2 rounded-full bg-brand px-6 py-3 text-sm font-medium text-on-brand">
                Sign in <ArrowRight size={16} />
              </Link>
            )}
          </div>
          {demo ? (
            <p className="t-rise mt-4 text-xs text-ink-2" style={at(4)}>
              Sample workspace, no account needed. Each demo sign-in starts with a clean slate.
            </p>
          ) : null}
        </section>

        <section className="grid gap-4 pb-24 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map(({ icon: Icon, title, body }, i) => (
            <article key={title} className="t-rise rounded-card bg-surface p-6 transition-shadow duration-200 hover:shadow-lift" style={at(i)}>
              <span className="mb-5 inline-flex size-10 items-center justify-center rounded-full bg-muted">
                <Icon size={18} strokeWidth={1.75} className="text-ink" />
              </span>
              <h2 className="text-md font-medium">{title}</h2>
              <p className="mt-2 text-sm text-ink-2">{body}</p>
            </article>
          ))}
        </section>

        <footer className="flex flex-col gap-2 border-t border-line py-8 text-xs text-ink-2 sm:flex-row sm:justify-between">
          <span>Orqestra: open-source hiring and HR.</span>
          <span>Agents are rule-based. Nothing is decided without a person.</span>
        </footer>
      </main>

      <style>{`
        .landing-wash {
          background:
            radial-gradient(40% 50% at 15% 20%, color-mix(in oklab, var(--color-info) 22%, transparent), transparent 70%),
            radial-gradient(35% 45% at 85% 10%, color-mix(in oklab, var(--color-caution) 20%, transparent), transparent 70%),
            radial-gradient(50% 40% at 50% 90%, color-mix(in oklab, var(--color-positive) 14%, transparent), transparent 70%);
          filter: blur(40px);
          opacity: 0.9;
          animation: landing-drift 18s ease-in-out infinite alternate;
        }
        @keyframes landing-drift {
          from { transform: translate3d(-2%, 0, 0) scale(1); }
          to { transform: translate3d(2%, 2%, 0) scale(1.05); }
        }
        @media (prefers-reduced-motion: reduce) {
          .landing-wash { animation: none; }
        }
      `}</style>
    </div>
  );
}
