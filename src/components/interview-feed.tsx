'use client';

import { useState, useTransition } from 'react';
import { ChevronDown, ClipboardCheck, FileAudio, MessageSquareText } from 'lucide-react';
import { summarizeTranscriptAction } from '@/app/(app)/actions';
import { buttonClass } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { ThinkingStates } from '@/components/ui/motion';
import { Bot } from '@/components/ui/bot';
import { qaAsText, type TranscriptInsights } from '@/lib/interview-insights';
import { badge, surface } from '@/components/form-controls';
import { Badge, Segmented } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';
import { Collapse } from '@/components/ui/motion';
import { LocalTime } from '@/components/local-time';
import { AttachRecordingButton } from '@/components/attach-recording';

const RATING_LABELS: Record<number, string> = {
  1: 'Strong no',
  2: 'No',
  3: 'Yes',
  4: 'Strong yes',
};

export type FeedInterview = {
  id: string;
  title: string;
  startAt: string;
  panelists: string[];
  feedback: {
    id: string;
    rating: number;
    summary: string;
    author: string;
    answers?: { label: string; kind: 'RATING' | 'TEXT'; value: string }[];
  }[];
  transcripts: { id: string; title: string; source: string; preview: string; insights: TranscriptInsights | null }[];
};

type Tab = 'questions' | 'transcript' | 'feedback';

/**
 * Activity feed (Recruiting-Assistant profile layout): completed interviews
 * as a timeline — attendee pills and date, an expandable card with
 * Questions | Transcript | Feedback tabs — ending with the "Opportunity
 * created" event. Questions are pulled out of the transcript: what was
 * asked, and the candidate's answers.
 */
export function InterviewFeed({
  opportunityId,
  interviews,
  createdAt,
  aiEnabled,
  recordings = null,
}: {
  opportunityId: string;
  interviews: FeedInterview[];
  createdAt: string;
  aiEnabled: boolean;
  /** The viewer has a notetaker connected: offer "Attach a recording" (with the candidate's name for the dialog). */
  recordings?: { candidateName: string } | null;
}) {
  const [openId, setOpenId] = useState<string | null>(interviews[0]?.id ?? null);
  const withQuestions = aiEnabled || interviews.some((iv) => iv.transcripts.some((t) => t.insights?.qa.length));
  const [tab, setTab] = useState<Tab>(withQuestions ? 'questions' : 'feedback');

  if (interviews.length === 0 && !createdAt) return null;

  return (
    <section>
      <h2 className="mb-3 text-md font-medium text-ink">Activity feed</h2>
      <div className="flex flex-col gap-3">
        {interviews.map((iv) => {
          const open = openId === iv.id;
          return (
            <div key={iv.id} className={`${surface}`}>
              <button
                type="button"
                onClick={() => setOpenId(open ? null : iv.id)}
                aria-expanded={open}
                className="flex w-full cursor-pointer items-center gap-2 px-4 py-3 text-left"
              >
                <span className={badge}>{iv.title}</span>
                <span className="truncate text-sm text-ink-2">
                  {iv.panelists.length ? `with ${iv.panelists.join(', ')}` : ''}
                </span>
                <span className="ml-auto shrink-0 text-xs text-ink-2">
                  <LocalTime date={iv.startAt} options={{ month: 'short', day: 'numeric', year: 'numeric' }} />
                </span>
                <ChevronDown
                  size={14}
                  className={cn(
                    'shrink-0 text-ink-2 transition-transform duration-[var(--duration-fast)] ease-[var(--ease-smooth)]',
                    open && '-scale-y-100',
                  )}
                />
              </button>

              <Collapse open={open}>
                <div className="px-4 pb-4">
                  <Segmented
                    size="sm"
                    className="mt-1 w-full"
                    value={tab}
                    onChange={setTab}
                    items={(
                      [
                        ...(withQuestions
                          ? ([['questions', 'Questions', MessageSquareText, iv.transcripts.reduce((n, t) => n + (t.insights?.qa.length ?? 0), 0)]] as const)
                          : []),
                        ['transcript', 'Transcript', FileAudio, iv.transcripts.length],
                        ['feedback', 'Feedback', ClipboardCheck, iv.feedback.length],
                      ] as const
                    ).map(([key, label, Icon, count]) => ({
                      value: key,
                      label: (
                        <span className="inline-flex items-center gap-1.5">
                          <Icon size={14} /> {label}
                          <span className="tabular-nums text-ink-2">· {count}</span>
                        </span>
                      ),
                    }))}
                  />

                  <div className="mt-4 flex flex-col gap-4">
                    {tab === 'questions' ? (
                      <QuestionsPanel opportunityId={opportunityId} transcripts={iv.transcripts} aiEnabled={aiEnabled} />
                    ) : tab === 'feedback' ? (
                      iv.feedback.length ? (
                        iv.feedback.map((f) => (
                          <div key={f.id}>
                            <div className="flex items-center justify-between gap-2">
                              <Badge tone={f.rating >= 3 ? 'positive' : 'critical'}>
                                {RATING_LABELS[f.rating] ?? f.rating}
                              </Badge>
                              <span className="text-xs text-ink-2">{f.author}</span>
                            </div>
                            <p className="mt-1.5 whitespace-pre-wrap text-sm">{f.summary}</p>
                            {f.answers?.length ? (
                              <div className="mt-2 flex flex-col gap-1">
                                {f.answers.map((a, i) => (
                                  <p key={i} className="text-sm">
                                    <span className="text-ink-2">{a.label}: </span>
                                    {a.kind === 'RATING'
                                      ? (RATING_LABELS[Number(a.value)] ?? a.value)
                                      : a.value}
                                  </p>
                                ))}
                              </div>
                            ) : null}
                          </div>
                        ))
                      ) : (
                        <p className="text-sm text-ink-2">No scorecards for this interview yet.</p>
                      )
                    ) : iv.transcripts.length ? (
                      iv.transcripts.map((t) => (
                        <div key={t.id}>
                          <div className="flex items-center justify-between gap-2">
                            <p className="truncate text-sm font-medium">{t.title}</p>
                            <span className={`${badge} shrink-0`}>{t.source}</span>
                          </div>
                          <p className="mt-1.5 line-clamp-6 whitespace-pre-wrap text-sm text-ink-2">
                            {t.preview}
                          </p>
                        </div>
                      ))
                    ) : (
                      <p className="text-sm text-ink-2">
                        No transcript attached to this interview yet.
                      </p>
                    )}
                    {recordings && (tab === 'transcript' || (tab === 'questions' && !iv.transcripts.length)) ? (
                      <div>
                        <AttachRecordingButton
                          interview={{ id: iv.id, title: iv.title, startAt: iv.startAt }}
                          candidateName={recordings.candidateName}
                        />
                      </div>
                    ) : null}
                  </div>
                </div>
              </Collapse>
            </div>
          );
        })}

        <div className="flex items-center gap-2 px-1">
          <Badge onCanvas>Opportunity created</Badge>
          <span className="text-xs text-ink-2">
            <LocalTime date={createdAt} options={{ month: 'short', day: 'numeric', year: 'numeric' }} />
          </span>
        </div>
      </div>
    </section>
  );
}

