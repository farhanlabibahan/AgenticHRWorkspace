import type { ParseStatus, Prisma, TextStatus } from '@prisma/client';
import { db } from '@/lib/db';
import { chainCron, selfOrigin, takeCronLease } from '@/server/cron';
import { OCR_TEXT_STATUSES, ocrSettled } from '@/server/ocr/status';
import { EXTRACTOR_VERSION, MAX_TEXT_ATTEMPTS } from '@/server/text/status';
import { completeResumeJson, emptyUsage, ResumeParseError, type ResumeParseErrorCode, type Usage } from './client';
import { orgExcluded, resumeParserConfig, resumeParsingOn, type ResumeParserConfig, type ResumeParserState } from './config';
import { fillContactFromResume, filledAnything, type FillResult } from './fill';
import { sanitizeResumeText } from './prompt';
import { validateParsedResume } from './validate';

/**
 * The resume-parse queue: new applicants' resumes are read by the configured
 * model, in the background, and fill in the contact's empty fields (fill.ts).
 *
 * What gets parsed. Only a careers-page application marks its resume QUEUED
 * (parseQueueFields, inside the apply transaction), and only when parsing is
 * on and the resume has text or may still get it (a scan waits for OCR,
 * src/server/resume-ocr.ts). ATS imports, the CLI
 * importers, CSV import and the resume-text backfill never set a status, so
 * they are never sent anywhere and never cost anything. queueResumeParse is
 * the hook for an admin to queue older resumes; nothing calls it yet.
 *
 * When. Right after the apply response (kickResumeParse, from after()), and
 * every 10 minutes from /api/cron/resume-parse for anything the kick missed:
 * a killed function, a provider outage, a resume whose text arrives later.
 * Both go through one lease, so there is one run at a time: a burst of
 * applications queues up behind it instead of making a burst of calls, and
 * the daily limits (counted before each claim) hold.
 *
 * Limits. RESUME_PARSER_DAILY_LIMIT per organization per UTC day, and
 * optionally RESUME_PARSER_GLOBAL_DAILY_LIMIT across all of them, both
 * counting attempts (a resume tried twice counts twice). A file over the
 * limit stays QUEUED for the next day; after 72 hours in the queue it is
 * SKIPPED (expired), so a spam burst costs at most a day's limit per day and
 * its backlog is gone after three. RESUME_PARSER_EXCLUDE_ORGS leaves chosen
 * organizations out altogether.
 *
 * Attempts. A file is claimed with a conditional update that stamps
 * parseCheckedAt, and every write after that is fenced on the stamp. Three
 * attempts per file, 15 minutes apart, for failures that are about the file
 * (bad JSON, truncated, too large). Failures that are about the provider or
 * the setup (bad key, unknown or retired model, no credit, rate limit) give
 * the attempt back, pause the queue for a while, and stop the run, so a
 * revoked key doesn't use up everyone's attempts. Some failures could be
 * either (a server error, no answer in time, a 400 we don't know): the file
 * gets its attempt back and waits 15 minutes while the run moves on to the
 * next file, so one resume that crashes the model can't hold up the queue;
 * two in a row mean the provider is down, and the queue pauses. A file only
 * gets its attempt back this way for its first hours in the queue, so a
 * resume that always fails is still given up on.
 *
 * Logs: one line per file and one per run, with ids, codes, counts and
 * token usage. Never resume text, names, field values, provider messages or
 * the key.
 */

export const RESUME_PARSE_BUDGET_MS = 240_000;
export const MAX_PARSE_ATTEMPTS = 3;
const RETRY_AFTER_MS = 15 * 60_000;
const QUEUE_TTL_MS = 72 * 3_600_000;
const BATCH = 25;

/** Failures that aren't the file's fault: the attempt is given back and the queue pauses. */
const PAUSE_MS: Partial<Record<ResumeParseErrorCode, number>> = {
  provider_auth: 15 * 60_000,
  provider_not_found: 15 * 60_000,
  provider_model_retired: 15 * 60_000,
  provider_quota: 15 * 60_000,
  provider_redirect: 15 * 60_000,
  provider_rate_limited: 60_000,
};

