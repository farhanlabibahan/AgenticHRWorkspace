'use server';

import { after } from 'next/server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { isAdmin, requireSession } from '@/lib/session';
import { requestBaseUrl } from '@/lib/base-url';
import { chainCron } from '@/server/cron';
import {
  deleteNewsletter,
  NewsletterError,
  previewNewsletter,
  processNewsletters,
  saveNewsletter,
  sendTestNewsletter,
  startNewsletter,
  type NewsletterInput,
} from '@/server/newsletters';

type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

/** A NewsletterError's message is for people; anything else is logged and said plainly. */
async function attempt<T>(run: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, ...(await run()) } as Result<T>;
  } catch (error) {
    if (error instanceof NewsletterError) return { ok: false, error: error.message };
    console.error('[newsletters]', error);
    return { ok: false, error: 'That didn’t work. Try again in a moment.' };
  }
}

export async function saveNewsletterAction(id: string | null, input: NewsletterInput) {
  return attempt(async () => {
    const ctx = await requireSession();
    const saved = await saveNewsletter(ctx, id, input);
    revalidatePath('/newsletters');
    return { id: saved.id };
  });
}

export async function previewNewsletterAction(input: NewsletterInput) {
  return attempt(async () => {
    const ctx = await requireSession();
    return { html: await previewNewsletter(ctx, input, await requestBaseUrl()) };
  });
}

export async function sendTestNewsletterAction(id: string) {
  return attempt(async () => {
    const ctx = await requireSession();
    return { sentTo: await sendTestNewsletter(ctx, id, await requestBaseUrl()) };
  });
}

/** Admins only: one email to every candidate. The first copies go right away; the cron sends the rest. */
export async function startNewsletterAction(id: string) {
  return attempt(async () => {
    const ctx = await requireSession();
    if (!isAdmin(ctx)) throw new NewsletterError('Only admins can send to every candidate.');
    const recipients = await startNewsletter(ctx, id, await requestBaseUrl());
    after(async () => {
      const { more } = await processNewsletters(45_000);
      if (more) await chainCron('/api/cron/newsletters');
    });
    revalidatePath('/newsletters');
    return { recipients };
  });
}

export async function deleteNewsletterAction(id: string) {
  const ctx = await requireSession();
  await deleteNewsletter(ctx, id);
  revalidatePath('/newsletters');
  redirect('/newsletters');
}
