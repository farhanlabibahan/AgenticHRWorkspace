import Link from 'next/link';
import { redirect } from 'next/navigation';
import { SourceLockup } from '@/components/powered-by';
import { demoEnabled } from '@/server/demo-accounts';
import { getAuthSession } from '@/lib/session';

export const metadata = { title: 'Orqestra: hiring and HR in one place' };
export const dynamic = 'force-dynamic';

// Sample names on the pipeline mock. Labelled "Sample data" on the page.
const STAGES = [
  { name: 'Applied', cards: ['Amira Hossain', 'Tanvir Ahmed'] },
  { name: 'Interview', cards: ['Nadia Rahman'] },
  { name: 'Offer', cards: ['Sami Chowdhury'] },
  { name: 'Hired', cards: [] as string[] },
];

export default async function LandingPage() {
  // Signed-in company users go straight to the app.
  const session = await getAuthSession();
  if (session?.user?.orgId) redirect('/dashboard');
  const demo = demoEnabled();

  return (
    <div className="min-h-screen bg-canvas text-ink">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
        <SourceLockup href="/" />
        <nav className="flex items-center gap-1 whitespace-nowrap text-sm">
          <Link href="/jobs" className="hidden rounded-full px-3 py-2 text-ink-2 hover:text-ink sm:inline-block">Find jobs</Link>
          <Link href="/login" className="rounded-full px-3 py-2 text-ink-2 hover:text-ink sm:px-4">Sign in</Link>
          <Link href="/signup" className="rounded-full bg-brand px-3 py-2 font-medium text-on-brand sm:px-4">
            Create workspace
          </Link>
        </nav>
      </header>

      <main className="mx-auto max-w-6xl px-6">
        {/* Hero: one idea, left-aligned, with the product as the picture. */}
        <section className="grid items-center gap-12 pb-24 pt-10 lg:grid-cols-[1fr_1.1fr] lg:pt-16">
          <div>
            <p className="text-sm text-ink-2">For companies that hire and run their people</p>
            <h1 className="mt-4 text-5xl font-semibold leading-[1.02] tracking-[-0.035em] md:text-6xl">
              Hire well. Run HR without the paperwork.
            </h1>
            <p className="mt-6 max-w-md text-lg leading-relaxed text-ink-2">
              Post a role, review applicants, book interviews and make the offer. The new hire then
              finds their job in their own account. Attendance and leave run alongside it, and people
              make every decision.
            </p>
            <div className="mt-10 flex flex-wrap items-center gap-3">
              <Link href="/signup" className="rounded-full bg-brand px-6 py-3 text-sm font-medium text-on-brand transition-transform active:scale-[0.98]">
                Create workspace
              </Link>
              {demo ? (
                <a href="/demo/manager" className="rounded-full bg-surface px-6 py-3 text-sm font-medium text-ink transition-transform active:scale-[0.98]">
                  Try the demo
                </a>
              ) : null}
            </div>
          </div>

          {/* The product: a hiring pipeline. Names are sample data, labelled as such. */}
          <figure aria-label="A hiring pipeline with four stages" className="rounded-2xl bg-surface p-4 shadow-[0_24px_60px_-30px_rgba(29,36,25,0.35)]">
            <div className="mb-3 flex items-center justify-between px-2 pt-1">
              <p className="text-sm font-medium">Product Designer</p>
              <p className="text-xs text-ink-2">Sample data</p>
            </div>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              {STAGES.map((stage) => (
                <div key={stage.name} className="flex flex-col gap-2 rounded-xl bg-muted p-3">
                  <p className="text-xs font-medium text-ink-2">{stage.name}</p>
                  {stage.cards.length ? (
                    stage.cards.map((c) => (
                      <div key={c} className="rounded-lg bg-surface px-3 py-2.5 text-xs shadow-sm">{c}</div>
                    ))
                  ) : (
                    <p className="px-1 py-2 text-xs text-ink-3">Nobody yet</p>
                  )}
                </div>
              ))}
            </div>
          </figure>
        </section>

        {/* One idea: the candidate keeps one account across companies. */}
        <section className="grid gap-10 border-t border-line py-20 md:grid-cols-2">
          <h2 className="text-3xl font-semibold tracking-[-0.02em]">One account for every company.</h2>
          <div className="text-ink-2">
            <p>
              Candidates create one account and apply to any company on Orqestra. When they are hired,
              the job appears under My jobs in that same account.
            </p>
            <p className="mt-3 text-sm">Companies only see what the candidate chose to share.</p>
          </div>
        </section>

        {/* One idea: agents report, people decide. */}
        <section className="grid gap-10 border-t border-line py-20 md:grid-cols-2">
          <h2 className="text-3xl font-semibold tracking-[-0.02em]">Agents report. People decide.</h2>
          <div className="text-ink-2">
            <p>
              The HR agents read your records and list what needs attention, such as a missing check-out or
              a leave request waiting for an answer. They don&apos;t approve, reject or change anything, and
              every run is logged.
            </p>
            <p className="mt-3 text-sm">Leave is approved by an admin, never by the person who asked for it.</p>
          </div>
        </section>

        {/* Closing call to action. */}
        <section className="mb-24 rounded-3xl bg-brand px-8 py-14 text-on-brand md:px-14">
          <h2 className="max-w-xl text-3xl font-semibold tracking-[-0.02em]">Set up a workspace in a few minutes.</h2>
          <p className="mt-3 max-w-lg text-on-brand/80">Post your first role, invite your team, and see who is in today.</p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/signup" className="rounded-full bg-surface px-6 py-3 text-sm font-medium text-ink">
              Create workspace
            </Link>
            <Link href="/help" className="rounded-full px-6 py-3 text-sm font-medium text-on-brand/90 underline-offset-4 hover:underline">
              Read the guide
            </Link>
          </div>
        </section>

        <footer className="flex flex-col gap-2 border-t border-line py-8 text-xs text-ink-2 sm:flex-row sm:justify-between">
          <span>Orqestra: hiring and HR, open source.</span>
          <span>Agents are rule-based. Nothing is decided without a person.</span>
        </footer>
      </main>
    </div>
  );
}