/**
 * Failures that are the provider's or the file's: an outage and a resume that
 * crashes a local model look the same. The file gets its attempt back and
 * waits; two in a row pause the queue for this long.
 */
const SUSPECT_PAUSE_MS: Partial<Record<ResumeParseErrorCode, number>> = {
  provider_unavailable: 2 * 60_000,
  provider_timeout: 5 * 60_000,
  provider_bad_request: 5 * 60_000,
};
/** How long after queueing a file still gets its attempt back for a suspect failure. */
const HOLD_WINDOW_MS = 4 * 3_600_000;

/** Text statuses the backfill won't retry, and OCR won't try: a resume in one of them will never have text. */
const TEXT_FINAL: TextStatus[] = ['ENCRYPTED', 'TOO_LARGE', 'MISSING'];

export type ResumeParseRun = {
  state: 'on' | 'off' | 'misconfigured';
  /** Files claimed (a provider call was made or about to be). */
  claimed: number;
  byStatus: Partial<Record<ParseStatus, number>>;
  /** Contacts that got at least one field. */
  filledContacts: number;
  /** Queued too long, or their candidate is gone. */
  expired: number;
  skipped: number;
  /** Organizations that reached today's limit during this run. */
  cappedOrgs: number;
  /** Files that got their attempt back after a failure that may have been the provider's. */
  held: number;
  /** The limit across all organizations was reached. */
  globalCapped: boolean;
  /** The provider or the setup failed; the queue is paused until `pausedUntil`. */
  stoppedOn?: ResumeParseErrorCode;
  pausedUntil?: string;
  /** A pause from an earlier run is still on; nothing was sent. */
  paused?: true;
  /** Another run holds the lease, so this one did nothing. */
  busy?: true;
  /** The budget ran out with work left: run again now. */
  more: boolean;
  tokens: Usage;
  ms: number;
  error?: string;
};

type ParseOpts = {
  budgetMs?: number;
  /** Tests: only these organizations (and their own lease). */
  orgId?: string | string[];
  now?: () => Date;
  complete?: typeof completeResumeJson;
  config?: ResumeParserState;
  sleep?: (ms: number) => Promise<void>;
};

export function startOfUtcDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

/**
 * Spread into the StoredFile update of a careers-page application: queues the
 * resume when parsing is on and its text is there or may still come (the
 * backfill retries FAILED, and OCR reads an EMPTY scan). Never throws: a bad
 * configuration never stops an application.
 */
export function parseQueueFields(
  textStatus?: TextStatus | null,
  org?: { id: string; slug?: string | null },
  env: Record<string, string | undefined> = process.env,
): { parseStatus?: 'QUEUED'; parseQueuedAt?: Date } {
  try {
    if (!resumeParsingOn(env)) return {};
    if (org && orgExcluded(org, env)) return {};
    if (textStatus && textStatus !== 'OK' && textStatus !== 'FAILED' && textStatus !== 'EMPTY') return {};
    return { parseStatus: 'QUEUED', parseQueuedAt: new Date() };
  } catch {
    return {};
  }
}

function scopeOf(orgId: ParseOpts['orgId']): Prisma.StoredFileWhereInput {
  if (!orgId) return {};
  return { orgId: Array.isArray(orgId) ? { in: orgId } : orgId };
}

/** A live candidate's current resume, and that candidate has its text. */
const readyResume: Prisma.StoredFileWhereInput = { contacts: { some: { isAnonymized: false, resumeText: { not: null } } } };

/** Files of organizations left out on this server (RESUME_PARSER_EXCLUDE_ORGS), by id or slug. */
function excludedWhere(orgs: string[]): Prisma.StoredFileWhereInput {
  return { OR: [{ orgId: { in: orgs } }, { org: { slug: { in: orgs } } }] };
}

