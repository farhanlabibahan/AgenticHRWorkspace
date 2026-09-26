import type { OcrStatus, Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { takeCronLease } from '@/server/cron';
import { createOcrEngine, ocrDocument, runOcrSelfTest, type OcrEngine, type OcrResult } from '@/server/ocr';
import { MAX_OCR_ATTEMPTS, OCR_TEXT_STATUSES, OCR_VERSION } from '@/server/ocr/status';
import { fileStorageAvailable, readStoredFile, StoredFileMissingError } from '@/server/storage';
import { EXTRACTOR_VERSION } from '@/server/text/status';

/**
 * Reads scanned resumes with OCR: a PDF whose pages are pictures of paper (a
 * scanner, a fax, a phone), which text extraction leaves EMPTY, and image
 * files, which imports bring. Driven by /api/cron/ocr, never by an
 * application: OCR takes seconds a page, and applying must stay fast.
 *
 * The work queue is derived from state, like the resume-text backfill's: a
 * contact's resume, the contact still without text and not anonymized, text
 * extraction settled for this extractor version with EMPTY or UNSUPPORTED,
 * and the file not yet tried by this OCR version (or FAILED, retried after
 * RETRY_AFTER_MS up to MAX_OCR_ATTEMPTS times). LOW_CONFIDENCE and SKIPPED
 * are final until OCR_VERSION changes.
 *
 * Each file is claimed with a conditional UPDATE that stamps ocrCheckedAt,
 * so concurrent runs take different files, and the result is written only if
 * that stamp is still there. The contact gets the text only if the file is
 * still its resume, it still has no text, and it hasn't been anonymized;
 * otherwise the file is SKIPPED ("has_text"), so OK always means the
 * contact's text came from this OCR. Only resumeText is written, as with the
 * backfill.
 *
 * A careers-page application whose resume is a scan is queued for parsing
 * (resume-parse parseQueueFields) and waits there for this text. If the parse
 * queue gave up on it first (SKIPPED "no_text"), the text arriving queues it
 * again. Imports never queue parsing, here or anywhere.
 *
 * One run at a time (a CronLease row). The Tesseract worker is started once
 * per run and stopped at the end.
 */

/** Stop starting files after this; with the file in hand it stays under the route's 300 s. */
export const OCR_BUDGET_MS = 230_000;
export const OCR_FILE_TIMEOUT_MS = 60_000;
const RETRY_AFTER_MS = 15 * 60_000;
const BATCH = 10;
/**
 * Text extraction's MAX_EXTRACT_BYTES, repeated rather than imported: importing
 * src/server/text would ship unpdf and the extraction worker in this function.
 */
const MAX_OCR_BYTES = 10 * 1024 * 1024;

export type ResumeOcrRun = {
  selfTest: 'ok' | 'failed' | 'skipped';
  claimed: number;
  byStatus: Partial<Record<OcrStatus, number>>;
  /** Contacts that got text. */
  written: number;
  /** Pages (or images) read. */
  pages: number;
  /** Files another run claimed first, or re-claimed before this one finished. */
  lost: number;
  /** The budget ran out with files left: run again now. */
  more: boolean;
  /** Another run holds the lease, so this one did nothing. */
  busy?: true;
  ms: number;
  error?: string;
};

/** Logged and stored: the error's code or the last line of its message, never a path or a key. */
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return 'Unknown error';
  const code = (err as NodeJS.ErrnoException).code;
  return `${err.name}: ${code ?? err.message.trim().split('\n').pop()}`.slice(0, 300);
}

/** Some live contact's resume, and that contact has no text yet. */
const pendingResume: Prisma.StoredFileWhereInput = { contacts: { some: { resumeText: null, isAnonymized: false } } };

/** Text extraction is done with this file and found nothing OCR can't try. */
const scannedLooking = (textVersion: number): Prisma.StoredFileWhereInput => ({
  textVersion,
  textStatus: { in: [...OCR_TEXT_STATUSES] },
});

