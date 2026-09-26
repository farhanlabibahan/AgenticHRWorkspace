import { Prisma, type ImportStatus, type StageType } from '@prisma/client';
import { db } from '@/lib/db';
import { isAdmin, type SessionContext } from '@/lib/session';
import { providerMeta } from '@/lib/import-providers';
import { sealCredentials } from '@/server/imports/crypto';
import { createHttpClient, ImportAuthError, ImportHttpError } from '@/server/imports/http';
import {
  countsAsRejection,
  defaultMapping,
  inferStageType,
  nameKey,
  orderNewStages,
  parseCatalog,
  STAGE_TYPES,
  type AppliedMapping,
  type Catalog,
  type MappingInput,
} from '@/server/imports/mapping';
import { actorOf, emitEvent } from '@/server/events';
import { invalidateListMeta } from '@/server/lists/cache';
import { insertStages } from '@/server/imports/pipeline';
import { getProvider } from '@/server/imports/providers';
import { ACTIVE_STATUSES, DONE, parseIssues, parseOptions, planFor, type ImportIssue } from '@/server/imports/runner';
import type { Credentials, ImportOptions } from '@/server/imports/types';
import { DEFAULT_IMPORT_OPTIONS } from '@/server/imports/types';

/**
 * Session-facing import operations: test a connection, start a job, review
 * and confirm the stage mapping, cancel, and read progress. Admin-only —
 * an import writes across the whole org.
 */

/** Postgres caps a statement at 65,535 bind parameters; big accounts have more stage ids than that. */
function chunks<T>(list: T[], size = 5_000): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function requireAdmin(ctx: SessionContext) {
  if (!isAdmin(ctx)) throw new Error('Only admins can import data');
}

function cleanCredentials(provider: string, raw: Record<string, unknown>): Credentials {
  const meta = providerMeta(provider);
  if (!meta || !getProvider(provider)) throw new Error('Unknown provider');
  const creds: Credentials = {};
  for (const field of meta.fields) {
    const value = String(raw[field.key] ?? field.defaultValue ?? '').trim();
    if (!value && !field.optional) throw new Error(`${field.label} is required`);
    if (value.length > 4000) throw new Error(`${field.label} is too long`);
    if (value) creds[field.key] = value;
  }
  return creds;
}

function cleanOptions(raw: Partial<ImportOptions> | undefined): ImportOptions {
  const since = raw?.since ? new Date(raw.since) : null;
  return {
    archived: raw?.archived ?? DEFAULT_IMPORT_OPTIONS.archived,
    activity: raw?.activity ?? DEFAULT_IMPORT_OPTIONS.activity,
    offers: raw?.offers ?? DEFAULT_IMPORT_OPTIONS.offers,
    files: raw?.files ?? DEFAULT_IMPORT_OPTIONS.files,
    since: since && !Number.isNaN(since.getTime()) ? since.toISOString() : null,
  };
}

/** Turn vendor errors into something an admin can act on. Never echoes credentials. */
function connectionError(err: unknown): string {
  if (err instanceof ImportAuthError) {
    return err.status === 401
      ? 'The key was rejected. Check that you copied all of it, and that it has not been revoked.'
      : `The key works but is missing a permission: ${err.message}`;
  }
  if (err instanceof ImportHttpError) {
    if (err.status === 0) return 'Could not reach the provider. Check the subdomain/region and try again.';
    if (err.status === 404) return 'The provider could not find that account. Check the subdomain or company id.';
    return `The provider returned an error: ${err.message}`;
  }
  return err instanceof Error ? err.message : 'Connection failed';
}

async function verify(provider: string, creds: Credentials): Promise<{ accountName: string }> {
  const mod = getProvider(provider)!;
  const http = createHttpClient({
    auth: mod.auth(creds),
    minIntervalMs: mod.minIntervalMs,
    timeoutMs: mod.timeoutMs,
    deadline: Date.now() + 25_000,
    maxRetries: 1,
  });
  return mod.create(creds, http).verify();
}

export async function testImportConnection(
  ctx: SessionContext,
  provider: string,
  rawCredentials: Record<string, unknown>,
): Promise<{ ok: true; accountName: string } | { ok: false; error: string }> {
  requireAdmin(ctx);
  try {
    const creds = cleanCredentials(provider, rawCredentials);
    const { accountName } = await verify(provider, creds);
    return { ok: true, accountName };
  } catch (err) {
    return { ok: false, error: connectionError(err) };
  }
}