/** Claimable as of `at`: queued and not claimed in the last 15 minutes, or failed with attempts left. */
function due(at: Date, excludedOrgs: string[] = []): Prisma.StoredFileWhereInput {
  const retryBefore = new Date(at.getTime() - RETRY_AFTER_MS);
  return {
    AND: [
      readyResume,
      { parseAttempts: { lt: MAX_PARSE_ATTEMPTS } },
      {
        OR: [
          { parseStatus: 'QUEUED', OR: [{ parseCheckedAt: null }, { parseCheckedAt: { lt: retryBefore } }] },
          { parseStatus: 'FAILED', parseCheckedAt: { lt: retryBefore } },
        ],
      },
      ...(excludedOrgs.length ? [{ NOT: excludedWhere(excludedOrgs) }] : []),
    ],
  };
}

/** Attempts claimed since `since` (today): what the daily limits count. */
async function attemptsSince(since: Date, orgId?: string): Promise<number> {
  const { _sum } = await db.storedFile.aggregate({
    where: { ...(orgId ? { orgId } : {}), parseCheckedAt: { gte: since } },
    _sum: { parseAttempts: true },
  });
  return _sum.parseAttempts ?? 0;
}

/** Queued files that will never be parsed: too old, their candidate gone, no text coming, or their organization left out. */
async function expire(scope: Prisma.StoredFileWhereInput, at: Date, excludedOrgs: string[]): Promise<{ expired: number; skipped: number }> {
  const waiting: Prisma.StoredFileWhereInput = {
    ...scope,
    OR: [{ parseStatus: 'QUEUED' }, { parseStatus: 'FAILED', parseAttempts: { lt: MAX_PARSE_ATTEMPTS } }],
  };
  const old = await db.storedFile.updateMany({
    where: { ...scope, parseStatus: 'QUEUED', parseQueuedAt: { lt: new Date(at.getTime() - QUEUE_TTL_MS) } },
    data: { parseStatus: 'SKIPPED', parseError: 'expired' },
  });
  // Nobody's current resume any more: replaced by a newer application, merged away, or erased.
  const orphaned = await db.storedFile.updateMany({
    where: { ...waiting, contacts: { none: { isAnonymized: false } } },
    data: { parseStatus: 'SKIPPED', parseError: 'no_contact' },
  });
  const noText = await db.storedFile.updateMany({
    where: {
      ...waiting,
      contacts: { some: { isAnonymized: false }, none: { isAnonymized: false, resumeText: { not: null } } },
      textVersion: EXTRACTOR_VERSION,
      AND: [
        {
          OR: [
            { textStatus: { in: TEXT_FINAL } },
            { textStatus: 'FAILED', textAttempts: { gte: MAX_TEXT_ATTEMPTS } },
            // A scan: no text until OCR has given its final answer.
            { textStatus: { in: [...OCR_TEXT_STATUSES] }, ...ocrSettled },
          ],
        },
      ],
    },
    data: { parseStatus: 'SKIPPED', parseError: 'no_text' },
  });
  const orgOff = excludedOrgs.length
    ? await db.storedFile.updateMany({ where: { AND: [waiting, excludedWhere(excludedOrgs)] }, data: { parseStatus: 'SKIPPED', parseError: 'org_off' } })
    : { count: 0 };
  return { expired: old.count, skipped: orphaned.count + noText.count + orgOff.count };
}

/**
 * The queue's pause after a provider or setup failure: a CronLease row whose
 * token is the error code, which Settings shows until a resume parses again.
 */
export function pauseName(leaseName = 'resume-parse') {
  return `${leaseName}:paused`;
}

async function pausedUntil(leaseName: string, at: Date): Promise<Date | null> {
  const row = await db.cronLease.findUnique({ where: { name: pauseName(leaseName) } });
  return row && row.leaseUntil > at ? row.leaseUntil : null;
}

