import { NextResponse } from 'next/server';
import { getSessionContext } from '@/lib/session';
import { requestOrigin } from '@/server/request-origin';
import { completeNotetakerOAuth } from '@/server/notetakers/connections';

/**
 * Where a notetaker's sign-in sends the browser back (the OAuth redirect
 * URI). The state is checked against the sign-in this person started before
 * the code is exchanged; then back to Settings with the outcome.
 */
export async function GET(request: Request) {
  const { origin: forwarded } = await requestOrigin();
  const origin = forwarded ?? new URL(request.url).origin;
  const ctx = await getSessionContext();
  if (!ctx?.userId) {
    return NextResponse.redirect(new URL('/login', origin));
  }
  const params = new URL(request.url).searchParams;
  const outcome = await completeNotetakerOAuth({ userId: ctx.userId, orgId: ctx.orgId }, params, origin);
  const back = new URL('/settings', origin);
  back.searchParams.set('section', 'integrations');
  back.searchParams.set('notetaker', outcome.result);
  if (outcome.provider) back.searchParams.set('provider', outcome.provider);
  return NextResponse.redirect(back, { headers: { 'Cache-Control': 'no-store' } });
}
