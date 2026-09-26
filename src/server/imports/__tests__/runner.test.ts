import { randomUUID } from 'crypto';
import type { Prisma } from '@prisma/client';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { hasDb } from '../../../../tests/setup';
import { db } from '@/lib/db';
import { sealCredentials } from '@/server/imports/crypto';
import { YieldError } from '@/server/imports/http';
import { registerProviderForTests } from '@/server/imports/providers';
import { processImports, runSlice } from '@/server/imports/runner';
import type { Phase, PhaseContext, ProviderModule } from '@/server/imports/types';

vi.mock('@/lib/session', () => ({ isAdmin: () => true }));
const cacheTags = vi.hoisted(() => ({ expired: [] as string[] }));
vi.mock('next/cache', () => ({
  revalidateTag: (tag: string) => cacheTags.expired.push(tag),
  revalidatePath: () => {},
  unstable_cache: (fn: () => unknown) => fn,
}));

/**
 * The runner's concurrency and failure guarantees, with a scriptable fake
 * provider whose single load phase does whatever the test tells it to.
 */

type Script = (step: number, cursor: unknown, ctx: PhaseContext) => Promise<unknown>;
let script: Script = async () => null;
let discoverScript: (ctx: PhaseContext) => Promise<void> = async () => undefined;
let runs = 0;

const scripted: ProviderModule = {
  id: 'scripted',
  minIntervalMs: 0,
  auth: () => ({ hosts: [] }),
  create() {
    const load: Phase[] = [
      {
        id: 'work',
        label: 'Work',
        run: async (ctx, cursor) => (await script(runs++, cursor, ctx)) as never,
      },
    ];
    const discover: Phase[] = [{ id: 'setup', label: 'Setup', run: async (ctx) => (await discoverScript(ctx), null) }];
    return { verify: async () => ({ accountName: 'Scripted' }), discover, load };
  },
};

let orgId = '';
let adminId = '';

async function job(data: Partial<Prisma.ImportJobUncheckedCreateInput> = {}) {
  return db.importJob.create({
    data: {
      orgId,
      provider: 'scripted',
      status: 'RUNNING',
      credentials: sealCredentials({}),
      options: {},
      mapping: { stages: {}, reasons: {} },
      createdById: adminId,
      ...data,
    },
  });
}

const reload = (id: string) => db.importJob.findUniqueOrThrow({ where: { id } });