async function pause(leaseName: string, until: Date, code: ResumeParseErrorCode) {
  const name = pauseName(leaseName);
  await db.cronLease.upsert({ where: { name }, create: { name, leaseUntil: until, token: code }, update: { leaseUntil: until, token: code } });
}

/** A resume parsed: whatever paused the queue is fixed. */
async function clearPause(leaseName: string) {
  await db.cronLease.deleteMany({ where: { name: pauseName(leaseName) } });
}

function addTokens(total: Usage, u: Usage) {
  total.promptTokens += u.promptTokens;
  total.completionTokens += u.completionTokens;
  total.reasoningTokens += u.reasoningTokens;
  total.cachedTokens += u.cachedTokens;
}

function describeError(err: unknown): string {
  if (!(err instanceof Error)) return 'Unknown error';
  const code = (err as { code?: unknown }).code;
  return `${err.name}: ${typeof code === 'string' ? code : err.message.trim().split('\n').pop()}`.slice(0, 200);
}

type FileRow = { id: string; orgId: string; parseCheckedAt: Date | null; parseQueuedAt: Date | null };

type FileOutcome =
  | { kind: 'lost' }
  /** Finished: parsed, nothing usable, skipped, or failed for a reason that is the file's. */
  | { kind: 'done'; status: ParseStatus; filled: boolean; answered: boolean }
  /** The call failed in a way that isn't clearly the file's; the claim is still held, for the run to settle. */
  | { kind: 'error'; code: ResumeParseErrorCode; retryAfterMs: number | null; claimedAt: Date; log: (fields: Record<string, unknown>) => void; base: Record<string, unknown> };