export async function startImport(
  ctx: SessionContext,
  provider: string,
  rawCredentials: Record<string, unknown>,
  rawOptions?: Partial<ImportOptions>,
): Promise<{ ok: true; jobId: string } | { ok: false; error: string }> {
  requireAdmin(ctx);
  let creds: Credentials;
  let accountName: string;
  try {
    creds = cleanCredentials(provider, rawCredentials);
    ({ accountName } = await verify(provider, creds));
  } catch (err) {
    return { ok: false, error: connectionError(err) };
  }

  const options = cleanOptions(rawOptions);
  const job = await db.$transaction(async (tx) => {
    // One import per org at a time — checked under a per-org lock so two
    // quick clicks can't both pass the check.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`import:${ctx.orgId}`}))`;
    const active = await tx.importJob.findFirst({
      where: { orgId: ctx.orgId, status: { in: [...ACTIVE_STATUSES, 'REVIEW'] } },
      select: { id: true },
    });
    if (active) return null;
    const created = await tx.importJob.create({
      data: {
        orgId: ctx.orgId,
        provider,
        accountName: accountName.slice(0, 200),
        credentials: sealCredentials(creds),
        options: options as Prisma.InputJsonValue,
        createdById: ctx.userId,
      },
      select: { id: true },
    });
    await tx.event.create({
      data: {
        orgId: ctx.orgId,
        actorType: 'user',
        actorId: ctx.userId,
        verb: 'import.started',
        subjectType: 'import',
        subjectId: created.id,
        payload: { provider, accountName, options },
      },
    });
    return created;
  });
  if (!job) return { ok: false, error: 'Another import is in progress. Finish or cancel it first.' };
  return { ok: true, jobId: job.id };
}

/** Returns false when the job had already finished (nothing to cancel). */
export async function cancelImport(ctx: SessionContext, jobId: string): Promise<boolean> {
  requireAdmin(ctx);
  const res = await db.importJob.updateMany({
    where: { id: jobId, orgId: ctx.orgId, status: { in: [...ACTIVE_STATUSES, 'REVIEW'] } },
    data: { status: 'CANCELED', credentials: null, cursor: Prisma.DbNull, finishedAt: new Date(), leaseUntil: null, leaseToken: null },
  });
  if (res.count) {
    await db.event.create({
      data: {
        orgId: ctx.orgId,
        actorType: 'user',
        actorId: ctx.userId,
        verb: 'import.canceled',
        subjectType: 'import',
        subjectId: jobId,
      },
    });
  }
  return res.count > 0;
}

// ---------- Review & confirm ----------

export type ReviewView = {
  stages: {
    key: string;
    name: string;
    count: number;
    /** Type to prefill when the admin switches this row to "create". */
    suggestedType: StageType;
    target: { stageId: string } | { create: { name: string; type: StageType } };
  }[];
  reasons: {
    key: string;
    name: string;
    kind: string;
    target: { reasonId: string } | { create: { name: string; countsAsRejection: boolean } };
  }[];
  existingStages: { id: string; name: string; type: StageType }[];
  existingReasons: { id: string; name: string }[];
  /** No applications in the org yet, so unmapped starter stages can go (MappingInput.replaceStarters). */
  canReplaceStarters: boolean;
  users: { total: number; matched: number; unmatchedNames: string[] };
};

async function previousRefs(orgId: string, provider: string, catalog: Catalog) {
  const ids = async (kind: string, groups: { externalIds: string[] }[]) =>
    (
      await Promise.all(
        chunks(groups.flatMap((g) => g.externalIds)).map((batch) =>
          db.importRef.findMany({
            where: { orgId, provider, kind, externalId: { in: batch } },
            select: { externalId: true, internalId: true },
          }),
        ),
      )
    ).flat();
  const [stages, reasons] = await Promise.all([ids('stage', catalog.stages), ids('reason', catalog.reasons)]);
  return {
    stages: new Map(stages.map((r) => [r.externalId, r.internalId])),
    reasons: new Map(reasons.map((r) => [r.externalId, r.internalId])),
  };
}

