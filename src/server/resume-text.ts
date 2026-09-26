import type { Prisma, TextStatus } from '@prisma/client';
import { db } from '@/lib/db';
import { takeCronLease } from '@/server/cron';
import { fileStorageAvailable, readStoredFile, StoredFileMissingError } from '@/server/storage';
import { EXTRACTOR_VERSION, extractText, MAX_EXTRACT_BYTES, runSelfTest } from '@/server/text';
import { MAX_TEXT_ATTEMPTS } from '@/server/text/status';

/**
 * Fills Contact.resumeText for resumes that have none: every PDF uploaded
 * while extraction was broken, formats older imports skipped, and anything
 * whose extraction failed or timed out. Driven by /api/cron/resume-text.
 *
 * The work queue is derived from state rather than a flag each writer must
 * remember: a contact's resume file, the contact still without text and not
 * anonymized, and the file not yet checked by this extractor version (or
 * FAILED, retried after RETRY_AFTER_MS up to MAX_TEXT_ATTEMPTS times).
 * Bumping EXTRACTOR_VERSION retries every resume that still has no text.
 *
 * Each file is claimed with a conditional UPDATE that stamps textCheckedAt,
 * so concurrent runs take different files, and the result is written only if
 * that stamp is still there. The contact gets the text only if the file is
 * still its resume, it still has no text, and it hasn't been anonymized.
 *
 * Only resumeText is written, never emails, phones or links: those changing
 * weeks later with no actor would be a surprise, and emails drive apply-time
 * dedupe, so an address found in a resume could route a stranger's
 * application onto this contact.
 *
 * One run at a time (a CronLease row): each scheduled tick during a backlog
 * would otherwise start another self-chaining run, and overlapping runs would
 * queue behind each other in the same extraction worker.
 */

export const RESUME_TEXT_BUDGET_MS = 240_000;
const RETRY_AFTER_MS = 15 * 60_000;
const FILE_TIMEOUT_MS = 20_000;
const BATCH = 50;

export type ResumeTextRun = {
  selfTest: 'ok' | 'failed' | 'skipped';
  claimed: number;
  byStatus: Partial<Record<TextStatus, number>>;
  /** Contacts that got text. */
  written: number;
  /** Files another run claimed first, or re-claimed before this one finished. */
  lost: number;
  /** The budget ran out with files left: run again now. */
  more: boolean;
  /** Another run holds the lease, so this one did nothing. */
  busy?: true;
  ms: number;
  error?: string;
};

type Outcome = { status: TextStatus; text: string | null; error?: string };

/**
 * Logged and stored: the error's code when it has one, else the last line of
 * its message (Prisma puts the cause there, after a code frame). An fs
 * error's message holds the file's path, and a stored file's key holds its
 * upload name, usually the candidate's.
 */
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return 'Unknown error';
  const code = (err as NodeJS.ErrnoException).code;
  return `${err.name}: ${code ?? err.message.trim().split('\n').pop()}`.slice(0, 300);
}

/**
 * Files worth a (re)try as of `at`: never checked by this extractor version
 * (a fresh try), or FAILED / cut off mid-run and due for another attempt.
 */
function retryable(version: number, at: Date) {
  const retryBefore = new Date(at.getTime() - RETRY_AFTER_MS);
  const fresh: Prisma.StoredFileWhereInput = { OR: [{ textVersion: null }, { textVersion: { lt: version } }] };
  const retry: Prisma.StoredFileWhereInput = {
    textVersion: version,
    OR: [{ textStatus: null }, { textStatus: 'FAILED' }],
    textAttempts: { lt: MAX_TEXT_ATTEMPTS },
    textCheckedAt: { lt: retryBefore },
  };
  return { fresh, retry };
}

/** Some live contact's resume, and that contact has no text yet. Never a logo or an attachment. */
const pendingResume: Prisma.StoredFileWhereInput = {
  contacts: { some: { resumeText: null, isAnonymized: false } },
};

