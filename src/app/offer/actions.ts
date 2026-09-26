'use server';

import { declineOfferByToken, signOfferByToken } from '@/server/offers';

export type OfferSignState = { error?: string; signed?: boolean; declined?: boolean } | undefined;

// Brute-force guard keyed by token: signing is a one-shot action, so a
// handful of attempts per hour is generous for a legitimate candidate.
const attempts = new Map<string, { count: number; resetAt: number }>();

function limited(token: string): boolean {
  const now = Date.now();
  const bucket = attempts.get(token);
  if (bucket && bucket.resetAt > now && bucket.count >= 15) return true;
  attempts.set(token, {
    count: bucket && bucket.resetAt > now ? bucket.count + 1 : 1,
    resetAt: bucket && bucket.resetAt > now ? bucket.resetAt : now + 60 * 60 * 1000,
  });
  return false;
}

export async function signOfferAction(
  _prev: OfferSignState,
  formData: FormData,
): Promise<OfferSignState> {
  const token = String(formData.get('token') ?? '');
  const name = String(formData.get('signedName') ?? '');
  const consent = formData.get('consent') === 'on';
  if (!token) return { error: 'Missing offer token.' };
  if (!consent) return { error: 'Check the box to sign electronically.' };
  if (limited(token)) return { error: 'Too many attempts — try again later.' };
  try {
    await signOfferByToken(token, name);
    return { signed: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Could not sign the offer.' };
  }
}

export async function declineOfferAction(
  _prev: OfferSignState,
  formData: FormData,
): Promise<OfferSignState> {
  const token = String(formData.get('token') ?? '');
  if (!token) return { error: 'Missing offer token.' };
  if (limited(token)) return { error: 'Too many attempts — try again later.' };
  try {
    await declineOfferByToken(token);
    return { declined: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Could not record your response.' };
  }
}