async function buildReview(orgId: string, provider: string, catalog: Catalog): Promise<ReviewView> {
  const [existingStages, existingReasons, users, applications] = await Promise.all([
    db.stage.findMany({ where: { orgId }, orderBy: { order: 'asc' }, select: { id: true, name: true, type: true } }),
    db.archiveReason.findMany({ where: { orgId }, orderBy: { name: 'asc' }, select: { id: true, name: true } }),
    db.user.findMany({ where: { orgId }, select: { email: true } }),
    db.opportunity.count({ where: { orgId } }),
  ]);
  const previous = await previousRefs(orgId, provider, catalog);
  // Drop prior targets that were deleted since; they fall back to name matching.
  for (const [ext, id] of previous.stages) if (!existingStages.some((s) => s.id === id)) previous.stages.delete(ext);
  for (const [ext, id] of previous.reasons) if (!existingReasons.some((r) => r.id === id)) previous.reasons.delete(ext);
  const defaults = defaultMapping(catalog, existingStages, existingReasons, previous);
  const emails = new Set(users.map((u) => u.email.toLowerCase()));
  const matched = catalog.users.filter((u) => u.email && emails.has(u.email));
  return {
    stages: catalog.stages.map((g) => ({
      key: g.key,
      name: g.name,
      count: g.externalIds.length,
      suggestedType: g.typeHint ?? inferStageType(g.name),
      target: defaults.stages[g.key],
    })),
    reasons: catalog.reasons.map((g) => ({ key: g.key, name: g.name, kind: g.kind, target: defaults.reasons[g.key] })),
    existingStages,
    existingReasons,
    canReplaceStarters: applications === 0,
    users: {
      total: catalog.users.length,
      matched: matched.length,
      unmatchedNames: catalog.users.filter((u) => !(u.email && emails.has(u.email))).map((u) => u.name).slice(0, 50),
    },
  };
}

/**
 * Apply the admin's mapping: create the new stages/reasons, record which
 * Source stage each vendor stage id became, match teammates by email, and
 * start loading data.
 */
export async function confirmImportMapping(ctx: SessionContext, jobId: string, input: MappingInput) {
  requireAdmin(ctx);
  const job = await db.importJob.findFirst({ where: { id: jobId, orgId: ctx.orgId, status: 'REVIEW' } });
  if (!job) throw new Error('This import is not waiting for review');
  const catalog = parseCatalog(job.catalog);

  await db.$transaction(
    async (tx) => {
      const stages = await tx.stage.findMany({ where: { orgId: ctx.orgId } });
      const reasons = await tx.archiveReason.findMany({ where: { orgId: ctx.orgId } });
      const stageIds = new Set(stages.map((s) => s.id));
      const reasonIds = new Set(reasons.map((r) => r.id));
      const reasonByName = new Map(reasons.map((r) => [nameKey(r.name), r.id]));

      const applied: AppliedMapping = { stages: {}, reasons: {} };

      // Stages: validate every target, then create new ones in pipeline order.
      const creates: { key: string; name: string; type: StageType; position: number | null }[] = [];
      for (const group of catalog.stages) {
        const target = input.stages[group.key];
        if (target && 'stageId' in target) {
          if (!stageIds.has(target.stageId)) throw new Error(`Pick a stage for "${group.name}"`);
          applied.stages[group.key] = target.stageId;
        } else {
          const name = (target?.create.name ?? group.name).trim().slice(0, 80) || group.name;
          const type = target?.create.type ?? 'SCREEN';
          if (!STAGE_TYPES.includes(type)) throw new Error(`Invalid stage type for "${group.name}"`);
          creates.push({ key: group.key, name, type, position: group.position });
        }
      }
      if (creates.length) {
        const ids = await insertStages(tx, ctx.orgId, orderNewStages(creates));
        for (const c of creates) applied.stages[c.key] = ids.get(nameKey(c.name))!;
      }

      for (const group of catalog.reasons) {
        const target = input.reasons[group.key];
        if (target && 'reasonId' in target) {
          if (!reasonIds.has(target.reasonId)) throw new Error(`Pick a reason for "${group.name}"`);
          applied.reasons[group.key] = target.reasonId;
          continue;
        }
        const name = (target?.create.name ?? group.name).trim().slice(0, 120) || group.name;
        let id = reasonByName.get(nameKey(name));
        if (!id) {
          const reason = await tx.archiveReason.create({
            data: {
              orgId: ctx.orgId,
              name,
              countsAsRejection: target?.create.countsAsRejection ?? countsAsRejection(group.kind),
            },
          });
          id = reason.id;
          reasonByName.set(nameKey(name), id);
        }
        applied.reasons[group.key] = id;
      }

      // Vendor ids → Source ids. On a re-run the admin may have chosen
      // differently this time; their latest choice wins for later records.
      for (const [kind, groups, targets] of [
        ['stage', catalog.stages, applied.stages],
        ['reason', catalog.reasons, applied.reasons],
      ] as const) {
        for (const g of groups) {
          for (const batch of chunks(g.externalIds)) {
            await tx.importRef.updateMany({
              where: { orgId: ctx.orgId, provider: job.provider, kind, externalId: { in: batch } },
              data: { internalId: targets[g.key] },
            });
          }
        }
      }
      if (input.replaceStarters) await dropUnmappedStarters(tx, ctx, applied);

      const refRows: Prisma.ImportRefCreateManyInput[] = [];
      for (const g of catalog.stages)
        for (const ext of g.externalIds)
          refRows.push({ orgId: ctx.orgId, provider: job.provider, kind: 'stage', externalId: ext, internalId: applied.stages[g.key], created: false, jobId });
      for (const g of catalog.reasons)
        for (const ext of g.externalIds)
          refRows.push({ orgId: ctx.orgId, provider: job.provider, kind: 'reason', externalId: ext, internalId: applied.reasons[g.key], created: false, jobId });

      const users = await tx.user.findMany({ where: { orgId: ctx.orgId }, select: { id: true, email: true } });
      const userByEmail = new Map(users.map((u) => [u.email.toLowerCase(), u.id]));
      for (const u of catalog.users) {
        const id = u.email ? userByEmail.get(u.email) : undefined;
        if (id) refRows.push({ orgId: ctx.orgId, provider: job.provider, kind: 'user', externalId: u.externalId, internalId: id, created: false, jobId });
      }
      for (const batch of chunks(refRows, 2_000)) {
        await tx.importRef.createMany({ data: batch, skipDuplicates: true });
      }

      // Only a job still in review moves on — not one canceled meanwhile.
      const moved = await tx.importJob.updateMany({
        where: { id: job.id, status: 'REVIEW' },
        data: {
          mapping: applied as unknown as Prisma.InputJsonValue,
          status: 'RUNNING',
          phase: null,
          cursor: Prisma.DbNull,
          leaseUntil: null,
          leaseToken: null,
        },
      });
      if (!moved.count) throw new Error('This import is not waiting for review');
    },
    { timeout: 60_000 },
  );
  // Stages were added (and maybe starters removed): pickers and filters list them.
  invalidateListMeta(ctx.orgId);
}

