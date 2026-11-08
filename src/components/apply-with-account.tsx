'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { applyWithAccount, type ApplyState } from '@/app/jobs/actions';
import { Field, btnPrimary, textareaClass, noAutofill } from '@/components/form-controls';
import { TextSwap } from '@/components/ui/motion';

export function ApplyWithAccount({
  orgSlug,
  postingSlug,
  signedIn,
  name,
  email,
}: {
  orgSlug: string;
  postingSlug: string;
  signedIn: boolean;
  name?: string;
  email?: string;
}) {
  const [state, action, pending] = useActionState<ApplyState, FormData>(applyWithAccount, undefined);

  if (!signedIn) {
    return (
      <div className="flex flex-col gap-3">
        <h2 className="text-md font-medium">Apply for this role</h2>
        <p className="text-sm text-ink-2">Create one account to apply here and to any other company on Orqestra.</p>
        <div className="flex flex-wrap gap-2">
          <Link
            href={`/candidate/signup?next=/jobs/${orgSlug}/${postingSlug}`}
            className="inline-flex items-center rounded-full bg-brand px-5 py-2.5 text-sm font-medium text-on-brand"
          >
            Create account to apply
          </Link>
          <Link
            href={`/candidate/signin?next=/jobs/${orgSlug}/${postingSlug}`}
            className="inline-flex items-center rounded-full bg-muted px-5 py-2.5 text-sm font-medium text-ink"
          >
            I have an account
          </Link>
        </div>
      </div>
    );
  }

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="postingSlug" value={postingSlug} />
      <h2 className="text-md font-medium">Apply as {name}</h2>
      <p className="text-sm text-ink-2">Applying as {email}. Your profile and applications are kept in your account.</p>
      <Field label="Why you (optional)">
        <textarea {...noAutofill} name="coverNote" rows={4} className={textareaClass} />
      </Field>
      {state?.error ? <p role="alert" className="rounded-field bg-critical/10 px-3 py-2 text-sm text-critical">{state.error}</p> : null}
      <div className="flex justify-end">
        <button type="submit" disabled={pending} className={btnPrimary}>
          <TextSwap>{pending ? 'Sending…' : 'Submit application'}</TextSwap>
        </button>
      </div>
    </form>
  );
}
