'use client';

import { useActionState } from 'react';
import { candidateSignIn, candidateSignUp, type CandidateFormState } from '@/app/candidate/actions';
import { Field, btnPrimary, inputLgClass, noAutofill } from '@/components/form-controls';
import { TextSwap } from '@/components/ui/motion';

export function CandidateAuthForm({ mode, next }: { mode: 'signin' | 'signup'; next: string }) {
  const action = mode === 'signup' ? candidateSignUp : candidateSignIn;
  const [state, formAction, pending] = useActionState<CandidateFormState, FormData>(action, undefined);
  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="next" value={next} />
      {mode === 'signup' ? (
        <Field label="Full name">
          <input {...noAutofill} name="name" required autoComplete="name" className={inputLgClass} />
        </Field>
      ) : null}
      <Field label="Email">
        <input name="email" type="email" required autoComplete="email" className={inputLgClass} />
      </Field>
      <Field label="Password" hint={mode === 'signup' ? 'At least 8 characters.' : undefined}>
        <input
          name="password"
          type="password"
          required
          minLength={8}
          autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
          className={inputLgClass}
        />
      </Field>
      {state?.error ? (
        <p role="alert" className="rounded-field bg-critical/10 px-3 py-2 text-sm text-critical">
          {state.error}
        </p>
      ) : null}
      <button type="submit" disabled={pending} className={btnPrimary}>
        <TextSwap>
          {pending ? 'Please wait…' : mode === 'signup' ? 'Create my account' : 'Sign in'}
        </TextSwap>
      </button>
    </form>
  );
}
