'use client';

import { useActionState } from 'react';
import { createCandidateAction, type FormState } from '@/app/(app)/actions';
import { Field, btnPrimary, inputClass, noAutofill } from '@/components/form-controls';
import { FormSelect } from '@/components/form-select';
import { TextSwap } from '@/components/ui/motion';

export function NewCandidateForm({
  stages,
  postings,
}: {
  stages: { id: string; name: string }[];
  postings: { id: string; title: string }[];
}) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    createCandidateAction,
    undefined,
  );

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-4">
        <Field label="Full name">
          <input {...noAutofill} name="name" required placeholder="Dana Reyes" className={inputClass} />
        </Field>
        <Field label="Email">
          <input {...noAutofill} name="email" type="email" placeholder="dana@example.com" className={inputClass} />
        </Field>
        <Field label="Headline">
          <input {...noAutofill} name="headline" placeholder="Senior Product Designer" className={inputClass} />
        </Field>
        <Field label="Location">
          <input {...noAutofill} name="location" placeholder="Brooklyn, NY" className={inputClass} />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Field label="Posting">
          <FormSelect
            name="postingId"
            options={[
              { value: '', label: 'General (no posting)' },
              ...postings.map((p) => ({ value: p.id, label: p.title })),
            ]}
          />
        </Field>
        <Field label="Stage">
          <FormSelect
            name="stageId"
            defaultValue={stages[0]?.id}
            options={stages.map((s) => ({ value: s.id, label: s.name }))}
          />
        </Field>
        <Field label="Origin">
          <FormSelect
            name="origin"
            defaultValue="SOURCED"
            options={[
              { value: 'SOURCED', label: 'Sourced' },
              { value: 'APPLIED', label: 'Applied' },
              { value: 'REFERRED', label: 'Referred' },
              { value: 'AGENCY', label: 'Agency' },
              { value: 'INTERNAL', label: 'Internal' },
              { value: 'UNIVERSITY', label: 'University' },
            ]}
          />
        </Field>
        <Field label="Source">
          <input {...noAutofill} name="source" placeholder="linkedin, referral name…" className={inputClass} />
        </Field>
      </div>

      {state?.error ? (
        <p className="rounded-field bg-critical/10 px-3 py-2 text-sm text-critical">{state.error}</p>
      ) : null}

      <div className="flex justify-end">
        <button type="submit" disabled={pending} className={btnPrimary}>
          <TextSwap>{pending ? 'Adding…' : 'Add candidate'}</TextSwap>
        </button>
      </div>
    </form>
  );
}
