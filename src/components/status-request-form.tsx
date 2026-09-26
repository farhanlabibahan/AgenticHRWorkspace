'use client';

import { useActionState } from 'react';
import { requestPortalLinkAction, type ApplyFormState } from '@/app/careers/actions';
import { Field, inputLgClass } from '@/components/form-controls';
import { buttonClass } from '@/components/ui/button';
import { TextSwap } from '@/components/ui/motion';

export function StatusRequestForm({ orgSlug }: { orgSlug: string }) {
  const [state, formAction, pending] = useActionState<ApplyFormState, FormData>(
    requestPortalLinkAction,
    undefined,
  );

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <Field label="Email">
        <input name="email" type="email" required autoComplete="email" className={inputLgClass} />
      </Field>
      {state?.error ? <p className="text-sm text-critical">{state.error}</p> : null}
      <button type="submit" disabled={pending} className={buttonClass({ variant: 'primary', size: 'lg', className: 'mt-2 w-full' })}>
        <TextSwap>{pending ? 'Sending…' : 'Email me a status link'}</TextSwap>
      </button>
    </form>
  );
}
