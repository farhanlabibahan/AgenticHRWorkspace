import { after, NextResponse } from 'next/server';
import { chainCron, cronAuthorized } from '@/server/cron';
import { processNewsletters } from '@/server/newsletters';

// A run sends for up to four minutes; leave headroom for the response.
export const maxDuration = 300;

/**
 * Sends newsletters that are going out (src/server/newsletters.ts). Starting
 * a send chains the first run; while copies are left, each run chains the
 * next, so a big list goes out continuously. The schedule is only a safety
 * net. Self-hosted, any cron + curl works:
 *   curl -H "Authorization: Bearer $CRON_SECRET" https://…/api/cron/newsletters
 */
export async function GET(request: Request) {
  if (!cronAuthorized(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { sent, more } = await processNewsletters(240_000);
  if (more) after(() => chainCron('/api/cron/newsletters'));
  return NextResponse.json({ sent, more });
}
