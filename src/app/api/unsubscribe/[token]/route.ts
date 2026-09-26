import { NextResponse } from 'next/server';
import { readUnsubscribeToken } from '@/server/newsletter-email';
import { unsubscribeContact } from '@/server/newsletters';

/**
 * RFC 8058 one-click unsubscribe: the List-Unsubscribe header of every
 * newsletter points here, and mail clients POST `List-Unsubscribe=One-Click`
 * without showing a page. A GET (someone opening the address) goes to the
 * page, which asks first, so link scanners never unsubscribe anyone.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const contactId = readUnsubscribeToken((await params).token);
  if (!contactId) return NextResponse.json({ error: 'invalid link' }, { status: 400 });
  await unsubscribeContact(contactId, 'one_click');
  return new NextResponse('Unsubscribed.', { status: 200, headers: { 'content-type': 'text/plain' } });
}

export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  return NextResponse.redirect(new URL(`/unsubscribe/${(await params).token}`, request.url), 303);
}