/** Files worth a (re)try as of `at`: never tried by this OCR version, or FAILED / cut off mid-run and due again. */
function retryable(version: number, at: Date) {
  const fresh: Prisma.StoredFileWhereInput = { OR: [{ ocrVersion: null }, { ocrVersion: { lt: version } }] };
  const retry: Prisma.StoredFileWhereInput = {
    ocrVersion: version,
    OR: [{ ocrStatus: null }, { ocrStatus: 'FAILED' }],
    ocrAttempts: { lt: MAX_OCR_ATTEMPTS },
    ocrCheckedAt: { lt: new Date(at.getTime() - RETRY_AFTER_MS) },
  };
  return { fresh, retry };
}

type Outcome = Pick<OcrResult, 'status' | 'text' | 'confidence' | 'pages' | 'error'>;

export async function processResumeOcr(
  opts: {
    budgetMs?: number;
    fileTimeoutMs?: number;
    orgId?: string;
    version?: number;
    textVersion?: number;
    now?: () => Date;
    /** Tests: stand-ins for the engine and the pipeline. */
    engine?: OcrEngine;
    ocr?: (data: Uint8Array, ctx: { engine: OcrEngine; fileId: string; timeoutMs: number }) => Promise<Omit<OcrResult, 'ms'>>;
    selfTest?: (engine: OcrEngine) => Promise<{ ok: boolean; missing?: string[]; error?: string; status?: string }>;
  } = {},
): Promise<ResumeOcrRun> {
  const started = Date.now();
  const deadline = started + (opts.budgetMs ?? OCR_BUDGET_MS);
  const fileTimeoutMs = opts.fileTimeoutMs ?? OCR_FILE_TIMEOUT_MS;
  const version = opts.version ?? OCR_VERSION;
  const textVersion = opts.textVersion ?? EXTRACTOR_VERSION;
  const now = opts.now ?? (() => new Date());
  const run: ResumeOcrRun = { selfTest: 'skipped', claimed: 0, byStatus: {}, written: 0, pages: 0, lost: 0, more: false, ms: 0 };
  const finish = () => ({ ...run, ms: Date.now() - started });

  if (!fileStorageAvailable()) return finish();

  const base: Prisma.StoredFileWhereInput = { ...pendingResume, ...scannedLooking(textVersion) };
  const scope: Prisma.StoredFileWhereInput = { ...base, ...(opts.orgId ? { orgId: opts.orgId } : {}) };

  /** Stamp the file as ours. Two statements because a retry counts its attempts and a fresh try starts at 1. */
  async function claim(id: string, claimedAt: Date): Promise<boolean> {
    const { fresh, retry } = retryable(version, claimedAt);
    const reset = { ocrStatus: null, ocrError: null, ocrConfidence: null, ocrCheckedAt: claimedAt };
    const first = await db.storedFile.updateMany({ where: { id, ...base, ...fresh }, data: { ...reset, ocrVersion: version, ocrAttempts: 1 } });
    if (first.count) return true;
    const again = await db.storedFile.updateMany({ where: { id, ...base, ...retry }, data: { ...reset, ocrAttempts: { increment: 1 } } });
    return again.count > 0;
  }

  const engine = opts.engine ?? createOcrEngine();
  const ocr = opts.ocr ?? ((data, ctx) => ocrDocument(data, { engine: ctx.engine, fileId: ctx.fileId, timeoutMs: ctx.timeoutMs, source: 'backfill' }));

  async function read(file: { id: string; key: string; size: number }): Promise<Outcome> {
    const none = { text: null, confidence: null, pages: 0 };
    if (file.size > MAX_OCR_BYTES) return { status: 'SKIPPED', ...none, error: 'too_large' };
    let data: Buffer;
    try {
      data = await readStoredFile(file.key);
    } catch (err) {
      if (err instanceof StoredFileMissingError) return { status: 'SKIPPED', ...none, error: 'missing' };
      const error = describeError(err);
      console.error('[resume-ocr] read failed', JSON.stringify({ fileId: file.id, error }));
      return { status: 'FAILED', ...none, error };
    }
    return ocr(data, { engine, fileId: file.id, timeoutMs: fileTimeoutMs });
  }

  async function processFile(file: { id: string; orgId: string; key: string; size: number }) {
    const { id } = file;
    const claimedAt = now();
    if (!(await claim(id, claimedAt))) {
      run.lost++;
      return;
    }
    run.claimed++;
    const outcome = await read(file);
    run.pages += outcome.pages;
    const status = await db.$transaction(async (tx): Promise<OcrStatus | 'LOST'> => {
      // Fenced on our stamp: a run that re-claimed the file after a timeout owns it now.
      const done = await tx.storedFile.updateMany({
        where: { id, ocrCheckedAt: claimedAt },
        data: { ocrStatus: outcome.status, ocrError: outcome.error ?? null, ocrConfidence: outcome.confidence },
      });
      if (!done.count) return 'LOST';
      if (!outcome.text) return outcome.status;
      const wrote = await tx.contact.updateMany({
        where: { orgId: file.orgId, resumeFileId: id, resumeText: null, isAnonymized: false },
        data: { resumeText: outcome.text },
      });
      if (!wrote.count) {
        // Someone else's text got there first, or the file stopped being a resume: OK would claim that text as ours.
        await tx.storedFile.update({ where: { id }, data: { ocrStatus: 'SKIPPED', ocrError: 'has_text' } });
        return 'SKIPPED';
      }
      run.written += wrote.count;
      // A careers-page application's parse gave up waiting for text: now there is some.
      await tx.storedFile.updateMany({
        where: { id, parseStatus: 'SKIPPED', parseError: 'no_text' },
        data: { parseStatus: 'QUEUED', parseQueuedAt: now(), parseCheckedAt: null, parseAttempts: 0, parseError: null },
      });
      return outcome.status;
    });
    if (status === 'LOST') {
      run.lost++;
      return;
    }
    run.byStatus[status] = (run.byStatus[status] ?? 0) + 1;
    console.log(
      '[resume-ocr] file',
      JSON.stringify({ fileId: id, orgId: file.orgId, status, error: outcome.error, confidence: outcome.confidence, pages: outcome.pages }),
    );
  }

  // Held past the budget by the file in hand, plus slack.
  const release = await takeCronLease(opts.orgId ? `resume-ocr:${opts.orgId}` : 'resume-ocr', new Date(deadline + fileTimeoutMs + 60_000));
  if (!release) return { ...finish(), busy: true };
  try {
    let selfTested = false;
    batches: while (true) {
      const { fresh, retry } = retryable(version, now());
      const batch = await db.storedFile.findMany({
        where: { ...scope, OR: [fresh, retry] },
        orderBy: { createdAt: 'desc' },
        take: BATCH,
        select: { id: true, orgId: true, key: true, size: true },
      });
      if (!batch.length) break;

      // Once, before claiming anything: a deploy missing a traced file must not burn every scan's attempts.
      if (!selfTested) {
        selfTested = true;
        const test = await (opts.selfTest ?? runOcrSelfTest)(engine).catch((err) => ({ ok: false, error: describeError(err), status: 'FAILED', missing: [] }));
        if (!test.ok) {
          run.selfTest = 'failed';
          run.error = `Self-test failed: ${test.error ?? test.status ?? 'unknown'}${test.missing?.length ? ` (missing ${test.missing.length})` : ''}`;
          console.error('[resume-ocr] run', JSON.stringify(finish()));
          return finish();
        }
        run.selfTest = 'ok';
      }

      for (const file of batch) {
        if (Date.now() >= deadline) {
          run.more = true;
          break batches;
        }
        try {
          await processFile(file);
        } catch (err) {
          // A write that failed will likely fail for the next file too: stop, and
          // let the schedule try again. The claim stays stamped, so the file is
          // retried after RETRY_AFTER_MS.
          run.error = describeError(err);
          console.error('[resume-ocr] file failed', JSON.stringify({ fileId: file.id, error: run.error }));
          break batches;
        }
      }
    }

    if (run.selfTest !== 'skipped') console.log('[resume-ocr] run', JSON.stringify(finish()));
    return finish();
  } finally {
    await release();
    if (!opts.engine) await engine.close();
  }
}