/**
 * A brand-new workspace importing its pipeline: remove the starter stages no
 * vendor stage maps to, so the pipeline is the vendor's rather than both.
 * Only while the org has no applications at all (checked here, not trusted
 * from the page), and one Applicant and one Hired stage always stay:
 * careers applications land in the first Applicant stage, and a move into
 * Hired is what records a hire.
 */
async function dropUnmappedStarters(tx: Prisma.TransactionClient, ctx: SessionContext, applied: AppliedMapping) {
  const orgId = ctx.orgId;
  if (await tx.opportunity.count({ where: { orgId } })) return;
  const stages = await tx.stage.findMany({ where: { orgId }, orderBy: { order: 'asc' } });
  const mapped = new Set(Object.values(applied.stages));
  const keep = new Set(mapped);
  for (const type of ['APPLICANT', 'HIRED'] as const) {
    if (!stages.some((s) => s.type === type && keep.has(s.id))) {
      const first = stages.find((s) => s.type === type);
      if (first) keep.add(first.id);
    }
  }
  const drop = stages.filter((s) => !keep.has(s.id));
  if (!drop.length) return;
  await tx.stage.deleteMany({ where: { orgId, id: { in: drop.map((s) => s.id) } } });
  for (const stage of drop) {
    await emitEvent(tx, {
      orgId,
      ...actorOf(ctx),
      verb: 'stage.deleted',
      subjectType: 'stage',
      subjectId: stage.id,
      payload: { name: stage.name },
    });
  }
}

// ---------- Progress ----------

export type ImportJobView = {
  id: string;
  provider: string;
  providerName: string;
  domain: string;
  status: ImportStatus;
  accountName: string | null;
  options: ImportOptions;
  phases: { id: string; label: string; group: 'discover' | 'load'; state: 'done' | 'current' | 'todo' }[];
  created: Record<string, number>;
  linked: Record<string, number>;
  stats: Record<string, number>;
  issues: ImportIssue[];
  issueCount: number;
  error: string | null;
  retrying: boolean;
  startedAt: string;
  finishedAt: string | null;
  review: ReviewView | null;
};