describe.skipIf(!hasDb)('import runner', () => {
  beforeAll(async () => {
    process.env.AUTH_SECRET ||= 'test-secret';
    registerProviderForTests(scripted);
    const org = await db.organization.create({ data: { slug: `runner-${randomUUID().slice(0, 8)}`, name: 'Runner Co', onboardedAt: new Date() } });
    orgId = org.id;
    adminId = (await db.user.create({ data: { orgId, email: `a-${org.slug}@test.local`, name: 'Admin', accessRole: 'ADMIN' } })).id;
  });

  it("holds the job until the vendor's Retry-After instead of hammering it", async () => {
    runs = 0;
    script = async () => {
      throw new YieldError(Date.now() + 60 * 60_000);
    };
    const j = await job();
    expect(await runSlice(j.id, 5_000)).toBe('waiting');
    const held = await reload(j.id);
    expect(held.leaseUntil!.getTime()).toBeGreaterThan(Date.now() + 20 * 60_000);
    expect(held.leaseToken).toBeNull();

    expect(await runSlice(j.id, 5_000)).toBe('busy');
    const { slices } = await processImports(6_000);
    expect(slices).toBe(0);
    expect(runs).toBe(1); // one request, then silence
    await db.importJob.update({ where: { id: j.id }, data: { status: 'CANCELED' } });
  });

  it('counts failures consecutively: a slice that made progress resets the count', async () => {
    runs = 0;
    // Each slice: one successful page, then a transient error.
    script = async (step) => {
      if (step % 2 === 1) throw new Error('upstream hiccup');
      return { page: step };
    };
    const j = await job();
    for (let i = 0; i < 14; i++) {
      await runSlice(j.id, 60_000);
      await db.importJob.update({ where: { id: j.id }, data: { leaseUntil: null } }); // skip the backoff wait
    }
    const after = await reload(j.id);
    expect(after.status).toBe('RUNNING');
    expect(after.failures).toBe(1);
    expect(after.cursor).toMatchObject({ page: expect.any(Number) });
    await db.importJob.update({ where: { id: j.id }, data: { status: 'CANCELED' } });
  });

  it('resumes a job whose phases all finished straight at the finish, without replaying them', async () => {
    runs = 0;
    script = async () => null;
    cacheTags.expired = [];
    const j = await job({ phase: '$done' });
    expect(await runSlice(j.id, 5_000)).toBe('worked');
    expect(runs).toBe(0);
    const done = await reload(j.id);
    expect(done.status).toBe('SUCCEEDED');
    // The lists' cached meta and counts are expired once the import lands.
    expect(cacheTags.expired).toEqual(
      expect.arrayContaining([`list-meta:${orgId}`, `pipeline-counts:${orgId}`, `contact-counts:${orgId}`]),
    );
    expect(done.credentials).toBeNull();
  });

  it("fences writes: a slice that lost its lease can't overwrite the new holder's progress", async () => {
    runs = 0;
    const j = await job({ cursor: { page: 'before' } });
    script = async () => {
      // Mid-step, another worker takes the job over.
      await db.importJob.update({ where: { id: j.id }, data: { leaseToken: 'someone-else', cursor: { page: 'theirs' } } });
      return { page: 'stale' };
    };
    await runSlice(j.id, 5_000);
    const after = await reload(j.id);
    expect(after.cursor).toEqual({ page: 'theirs' });
    expect(after.leaseToken).toBe('someone-else');
    await db.importJob.update({ where: { id: j.id }, data: { status: 'CANCELED', leaseToken: null } });
  });

  it('treats a slice that died mid-step as a failure, and gives up on a job that keeps dying', async () => {
    runs = 0;
    script = async () => ({ page: 1 });
    // A token left behind with an expired lease: the last slice never came back.
    const crashed = await job({ leaseToken: 'dead', leaseUntil: new Date(Date.now() - 1000), failures: 2 });
    await runSlice(crashed.id, 5_000);
    expect((await reload(crashed.id)).failures).toBe(0); // counted (3), then the step's progress reset it

    const doomed = await job({ leaseToken: 'dead', leaseUntil: new Date(Date.now() - 1000), failures: 9 });
    await runSlice(doomed.id, 5_000);
    const failed = await reload(doomed.id);
    expect(failed.status).toBe('FAILED');
    expect(failed.error).toMatch(/kept stopping/);
    expect(failed.credentials).toBeNull();
  });

  it('keeps going when vendor text in a warning or the catalog has characters Postgres rejects', async () => {
    runs = 0;
    script = async (step, _cursor, ctx) => {
      ctx.warn('Scorecards: HTTP 404: not\u0000found', { externalId: 'x\u0000y' });
      return step < 2 ? { page: step + 1 } : null;
    };
    const j = await job();
    for (let i = 0; i < 10 && (await reload(j.id)).status === 'RUNNING'; i++) await runSlice(j.id, 5_000);
    const done = await reload(j.id);
    expect(done.status).toBe('SUCCEEDED');
    expect(done.issues).toEqual([expect.objectContaining({ message: 'Scorecards: HTTP 404: notfound', count: 3 })]);

    discoverScript = async (ctx) => ctx.catalog.stage({ externalId: 's1', name: 'Culture fit \ud83d' });
    const d = await job({ status: 'DISCOVERING', mapping: undefined });
    await runSlice(d.id, 5_000);
    const reviewed = await reload(d.id);
    expect(reviewed.status).toBe('REVIEW');
    expect(reviewed.catalog).toMatchObject({ stages: [{ name: 'Culture fit \ufffd' }] });
    await db.importJob.update({ where: { id: d.id }, data: { status: 'CANCELED' } });
  });

  it("doesn't chain another cron run for a job something else is holding", async () => {
    await db.importJob.updateMany({ where: { status: { in: ['DISCOVERING', 'RUNNING'] } }, data: { status: 'CANCELED' } });
    const held = await job({ leaseUntil: new Date(Date.now() + 90_000) });
    expect(await processImports(6_000)).toEqual({ slices: 0, more: false });
    await db.importJob.update({ where: { id: held.id }, data: { status: 'CANCELED' } });
  });

  it('gives up on a vendor that keeps saying "wait" with no progress, and wipes the key', async () => {
    runs = 0;
    script = async () => {
      throw new YieldError(Date.now() + 60_000);
    };
    const j = await job({ stats: { 'job.waits': 48 } });
    await runSlice(j.id, 5_000);
    const failed = await reload(j.id);
    expect(failed.status).toBe('FAILED');
    expect(failed.error).toMatch(/kept asking Source to wait/);
    expect(failed.credentials).toBeNull();
  });

  it('cancels jobs left at the review step for a week and wipes their key', async () => {
    const stale = await job({ status: 'REVIEW' });
    const fresh = await job({ status: 'REVIEW' });
    await db.$executeRaw`UPDATE "ImportJob" SET "updatedAt" = now() - interval '8 days' WHERE id = ${stale.id}`;
    await processImports(1_000);
    expect(await reload(stale.id)).toMatchObject({ status: 'CANCELED', credentials: null });
    expect((await reload(fresh.id)).status).toBe('REVIEW');
    await db.importJob.update({ where: { id: fresh.id }, data: { status: 'CANCELED' } });
  });
});
