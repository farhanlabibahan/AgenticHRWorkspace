import { after, NextResponse } from 'next/server';
import { cronAuthorized } from '@/server/cron';
import { continueResumeParse, processResumeParse, runResumeParseSelfTest } from '@/server/resume-parse';

// A run starts no file it can't finish before RESUME_PARSE_BUDGET_MS, and cuts off any call still going then.
export const maxDuration = 300;

/**
 * Parses queued resumes (src/server/resume-parse): new applications the
 * after-apply kick didn't finish, and anything waiting on its text or on a
 * provider. Every 10 minutes with the other crons; while files are left, each
 * run chains the next. Self-hosted, any cron + curl works:
 *   curl -H "Authorization: Bearer $CRON_SECRET" https://…/api/cron/resume-parse
 * Off (no key set) it answers {state: "off"} and does nothing.
 *
 * `?selftest=1` parses a made-up resume through the configured provider and
 * returns what came back, touching no candidate data: the check to run right
 * after adding a key. It spends on the key, so it needs CRON_SECRET even
 * where the cron itself is left open (docker-compose's default).
 */
export async function GET(request: Request) {
  if (!cronAuthorized(request)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (new URL(request.url).searchParams.get('selftest') === '1') {
    if (!process.env.CRON_SECRET) return NextResponse.json({ error: 'selftest_needs_cron_secret' }, { status: 403 });
    const result = await runResumeParseSelfTest();
    const status = result.busy ? 429 : result.ok || result.state !== 'on' ? 200 : 502;
    return NextResponse.json(result, { status });
  }
  const run = await processResumeParse();
  if (run.more) after(() => continueResumeParse().catch(() => undefined));
  return NextResponse.json(run);
}
