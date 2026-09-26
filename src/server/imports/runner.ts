import { randomUUID } from 'crypto';
import { Prisma, type ImportJob, type ImportStatus } from '@prisma/client';
import { db } from '@/lib/db';
import { providerMeta } from '@/lib/import-providers';
import { CredentialsUnavailableError, openCredentials } from '@/server/imports/crypto';
import { createHttpClient, ImportAuthError, YieldError } from '@/server/imports/http';
import { createLoader, type LoaderStats } from '@/server/imports/loader';
import { catalogWriter, parseCatalog, parseMapping } from '@/server/imports/mapping';
import { scrub } from '@/server/imports/text';
import { getProvider } from '@/server/imports/providers';
import type { Cursor, ImportOptions, Loader, Phase, PhaseContext } from '@/server/imports/types';
import { DEFAULT_IMPORT_OPTIONS } from '@/server/imports/types';
import { invalidateLists } from '@/server/lists/cache';

/**
 * Runs import jobs in bounded slices. A slice leases the job, resumes the
 * current phase from its cursor, checkpoints after every step, and stops
 * when its time budget is spent. Anything can drive slices — the job page
 * (while an admin watches) or the imports cron and its chained follow-ups
 * (when nobody does).
 *
 * The lease is a token as well as a time: every write a slice makes is
 * fenced on its token, so a slice that overran its lease can never clobber
 * the next holder's progress. A token still set on an expired lease means
 * the last slice died mid-step (out of memory, killed at maxDuration); that
 * counts as a failure, so a record that crashes the process can't wedge the
 * job forever.
 */

export const PUMP_BUDGET_MS = 20_000;
export const CRON_BUDGET_MS = 240_000;

/**
 * Give up after this many consecutive failed slices. With the backoff below
 * that rides out roughly an hour and a half of vendor outage.
 */
const MAX_FAILURES = 10;
const MAX_BACKOFF_MS = 30 * 60_000;
/** How often a running slice checks it still owns the job (cancel, lost lease). */
const WATCH_MS = 3_000;
/** A job left waiting for review this long is canceled and its key wiped. */
const REVIEW_TTL_MS = 7 * 24 * 60 * 60_000;
/** `phase` value once every phase of the current stage has finished. */
export const DONE = '$done';
/** Give up when the vendor keeps us waiting this many slices in a row with no progress (about a day). */
const MAX_WAITS = 48;
/** Stop starting new steps this close to the deadline. */
const SAFETY_MS = 3_000;
const MAX_ISSUES = 100;

export const ACTIVE_STATUSES: ImportStatus[] = ['DISCOVERING', 'RUNNING'];
export const TERMINAL_STATUSES: ImportStatus[] = ['SUCCEEDED', 'FAILED', 'CANCELED'];

export type ImportIssue = {
  message: string;
  count: number;
  phase: string | null;
  entity?: string;
  externalId?: string;
  at: string;
};

export function parseOptions(value: Prisma.JsonValue | null | undefined): ImportOptions {
  return { ...DEFAULT_IMPORT_OPTIONS, ...((value ?? {}) as Partial<ImportOptions>) };
}

export function parseIssues(value: Prisma.JsonValue | null | undefined): ImportIssue[] {
  return Array.isArray(value) ? (value as unknown as ImportIssue[]) : [];
}

function enabledPhases(phases: Phase[], options: ImportOptions): Phase[] {
  return phases.filter((p) => p.enabled?.(options) ?? true);
}

/** The phases a job will run, in order — for progress display. */
export function planFor(provider: string, options: ImportOptions): { discover: Phase[]; load: Phase[] } | null {
  const mod = getProvider(provider);
  if (!mod) return null;
  // Adapters are pure constructors; building one with empty credentials only reads its phase list.
  const adapter = mod.create({}, createHttpClient({ auth: { hosts: [] }, minIntervalMs: 0 }));
  return { discover: enabledPhases(adapter.discover, options), load: enabledPhases(adapter.load, options) };
}

const providerName = (id: string) => providerMeta(id)?.name ?? id;

