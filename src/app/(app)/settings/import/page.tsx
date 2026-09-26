import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowLeft, ChevronRight } from 'lucide-react';
import { db } from '@/lib/db';
import { isAdmin, requireSession } from '@/lib/session';
import { listImportJobs } from '@/server/imports/jobs';
import { PageHeader } from '@/components/page-header';
import { IMPORT_PROVIDERS } from '@/lib/import-providers';
import { NewImport } from '@/components/imports/new-import';
import { formatCount, IMPORT_STATUS, isOpen, timeAgo } from '@/components/imports/import-meta';
import { SiteIcon } from '@/components/site-icon';
import { buttonClass } from '@/components/ui/button';
import { Card, SectionHeader, StatusDot } from '@/components/ui/primitives';

/** Settings → Import from another ATS: start a new import, reach the open one, and see past runs. */
export const metadata = { title: 'Import from another ATS — Source' };

const OPEN_COPY = {
  DISCOVERING: { title: (p: string) => `Reading your ${p} setup`, action: 'View progress' },
  REVIEW: { title: (p: string) => `Your ${p} import is ready for review`, action: 'Review stages' },
  RUNNING: { title: (p: string) => `Importing from ${p}`, action: 'View progress' },
} as const;

export default async function ImportPage({ searchParams }: { searchParams: Promise<{ provider?: string }> }) {
  const ctx = await requireSession();
  const { provider } = await searchParams;
  if (!isAdmin(ctx)) redirect('/settings');

  const [jobs, org] = await Promise.all([
    listImportJobs(ctx),
    db.organization.findUnique({ where: { id: ctx.orgId }, select: { retentionMonths: true } }),
  ]);
  const open = jobs.find((j) => isOpen(j.status));
  const past = jobs.filter((j) => j !== open);

  return (
    <div>
      <div className="px-6 pt-6">
        <Link
          href="/settings?section=data"
          className="inline-flex items-center gap-1.5 text-sm text-ink-2 transition-colors duration-[120ms] hover:text-ink"
        >
          <ArrowLeft size={14} /> Settings
        </Link>
      </div>
      <PageHeader
        title="Import from another ATS"
        subtitle="Bring candidates, postings, and their history into Source. Running it again only adds what's new."
      />

      <div className="mx-6 mt-4 flex max-w-3xl flex-col gap-8 pb-8">
        {open && open.status in OPEN_COPY ? (
          <Card className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-start gap-3">
              <span className="mt-0.5">
                <SiteIcon url={open.domain} size={20} />
              </span>
              <div className="min-w-0">
                <p className="text-md font-medium text-ink">
                  {OPEN_COPY[open.status as keyof typeof OPEN_COPY].title(open.providerName)}
                </p>
                <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-sm text-ink-2">
                  <StatusDot tone={IMPORT_STATUS[open.status].tone} />
                  {IMPORT_STATUS[open.status].label}
                  {open.accountName ? <span>· {open.accountName}</span> : null}
                  <span>· Started {timeAgo(open.startedAt)}</span>
                </p>
              </div>
            </div>
            <Link href={`/settings/import/${open.id}`} className={buttonClass({ variant: 'primary', className: 'self-start sm:self-auto' })}>
              {OPEN_COPY[open.status as keyof typeof OPEN_COPY].action}
            </Link>
          </Card>
        ) : null}

        <NewImport
          blocked={!!open}
          retentionMonths={org?.retentionMonths ?? null}
          importedFrom={[...new Set(jobs.filter((j) => j.status === 'SUCCEEDED').map((j) => j.provider))]}
          initialProvider={!open && IMPORT_PROVIDERS.some((p) => p.id === provider) ? provider : null}
        />

        {past.length || !open ? (
          <section>
            <SectionHeader title="Past imports" />
            {past.length ? (
              <Card className="divide-y divide-line overflow-hidden">
                {past.map((j) => (
                  <Link
                    key={j.id}
                    href={`/settings/import/${j.id}`}
                    className="flex min-h-14 items-center gap-3 px-4 py-3 transition-colors duration-[120ms] hover:bg-muted/60"
                  >
                    <SiteIcon url={j.domain} size={20} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-ink">
                        {j.providerName}
                        {j.accountName ? <span className="font-normal text-ink-2"> · {j.accountName}</span> : null}
                      </p>
                      <p className="mt-0.5 truncate text-xs text-ink-2 tabular-nums">
                        {formatCount(j.created)} {j.created === 1 ? 'candidate' : 'candidates'} ·{' '}
                        {j.finishedAt ? `Finished ${timeAgo(j.finishedAt)}` : `Started ${timeAgo(j.startedAt)}`}
                      </p>
                    </div>
                    <span className="flex shrink-0 items-center gap-1.5 text-xs text-ink-2">
                      <StatusDot tone={IMPORT_STATUS[j.status].tone} />
                      {IMPORT_STATUS[j.status].label}
                    </span>
                    <ChevronRight size={14} aria-hidden className="shrink-0 text-ink-3" />
                  </Link>
                ))}
              </Card>
            ) : (
              <Card className="px-4 py-4">
                <p className="text-sm text-ink-2">
                  No imports yet. Each one you run shows up here with what it brought over.
                </p>
              </Card>
            )}
          </section>
        ) : null}
      </div>
    </div>
  );
}
