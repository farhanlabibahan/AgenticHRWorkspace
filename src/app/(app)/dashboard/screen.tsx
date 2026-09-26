import Link from 'next/link';
import { Search } from 'lucide-react';
import type { loadDashboardPage } from '@/app/(app)/page-loaders';
import { OnboardingCard } from '@/components/onboarding-card';
import { ApprovalQueue } from '@/components/approval-queue';
import { DashboardInterviews } from '@/components/dashboard-interviews';
import { LocalTime } from '@/components/local-time';
import { inputClass, surface, noAutofill } from '@/components/form-controls';
import { buttonClass } from '@/components/ui/button';
import { Bot } from '@/components/ui/bot';

export function DashboardScreen({ data }: { data: Awaited<ReturnType<typeof loadDashboardPage>> }) {
  const now = new Date();
  const { upcomingCount, contactCount } = data;
  const count = (n: number) => n.toLocaleString('en-US');

  const steps = [
    {
      label: 'Post your first role',
      detail: 'Draft it, publish it to your careers page',
      done: data.postingCount > 0,
      href: '/postings/new',
    },
    {
      label: 'Add a candidate',
      detail: 'Import, apply, or add one by hand',
      done: data.contactCount > 0,
      href: '/contacts/new',
    },
    {
      label: 'Schedule an interview',
      detail: 'Invites go out with calendar files',
      done: data.interviews.length > 0,
      href: '/interviews',
    },
    {
      label: 'Attach a transcript',
      detail: 'Paste one in, or push from Walkie or Tactiq via the API',
      done: data.transcriptCount > 0,
      href: '/search',
    },
    {
      label: 'Make it yours',
      detail: 'Upload your logo',
      done: !!data.logoFileId,
      href: '/settings',
    },
  ];

  return (
    <div className="t-reveal">
      <header className="flex items-center gap-3 px-6 pb-2 pt-6">
        {data.logoFileId ? (
          // eslint-disable-next-line @next/next/no-img-element -- org-uploaded logo via internal route
          <img
            src={`/api/logo/${data.logoFileId}`}
            alt={data.orgName ? `${data.orgName} logo` : 'Workspace logo'}
            className="size-9 shrink-0 rounded-field bg-surface object-contain p-1"
          />
        ) : null}
        <div className="min-w-0">
          <h1 className="text-xl font-medium text-ink">
            Welcome back, {data.firstName}.
          </h1>
          <p className="mt-1 truncate text-sm text-ink-2">
            <LocalTime
              date={now.toISOString()}
              options={{ weekday: 'long', month: 'long', day: 'numeric' }}
            />
            {` · ${count(upcomingCount)} upcoming interview${upcomingCount === 1 ? '' : 's'}`}
            {` · ${count(contactCount)} candidate${contactCount === 1 ? '' : 's'} in your network`}
          </p>
        </div>
      </header>

      <div className="mx-6 mt-2 grid gap-8 pb-10 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0">
          <form method="get" action="/search" className="mb-6">
            <div className="relative max-w-2xl">
              <Search
                size={16}
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3"
              />
              <input {...noAutofill}
                type="search"
                name="q"
                aria-label="Search"
                placeholder="Search candidates, roles, transcripts…"
                className={`${inputClass} pl-9`}
              />
            </div>
          </form>

          <DashboardInterviews interviews={data.interviews} />
        </div>

        <div className="flex flex-col gap-4">
          {data.isAdmin && data.pendingApprovals.length ? (
            <ApprovalQueue items={data.pendingApprovals} />
          ) : null}
          <OnboardingCard steps={steps} />
          {data.aiEnabled ? (
            <div className={`${surface} p-5`}>
              <h2 className="text-md font-medium text-ink">Ask your corpus</h2>
              <p className="mt-1.5 text-sm text-ink-2">
                Every transcript, resume, and note is searchable — ask questions and get answers
                with candidates cited.
              </p>
              <Link
                href="/search"
                className={buttonClass({ variant: 'tonal', size: 'sm', className: 'mt-4' })}
              >
                <Bot size={20} /> Open Ask AI{' '}
                <span className="t-learn-arrow text-ink-3">→</span>
              </Link>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