async function finish(
  job: Pick<ImportJob, 'id' | 'orgId' | 'provider' | 'createdById'>,
  status: 'SUCCEEDED' | 'FAILED',
  data: Prisma.ImportJobUpdateManyMutationInput,
  leaseToken: string,
) {
  const counts = await db.importRef.groupBy({
    by: ['kind'],
    where: { jobId: job.id, created: true },
    _count: { _all: true },
  });
  await db.$transaction(async (tx) => {
    const res = await tx.importJob.updateMany({
      where: { id: job.id, status: { in: ACTIVE_STATUSES }, leaseToken },
      data: {
        ...data,
        status,
        credentials: null,
        finishedAt: new Date(),
        leaseUntil: null,
        leaseToken: null,
        cursor: Prisma.DbNull,
      },
    });
    if (!res.count) return;
    await tx.event.create({
      data: {
        orgId: job.orgId,
        actorType: job.createdById ? 'user' : 'system',
        actorId: job.createdById,
        verb: status === 'SUCCEEDED' ? 'import.completed' : 'import.failed',
        subjectType: 'import',
        subjectId: job.id,
        payload: {
          provider: job.provider,
          created: Object.fromEntries(counts.map((c) => [c.kind, c._count._all])),
          ...(status === 'FAILED' && typeof data.error === 'string' ? { error: data.error } : {}),
        },
      },
    });
  });
  // Stages, postings, candidates and counts may all have changed.
  invalidateLists(job.orgId);
  const created = counts.reduce((n, c) => n + c._count._all, 0);
  if (created >= VACUUM_AFTER) await vacuumLists();
}

/** Imports this size or larger refresh the list tables' visibility map and statistics. */
const VACUUM_AFTER = 1_000;

/**
 * Best effort, after a large import: keeps the pipeline's tile counts
 * index-only (they skip the heap only for all-visible pages) and the
 * planner's estimates current, instead of waiting for autovacuum. Plain
 * VACUUM blocks neither reads nor writes; any failure is only logged.
 */
async function vacuumLists() {
  try {
    await db.$executeRawUnsafe('VACUUM (ANALYZE) "Opportunity", "Contact"');
  } catch (err) {
    console.warn('[imports] post-import VACUUM skipped:', err instanceof Error ? err.message : err);
  }
}

/**
 * finish(), and if that write itself fails (a value in stats or issues
 * Postgres won't take, a timeout), a bare terminal write — a job must never
 * be left running with its key stored because its final save failed.
 */
async function finishSafely(...args: Parameters<typeof finish>) {
  const [job, status, data, leaseToken] = args;
  try {
    await finish(job, status, data, leaseToken);
  } catch (err) {
    console.error(`[imports] job ${job.id} final save failed:`, err instanceof Error ? err.message : err);
    await db.importJob.updateMany({
      where: { id: job.id, status: { in: ACTIVE_STATUSES }, leaseToken },
      data: {
        status,
        error: typeof data.error === 'string' ? scrub(data.error) : null,
        credentials: null,
        finishedAt: new Date(),
        leaseUntil: null,
        leaseToken: null,
        cursor: Prisma.DbNull,
      },
    });
  }
}

/**
 * worked: made progress (or finished). waiting: the vendor asked us to back
 * off; the job is held until then. failed: a transient error; retried with
 * backoff. busy: another worker holds it. idle: nothing to do.
 */
export type SliceResult = 'worked' | 'waiting' | 'failed' | 'busy' | 'idle';