export async function processResumeParse(opts: ParseOpts = {}): Promise<ResumeParseRun> {
  const started = Date.now();
  const cfg = opts.config ?? resumeParserConfig();
  const run: ResumeParseRun = {
    state: cfg.state,
    claimed: 0,
    byStatus: {},
    filledContacts: 0,
    expired: 0,
    skipped: 0,
    cappedOrgs: 0,
    held: 0,
    globalCapped: false,
    more: false,
    tokens: emptyUsage(),
    ms: 0,
  };
  const finish = () => ({ ...run, ms: Date.now() - started });
  if (cfg.state !== 'on') return finish();

  const now = opts.now ?? (() => new Date());
  const complete = opts.complete ?? completeResumeJson;
  const deadline = started + (opts.budgetMs ?? RESUME_PARSE_BUDGET_MS);
  const scope = scopeOf(opts.orgId);
  const leaseName = opts.orgId ? `resume-parse:${[opts.orgId].flat().join(',')}` : 'resume-parse';

  // Calls are cut off at the deadline, so nothing outlives the lease.
  const release = await takeCronLease(leaseName, new Date(deadline + 60_000));
  if (!release) return { ...finish(), busy: true };
  let logged = false;
  try {
    const expired = await expire(scope, now(), cfg.excludedOrgs);
    run.expired = expired.expired;
    run.skipped = expired.skipped;

    const pausedTill = await pausedUntil(leaseName, now());
    if (pausedTill) {
      run.paused = true;
      run.pausedUntil = pausedTill.toISOString();
      return finish();
    }

    const stop = async (code: ResumeParseErrorCode, ms: number, retryAfterMs: number | null) => {
      const wait = Math.min(Math.max(retryAfterMs ?? 0, ms), 15 * 60_000);
      const until = new Date(now().getTime() + wait);
      await pause(leaseName, until, code);
      run.stoppedOn = code;
      run.pausedUntil = until.toISOString();
    };

    // The daily limits count attempts claimed today, so a resume tried again counts again.
    const dayStart = startOfUtcDay(now());
    const usedByOrg = new Map<string, number>();
    const capped = new Set<string>();
    const seen: string[] = [];
    let cleared = false;
    // Failures in a row that could be the provider's; reset whenever the provider answers.
    let suspectStreak = 0;
    let globalLeft = cfg.globalDailyLimit === null ? null : cfg.globalDailyLimit - (await attemptsSince(dayStart));

    batches: while (true) {
      if (globalLeft !== null && globalLeft <= 0) {
        run.globalCapped = true;
        break;
      }
      const batch: FileRow[] = await db.storedFile.findMany({
        where: {
          AND: [
            scope,
            due(now(), cfg.excludedOrgs),
            capped.size ? { orgId: { notIn: [...capped] } } : {},
            seen.length ? { id: { notIn: seen } } : {},
          ],
        },
        orderBy: { parseQueuedAt: 'asc' },
        take: BATCH,
        select: { id: true, orgId: true, parseCheckedAt: true, parseQueuedAt: true },
      });
      if (!batch.length) break;

      for (const file of batch) {
        seen.push(file.id);
        if (capped.has(file.orgId)) continue;
        // Start a file only with time for an answer. A call still going at the
        // deadline is cut off and the file gets its attempt back, so this needn't
        // reserve a whole (possibly long) timeout.
        if (deadline - Date.now() < Math.min(cfg.timeoutMs, 60_000) + 2_000) {
          run.more = true;
          break batches;
        }
        let used = usedByOrg.get(file.orgId);
        if (used === undefined) {
          used = await attemptsSince(dayStart, file.orgId);
          usedByOrg.set(file.orgId, used);
        }
        if (used >= cfg.dailyLimit) {
          capped.add(file.orgId);
          run.cappedOrgs++;
          continue;
        }
        if (globalLeft !== null && globalLeft <= 0) {
          run.globalCapped = true;
          break batches;
        }

        const outcome = await parseFile(file, cfg, { now, complete, deadline, sleep: opts.sleep, run });
        if (outcome.kind === 'lost') continue;

        if (outcome.kind === 'error') {
          const { code } = outcome;
          const fenced = { id: file.id, parseCheckedAt: outcome.claimedAt };
          if (code === 'deadline' || PAUSE_MS[code] !== undefined) {
            // Not this file's fault: give back the attempt and the claim, so it is next once the pause ends.
            await db.storedFile.updateMany({ where: fenced, data: { parseCheckedAt: file.parseCheckedAt, parseAttempts: { decrement: 1 } } });
            run.claimed--;
            outcome.log({ status: 'GIVEN_BACK', ...outcome.base });
            if (code === 'deadline') run.more = true;
            else await stop(code, PAUSE_MS[code]!, outcome.retryAfterMs);
            break batches;
          }
          // The provider's fault or this file's. A young file gets its attempt
          // back and waits out its 15 minutes while the run tries the next one.
          suspectStreak++;
          const young = !file.parseQueuedAt || now().getTime() - file.parseQueuedAt.getTime() < HOLD_WINDOW_MS;
          if (young) {
            await db.storedFile.updateMany({ where: fenced, data: { parseAttempts: { decrement: 1 } } });
            run.claimed--;
            run.held++;
            outcome.log({ status: 'HELD', ...outcome.base });
          } else {
            await db.storedFile.updateMany({ where: fenced, data: { parseStatus: 'FAILED', parseError: code } });
            run.byStatus.FAILED = (run.byStatus.FAILED ?? 0) + 1;
            outcome.log({ status: 'FAILED', ...outcome.base });
            usedByOrg.set(file.orgId, used + 1);
            if (globalLeft !== null) globalLeft--;
          }
          if (suspectStreak >= 2) {
            // Two different resumes failed the same way: the provider is down.
            await stop(code, SUSPECT_PAUSE_MS[code] ?? 2 * 60_000, outcome.retryAfterMs);
            break batches;
          }
          continue;
        }

        if (outcome.answered) suspectStreak = 0;
        if (outcome.status === 'SKIPPED') continue; // no call made, no attempt spent
        usedByOrg.set(file.orgId, used + 1);
        if (globalLeft !== null) globalLeft--;
        if (!cleared && (outcome.status === 'OK' || outcome.status === 'EMPTY')) {
          cleared = true;
          await clearPause(leaseName);
        }
      }
    }

    if (run.claimed || run.held || run.expired || run.skipped || run.stoppedOn || run.cappedOrgs || run.globalCapped) {
      console.log('[resume-parse] run', JSON.stringify(finish()));
    }
    logged = true;
    return finish();
  } catch (err) {
    // A write that failed will likely fail for the next file too: stop, and
    // let the schedule try again. A claimed file is retried after 15 minutes.
    run.error = describeError(err);
    if (!logged) console.error('[resume-parse] run', JSON.stringify(finish()));
    return finish();
  } finally {
    await release();
  }
}

