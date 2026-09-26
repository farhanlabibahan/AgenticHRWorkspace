import { after, NextResponse } from 'next/server';
import { chainCron, cronAuthorized } from '@/server/cron';
import { runOcrSelfTest } from '@/server/ocr';
import { processResumeOcr } from '@/server/resume-ocr';

// A run starts no file after OCR_BUDGET_MS (230 s); the file in hand has OCR_FILE_TIMEOUT_MS (60 s) more.
export const maxDuration = 300;

/**
 * Reads scanned resumes with OCR (src/server/resume-ocr.ts). Its own route,
 * apart from /api/cron/resume-text, so Tesseract and pdfjs-dist (about 42 MB
 * traced in next.config.ts) ship in this function only, and a slow OCR run
 * never holds up text extraction. Runs every 10 minutes with the other
 * crons; while scans are left, each run chains the next one right away.
 * Self-hosted, any cron + curl works:
 *   curl -H "Authorization: Bearer $CRON_SECRET" https://…/api/cron/ocr
 *
 * `?selftest=1` OCRs a built-in scanned resume without touching the
 * database: the check that a deployed bundle can run OCR at all. Vercel
 * previews allow it without the secret (they sit behind Vercel
 * Authentication, and share production's database, which it never reads).
 */
export async function GET(request: Request) {
  const selftest = new URL(request.url).searchParams.get('selftest') === '1';
  if (!cronAuthorized(request) && !(selftest && process.env.VERCEL_ENV === 'preview')) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (selftest) {
    const result = await runOcrSelfTest();
    return NextResponse.json(result, { status: result.ok ? 200 : 500 });
  }
  const run = await processResumeOcr();
  if (run.more) after(() => chainCron('/api/cron/ocr'));
  return NextResponse.json(run);
}
