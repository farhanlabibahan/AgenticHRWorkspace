'use client';

import { useState, useActionState } from 'react';
import { ClipboardCheck } from 'lucide-react';
import { submitFeedbackAction, type FormState } from '@/app/(app)/actions';
import {
  Field,
  btnGhost,
  btnPrimary,
  surface,
  textareaClass,
  noAutofill,
} from '@/components/form-controls';
import { FormSelect } from '@/components/form-select';
import { Badge, SectionHeader, type Tone } from '@/components/ui/primitives';
import { TextSwap } from '@/components/ui/motion';
import { LocalTime } from '@/components/local-time';

const RATING_LABELS: Record<number, string> = {
  1: 'Strong no',
  2: 'No',
  3: 'Yes',
  4: 'Strong yes',
};

const RATING_TONES: Record<number, Tone> = {
  1: 'critical',
  2: 'caution',
  3: 'positive',
  4: 'positive',
};

export type ScorecardAnswerDisplay = { label: string; kind: 'RATING' | 'TEXT'; value: string };

type FeedbackItem = {
  id: string;
  overallRating: number;
  summary: string;
  authorName: string;
  interviewTitle: string | null;
  createdAt: string;
  answers?: ScorecardAnswerDisplay[];
};

export type ScorecardQuestionItem = { id: string; label: string; kind: 'RATING' | 'TEXT' };

export function FeedbackSection({
  opportunityId,
  feedback,
  interviews,
  hiddenCount = 0,
  questions = [],
}: {
  opportunityId: string;
  feedback: FeedbackItem[];
  interviews: { id: string; title: string }[];
  /** Scorecards hidden by the "independent scorecards" bias-control setting. */
  hiddenCount?: number;
  /** Org-configured scorecard questions rendered after the fixed fields. */
  questions?: ScorecardQuestionItem[];
}) {
  const [open, setOpen] = useState(false);
  const [rating, setRating] = useState('');
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    submitFeedbackAction,
    undefined,
  );

  return (
    <section>
      <SectionHeader
        title="Feedback"
        action={
          <button onClick={() => setOpen((v) => !v)} className={btnGhost}>
            <ClipboardCheck /> {open ? 'Cancel' : 'Add feedback'}
          </button>
        }
      />

      {open ? (
        <form action={formAction} className={`${surface} mb-3 flex flex-col gap-3 p-5`}>
          <input type="hidden" name="opportunityId" value={opportunityId} />
          <div className="grid grid-cols-2 gap-3">
            <Field label="Overall">
              <FormSelect
                name="overallRating"
                placeholder="Rating…"
                value={rating}
                onChange={setRating}
                options={[4, 3, 2, 1].map((r) => ({ value: String(r), label: RATING_LABELS[r] }))}
              />
            </Field>
            <Field label="Interview (optional)">
              <FormSelect
                name="interviewId"
                options={[
                  { value: '', label: 'General' },
                  ...interviews.map((iv) => ({ value: iv.id, label: iv.title })),
                ]}
              />
            </Field>
          </div>
          <Field label="Summary">
            <textarea {...noAutofill}
              name="summary"
              rows={3}
              required
              placeholder="Strengths, concerns, recommendation…"
              className={textareaClass}
            />
          </Field>
          {questions.map((q) =>
            q.kind === 'RATING' ? (
              <Field key={q.id} label={q.label}>
                <FormSelect
                  name={`answer_${q.id}`}
                  placeholder="Rating…"
                  options={[4, 3, 2, 1].map((r) => ({
                    value: String(r),
                    label: RATING_LABELS[r],
                  }))}
                />
              </Field>
            ) : (
              <Field key={q.id} label={q.label}>
                <textarea {...noAutofill} name={`answer_${q.id}`} rows={2} className={textareaClass} />
              </Field>
            ),
          )}
          {state?.error ? <p className="text-sm text-critical">{state.error}</p> : null}
          <div className="flex justify-end">
            <button type="submit" disabled={pending || !rating} className={btnPrimary}>
              <TextSwap>{pending ? 'Submitting…' : 'Submit feedback'}</TextSwap>
            </button>
          </div>
        </form>
      ) : null}

      {hiddenCount > 0 ? (
        <p className="mb-3 rounded-card bg-surface px-4 py-3 text-sm text-ink-2">
          {hiddenCount} scorecard{hiddenCount === 1 ? ' is' : 's are'} hidden until you submit your
          own — independent scorecards are on for this organization.
        </p>
      ) : null}

      {feedback.length ? (
        <div className={`${surface} divide-y divide-line`}>
          {feedback.map((f) => (
            <div key={f.id} className="px-5 py-4">
              <div className="flex items-center justify-between gap-2">
                <Badge tone={RATING_TONES[f.overallRating]} className="text-ink">
                  {RATING_LABELS[f.overallRating]}
                </Badge>
                <span className="text-xs text-ink-2">
                  <LocalTime date={f.createdAt} options={{ year: 'numeric', month: 'numeric', day: 'numeric' }} />
                </span>
              </div>
              <p className="mt-2 whitespace-pre-wrap text-sm">{f.summary}</p>
              {f.answers?.length ? (
                <div className="mt-3 flex flex-col gap-1.5">
                  {f.answers.map((a, i) => (
                    <div key={i} className="text-sm">
                      <span className="text-ink-2">{a.label}: </span>
                      {a.kind === 'RATING' ? (
                        <span className="text-xs font-medium">
                          {RATING_LABELS[Number(a.value)] ?? a.value}
                        </span>
                      ) : (
                        <span className="whitespace-pre-wrap">{a.value}</span>
                      )}
                    </div>
                  ))}
                </div>
              ) : null}
              <p className="mt-2 text-xs text-ink-2">
                {f.authorName}
                {f.interviewTitle ? ` · ${f.interviewTitle}` : ''}
              </p>
            </div>
          ))}
        </div>
      ) : !open ? (
        <p className="text-sm text-ink-2">No feedback yet.</p>
      ) : null}
    </section>
  );
}