async function parseFile(
  file: FileRow,
  cfg: ResumeParserConfig,
  ctx: { now: () => Date; complete: typeof completeResumeJson; deadline: number; sleep?: (ms: number) => Promise<void>; run: ResumeParseRun },
): Promise<FileOutcome> {
  const started = Date.now();
  const claimedAt = ctx.now();
  const claim = await db.storedFile.updateMany({
    where: { AND: [{ id: file.id }, due(claimedAt, cfg.excludedOrgs)] },
    data: { parseCheckedAt: claimedAt, parseAttempts: { increment: 1 } },
  });
  if (!claim.count) return { kind: 'lost' };
  ctx.run.claimed++;

  const fenced = { id: file.id, parseCheckedAt: claimedAt };
  const log = (fields: Record<string, unknown>) =>
    console.log(
      '[resume-parse] file',
      JSON.stringify({ fileId: file.id, orgId: file.orgId, model: cfg.model, host: cfg.host, ms: Date.now() - started, ...fields }),
    );
  const count = (status: ParseStatus) => (ctx.run.byStatus[status] = (ctx.run.byStatus[status] ?? 0) + 1);

  const contact = await db.contact.findFirst({
    where: { orgId: file.orgId, resumeFileId: file.id, isAnonymized: false },
    select: { id: true, resumeText: true },
  });
  if (!contact?.resumeText) {
    await db.storedFile.updateMany({ where: fenced, data: { parseStatus: 'SKIPPED', parseError: 'no_contact' } });
    count('SKIPPED');
    log({ status: 'SKIPPED', code: 'no_contact' });
    return { kind: 'done', status: 'SKIPPED', filled: false, answered: false };
  }

  const text = sanitizeResumeText(contact.resumeText, cfg.maxChars);
  let result: Awaited<ReturnType<typeof completeResumeJson>>;
  try {
    result = await ctx.complete(cfg, text, { deadline: ctx.deadline, sleep: ctx.sleep });
  } catch (err) {
    if (!(err instanceof ResumeParseError)) throw err;
    addTokens(ctx.run.tokens, err.usage);
    const base = { code: err.code, httpStatus: err.status, calls: err.calls, requestId: err.requestId, ...err.usage };
    if (err.code === 'deadline' || PAUSE_MS[err.code] !== undefined || SUSPECT_PAUSE_MS[err.code] !== undefined) {
      return { kind: 'error', code: err.code, retryAfterMs: err.retryAfterMs, claimedAt, log, base };
    }
    // The provider answered, and the answer for this file was unusable: the file's attempt.
    await db.storedFile.updateMany({ where: fenced, data: { parseStatus: 'FAILED', parseError: err.code } });
    count('FAILED');
    log({ status: 'FAILED', ...base });
    return { kind: 'done', status: 'FAILED', filled: false, answered: true };
  }
  addTokens(ctx.run.tokens, result.usage);

  const { profile, empty } = validateParsedResume(result.raw, text);
  const status: ParseStatus = empty ? 'EMPTY' : 'OK';
  const parsed = { v: 1, parsedAt: ctx.now().toISOString(), ...profile };
  let fill: FillResult | null = null;
  const written = await db.$transaction(async (tx) => {
    // The contact's row first, then the file's: the order anonymizeContact
    // takes them in, so an erasure running now waits instead of deadlocking.
    await tx.$queryRaw`SELECT "id" FROM "Contact" WHERE "id" = ${contact.id} FOR UPDATE`;
    const done = await tx.storedFile.updateMany({
      where: fenced,
      data: { parseStatus: status, parseError: null, parseModel: cfg.model, parsed },
    });
    if (!done.count) return false;
    if (empty) return true;
    fill = await fillContactFromResume(tx, {
      orgId: file.orgId,
      contactId: contact.id,
      fileId: file.id,
      profile,
      sourceText: text,
      model: cfg.model,
      providerLabel: cfg.providerLabel,
    });
    if (fill && filledAnything(fill)) {
      // Which values came from the resume, so a later change can tell machine from human.
      await tx.storedFile.update({ where: { id: file.id }, data: { parsed: { ...parsed, filled: fill.values } } });
    }
    return true;
  });
  const f = fill as FillResult | null;
  const filled = !!f && filledAnything(f);
  if (!written) {
    log({ status: 'LOST' });
    return { kind: 'lost' };
  }
  count(status);
  if (filled) ctx.run.filledContacts++;
  log({
    status,
    mode: result.mode,
    calls: result.calls,
    salvaged: result.salvaged || undefined,
    requestId: result.requestId,
    ...result.usage,
    filled: f?.filled ?? [],
    added: f?.added ?? { phones: 0, links: 0 },
  });
  return { kind: 'done', status, filled, answered: true };
}

