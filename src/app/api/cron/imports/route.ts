import { after, NextResponse } from 'next/server';
import { chainCron, cronAuthorized } from '@/server/cron';
import { CRON_BUDGET_MS, processImports } from '@/server/imports/runner';

// An import slice runs for up to CRON_BUDGET_MS; leave headroom for the response.
export const maxDuration = 300;

/**
 * Advances running ATS imports when nobody has the job page open. The
 * schedule (every 10 minutes, with the other crons) is only a safety net:
 * while an import has work left, each run chains the next one right away,
 * so imports move continuously but the database is left alone when none
 * are running. Self-hosted, any cron + curl works:
 *   curl -H "Authorization: Bearer $CRON_SECRET" https://…/api/cron/imports
 */
export async function GET(request: Request) {
  if (!cronAuthorized(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { slices, more } = await processImports(CRON_BUDGET_MS);
  if (more) after(() => chainCron('/api/cron/imports'));
  return NextResponse.json({ slices, more });
}