export async function getImportJob(ctx: SessionContext, jobId: string): Promise<ImportJobView | null> {
  requireAdmin(ctx);
  const job = await db.importJob.findFirst({ where: { id: jobId, orgId: ctx.orgId } });
  if (!job) return null;
  const meta = providerMeta(job.provider);
  const options = parseOptions(job.options);

  // While a job runs the page polls every few seconds, so read the loader's
  // running counters; count the ledger exactly once the job has ended.
  const stats = (job.stats ?? {}) as Record<string, number>;
  const created: Record<string, number> = {};
  const linked: Record<string, number> = {};
  if (ACTIVE_STATUSES.includes(job.status)) {
    for (const [k, v] of Object.entries(stats)) {
      const [bucket, kind] = k.split('.');
      if (bucket === 'created' && kind) created[kind] = v;
      if (bucket === 'linked' && kind) linked[kind] = v;
    }
  } else {
    const refCounts = await db.importRef.groupBy({
      by: ['kind', 'created'],
      where: { jobId: job.id },
      _count: { _all: true },
    });
    for (const r of refCounts) (r.created ? created : linked)[r.kind] = r._count._all;
  }

  const plan = planFor(job.provider, options);
  const ordered = plan
    ? [
        ...plan.discover.map((p) => ({ id: p.id, label: p.label, group: 'discover' as const })),
        ...plan.load.map((p) => ({ id: p.id, label: p.label, group: 'load' as const })),
      ]
    : [];
  const currentIdx =
    job.phase === DONE
      ? job.status === 'DISCOVERING'
        ? (plan?.discover.length ?? 0)
        : ordered.length
      : job.status === 'DISCOVERING'
      ? ordered.findIndex((p) => p.group === 'discover' && p.id === (job.phase ?? plan?.discover[0]?.id))
      : job.status === 'RUNNING'
        ? ordered.findIndex((p) => p.group === 'load' && p.id === (job.phase ?? plan?.load[0]?.id))
        : job.status === 'REVIEW'
          ? (plan?.discover.length ?? 0)
          : job.status === 'SUCCEEDED'
            ? ordered.length
            : -1;
  const phases = ordered.map((p, i) => ({
    ...p,
    state:
      job.status === 'FAILED' || job.status === 'CANCELED'
        ? ('todo' as const)
        : i < currentIdx
          ? ('done' as const)
          : i === currentIdx && job.status !== 'REVIEW'
            ? ('current' as const)
            : ('todo' as const),
  }));

  return {
    id: job.id,
    provider: job.provider,
    providerName: meta?.name ?? job.provider,
    domain: meta?.domain ?? '',
    status: job.status,
    accountName: job.accountName,
    options,
    phases,
    created,
    linked,
    stats: (job.stats ?? {}) as Record<string, number>,
    issues: parseIssues(job.issues),
    issueCount: job.issueCount,
    error: job.error,
    retrying: job.failures > 0 && ACTIVE_STATUSES.includes(job.status),
    startedAt: job.startedAt.toISOString(),
    finishedAt: job.finishedAt?.toISOString() ?? null,
    review: job.status === 'REVIEW' ? await buildReview(job.orgId, job.provider, parseCatalog(job.catalog)) : null,
  };
}

export type ImportJobSummary = {
  id: string;
  provider: string;
  providerName: string;
  domain: string;
  status: ImportStatus;
  accountName: string | null;
  startedAt: string;
  finishedAt: string | null;
  created: number;
};

export async function listImportJobs(ctx: SessionContext): Promise<ImportJobSummary[]> {
  requireAdmin(ctx);
  const jobs = await db.importJob.findMany({
    where: { orgId: ctx.orgId },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: { id: true, provider: true, status: true, accountName: true, startedAt: true, finishedAt: true },
  });
  const totals = await db.importRef.groupBy({
    by: ['jobId'],
    where: { jobId: { in: jobs.map((j) => j.id) }, created: true, kind: 'contact' },
    _count: { _all: true },
  });
  const byJob = new Map(totals.map((t) => [t.jobId, t._count._all]));
  return jobs.map((j) => {
    const meta = providerMeta(j.provider);
    return {
      id: j.id,
      provider: j.provider,
      providerName: meta?.name ?? j.provider,
      domain: meta?.domain ?? '',
      status: j.status,
      accountName: j.accountName,
      startedAt: j.startedAt.toISOString(),
      finishedAt: j.finishedAt?.toISOString() ?? null,
      created: byJob.get(j.id) ?? 0,
    };
  });
}

/** Org-scoped lookup the pump route uses before advancing a job. */
export async function importJobBelongsTo(ctx: SessionContext, jobId: string): Promise<boolean> {
  requireAdmin(ctx);
  return !!(await db.importJob.findFirst({ where: { id: jobId, orgId: ctx.orgId }, select: { id: true } }));
}
