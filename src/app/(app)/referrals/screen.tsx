import { UserPlus } from 'lucide-react';
import type { loadReferralsPage } from '@/app/(app)/page-loaders';
import { PageHeader } from '@/components/page-header';
import { EmptyState } from '@/components/empty-state';
import { ReferralForm } from '@/components/referral-form';
import { surface } from '@/components/form-controls';
import { Avatar } from '@/components/ui/orb';
import { Badge, SectionHeader } from '@/components/ui/primitives';
import { LocalTime } from '@/components/local-time';

const STATUS_LABEL: Record<string, string> = {
  ACTIVE: 'In process',
  ARCHIVED: 'Archived',
  HIRED: 'Hired',
};

export function ReferralsScreen({ data }: { data: Awaited<ReturnType<typeof loadReferralsPage>> }) {
  return (
    <div className="t-reveal">
      <PageHeader
        title="Referrals"
        subtitle="Submit people you know and track them through the pipeline"
      />

      <div className="mx-6 mt-2 flex flex-col gap-8 pb-10">
        <section className={`${surface} p-5`}>
          <h2 className="text-md font-medium">Refer someone</h2>
          <p className="mb-5 mt-1 text-sm text-ink-2">
            We&apos;ll open them in the pipeline as a referred candidate and keep you on the record
            as the source.
          </p>
          <ReferralForm postings={data.postings} />
        </section>

        {data.referrals.length === 0 ? (
          <EmptyState
            icon={UserPlus}
            title="No referrals yet"
            description="When you or a teammate refers someone, they show up here with live pipeline status."
          />
        ) : (
          <section>
            <SectionHeader title="Submitted" />
            <div className={`${surface} divide-y divide-line overflow-hidden`}>
              {data.referrals.map((r) => (
                <a
                  key={r.id}
                  href={`/candidates/${r.opportunityId}`}
                  className="flex items-start gap-3 px-4 py-4 transition-colors duration-[120ms] hover:bg-muted/60"
                >
                  <Avatar name={r.contactName} size={32} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{r.contactName}</p>
                        <p className="mt-0.5 truncate text-sm text-ink-2">
                          {r.headline || r.email}
                          {r.postingTitle ? ` · ${r.postingTitle}` : ''}
                        </p>
                      </div>
                      <Badge tone={r.opportunityStatus === 'HIRED' ? 'positive' : undefined}>
                        {r.opportunityStatus === 'ACTIVE'
                          ? r.stageName
                          : (STATUS_LABEL[r.opportunityStatus] ?? r.opportunityStatus)}
                      </Badge>
                    </div>
                    <p className="mt-2 text-xs text-ink-2">
                      Referred by {r.referrerName}
                      {r.relationship ? ` · ${r.relationship.replace(/-/g, ' ')}` : ''}
                      {' · '}
                      <LocalTime date={r.createdAt} options={{ month: 'short', day: 'numeric' }} />
                    </p>
                    {r.notes ? (
                      <p className="mt-1.5 line-clamp-2 text-sm text-ink-2">{r.notes}</p>
                    ) : null}
                  </div>
                </a>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