/**
 * What was asked and how the candidate answered, per transcript. With AI on,
 * a transcript not yet read offers to pull its questions out.
 */
function QuestionsPanel({
  opportunityId,
  transcripts,
  aiEnabled,
}: {
  opportunityId: string;
  transcripts: FeedInterview['transcripts'];
  aiEnabled: boolean;
}) {
  if (!transcripts.length) {
    return <p className="text-sm text-ink-2">No transcript attached to this interview yet.</p>;
  }
  return (
    <>
      {transcripts.map((t) =>
        t.insights?.qa.length ? (
          <div key={t.id}>
            <QuestionList qa={t.insights.qa} />
            <div className="mt-3 flex justify-end">
              <CopyButton text={qaAsText(t.insights.qa)} size="sm" />
            </div>
          </div>
        ) : t.insights ? (
          <p key={t.id} className="text-sm text-ink-2">
            No interview questions found in {t.title}.
          </p>
        ) : aiEnabled ? (
          <PullQuestions key={t.id} opportunityId={opportunityId} transcriptId={t.id} title={t.title} />
        ) : null,
      )}
    </>
  );
}

export function QuestionList({ qa }: { qa: NonNullable<TranscriptInsights>['qa'] }) {
  return (
    <ol className="flex flex-col gap-4">
      {qa.map((q, i) => (
        <li key={i}>
          <p className="text-sm font-medium text-ink">{q.question}</p>
          <ul className="mt-1.5 flex list-disc flex-col gap-1 pl-4 text-sm text-ink-2 marker:text-ink-3">
            {q.answer.map((a, j) => (
              <li key={j}>{a}</li>
            ))}
          </ul>
        </li>
      ))}
    </ol>
  );
}

export function PullQuestions({ opportunityId, transcriptId, title }: { opportunityId: string; transcriptId: string; title: string }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  if (pending) {
    return (
      <p className="text-sm">
        <ThinkingStates lines={['Reading the transcript…', 'Finding the questions…', 'Summarizing the answers…']} />
      </p>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        onClick={() =>
          start(async () => {
            const result = await summarizeTranscriptAction(transcriptId, opportunityId);
            setError(result.error ?? null);
          })
        }
        className={buttonClass({ variant: 'tonal', size: 'sm' })}
      >
        <Bot size={16} /> Pull out the questions
      </button>
      <span className="text-xs text-ink-2">{error ?? `From ${title}`}</span>
    </div>
  );
}