/** Runs one after another in this process, when nothing else can start the next. */
const IN_PROCESS_RUNS = 10;

/**
 * Carry on with the queue after a run that ran out of time with work left.
 * Where the app can reach its own cron route (CRON_SECRET set), it asks that
 * route to run, which has the long function duration. A server without the
 * secret (docker-compose's default) keeps going in this process instead, a
 * bounded number of runs, so a burst on a slow local model isn't left for
 * the next tick of the schedule. On Vercel without a way to call itself, the
 * schedule covers it.
 */
export async function continueResumeParse(opts: ParseOpts = {}): Promise<number> {
  if (process.env.CRON_SECRET && selfOrigin()) {
    await chainCron('/api/cron/resume-parse');
    return 0;
  }
  if (process.env.VERCEL) return 0;
  let runs = 0;
  while (runs < IN_PROCESS_RUNS) {
    runs++;
    const run = await processResumeParse(opts);
    if (!run.more) break;
  }
  return runs;
}

/**
 * After a careers-page application with a resume (from next/server after()):
 * start a run now rather than at the next tick of the schedule. It is the
 * same single-flight run the cron uses, so a burst of applications doesn't
 * become a burst of calls. Never on a Vercel preview: previews share the
 * production database.
 */
export async function kickResumeParse(opts: { budgetMs?: number } = {}): Promise<void> {
  if (!resumeParsingOn()) return;
  if (process.env.VERCEL && process.env.VERCEL_ENV !== 'production') return;
  await continueResumeParse(opts);
}

/**
 * Queue resumes an admin chose (older applications, imports). Only files
 * that are a live candidate's current resume with text, and not queued or
 * parsed already. Returns how many were queued. Nothing calls this yet.
 */
export async function queueResumeParse(input: { orgId: string; fileIds?: string[]; limit?: number }, at = new Date()): Promise<number> {
  const files = await db.storedFile.findMany({
    where: {
      orgId: input.orgId,
      ...(input.fileIds ? { id: { in: input.fileIds } } : {}),
      ...readyResume,
      OR: [{ parseStatus: null }, { parseStatus: { in: ['FAILED', 'SKIPPED'] } }],
    },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(input.limit ?? 1_000, 1), 10_000),
    select: { id: true },
  });
  if (!files.length) return 0;
  const { count } = await db.storedFile.updateMany({
    where: { id: { in: files.map((f) => f.id) }, orgId: input.orgId },
    data: { parseStatus: 'QUEUED', parseQueuedAt: at, parseCheckedAt: null, parseAttempts: 0, parseError: null },
  });
  return count;
}
