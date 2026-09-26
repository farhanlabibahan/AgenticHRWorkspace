import { after, NextResponse } from 'next/server';
import { chainCron, cronAuthorized } from '@/server/cron';
import { processResumeText } from '@/server/resume-text';
import { runSelfTest } from '@/server/text';

// A run stops starting files after RESUME_TEXT_BUDGET_MS; the file in hand can take a little longer.
export const maxDuration = 300;

/**
 * Reads the text out of resumes that have none (src/server/resume-text.ts).
 * Runs every 10 minutes with the other crons; while files are left, each run
 * chains the next one right away. Self-hosted, any cron + curl works:
 *   curl -H "Authorization: Bearer $CRON_SECRET" https://…/api/cron/resume-text
 *
 * `?selftest=1` extracts a built-in sample of every format without touching
 * the database: the check that a deployed bundle can read documents at all.
 * Vercel previews allow it without the secret (they sit behind Vercel
 * Authentication, and share production's database, which it never reads).
 */
export async function GET(request: Request) {
  const selftest = new URL(request.url).searchParams.get('selftest') === '1';
  if (!cronAuthorized(request) && !(selftest && process.env.VERCEL_ENV === 'preview')) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (selftest) {
    const result = await runSelfTest();
    return NextResponse.json(result, { status: result.ok ? 200 : 500 });
  }
  const run = await processResumeText();
  if (run.more) after(() => chainCron('/api/cron/resume-text'));
  return NextResponse.json(run);
}
