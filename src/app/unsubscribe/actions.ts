'use server';

import { redirect } from 'next/navigation';
import { readUnsubscribeToken } from '@/server/newsletter-email';
import { unsubscribeContact } from '@/server/newsletters';

export async function unsubscribeAction(token: string): Promise<void> {
  const contactId = readUnsubscribeToken(token);
  if (contactId) await unsubscribeContact(contactId, 'link');
  redirect(`/unsubscribe/${token}?done=1`);
}
