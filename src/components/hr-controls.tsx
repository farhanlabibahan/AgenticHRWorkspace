'use client';

import { useActionState, useTransition } from 'react';
import { Field, btnPrimary, inputClass, noAutofill, textareaClass } from '@/components/form-controls';
import { FormSelect } from '@/components/form-select';
import { TextSwap } from '@/components/ui/motion';
import { requestLeaveAction, checkInAction, checkOutAction, decideLeaveAction, runAgentAction, type HrState } from '@/app/(app)/hr/actions';
import { btnSecondary } from '@/components/form-controls';

/** Check-in / check-out for the signed-in person. */
export function CheckButtons({ canIn, canOut }: { canIn: boolean; canOut: boolean }) {
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<HrState>) => start(async () => { await fn(); });
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        disabled={!canIn || pending}
        onClick={() => run(checkInAction)}
        className={btnPrimary}
      >
        <TextSwap>{pending ? 'Working…' : 'Check in'}</TextSwap>
      </button>
      <button
        type="button"
        disabled={!canOut || pending}
        onClick={() => run(checkOutAction)}
        className={btnSecondary}
      >
        Check out
      </button>
    </div>
  );
}

export function LeaveRequestForm({ types }: { types: { id: string; name: string }[] }) {
  const [state, formAction, pending] = useActionState<HrState, FormData>(requestLeaveAction, undefined);
  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Leave type">
          <FormSelect name="leaveTypeId" options={types.map((t) => ({ value: t.id, label: t.name }))} />
        </Field>
        <Field label="From">
          <input {...noAutofill} type="date" name="startDate" required className={inputClass} />
        </Field>
        <Field label="To">
          <input {...noAutofill} type="date" name="endDate" required className={inputClass} />
        </Field>
      </div>
      <Field label="Reason (optional)">
        <textarea {...noAutofill} name="reason" rows={2} className={textareaClass} />
      </Field>
      {state?.error ? <p className="rounded-field bg-critical/10 px-3 py-2 text-sm text-critical">{state.error}</p> : null}
      {state?.ok ? <p className="rounded-field bg-positive/10 px-3 py-2 text-sm text-positive">{state.ok}</p> : null}
      <div className="flex justify-end">
        <button type="submit" disabled={pending} className={btnPrimary}>
          <TextSwap>{pending ? 'Sending…' : 'Request leave'}</TextSwap>
        </button>
      </div>
    </form>
  );
}

export function DecideButtons({ id }: { id: string }) {
  const [pending, start] = useTransition();
  const decide = (decision: 'APPROVED' | 'REJECTED') => {
    const fd = new FormData();
    fd.set('id', id);
    fd.set('decision', decision);
    start(async () => {
      await decideLeaveAction(fd);
    });
  };
  return (
    <div className="flex gap-2">
      <button type="button" disabled={pending} onClick={() => decide('APPROVED')} className={btnPrimary}>
        Approve
      </button>
      <button type="button" disabled={pending} onClick={() => decide('REJECTED')} className={btnSecondary}>
        Reject
      </button>
    </div>
  );
}

export function RunAgentButton({ agent }: { agent: 'ATTENDANCE' | 'LEAVE' | 'BRIEFING' }) {
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        const fd = new FormData();
        fd.set('agent', agent);
        start(async () => {
          await runAgentAction(fd);
        });
      }}
      className={btnSecondary}
    >
      {pending ? 'Running…' : 'Run now'}
    </button>
  );
}
