'use client';

import { useState, useTransition } from 'react';
import { runAiEvaluationAction } from '@/app/(app)/actions';
import { btnGhost, surface } from '@/components/form-controls';
import { Badge, SectionHeader, StatusDot, type Tone } from '@/components/ui/primitives';
import { TextSwap, ThinkingStates } from '@/components/ui/motion';
import { Bot } from '@/components/ui/bot';
import { LocalTime } from '@/components/local-time';
import { DitherBar } from '@/components/ui/dither';
import { MatchCriteriaEditor } from '@/components/match-criteria-editor';
import { orderResults, scoreTone, type CriterionResult, type MatchCriterion } from '@/lib/match-criteria';
import { cn } from '@/lib/utils';

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

type EvaluationItem = {
  id: string;
  recommendation: number;
  summary: string;
  strengths: string[];
  concerns: string[];
  questions: string[];
  /** Scored role criteria; empty for evaluations from before criteria existed. */
  criteria: CriterionResult[];
  matchScore: number | null;
  createdAt: string;
};

export function AiEvaluationSection({
  opportunityId,
  aiEnabled,
  posting,
  evaluations,
}: {
  opportunityId: string;
  aiEnabled: boolean;
  /** The role and what it scores candidates on, for Edit criteria. */
  posting: { id: string; title: string; criteria: MatchCriterion[] } | null;
  evaluations: EvaluationItem[];
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Without AI there's nothing to run; past evaluations still show.
  if (!aiEnabled && evaluations.length === 0) return null;

  return (
    <section>
      <SectionHeader
        title={
          <span className="flex items-center gap-2">
            <Bot state={!aiEnabled ? 'sleeping' : pending ? 'working' : 'idle'} size={20} />
            Candidate match
          </span>
        }
        action={
          aiEnabled ? (
            <span className="-my-1.5 flex items-center gap-1">
            {posting ? (
              <MatchCriteriaEditor
                postingId={posting.id}
                postingTitle={posting.title}
                criteria={posting.criteria}
                aiEnabled={aiEnabled}
              />
            ) : null}
            <button
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const result = await runAiEvaluationAction(opportunityId);
                  setError(result.error ?? null);
                })
              }
              className={btnGhost}
            >
              <TextSwap>{pending ? 'Evaluating…' : evaluations.length ? 'Re-run' : 'Run evaluation'}</TextSwap>
            </button>
            </span>
          ) : null
        }
      />

      {error ? <p className="mb-2 text-sm text-critical">{error}</p> : null}

      {pending ? (
        <p className="animate-fade-rise mb-3 text-sm">
          <ThinkingStates
            lines={['Reading the resume…', 'Checking the application note…', 'Weighing the scorecards…']}
          />
        </p>
      ) : null}

      {evaluations.length === 0 ? (
        <p className="text-sm text-ink-2">
          No evaluations yet. AI reads the resume, application note, and scorecards — advisory
          input only, never a decision.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {evaluations.map((ev, idx) => (
            <div key={ev.id} className={`${surface} p-5 ${idx > 0 ? 'opacity-70' : ''}`}>
              {/* The verdict is the card's headline, not one more chip: the
                  word large, and a dithered meter filling one to four steps
                  from Strong no to Strong yes. */}
              <div className="flex items-start justify-between gap-4">
                <div className="flex min-w-0 flex-wrap gap-x-10 gap-y-4">
                  {/* How well they meet the role's criteria, then the overall verdict */}
                  {ev.matchScore !== null ? (
                    <div>
                      <p className="text-xs text-ink-2">Match</p>
                      <p className="mt-0.5 text-2xl tabular-nums text-ink">{ev.matchScore}%</p>
                      <p className="mt-3 text-xs tabular-nums text-ink-2">
                        {ev.criteria.filter((c) => (c.score ?? 0) >= 75).length} of {ev.criteria.length} criteria met
                      </p>
                    </div>
                  ) : null}
                  <div>
                    <p className="text-xs text-ink-2">Recommendation</p>
                    <p className="mt-0.5 flex items-center gap-2 text-2xl text-ink">
                      <StatusDot tone={RATING_TONES[ev.recommendation]} className="size-2" />
                      {RATING_LABELS[ev.recommendation]}
                    </p>
                    <div className="mt-3 flex w-72 max-w-full items-center gap-3">
                      <DitherBar
                        value={ev.recommendation}
                        max={4}
                        height={8}
                        label={`${RATING_LABELS[ev.recommendation]}, ${ev.recommendation} of 4`}
                      />
                      <span aria-hidden className="shrink-0 text-xs tabular-nums text-ink-2">
                        {ev.recommendation} of 4
                      </span>
                    </div>
                  </div>
                </div>
                <span className="shrink-0 text-xs text-ink-2">
                  <LocalTime date={ev.createdAt} options={{ year: 'numeric', month: 'numeric', day: 'numeric' }} />
                </span>
              </div>

              {ev.criteria.length ? <CriteriaChips results={ev.criteria} /> : null}

              {/* Before criteria: a positive dot marks a strength, a caution dot a concern */}
              {!ev.criteria.length && (ev.strengths.length || ev.concerns.length) ? (
                <div className="mt-5 flex flex-wrap gap-1.5">
                  {ev.strengths.map((st, i) => (
                    <Badge key={`s${i}`} tone="positive" wrap className="text-ink">
                      <span className="sr-only">Strength: </span>
                      {st}
                    </Badge>
                  ))}
                  {ev.concerns.map((c, i) => (
                    <Badge key={`c${i}`} tone="caution" wrap className="text-ink">
                      <span className="sr-only">Concern: </span>
                      {c}
                    </Badge>
                  ))}
                </div>
              ) : null}

              {/* Summary as the highlighted callout: a muted well inside the card */}
              <div className="mt-4 rounded-field bg-muted px-4 py-3">
                <p className="whitespace-pre-wrap text-sm">{ev.summary}</p>
              </div>

              {ev.questions.length ? (
                <div className="mt-4">
                  <p className="mb-1.5 text-xs font-medium text-ink-2">Suggested questions</p>
                  <ul className="flex list-disc flex-col gap-0.5 pl-4 text-sm">
                    {ev.questions.map((q, i) => (
                      <li key={i}>{q}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * One chip per role criterion: its score as a status dot and a percentage,
 * must-haves first. Choosing a chip shows the evidence behind its score.
 */
function CriteriaChips({ results }: { results: CriterionResult[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const ordered = orderResults(results);
  const shown = ordered.find((r) => r.id === open) ?? null;
  return (
    <div className="mt-5">
      <div className="flex flex-wrap gap-1.5">
        {ordered.map((r) => (
          <button
            key={r.id}
            type="button"
            aria-expanded={open === r.id}
            onClick={() => setOpen((o) => (o === r.id ? null : r.id))}
            className={cn(
              'selectable inline-flex min-h-7 items-center gap-1.5 rounded-[14px] px-2.5 py-1 text-left text-xs text-ink',
              open === r.id ? 'is-selected' : 'bg-muted hover:bg-recessed',
            )}
          >
            <StatusDot tone={scoreTone(r.score)} />
            <span className={r.must ? 'font-medium' : undefined}>{r.label}</span>
            {r.must ? <span className="sr-only">, must-have</span> : null}
            <span className="tabular-nums text-ink-2">{r.score === null ? '—' : `${r.score}%`}</span>
          </button>
        ))}
      </div>
      {shown ? (
        <p className="animate-fade-rise mt-2.5 text-sm text-ink-2">
          <span className="font-medium text-ink">{shown.label}</span>
          {shown.must ? ' · must-have' : ''}
          {' — '}
          {shown.evidence || 'Nothing in the resume, application or interviews speaks to this yet.'}
        </p>
      ) : null}
    </div>
  );
}
