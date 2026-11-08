'use server';

import { redirect } from 'next/navigation';
import { currentCandidate } from '@/server/candidate-accounts';
import { submitApplication } from '@/server/applications';
import { db } from '@/lib/db';

export type ApplyState = { error?: string } | undefined;

/**
 * Apply with a candidate account. Identity comes from the signed cookie, never
 * from the form, so a candidate can only apply as themselves. The company
 * receives the same application record as from its careers page.
 */
export async function applyWithAccount(_prev: ApplyState, formData: FormData): Promise<ApplyState> {
  const me = await currentCandidate();
  if (!me) redirect(`/candidate/signin?next=/jobs/${String(formData.get('orgSlug') ?? '')}/${String(formData.get('postingSlug') ?? '')}`);

  const orgSlug = String(formData.get('orgSlug') ?? '');
  const postingSlug = String(formData.get('postingSlug') ?? '');
  const coverNote = String(formData.get('coverNote') ?? '').trim() || undefined;
  // One active application per role per candidate (re-applying after an archive is allowed).
  const posting = await db.posting.findFirst({
    where: { state: 'PUBLISHED', slug: postingSlug, org: { slug: orgSlug } },
    select: { id: true },
  });
  if (!posting) return { error: 'This role is no longer open.' };
  const dup = await db.opportunity.findFirst({
    where: { postingId: posting.id, status: 'ACTIVE', contact: { candidateAccountId: me.id } },
    select: { id: true },
  });
  if (dup) return { error: 'You have already applied to this role.' };
  try {
    await submitApplication({ orgSlug, postingSlug, name: me.name, email: me.email, coverNote });
  } catch (err) {
    return { error: 'We could not send your application. Please try again.' };
  }
  redirect('/candidate?applied=1');
}
