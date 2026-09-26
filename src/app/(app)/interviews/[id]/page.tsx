import { CandidateLink } from '@/components/candidate-link';
import { notFound } from 'next/navigation';
import { ArrowLeft, FileText } from 'lucide-react';
import { db } from '@/lib/db';
import { requireSession } from '@/lib/session';
import { FeedbackSection } from '@/components/feedback-section';
import { badge, sectionLabel, surface } from '@/components/form-controls';
import { LocalTime } from '@/components/local-time';
import { buttonClass } from '@/components/ui/button';
import { Avatar } from '@/components/ui/orb';
import { Badge, type Tone } from '@/components/ui/primitives';

const STATE_BADGES: Record<string, { label: string; tone: Tone }> = {
  SCHEDULED: { label: 'Scheduled', tone: 'neutral' },
  COMPLETED: { label: 'Completed', tone: 'positive' },
  CANCELED: { label: 'Canceled', tone: 'critical' },
};

/**
 * Interview kit (docs/02 §7): everything a panelist needs in one place —
 * candidate context, the step's focus areas, the resume, and the scorecard.
 * Respects the independent-scorecards setting like the profile does.
 */
export default async function InterviewKitPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireSession();
  const { id } = await params;

  const interview = await db.interview.findFirst({
    where: { id, orgId: ctx.orgId },
    include: {
      panelists: { orderBy: { name: 'asc' } },
      opportunity: {
        include: {
          contact: { include: { resumeFile: true } },
          posting: true,
          stage: true,
          feedback: { orderBy: { createdAt: 'desc' }, include: { author: true, interview: true } },
          notes: { orderBy: { createdAt: 'desc' }, take: 5, include: { author: true } },
        },
      },
    },
  });
  if (!interview) notFound();
  const [org, scorecardQuestions] = await Promise.all([
    db.organization.findUnique({
      where: { id: ctx.orgId },
      select: { hideFeedbackUntilSubmitted: true },
    }),
    db.scorecardQuestion.findMany({
      where: { orgId: ctx.orgId, archivedAt: null },
      orderBy: { order: 'asc' },
    }),
  ]);

  const { opportunity } = interview;
  const state = STATE_BADGES[interview.state] ?? { label: interview.state, tone: 'neutral' as Tone };
  const { contact } = opportunity;
  const mustSubmitFirst =
    !!org?.hideFeedbackUntilSubmitted &&
    !opportunity.feedback.some((f) => f.authorId === ctx.userId);
  const visibleFeedback = mustSubmitFirst
    ? opportunity.feedback.filter((f) => f.authorId === ctx.userId)
    : opportunity.feedback;

  return (
    <div className="mx-auto max-w-3xl px-6 py-6">
      <CandidateLink
        id={opportunity.id}
        className={buttonClass({ variant: 'ghost', size: 'sm', className: '-ml-3 mb-4' })}
      >
        <ArrowLeft /> Candidate profile
      </CandidateLink>

      <div className={`${surface} p-5`}>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-medium text-ink">{interview.title}</h1>
          <Badge tone={state.tone}>{state.label}</Badge>
        </div>
        <p className="mt-1 text-sm text-ink-2">
          <LocalTime
            date={interview.startAt.toISOString()}
            options={{ weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }}
          />{' '}
          · {interview.durationMins} min
          {interview.location ? ` · ${interview.location}` : ''}
          {interview.panelists.length
            ? ` · with ${interview.panelists.map((p) => p.name).join(', ')}`
            : ''}
        </p>

        <div className="mt-6 flex items-start gap-3">
          <Avatar name={contact.name} size={40} />
          <div className="min-w-0">
            <p className="text-md font-medium text-ink">{contact.name}</p>
            <p className="mt-0.5 text-sm text-ink-2">
              {[contact.headline, opportunity.posting?.title, `currently in ${opportunity.stage.name}`]
                .filter(Boolean)
                .join(' · ')}
            </p>
            {contact.resumeFile ? (
              <a
                href={`/api/files/${contact.resumeFile.id}`}
                target="_blank"
                className={buttonClass({ variant: 'tonal', size: 'sm', className: 'mt-3' })}
              >
                <FileText /> Resume
              </a>
            ) : null}
          </div>
        </div>

        {interview.focusAreas.length ? (
          <div className="mt-6">
            <p className={`${sectionLabel} mb-2`}>Your focus areas</p>
            <div className="flex flex-wrap gap-1.5">
              {interview.focusAreas.map((f) => (
                <span key={f} className={badge}>
                  {f}
                </span>
              ))}
            </div>
          </div>
        ) : null}

        {opportunity.notes.length ? (
          <div className="mt-6">
            <p className={`${sectionLabel} mb-2`}>Recent notes</p>
            <div className="flex flex-col gap-2">
              {opportunity.notes.map((n) => (
                <p key={n.id} className="text-sm">
                  <span className="text-ink-2">{n.author.name}:</span>{' '}
                  {n.body.length > 200 ? `${n.body.slice(0, 200)}…` : n.body}
                </p>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      <div className="mt-8">
        <FeedbackSection
          opportunityId={opportunity.id}
          interviews={[{ id: interview.id, title: interview.title }]}
          hiddenCount={opportunity.feedback.length - visibleFeedback.length}
          questions={scorecardQuestions.map((q) => ({ id: q.id, label: q.label, kind: q.kind }))}
          feedback={visibleFeedback.map((f) => ({
            id: f.id,
            overallRating: f.overallRating,
            summary: f.summary,
            authorName: f.author.name,
            interviewTitle: f.interview?.title ?? null,
            createdAt: f.createdAt.toISOString(),
            answers:
              f.answers && typeof f.answers === 'object'
                ? Object.values(
                    f.answers as Record<string, { label: string; kind: 'RATING' | 'TEXT'; value: string }>,
                  )
                : undefined,
          }))}
        />
      </div>
    </div>
  );
}
