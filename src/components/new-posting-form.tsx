'use client';

import { useActionState } from 'react';
import { createPostingAction, type FormState } from '@/app/(app)/actions';
import {
  Field,
  btnPrimary,
  inputClass,
  textareaClass,
  noAutofill,
} from '@/components/form-controls';
import { FormSelect } from '@/components/form-select';
import { TextSwap } from '@/components/ui/motion';

export function NewPostingForm({
  isAgency,
  groups,
}: {
  isAgency: boolean;
  groups: { id: string; name: string }[];
}) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    createPostingAction,
    undefined,
  );

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <Field label="Title">
        <input {...noAutofill} name="title" required placeholder="Senior Product Designer" className={inputClass} />
      </Field>

      <div className="grid grid-cols-2 gap-4">
        <Field label={isAgency ? 'Client company' : 'Department'}>
          <FormSelect
            name={isAgency ? 'clientCompanyId' : 'departmentId'}
            options={[
              { value: '', label: isAgency ? 'No client' : 'No department' },
              ...groups.map((g) => ({ value: g.id, label: g.name })),
            ]}
          />
        </Field>
        <Field label="Location">
          <input {...noAutofill} name="location" placeholder="New York, NY" className={inputClass} />
        </Field>
        <Field label="Workplace">
          <FormSelect
            name="workplaceType"
            defaultValue="HYBRID"
            options={[
              { value: 'ONSITE', label: 'On-site' },
              { value: 'HYBRID', label: 'Hybrid' },
              { value: 'REMOTE', label: 'Remote' },
            ]}
          />
        </Field>
        <Field label="Commitment">
          <FormSelect
            name="commitment"
            defaultValue="FULL_TIME"
            options={[
              { value: 'FULL_TIME', label: 'Full-time' },
              { value: 'PART_TIME', label: 'Part-time' },
              { value: 'CONTRACT', label: 'Contract' },
              { value: 'INTERNSHIP', label: 'Internship' },
            ]}
          />
        </Field>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <Field label="Salary min">
          <input {...noAutofill} name="salaryMin" type="number" min="0" placeholder="120000" className={inputClass} />
        </Field>
        <Field label="Salary max">
          <input {...noAutofill} name="salaryMax" type="number" min="0" placeholder="160000" className={inputClass} />
        </Field>
        <Field label="Currency">
          <input {...noAutofill} name="salaryCurrency" placeholder="USD" className={inputClass} />
        </Field>
      </div>

      <Field label="Description">
        <textarea {...noAutofill}
          name="description"
          rows={6}
          placeholder="What the role is, what you'll do, what you're looking for…"
          className={textareaClass}
        />
      </Field>

      {state?.error ? (
        <p className="rounded-field bg-critical/10 px-3 py-2 text-sm text-critical">{state.error}</p>
      ) : null}

      <div className="flex justify-end">
        <button type="submit" disabled={pending} className={btnPrimary}>
          <TextSwap>{pending ? 'Creating…' : 'Create draft'}</TextSwap>
        </button>
      </div>
    </form>
  );
}
