import { NextResponse } from 'next/server';
import { processRetention } from '@/server/retention';

/**
 * Policy-driven anonymization of long-archived candidates. Daily is plenty.
 * Same auth contract as the other cron routes: CRON_SECRET bearer, open in
 * local dev when unset.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get('authorization');
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  }
  const anonymized = await processRetention();
  return NextResponse.json({ anonymized });
}
