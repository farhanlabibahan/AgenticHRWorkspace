'use client';

import { useState, useActionState, useTransition } from 'react';
import { FileAudio, X } from 'lucide-react';
import {
  addTranscriptAction,
  deleteTranscriptAction,
  type FormState,
} from '@/app/(app)/actions';
import {
  Field,
  btnGhost,
  btnPrimary,
  inputClass,
  surface,
  textareaClass,
  noAutofill,
} from '@/components/form-controls';
import { FormSelect } from '@/components/form-select';
import { buttonClass } from '@/components/ui/button';
import { SectionHeader } from '@/components/ui/primitives';
import { TextSwap, ThinkingStates } from '@/components/ui/motion';
import { LocalTime } from '@/components/local-time';
import { PullQuestions, QuestionList } from '@/components/interview-feed';
import type { TranscriptInsights } from '@/lib/interview-insights';

export type TranscriptItem = {
  id: string;
  title: string;
  source: string;
  interviewTitle: string | null;
  chars: number;
  createdAt: string;
  preview: string;
  insights: TranscriptInsights | null;
};

export function TranscriptSection({
  opportunityId,
  interviews,
  transcripts,
  aiEnabled,
}: {
  opportunityId: string;
  interviews: { id: string; title: string }[];
  transcripts: TranscriptItem[];
  aiEnabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    addTranscriptAction,
    undefined,
  );
  const [deletePending, startTransition] = useTransition();

  return (
    <section>
      <SectionHeader
        title="Transcripts"
        action={
          <button onClick={() => setOpen((v) => !v)} className={btnGhost}>
            <FileAudio /> {open ? 'Cancel' : 'Add transcript'}
          </button>
        }
      />

      {open ? (
        <form action={formAction} className={`${surface} mb-3 flex flex-col gap-3 p-5`}>
          <input type="hidden" name="opportunityId" value={opportunityId} />
          <div className="grid grid-cols-2 gap-3">
            <Field label="Title">
              <input {...noAutofill}
                name="title"
                placeholder="Phone screen — Google Meet"
                className={inputClass}
              />
            </Field>
            <Field label="Interview (optional)">
              <FormSelect
                name="interviewId"
                options={[
                  { value: '', label: 'Not tied to one interview' },
                  ...interviews.map((iv) => ({ value: iv.id, label: iv.title })),
                ]}
              />
            </Field>
          </div>
          <Field label="Transcript text">
            <textarea {...noAutofill}
              name="content"
              rows={8}
              required
              placeholder="Paste the meeting transcript… External tools can also push transcripts automatically via POST /api/v1/transcripts."
              className={textareaClass}
            />
          </Field>
          {state?.error ? <p className="text-sm text-critical">{state.error}</p> : null}
          <div className="flex items-center justify-end gap-3">
            {pending && aiEnabled ? (
              <span className="text-sm">
                <ThinkingStates lines={['Saving the transcript…', 'Finding the questions…', 'Summarizing the answers…']} />
              </span>
            ) : null}
            <button type="submit" disabled={pending} className={btnPrimary}>
              <TextSwap>{pending ? 'Saving…' : 'Save transcript'}</TextSwap>
            </button>
          </div>
        </form>
      ) : null}

      {transcripts.length ? (
        <div className={`${surface} divide-y divide-line`}>
          {transcripts.map((t) => (
            <div key={t.id} className="px-5 py-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{t.title}</p>
                  <p className="mt-0.5 text-xs text-ink-2">
                    {t.interviewTitle ? `${t.interviewTitle} · ` : ''}
                    {t.source} · {(t.chars / 1000).toFixed(1)}k chars ·{' '}
                    <LocalTime date={t.createdAt} options={{ year: 'numeric', month: 'numeric', day: 'numeric' }} />
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    onClick={() => setExpanded((v) => (v === t.id ? null : t.id))}
                    aria-expanded={expanded === t.id}
                    className={buttonClass({ variant: 'tonal', size: 'xs' })}
                  >
                    {expanded === t.id ? 'Collapse' : 'Read'}
                  </button>
                  <button
                    title="Delete transcript"
                    aria-label="Delete transcript"
                    disabled={deletePending}
                    onClick={() => {
                      if (!confirm(`Delete transcript "${t.title}"? This cannot be undone.`)) return;
                      startTransition(() => deleteTranscriptAction(t.id, opportunityId));
                    }}
                    className={buttonClass({ variant: 'ghost', size: 'xs', icon: true, className: 'hover:text-critical' })}
                  >
                    <X />
                  </button>
                </div>
              </div>
              {expanded === t.id && t.insights?.qa.length ? (
                <div className="mt-4 rounded-field bg-muted px-4 py-3.5">
                  <p className="mb-3 text-xs font-medium text-ink-2">Questions</p>
                  <QuestionList qa={t.insights.qa} />
                </div>
              ) : expanded === t.id && !t.insights && aiEnabled ? (
                <div className="mt-4">
                  <PullQuestions opportunityId={opportunityId} transcriptId={t.id} title={t.title} />
                </div>
              ) : null}
              <p className={`mt-2 whitespace-pre-wrap text-sm ${expanded === t.id ? '' : 'line-clamp-3 text-ink-2'}`}>
                {t.preview}
              </p>
            </div>
          ))}
        </div>
      ) : !open ? (
        <p className="text-sm text-ink-2">
          No transcripts yet. Paste one here, or point your transcription tool at the API.
        </p>
      ) : null}
    </section>
  );
}