export async function runSlice(
  jobId: string,
  budgetMs: number,
  opts: { fetchImpl?: typeof fetch; now?: () => number; resolveHost?: (host: string) => Promise<string[]> } = {},
): Promise<SliceResult> {
  const now = opts.now ?? Date.now;
  const started = now();
  const deadline = started + budgetMs;

  // ---------- lease ----------
  const current = await db.importJob.findUnique({
    where: { id: jobId },
    select: { status: true, leaseUntil: true, leaseToken: true },
  });
  if (!current || !ACTIVE_STATUSES.includes(current.status)) return 'idle';
  if (current.leaseUntil && current.leaseUntil.getTime() > started) return 'busy';
  const crashed = !!current.leaseToken;
  const token = randomUUID();
  const leased = await db.importJob.updateMany({
    where: {
      id: jobId,
      status: { in: ACTIVE_STATUSES },
      leaseToken: current.leaseToken,
      OR: [{ leaseUntil: null }, { leaseUntil: { lte: new Date(started) } }],
    },
    data: {
      leaseUntil: new Date(deadline + 60_000),
      leaseToken: token,
      ...(crashed ? { failures: { increment: 1 } } : {}),
    },
  });
  if (!leased.count) return 'busy';

  const job = await db.importJob.findUniqueOrThrow({ where: { id: jobId } });
  if (crashed && job.failures >= MAX_FAILURES) {
    await finishSafely(
      job,
      'FAILED',
      { error: 'The import kept stopping before it could save its progress. A record may be too large to process; run it again to retry.' },
      token,
    );
    return 'worked';
  }

  const org = await db.organization.findUniqueOrThrow({ where: { id: job.orgId }, select: { kind: true } });
  const options = parseOptions(job.options);
  const since = options.since ? new Date(options.since) : null;
  const catalog = parseCatalog(job.catalog);
  const stats: LoaderStats = { ...((job.stats ?? {}) as LoaderStats) };
  const issues = new Map(parseIssues(job.issues).map((i) => [i.message, i]));
  let issueCount = job.issueCount;
  const status = job.status;
  let phaseId = job.phase;
  let cursor = (job.cursor ?? null) as Cursor | null;
  let failures = job.failures;
  let dirty = false;
  // After a failure or a vendor back-off the lease doubles as a retry-after:
  // nobody picks the job up again until it expires.
  let releaseAt: Date | null = null;
  let progressed = false;
  let keepToken = false;

  // Stop promptly (not just between pages) if the job is canceled or the lease lost.
  let lost = false;
  const watch = setInterval(() => {
    db.importJob
      .findFirst({ where: { id: jobId, status, leaseToken: token }, select: { id: true } })
      .then((row) => {
        if (!row) lost = true;
      })
      .catch(() => undefined);
  }, WATCH_MS);
  watch.unref?.();

  // Vendor text ends up in these JSON columns; one NUL would make every checkpoint throw.
  const warn: PhaseContext['warn'] = (message, detail) => {
    const clean = scrub(message).slice(0, 500);
    detail = detail && scrub(detail);
    issueCount++;
    dirty = true;
    const existing = issues.get(clean);
    if (existing) existing.count++;
    else if (issues.size < MAX_ISSUES)
      issues.set(clean, { message: clean, count: 1, phase: phaseId, ...detail, at: new Date(now()).toISOString() });
  };

  const checkpoint = async (extra: Prisma.ImportJobUpdateManyMutationInput = {}) => {
    const res = await db.importJob.updateMany({
      where: { id: jobId, status, leaseToken: token },
      data: {
        phase: phaseId,
        cursor: cursor === null ? Prisma.DbNull : (scrub(cursor) as Prisma.InputJsonValue),
        // The catalog only changes while discovering; don't rewrite it on every page after.
        ...(status === 'DISCOVERING' ? { catalog: catalog as unknown as Prisma.InputJsonValue } : {}),
        stats: stats as Prisma.InputJsonValue,
        issues: [...issues.values()] as unknown as Prisma.InputJsonValue,
        issueCount,
        ...extra,
      },
    });
    dirty = false;
    if (!res.count) lost = true;
    return res.count > 0; // false → canceled, or the lease went to someone else
  };

  try {
    const mod = getProvider(job.provider);
    if (!mod) throw new Error(`Unknown provider "${job.provider}"`);
    const credentials = openCredentials(job.credentials);
    const http = createHttpClient({
      auth: mod.auth(credentials),
      minIntervalMs: mod.minIntervalMs,
      timeoutMs: mod.timeoutMs,
      deadline,
      fetchImpl: opts.fetchImpl,
      resolveHost: opts.resolveHost,
      now,
    });
    const adapter = mod.create(credentials, http);

    let loader: Loader | null = null;
    if (status === 'RUNNING') {
      const author =
        (job.createdById &&
          (await db.user.findFirst({ where: { id: job.createdById, orgId: job.orgId }, select: { id: true } }))) ||
        (await db.user.findFirst({
          where: { orgId: job.orgId, accessRole: { in: ['SUPER_ADMIN', 'ADMIN'] } },
          orderBy: { createdAt: 'asc' },
          select: { id: true },
        }));
      if (!author) throw new Error('This organization has no admin to attribute imported notes to');
      loader = createLoader({
        orgId: job.orgId,
        orgKind: org.kind,
        provider: job.provider,
        providerName: providerMeta(job.provider)?.name ?? job.provider,
        jobId: job.id,
        fallbackAuthorId: author.id,
        mapping: parseMapping(job.mapping),
        options,
        since,
        startedAt: job.startedAt,
        updates: !!mod.updatesOnReimport,
        stats,
        warn,
      });
    }
    const noLoader = new Proxy({} as Loader, {
      get() {
        throw new Error('Discover phases must not write data');
      },
    });

    const resync =
      status === 'RUNNING' &&
      !!mod.updatesOnReimport &&
      !!(await db.importRef.findFirst({
        where: {
          orgId: job.orgId,
          provider: job.provider,
          kind: 'opportunity',
          OR: [{ jobId: null }, { jobId: { not: job.id } }],
        },
        select: { id: true },
      }));

    const ctx: PhaseContext = {
      http,
      catalog: catalogWriter(catalog),
      load: loader ?? noLoader,
      options,
      since,
      resync,
      outOfTime: () => lost || now() > deadline - SAFETY_MS,
      warn,
    };

    const phases = enabledPhases(status === 'DISCOVERING' ? adapter.discover : adapter.load, options);
    let idx = phaseId === DONE ? phases.length : phaseId ? phases.findIndex((p) => p.id === phaseId) : 0;
    if (idx < 0) {
      // Phase list changed between deploys — restart this stage; refs make it idempotent.
      idx = 0;
      cursor = null;
    }
    phaseId = phases[idx]?.id ?? DONE;

    let steps = 0;
    while (idx < phases.length) {
      // Always take at least one step, so even a tiny budget makes progress.
      if (steps++ > 0 && ctx.outOfTime()) break;
      const next = await phases[idx].run(ctx, cursor);
      if (next === null) {
        idx++;
        cursor = null;
        // DONE is stored explicitly: a finish that fails resumes at the finish,
        // instead of reading as "not started" and replaying every phase.
        phaseId = phases[idx]?.id ?? DONE;
      } else {
        cursor = next;
      }
      if (stats['job.waits']) stats['job.waits'] = 0; // progress resets the wait count
      if (!(await checkpoint({ failures: 0, error: null }))) return 'worked';
      failures = 0;
      progressed = true;
    }

    if (idx >= phases.length && !lost) {
      if (status === 'DISCOVERING') {
        phaseId = null;
        cursor = null;
        await checkpoint({ status: 'REVIEW', failures: 0, leaseUntil: null, leaseToken: null });
      } else {
        await finishSafely(
          job,
          'SUCCEEDED',
          { phase: null, stats: stats as Prisma.InputJsonValue, issues: [...issues.values()] as unknown as Prisma.InputJsonValue, issueCount },
          token,
        );
      }
    }
    return 'worked';
  } catch (err) {
    if (err instanceof YieldError) {
      // Waiting with nothing done this slice: count it, so a vendor that never
      // lets us through (an exhausted quota) ends the job instead of holding the key forever.
      const waits = progressed ? 0 : (stats['job.waits'] ?? 0) + 1;
      stats['job.waits'] = waits;
      if (waits > MAX_WAITS) {
        await finishSafely(job, 'FAILED', { error: `${providerName(job.provider)} kept asking Source to wait, for over a day. Run the import again later.` }, token);
        return 'worked';
      }
      await checkpoint().catch(() => undefined);
      if (err.resumeAt) releaseAt = new Date(Math.min(err.resumeAt, now() + MAX_BACKOFF_MS));
      return 'waiting';
    }
    const fatal =
      err instanceof ImportAuthError || err instanceof CredentialsUnavailableError || (err as Error)?.message?.startsWith('Unknown provider');
    const message = scrub(err instanceof Error ? err.message : String(err));
    if (fatal) {
      await finishSafely(
        job,
        'FAILED',
        { error: message.slice(0, 1000), stats: stats as Prisma.InputJsonValue, issues: [...issues.values()] as unknown as Prisma.InputJsonValue, issueCount },
        token,
      );
      return 'worked';
    }
    failures++;
    console.error(`[imports] job ${jobId} slice failed (${failures}/${MAX_FAILURES}):`, message);
    if (failures >= MAX_FAILURES) {
      await finishSafely(job, 'FAILED', { error: message.slice(0, 1000), failures }, token);
      return 'worked';
    }
    warn(`Retrying after an error: ${message}`);
    // The full checkpoint can itself be what's failing; the count must still land.
    const saved =
      (await checkpoint({ failures, error: message.slice(0, 1000) }).catch(() => false)) ||
      (await db.importJob
        .updateMany({ where: { id: jobId, status, leaseToken: token }, data: { failures, error: message.slice(0, 1000) } })
        .then((r) => r.count > 0)
        .catch(() => false));
    // Not even that? Keep the token: the lease expires with it set, and the
    // next slice counts it as a crash — so the failure is counted either way.
    if (!saved) keepToken = true;
    releaseAt = new Date(now() + Math.min(MAX_BACKOFF_MS, 15_000 * 2 ** (failures - 1)));
    return 'failed';
  } finally {
    clearInterval(watch);
    if (dirty) await checkpoint().catch(() => undefined);
    if (!keepToken) {
      await db.importJob
        .updateMany({ where: { id: jobId, leaseToken: token }, data: { leaseUntil: releaseAt, leaseToken: null } })
        .catch(() => undefined);
    }
  }
}

