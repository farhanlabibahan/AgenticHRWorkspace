import Link from 'next/link';
import { Briefcase, MapPin } from 'lucide-react';
import { SourceLockup } from '@/components/powered-by';
import { surface } from '@/components/form-controls';
import { Badge, type Tone } from '@/components/ui/primitives';
import { currentCandidate } from '@/server/candidate-accounts';
import { listAllPublishedJobs } from '@/server/candidate-data';

export const metadata = { title: 'Jobs · Orqestra' };
export const dynamic = 'force-dynamic';

const WORKPLACE: Record<string, string> = { ONSITE: 'On-site', HYBRID: 'Hybrid', REMOTE: 'Remote' };
const COMMITMENT: Record<string, string> = { FULL_TIME: 'Full-time', PART_TIME: 'Part-time', CONTRACT: 'Contract', INTERNSHIP: 'Internship' };
const WORKPLACE_TONE: Record<string, Tone> = { REMOTE: 'positive', HYBRID: 'info', ONSITE: 'neutral' };

function money(min: number | null, max: number | null, cur: string | null): string | null {
  if (!min && !max) return null;
  const f = (n: number) => n.toLocaleString('en-US');
  const c = cur ?? '';
  return min && max ? `${c} ${f(min)} – ${f(max)}`.trim() : `${c} ${f((min ?? max) as number)}`.trim();
}

export default async function JobsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; workplace?: string; type?: string }>;
}) {
  const params = await searchParams;
  const [jobs, me] = await Promise.all([
    listAllPublishedJobs({ q: params.q, workplace: params.workplace, type: params.type }),
    currentCandidate(),
  ]);

  return (
    <div className="min-h-screen bg-canvas text-ink">
      <header className="mx-auto flex max-w-5xl items-center justify-between px-6 py-5">
        <SourceLockup href="/" />
        <nav className="flex items-center gap-1">
          {me ? (
            <Link href="/candidate" className="rounded-full bg-brand px-4 py-2 text-sm font-medium text-on-brand">My jobs</Link>
          ) : (
            <>
              <Link href="/candidate/signin" className="rounded-full px-4 py-2 text-sm font-medium text-ink-2 hover:text-ink">Sign in</Link>
              <Link href="/candidate/signup" className="rounded-full bg-brand px-4 py-2 text-sm font-medium text-on-brand">Create account</Link>
            </>
          )}
        </nav>
      </header>

      <main className="mx-auto max-w-5xl px-6 pb-24">
        <section className="pb-6 pt-6">
          <h1 className="text-2xl font-semibold tracking-[-0.02em]">Open roles</h1>
          <p className="mt-1 text-sm text-ink-2">
            Apply to any company from one account. {me ? `Signed in as ${me.name}.` : 'Create an account to apply.'}
          </p>
          <form method="get" className="mt-5 flex flex-wrap gap-2">
            <input name="q" defaultValue={params.q ?? ''} placeholder="Search title or city" className="h-10 min-w-56 flex-1 rounded-field bg-recessed px-3 text-sm outline-none" />
            <select name="workplace" defaultValue={params.workplace ?? ''} className="h-10 rounded-field bg-recessed px-3 text-sm">
              <option value="">Any workplace</option>
              <option value="REMOTE">Remote</option>
              <option value="HYBRID">Hybrid</option>
              <option value="ONSITE">On-site</option>
            </select>
            <select name="type" defaultValue={params.type ?? ''} className="h-10 rounded-field bg-recessed px-3 text-sm">
              <option value="">Any type</option>
              <option value="FULL_TIME">Full-time</option>
              <option value="PART_TIME">Part-time</option>
              <option value="CONTRACT">Contract</option>
              <option value="INTERNSHIP">Internship</option>
            </select>
            <button type="submit" className="h-10 rounded-full bg-brand px-4 text-sm font-medium text-on-brand">Search</button>
          </form>
        </section>

        {jobs.length === 0 ? (
          <div className={`${surface} p-10 text-center text-sm text-ink-2`}>No open roles match. Try fewer filters.</div>
        ) : (
          <div className={`${surface} divide-y divide-line overflow-hidden`}>
            {jobs.map((j) => {
              const pay = money(j.salaryMin, j.salaryMax, j.salaryCurrency);
              return (
                <Link
                  key={j.id}
                  href={`/jobs/${j.orgSlug}/${j.slug}`}
                  className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 transition-colors duration-[120ms] hover:bg-muted/60"
                >
                  <div className="flex min-w-0 items-start gap-3">
                    <Briefcase size={16} className="mt-0.5 shrink-0 text-ink-2" />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{j.title}</p>
                      <p className="text-sm text-ink-2">
                        {j.companyName}
                        {j.location ? (
                          <span className="inline-flex items-center gap-1"> · <MapPin size={12} />{j.location}</span>
                        ) : null}
                        {pay ? ` · ${pay}` : ''}
                      </p>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Badge tone={WORKPLACE_TONE[j.workplaceType]}>{WORKPLACE[j.workplaceType] ?? j.workplaceType}</Badge>
                    <Badge>{COMMITMENT[j.commitment] ?? j.commitment}</Badge>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
