'use client';

import { useState, useTransition } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Plus, X } from 'lucide-react';
import { saveMatchCriteriaAction, suggestMatchCriteriaAction } from '@/app/(app)/actions';
import { inputClass, noAutofill } from '@/components/form-controls';
import { buttonClass, type ButtonSize, type ButtonVariant } from '@/components/ui/button';
import { ThinkingStates } from '@/components/ui/motion';
import { Bot } from '@/components/ui/bot';
import { MAX_CRITERIA, MAX_LABEL, type MatchCriterion } from '@/lib/match-criteria';
import { cn } from '@/lib/utils';

const newId = () => Math.random().toString(36).slice(2, 10);

/**
 * Edit what every candidate for a role is scored on. Opens from the
 * candidate's match card and from the posting. A criterion is a short
 * phrase; must-haves count double in the match. With AI on, the list can be
 * drafted from the job description, to review before saving.
 */
export function MatchCriteriaEditor({
  postingId,
  postingTitle,
  criteria,
  aiEnabled,
  label = 'Edit criteria',
  variant = 'ghost',
  size = 'sm',
}: {
  postingId: string;
  postingTitle: string;
  criteria: MatchCriterion[];
  aiEnabled: boolean;
  label?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<MatchCriterion[]>(criteria);
  const [error, setError] = useState<string | null>(null);
  const [saving, startSave] = useTransition();
  const [suggesting, startSuggest] = useTransition();

  const update = (id: string, patch: Partial<MatchCriterion>) =>
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setRows(criteria.length ? criteria : [{ id: newId(), label: '', must: false }]);
          setError(null);
        }
      }}
    >
      <Dialog.Trigger asChild>
        <button type="button" className={buttonClass({ variant, size })}>
          {label}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay fixed inset-0 z-[300] bg-ink/10" />
        <Dialog.Content className="dialog-animate fixed left-1/2 top-[max(16px,12vh)] z-[300] flex max-h-[calc(100dvh-32px)] w-[min(520px,calc(100vw-32px))] -translate-x-1/2 flex-col rounded-dialog bg-surface shadow-float outline-none">
          <div className="px-6 pt-6">
            <Dialog.Title className="text-md font-medium text-ink">Match criteria</Dialog.Title>
            <Dialog.Description className="mt-1 text-sm text-ink-2">
              Every candidate for {postingTitle} is scored on these. Must-haves count double. Changes apply to
              evaluations run from now on.
            </Dialog.Description>
          </div>

          <form
            id="criteria-form"
            className="mt-5 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-6 pb-1"
            onSubmit={(e) => {
              e.preventDefault();
              startSave(async () => {
                const result = await saveMatchCriteriaAction(postingId, rows.filter((r) => r.label.trim()));
                if (result.error) setError(result.error);
                else setOpen(false);
              });
            }}
          >
            {suggesting ? (
              <div className="rounded-field bg-muted px-4 py-3 text-sm">
                <ThinkingStates lines={['Reading the job description…', 'Picking out what to screen for…', 'Marking the must-haves…']} />
              </div>
            ) : (
              rows.map((r, i) => (
                <div key={r.id} className="flex items-center gap-1.5">
                  <input
                    {...noAutofill}
                    value={r.label}
                    maxLength={MAX_LABEL}
                    autoFocus={i === rows.length - 1 && !r.label}
                    aria-label={`Criterion ${i + 1}`}
                    placeholder="e.g. Senior-level product design"
                    onChange={(e) => update(r.id, { label: e.target.value })}
                    className={cn(inputClass, 'h-9 min-w-0 flex-1 text-sm')}
                  />
                  <button
                    type="button"
                    aria-pressed={r.must}
                    onClick={() => update(r.id, { must: !r.must })}
                    title={r.must ? 'Must-have: counts double' : 'Nice to have'}
                    className={cn(
                      'selectable inline-flex h-9 w-[104px] shrink-0 items-center justify-center rounded-full text-xs',
                      r.must ? 'is-selected font-medium' : 'bg-muted text-ink-2 hover:text-ink',
                    )}
                  >
                    {r.must ? 'Must-have' : 'Nice to have'}
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove ${r.label || 'criterion'}`}
                    onClick={() => setRows((rs) => rs.filter((x) => x.id !== r.id))}
                    className={buttonClass({ variant: 'ghost', size: 'md', icon: true })}
                  >
                    <X />
                  </button>
                </div>
              ))
            )}
            {!suggesting ? (
              <div className="flex flex-wrap items-center gap-1 pt-1">
                <button
                  type="button"
                  disabled={rows.length >= MAX_CRITERIA}
                  onClick={() => setRows((rs) => [...rs, { id: newId(), label: '', must: false }])}
                  className={buttonClass({ variant: 'ghost', size: 'sm' })}
                >
                  <Plus /> Add criterion
                </button>
                {aiEnabled ? (
                  <button
                    type="button"
                    onClick={() =>
                      startSuggest(async () => {
                        const result = await suggestMatchCriteriaAction(postingId);
                        if (result.error || !result.criteria) {
                          setError(result.error ?? 'Couldn’t suggest criteria.');
                          return;
                        }
                        setError(null);
                        // Keep what's typed; add suggestions it doesn't already have.
                        setRows((rs) => {
                          const kept = rs.filter((r) => r.label.trim());
                          const have = new Set(kept.map((r) => r.label.trim().toLowerCase()));
                          const added = result.criteria!.filter((c) => !have.has(c.label.toLowerCase()));
                          return [...kept, ...added].slice(0, MAX_CRITERIA);
                        });
                      })
                    }
                    className={buttonClass({ variant: 'ghost', size: 'sm' })}
                  >
                    <Bot size={16} /> Suggest from the job description
                  </button>
                ) : null}
              </div>
            ) : null}
          </form>

          {error ? <p className="px-6 pt-2 text-sm text-critical">{error}</p> : null}
          <div className="flex justify-end gap-2 px-6 pb-6 pt-5">
            <Dialog.Close className={buttonClass({ variant: 'ghost' })}>Cancel</Dialog.Close>
            <button type="submit" form="criteria-form" disabled={saving || suggesting} className={buttonClass({ variant: 'primary' })}>
              {saving ? 'Saving…' : 'Save criteria'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
