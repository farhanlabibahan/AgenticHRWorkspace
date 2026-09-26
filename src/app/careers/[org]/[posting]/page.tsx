import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, CheckCircle2, MapPin } from 'lucide-react';
import { db } from '@/lib/db';
import { ApplyForm } from '@/components/apply-form';
import { isSampleSlug } from '@/server/sample-boards';
import { buttonClass } from '@/components/ui/button';

const WORKPLACE_LABELS: Record<string, string> = {
  ONSITE: 'On-site',
  HYBRID: 'Hybrid',
  REMOTE: 'Remote',
};

const COMMITMENT_LABELS: Record<string, string> = {
  FULL_TIME: 'Full-time',
  PART_TIME: 'Part-time',
  CONTRACT: 'Contract',
  INTERNSHIP: 'Internship',
};

function formatSalary(min: number | null, max: number | null, currency: string | null): string | null {
  if (!min && !max) return null;
  const fmt = (n: number) => n.toLocaleString();
  const cur = currency ?? '';
  if (min && max) return `${cur} ${fmt(min)} – ${fmt(max)}`.trim();
  return `${cur} ${fmt(min ?? max ?? 0)}`.trim();
}

export default async function PostingPage({
  params,
  searchParams,
}: {
  params: Promise<{ org: string; posting: string }>;
  searchParams: Promise<{
    applied?: string;
    utm_source?: string;
    utm_medium?: string;
    utm_campaign?: string;
  }>;
}) {
  const { org: orgSlug, posting: postingSlug } = await params;
  const { applied, utm_source, utm_medium, utm_campaign } = await searchParams;

  const org = await db.organization.findUnique({ where: { slug: orgSlug } });
  if (!org) notFound();
  const posting = await db.posting.findFirst({
    where: { orgId: org.id, slug: postingSlug, state: 'PUBLISHED' },
    include: { department: true, clientCompany: true },
  });
  if (!posting) notFound();

  const salary = formatSalary(posting.salaryMin, posting.salaryMax, posting.salaryCurrency);
  const description =
    posting.content && typeof posting.content === 'object' && 'description' in posting.content
      ? String((posting.content as { description?: string }).description ?? '')
      : '';

  return (
    <div>
      <Link
        href={`/careers/${orgSlug}`}
        className="mb-6 inline-flex items-center gap-1.5 text-sm font-medium text-ink-2 transition-colors duration-[120ms] hover:text-ink"
      >
        <ArrowLeft size={14} /> All positions
      </Link>

      {/* a role's own logo (an agency's client); the organization's is in the header */}
      {posting.logoFileId ? (
        // eslint-disable-next-line @next/next/no-img-element -- upload via public logo route
        <img
          src={`/api/logo/${posting.logoFileId}`}
          alt={`${posting.clientCompany?.name ?? org.name} logo`}
          className="mb-6 size-12 rounded-card bg-surface object-contain p-1"
        />
      ) : null}
      <h1 className="text-3xl">{posting.title}</h1>
      <p className="mt-2 flex flex-wrap items-center gap-3 text-sm text-ink-2">
        {posting.clientCompany ? <span>Hiring for {posting.clientCompany.name}</span> : null}
        {posting.department ? <span>{posting.department.name}</span> : null}
        {posting.location ? (
          <span className="flex items-center gap-1">
            <MapPin size={13} /> {posting.location}
          </span>
        ) : null}
        <span>{WORKPLACE_LABELS[posting.workplaceType]}</span>
        <span>{COMMITMENT_LABELS[posting.commitment]}</span>
        {salary ? <span className="tabular-nums">{salary}</span> : null}
      </p>

      {description ? (
        <div className="mt-8 max-w-prose whitespace-pre-wrap text-md text-ink">{description}</div>
      ) : null}

      <div className="mt-12 rounded-card bg-surface p-8">
        {applied ? (
          <div className="flex flex-col items-center py-6 text-center">
            <CheckCircle2 size={28} className="text-positive" />
            <h2 className="mt-4 text-xl font-medium">Application received</h2>
            <p className="mt-1 max-w-sm text-sm text-ink-2">
              Thanks for applying to {org.name}. The team will review your application and be in
              touch.
            </p>
            <Link
              href={`/careers/${orgSlug}/status`}
              className={buttonClass({ variant: 'tonal', size: 'lg', className: 'mt-6' })}
            >
              Track your application status
            </Link>
          </div>
        ) : (
          isSampleSlug(orgSlug) ? (
            // A sample board from the Source homepage: nobody reads these applications.
            <div className="py-2">
              <h2 className="text-xl font-medium">This is a sample job board</h2>
              <p className="mt-2 max-w-md text-sm text-ink-2">
                Applying is off here. It shows what candidates see on a careers page run by Source ATS.
              </p>
              <Link href="/" className={buttonClass({ variant: 'primary', size: 'lg', className: 'mt-6' })}>
                Get your own careers page
              </Link>
            </div>
          ) : (
          <>
            <h2 className="mb-6 text-xl font-medium">Apply for this role</h2>
            <ApplyForm
              orgSlug={orgSlug}
              postingSlug={postingSlug}
              networkOptIn={org.talentNetworkEnabled}
              collectEeo={org.collectEeo}
              utm={{ source: utm_source, medium: utm_medium, campaign: utm_campaign }}
            />
          </>
          )
        )}
      </div>
    </div>
  );
}
