import { db } from '@/lib/db';
import { PoweredBySource } from '@/components/powered-by';
import { buttonClass } from '@/components/ui/button';
import { readUnsubscribeToken } from '@/server/newsletter-email';
import { unsubscribeAction } from '../actions';

export const metadata = { title: 'Unsubscribe', robots: { index: false, follow: false } };

/**
 * Where a newsletter's unsubscribe link lands. It asks before it acts: link
 * scanners in mail systems open every link, and a page that unsubscribed on
 * sight would sign people out of emails they wanted.
 */
export default async function UnsubscribePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ done?: string }>;
}) {
  const { token } = await params;
  const { done } = await searchParams;
  const contactId = token === 'preview' ? null : readUnsubscribeToken(token);
  const contact = contactId
    ? await db.contact.findUnique({ where: { id: contactId }, select: { emailOptOutAt: true, org: { select: { name: true } } } })
    : null;

  let title: string;
  let body: string;
  let ask = false;
  if (token === 'preview') {
    title = 'This was a test copy';
    body = 'In the real newsletter, this link lets each reader unsubscribe.';
  } else if (!contact) {
    title = 'This link doesn’t work';
    body = 'It may have been copied incompletely. Try the link in the email again.';
  } else if (done || contact.emailOptOutAt) {
    title = 'You’re unsubscribed';
    body = `${contact.org.name} won’t send you job newsletters any more. You’ll still hear from them about roles you’ve applied for.`;
  } else {
    title = `Unsubscribe from ${contact.org.name}?`;
    body = 'You’ll stop getting their newsletters about open roles. Emails about roles you’ve applied for still come through.';
    ask = true;
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-canvas px-6 py-16">
      <div className="w-full max-w-md rounded-card bg-surface p-8">
        <h1 className="text-xl text-ink">{title}</h1>
        <p className="mt-3 text-sm text-ink-2">{body}</p>
        {ask ? (
          <form action={unsubscribeAction.bind(null, token)} className="mt-6">
            <button type="submit" className={buttonClass({ variant: 'primary' })}>
              Unsubscribe
            </button>
          </form>
        ) : null}
      </div>
      <div className="mt-8">
        <PoweredBySource />
      </div>
    </div>
  );
}
