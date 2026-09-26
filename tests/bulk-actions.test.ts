import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasDb } from './setup';
import { candidate, createOrg } from './fixtures';
import { db } from '@/lib/db';

/**
 * A bulk edit is sent in chunks; only the last (final) chunk may re-render
 * the page. Revalidating a path — or expiring a cache tag — is what makes a
 * Server Action send a re-render back, so neither may happen before it.
 */
const calls = vi.hoisted(() => ({ paths: [] as string[], tags: [] as string[] }));
vi.mock('next/cache', () => ({
  revalidatePath: (p: string) => calls.paths.push(p),
  revalidateTag: (t: string) => calls.tags.push(t),
  unstable_cache: (fn: () => unknown) => fn,
}));
const session = vi.hoisted(() => ({ orgId: '', userId: '' }));
vi.mock('@/lib/session', () => ({
  requireSession: async () => ({ userId: session.userId, orgId: session.orgId, accessRole: 'SUPER_ADMIN' }),
  getAuthSession: async () => null,
  isAdmin: () => true,
}));
vi.mock('@/server/scheduling', () => ({ maybeAutoSendSchedulingLink: async () => {} }));

const actions = await import('@/app/(app)/actions');

describe.skipIf(!hasDb)('bulk actions revalidate once per run', () => {
  let opps: string[] = [];
  let contacts: string[] = [];
  let stages: { id: string }[] = [];
  let reasonId = '';
  let poolId = '';

  beforeAll(async () => {
    const org = await createOrg();
    session.orgId = org.org.id;
    session.userId = org.admin.id;
    stages = org.stages;
    for (let i = 0; i < 6; i++) {
      const c = await candidate(org.org.id, stages, [[0, 0]], { name: `Bulk ${i}` });
      opps.push(c.opportunity.id);
      contacts.push(c.contact.id);
    }
    reasonId = (await db.archiveReason.create({ data: { orgId: org.org.id, name: 'Other' } })).id;
    poolId = (await db.talentPool.create({ data: { orgId: org.org.id, name: 'P', kind: 'STATIC' } })).id;
  });
  beforeEach(() => {
    calls.paths = [];
    calls.tags = [];
  });

  const runs: [string, (final: boolean) => Promise<unknown>][] = [
    ['bulkMoveStageAction', (final) => actions.bulkMoveStageAction(opps.slice(0, 2), stages[1].id, final)],
    ['bulkArchiveAction', (final) => actions.bulkArchiveAction(opps.slice(2, 3), reasonId, final)],
    ['bulkTagAction', (final) => actions.bulkTagAction(contacts.slice(0, 2), 'vip', final)],
    ['addContactsToPoolAction', (final) => actions.addContactsToPoolAction(poolId, contacts.slice(0, 3), final)],
    ['removeContactsFromPoolAction', (final) => actions.removeContactsFromPoolAction(poolId, contacts.slice(0, 1), final)],
  ];

  for (const [name, run] of runs) {
    it(`${name}: nothing before the final chunk, then once`, async () => {
      await run(false);
      expect(calls.paths, name).toEqual([]);
      expect(calls.tags, name).toEqual([]);
      await run(true);
      expect(calls.paths.length, name).toBeGreaterThan(0);
      expect(calls.tags.length, name).toBe(1);
    });
  }

  it('still saves every chunk', async () => {
    await actions.bulkMoveStageAction(opps.slice(3, 5), stages[2].id, false);
    const moved = await db.opportunity.findMany({ where: { id: { in: opps.slice(3, 5) } } });
    expect(moved.every((o) => o.stageId === stages[2].id)).toBe(true);
  });

  it('treats a missing flag as final (older clients)', async () => {
    await (actions.bulkMoveStageAction as (ids: string[], s: string) => Promise<unknown>)(opps.slice(5), stages[1].id);
    expect(calls.paths).toContain('/pipeline');
  });

  it('revalidateListsAction expires every list cache and path', async () => {
    await actions.revalidateListsAction();
    expect(calls.paths).toEqual(expect.arrayContaining(['/pipeline', '/contacts', '/review']));
    expect(calls.tags).toEqual(
      expect.arrayContaining([`list-meta:${session.orgId}`, `pipeline-counts:${session.orgId}`, `contact-counts:${session.orgId}`]),
    );
  });
});
