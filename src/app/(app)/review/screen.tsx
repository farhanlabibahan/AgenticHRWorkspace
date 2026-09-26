import { CandidateLink } from '@/components/candidate-link';
import { Inbox } from 'lucide-react';
import type { loadReviewPage } from '@/app/(app)/page-loaders';
import { PageHeader } from '@/components/page-header';
import { EmptyState } from '@/components/empty-state';
import { BatchEvaluateButton, ReviewRowActions } from '@/components/review-controls';
import { RemovableRow } from '@/components/removable-row';
import { surface } from '@/components/form-controls';
import { Avatar } from '@/components/ui/orb';
import { Badge, Chip, type Tone } from '@/components/ui/primitives';

const REC_LABELS: Record<number, string> = {
  1: 'Strong no',
  2: 'No',
  3: 'Yes',
  4: 'Strong yes',
};
const REC_TONES: Record<number, Tone> = {
  1: 'critical',
  2: 'caution',
  3: 'positive',
  4: 'positive',
};

export function ReviewScreen({ data }: { data: Awaited<ReturnType<typeof loadReviewPage>> }) {
  const href = (posting: string) => (posting ? `/review?posting=${posting}` : '/review');
  const hidden = data.queueLength - data.rows.length;

  return (
    <div className="t-reveal">
      <div className="flex items-start justify-between pr-6">
        <PageHeader
          title="Review"
          subtitle="New applications, evaluated against the role and ranked"
        />
        {data.aiEnabled && data.queueLength ? (
          <div className="mt-6">
            <BatchEvaluateButton postingId={data.postingFilter || undefined} />
          </div>
        ) : null}
      </div>

      <div className="mx-6 mt-2 flex flex-col gap-4 pb-10">
        <div className="flex flex-wrap items-center gap-2">
          <Chip href={href('')} selected={!data.postingFilter}>
            All roles · <span className="tabular-nums">{data.queueLength}</span>
          </Chip>
          {data.postings.map((p) => (
            <Chip key={p.id} href={href(p.id)} selected={data.postingFilter === p.id}>
              {p.title}
            </Chip>
          ))}
          {data.aiEnabled && data.unevaluated > 0 ? (
            <span className="ml-2 text-xs text-ink-2">
              {data.unevaluated} awaiting AI review
            </span>
          ) : null}
        </div>

        {data.rows.length === 0 ? (
          <EmptyState
            icon={Inbox}
            title="Review queue is clear"
            description="New applications land here while they sit in your lead and applicant stages."
          />
        ) : (
          <div className={`${surface} divide-y divide-line`}>
            {data.rows.map((o) => {
              const ev = o.evaluation;
              return (
                <RemovableRow key={o.id} className="flex items-start gap-3 px-4 py-3.5">
                  <Avatar name={o.name} seed={o.id} size={32} />
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2">
                      <CandidateLink id={o.id} className="text-sm font-medium hover:underline">
                        {o.name}
                      </CandidateLink>
                      {ev ? (
                        <Badge tone={REC_TONES[ev.recommendation]}>
                          {REC_LABELS[ev.recommendation]}
                        </Badge>
                      ) : (
                        <Badge>Unreviewed</Badge>
                      )}
                      {ev && ev.matchScore !== null ? (
                        <Badge className="tabular-nums">{`${ev.matchScore}% match`}</Badge>
                      ) : null}
                      <Badge>{o.stageName}</Badge>
                    </p>
                    <p className="mt-0.5 truncate text-xs text-ink-2">
                      {[o.headline, o.postingTitle, o.location].filter(Boolean).join(' · ') || '—'}
                    </p>
                    {ev ? (
                      <>
                        <p className="mt-1.5 line-clamp-2 max-w-3xl text-sm text-ink-2">
                          {ev.summary}
                        </p>
                        {ev.strengths.length || ev.concerns.length ? (
                          <p className="mt-1.5 flex flex-wrap gap-1.5">
                            {ev.strengths.slice(0, 2).map((s) => (
                              <Badge key={s} tone="positive">
                                + {s}
                              </Badge>
                            ))}
                            {ev.concerns.slice(0, 2).map((c) => (
                              <Badge key={c} tone="caution">
                                − {c}
                              </Badge>
                            ))}
                          </p>
                        ) : null}
                      </>
                    ) : null}
                  </div>
                  <ReviewRowActions
                    opportunityId={o.id}
                    nextStageId={o.nextStageId}
                    nextStageName={o.nextStageName}
                    advanceLeavesQueue={o.advanceLeavesQueue}
                    rejectReasonId={data.rejectReasonId}
                  />
                </RemovableRow>
              );
            })}
          </div>
        )}

        {hidden > 0 ? (
          <p className="text-xs text-ink-2">
            Showing the top {data.rows.length} of {data.queueLength}. Advance or archive these to
            bring up the next ones.
          </p>
        ) : null}

        <p className="text-xs text-ink-2">
          AI reviews are advisory — they read the resume, application note, and role description,
          and never move a candidate on their own.
        </p>
      </div>
    </div>
  );
}
