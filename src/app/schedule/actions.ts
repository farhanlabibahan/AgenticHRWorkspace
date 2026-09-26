'use server';

import { bookSchedulingSlot } from '@/server/scheduling';

export type BookSlotState = { error?: string; bookedAt?: string } | undefined;

// In-memory brute-force guard, same spirit as the API-key limiter. Public
// endpoint, so keyed by token: 20 booking attempts/hour is far beyond any
// legitimate candidate retry pattern.
const attempts = new Map<string, { count: number; resetAt: number }>();

export async function bookSlotAction(
  _prev: BookSlotState,
  formData: FormData,
): Promise<BookSlotState> {
  const token = String(formData.get('token') ?? '');
  const startAt = String(formData.get('startAt') ?? '');
  if (!token || !startAt) return { error: 'Pick a time first.' };

  const now = Date.now();
  const bucket = attempts.get(token);
  if (bucket && bucket.resetAt > now && bucket.count >= 20)
    return { error: 'Too many attempts — try again later.' };
  attempts.set(token, {
    count: bucket && bucket.resetAt > now ? bucket.count + 1 : 1,
    resetAt: bucket && bucket.resetAt > now ? bucket.resetAt : now + 60 * 60 * 1000,
  });

  try {
    const interview = await bookSchedulingSlot(token, startAt);
    return { bookedAt: interview.startAt.toISOString() };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Could not book that time.' };
  }
}