export async function processResumeText(
  opts: {
    budgetMs?: number;
    orgId?: string;
    version?: number;
    now?: () => Date;
    extract?: typeof extractText;
    selfTest?: typeof runSelfTest;
  } = {},
): Promise<ResumeTextRun> {
  const started = Date.now();
  const deadline = started + (opts.budgetMs ?? RESUME_TEXT_BUDGET_MS);
  const version = opts.version ?? EXTRACTOR_VERSION;
  const now = opts.now ?? (() => new Date());
  const extract = opts.extract ?? extractText;
  const run: ResumeTextRun = { selfTest: 'skipped', claimed: 0, byStatus: {}, written: 0, lost: 0, more: false, ms: 0 };
  const finish = () => ({ ...run, ms: Date.now() - started });

  if (!fileStorageAvailable()) return finish();

  const scope: Prisma.StoredFileWhereInput = { ...pendingResume, ...(opts.orgId ? { orgId: opts.orgId } : {}) };

  /** Stamp the file as ours. Two statements because a retry counts its attempts and a fresh try starts at 1. */
  async function claim(id: string, claimedAt: Date): Promise<boolean> {
    const { fresh, retry } = retryable(version, claimedAt);
    const reset = { textStatus: null, textError: null, textCheckedAt: claimedAt };
    const first = await db.storedFile.updateMany({
      where: { id, ...pendingResume, ...fresh },
      data: { ...reset, textVersion: version, textAttempts: 1 },
    });
    if (first.count) return true;
    const again = await db.storedFile.updateMany({
      where: { id, ...pendingResume, ...retry },
      data: { ...reset, textAttempts: { increment: 1 } },
    });
    return again.count > 0;
  }

  async function read(id: string, file: { key: string; size: number }): Promise<Outcome> {
    if (file.size > MAX_EXTRACT_BYTES) return { status: 'TOO_LARGE', text: null };
    let data: Buffer;
    try {
      data = await readStoredFile(file.key);
    } catch (err) {
      if (err instanceof StoredFileMissingError) return { status: 'MISSING', text: null };
      const error = describeError(err);
      console.error('[resume-text] read failed', JSON.stringify({ fileId: id, error }));
      return { status: 'FAILED', text: null, error };
    }
    const r = await extract({ data, source: 'backfill', timeoutMs: FILE_TIMEOUT_MS, fileId: id });
    return { status: r.status, text: r.text, error: r.error };
  }

  async function processFile(file: { id: string; orgId: string; key: string; size: number }) {
    const { id } = file;
    const claimedAt = now();
    if (!(await claim(id, claimedAt))) {
      run.lost++;
      return;
    }
    run.claimed++;
    const outcome = await read(id, file);
    run.byStatus[outcome.status] = (run.byStatus[outcome.status] ?? 0) + 1;
    await db.$transaction(async (tx) => {
      // Fenced on our stamp: a run that re-claimed the file after a timeout owns it now.
      const done = await tx.storedFile.updateMany({
        where: { id, textCheckedAt: claimedAt },
        data: { textStatus: outcome.status, textError: outcome.error ?? null },
      });
      if (!done.count) {
        run.lost++;
        return;
      }
      if (!outcome.text) return;
      const wrote = await tx.contact.updateMany({
        where: { orgId: file.orgId, resumeFileId: id, resumeText: null, isAnonymized: false },
        data: { resumeText: outcome.text },
      });
      run.written += wrote.count;
    });
  }

  // Held past the budget by the file in hand, plus slack.
  const release = await takeCronLease(opts.orgId ? `resume-text:${opts.orgId}` : 'resume-text', new Date(deadline + FILE_TIMEOUT_MS + 60_000));
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

      // Once, before claiming anything: a broken environment (a missing
      // library in the deployed bundle) must not burn every file's attempts.
      if (!selfTested) {
        selfTested = true;
        const test = await (opts.selfTest ?? runSelfTest)();
        if (!test.ok) {
          run.selfTest = 'failed';
          run.error = `Self-test failed: ${test.results
            .filter((r) => !r.match)
            .map((r) => `${r.format} ${r.status}`)
            .join(', ')}`;
          console.error('[resume-text] run', JSON.stringify({ ...finish(), worker: test.worker, results: test.results }));
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
          // A write that failed will likely fail for the next file too, and
          // this one would come straight back in the next batch: stop, and
          // let the schedule try again. The claim stays stamped, so the file
          // is retried after RETRY_AFTER_MS.
          run.error = describeError(err);
          console.error('[resume-text] file failed', JSON.stringify({ fileId: file.id, error: run.error }));
          break batches;
        }
      }
    }

    if (run.selfTest !== 'skipped') console.log('[resume-text] run', JSON.stringify(finish()));
    return finish();
  } finally {
    await release();
  }
}
