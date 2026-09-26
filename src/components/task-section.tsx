'use client';

import { useState, useActionState, useTransition, useOptimistic } from 'react';
import { ListTodo } from 'lucide-react';
import {
  createTaskAction,
  setTaskCompletedAction,
  type FormState,
} from '@/app/(app)/actions';
import {
  Field,
  btnGhost,
  btnPrimary,
  inputClass,
  surface,
  noAutofill,
} from '@/components/form-controls';
import { FormSelect } from '@/components/form-select';
import { SectionHeader } from '@/components/ui/primitives';
import { TextSwap } from '@/components/ui/motion';
import { Checkbox } from '@/components/ui/checkbox';
import { runOptimistic } from '@/lib/optimistic';
import { LocalTime } from '@/components/local-time';

export type TaskItem = {
  id: string;
  title: string;
  dueAt: string | null;
  completed: boolean;
  assigneeName: string | null;
};

export function TaskSection({
  opportunityId,
  teammates,
  tasks,
}: {
  opportunityId: string;
  teammates: { id: string; name: string }[];
  tasks: TaskItem[];
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    createTaskAction,
    undefined,
  );
  const [, startTransition] = useTransition();
  // Checked state flips the moment it's clicked; the server confirms behind it.
  const [doneOverrides, setDone] = useOptimistic<Record<string, boolean>, [string, boolean]>(
    {},
    (overrides, [id, done]) => ({ ...overrides, [id]: done }),
  );

  return (
    <section>
      <SectionHeader
        title="Tasks"
        action={
          <button onClick={() => setOpen((v) => !v)} className={btnGhost}>
            <ListTodo /> {open ? 'Cancel' : 'Add task'}
          </button>
        }
      />

      {open ? (
        <form action={formAction} className={`${surface} mb-3 flex flex-col gap-3 p-5`}>
          <input type="hidden" name="opportunityId" value={opportunityId} />
          <Field label="Task">
            <input {...noAutofill}
              name="title"
              required
              placeholder="Follow up on references…"
              className={inputClass}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Due">
              <input {...noAutofill} type="date" name="dueAt" className={inputClass} />
            </Field>
            <Field label="Assignee">
              <FormSelect
                name="assigneeId"
                options={[
                  { value: '', label: 'Me' },
                  ...teammates.map((t) => ({ value: t.id, label: t.name })),
                ]}
              />
            </Field>
          </div>
          {state?.error ? <p className="text-sm text-critical">{state.error}</p> : null}
          <div className="flex justify-end">
            <button type="submit" disabled={pending} className={btnPrimary}>
              <TextSwap>{pending ? 'Adding…' : 'Add task'}</TextSwap>
            </button>
          </div>
        </form>
      ) : null}

      {tasks.length ? (
        <div className={`${surface} divide-y divide-line overflow-hidden`}>
          {tasks.map((t) => ({ ...t, completed: doneOverrides[t.id] ?? t.completed })).map((t) => (
            <label
              key={t.id}
              className="flex cursor-pointer items-center gap-3 px-4 py-3 transition-colors duration-[120ms] hover:bg-muted/60"
            >
              <Checkbox
                checked={t.completed}
                onChange={() =>
                  runOptimistic(
                    startTransition,
                    () => setDone([t.id, !t.completed]),
                    () => setTaskCompletedAction(t.id, !t.completed),
                    t.completed ? 'Reopening the task' : 'Completing the task',
                  )
                }
              />
              <span className={`flex-1 text-sm ${t.completed ? 'text-ink-2 line-through' : ''}`}>
                {t.title}
              </span>
              <span className="shrink-0 text-xs text-ink-2">
                {t.assigneeName ? `${t.assigneeName} · ` : ''}
                {t.dueAt
                  ? <LocalTime date={t.dueAt} options={{ month: 'short', day: 'numeric' }} />
                  : ''}
              </span>
            </label>
          ))}
        </div>
      ) : !open ? (
        <p className="text-sm text-ink-2">No tasks yet.</p>
      ) : null}
    </section>
  );
}