/** Cancel jobs abandoned at the review step so their keys don't sit in the database. */
async function expireStaleReviews() {
  const stale = await db.importJob.findMany({
    where: { status: 'REVIEW', updatedAt: { lt: new Date(Date.now() - REVIEW_TTL_MS) } },
    select: { id: true, orgId: true },
    take: 50,
  });
  for (const job of stale) {
    const res = await db.importJob.updateMany({
      where: { id: job.id, status: 'REVIEW' },
      data: { status: 'CANCELED', credentials: null, cursor: Prisma.DbNull, finishedAt: new Date() },
    });
    if (res.count) {
      await db.event.create({
        data: {
          orgId: job.orgId,
          actorType: 'system',
          verb: 'import.canceled',
          subjectType: 'import',
          subjectId: job.id,
          payload: { reason: 'review_expired' },
        },
      });
    }
  }
}

/**
 * Advance every runnable job until the budget is spent (cron). Returns
 * whether a job will be runnable again soon — the cron uses it to chain
 * the next run instead of polling the database around the clock.
 */
export async function processImports(budgetMs = CRON_BUDGET_MS): Promise<{ slices: number; more: boolean }> {
  const deadline = Date.now() + budgetMs;
  await expireStaleReviews();
  let slices = 0;
  const tried = new Set<string>();
  while (Date.now() < deadline - 5_000) {
    const job = await db.importJob.findFirst({
      where: {
        status: { in: ACTIVE_STATUSES },
        id: { notIn: [...tried] },
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }],
      },
      orderBy: { updatedAt: 'asc' },
      select: { id: true },
    });
    if (!job) {
      if (!tried.size) break;
      tried.clear(); // every job had a turn — go round again with the remaining time
      continue;
    }
    tried.add(job.id);
    const result = await runSlice(job.id, Math.max(5_000, deadline - Date.now()));
    if (result !== 'busy' && result !== 'idle') slices++;
  }
  // Chain another run only if this one did work and a job can run right now.
  // A job held by the page's pump, a backoff, or a vendor's Retry-After is
  // left to its holder or the schedule — chaining on it would just spin.
  if (!slices) return { slices, more: false };
  const runnable = await db.importJob.count({
    where: {
      status: { in: ACTIVE_STATUSES },
      OR: [{ leaseUntil: null }, { leaseUntil: { lte: new Date() } }],
    },
  });
  return { slices, more: runnable > 0 };
}
