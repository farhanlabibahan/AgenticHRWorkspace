'use client';

import { useActionState, useTransition } from 'react';
import { Plus, X } from 'lucide-react';
import { createPlanStepAction, deletePlanStepAction, type FormState } from '@/app/(app)/actions';
import { Field, btnPrimary, inputClass, badge, surface, noAutofill } from '@/components/form-controls';
import { buttonClass } from '@/components/ui/button';

export type PlanStepItem = {
  id: string;
  title: string;
  durationMins: number;
  focusAreas: string[];
};

export function PlanEditor({ postingId, steps }: { postingId: string; steps: PlanStepItem[] }) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    createPlanStepAction.bind(null, postingId),
    undefined,
  );
  const [deletePending, startTransition] = useTransition();

  return (
    <div className="flex flex-col gap-3">
      {steps.length ? (
        <div className={`${surface} divide-y divide-line`}>
          {steps.map((s, i) => (
            <div key={s.id} className="flex min-h-14 items-center justify-between gap-3 px-4 py-3">
              <div className="flex min-w-0 items-center gap-3">
                <span className="w-4 shrink-0 text-xs tabular-nums text-ink-2">{i + 1}</span>
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {s.title} <span className="text-xs text-ink-2">· {s.durationMins} min</span>
                  </p>
                  {s.focusAreas.length ? (
                    <p className="mt-1.5 flex flex-wrap gap-1">
                      {s.focusAreas.map((f) => (
                        <span key={f} className={badge}>
                          {f}
                        </span>
                      ))}
                    </p>
                  ) : null}
                </div>
              </div>
              <button
                title="Remove step"
                aria-label="Remove step"
                disabled={deletePending}
                onClick={() => {
                  if (!confirm(`Remove "${s.title}" from the interview plan?`)) return;
                  startTransition(() => deletePlanStepAction(postingId, s.id));
                }}
                className={buttonClass({
                  variant: 'ghost',
                  size: 'sm',
                  icon: true,
                  className: 'hover:text-critical',
                })}
              >
                <X />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <form action={formAction} className={`${surface} flex flex-col gap-4 p-5`}>
        <div className="grid grid-cols-[1fr_110px] gap-3">
          <Field label="Interview step">
            <input {...noAutofill} name="title" required placeholder="Technical deep-dive" className={inputClass} />
          </Field>
          <Field label="Duration (min)">
            <input {...noAutofill}
              name="durationMins"
              type="number"
              min={15}
              step={15}
              defaultValue={60}
              className={inputClass}
            />
          </Field>
        </div>
        <Field label="Focus areas (comma-separated)">
          <input {...noAutofill}
            name="focusAreas"
            placeholder="System design, Communication, Ownership"
            className={inputClass}
          />
        </Field>
        {state?.error ? <p className="text-sm text-critical">{state.error}</p> : null}
        <div className="flex justify-end">
          <button type="submit" disabled={pending} className={btnPrimary}>
            <Plus /> Add step
          </button>
        </div>
      </form>
    </div>
  );
}
