'use server';

import { redirect } from 'next/navigation';
import { clearCandidateCookie, CandidateAuthError, setCandidateCookie, signInCandidate, signUpCandidate } from '@/server/candidate-accounts';

export type CandidateFormState = { error?: string } | undefined;

/** Only same-site paths after sign-in, so the form can't become an open redirect. */
function safeNext(value: FormDataEntryValue | null): string {
  const s = String(value ?? '');
  return s.startsWith('/') && !s.startsWith('//') ? s : '/candidate';
}

export async function candidateSignUp(_prev: CandidateFormState, formData: FormData): Promise<CandidateFormState> {
  let accountId: string;
  try {
    const account = await signUpCandidate({
      name: String(formData.get('name') ?? ''),
      email: String(formData.get('email') ?? ''),
      password: String(formData.get('password') ?? ''),
    });
    accountId = account.id;
  } catch (err) {
    if (err instanceof CandidateAuthError) return { error: err.message };
    return { error: 'Something went wrong. Please try again.' };
  }
  await setCandidateCookie(accountId);
  redirect(safeNext(formData.get('next')));
}

export async function candidateSignIn(_prev: CandidateFormState, formData: FormData): Promise<CandidateFormState> {
  let accountId: string;
  try {
    const account = await signInCandidate({
      email: String(formData.get('email') ?? ''),
      password: String(formData.get('password') ?? ''),
    });
    accountId = account.id;
  } catch (err) {
    if (err instanceof CandidateAuthError) return { error: err.message };
    return { error: 'Something went wrong. Please try again.' };
  }
  await setCandidateCookie(accountId);
  redirect(safeNext(formData.get('next')));
}

export async function candidateSignOut(): Promise<void> {
  await clearCandidateCookie();
  redirect('/jobs');
}
