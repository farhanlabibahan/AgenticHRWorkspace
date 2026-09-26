import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasDb } from './setup';
import { candidate, createOrg } from './fixtures';
import { db } from '@/lib/db';

/**
 * Every write path that changes what the lists' cached meta and counts show
 * expires them (revalidateTag with expire: 0, so the next read recomputes).
 */
const tags = vi.hoisted(() => ({ calls: [] as { tag: string; profile: unknown }[] }));
vi.mock('next/cache', () => ({
  revalidateTag: (tag: string, profile: unknown) => tags.calls.push({ tag, profile }),
  revalidatePath: () => {},
  unstable_cache: (fn: () => unknown) => fn,
}));
vi.mock('@/lib/session', () => ({ isAdmin: () => true }));
vi.mock('@/server/scheduling', () => ({ maybeAutoSendSchedulingLink: async () => {} }));

const { createStage, renameStage, setStageOrder, deleteStage } = await import('@/server/stages');
const { createPosting } = await import('@/server/postings');
const { setOrgKind, addGroups, removeDepartment, removeClientCompany } = await import('@/server/org');
const { createCandidate, moveStage, archiveOpportunity, unarchiveOpportunity } = await import('@/server/opportunities');
const { snoozeOpportunity } = await import('@/server/tasks');
const { mergeContacts, setContactTags, importContactRows } = await import('@/server/contacts');
const { loadListMeta } = await import('@/server/list-meta');

const expired = (tag: string) => tags.calls.filter((c) => c.tag === tag && JSON.stringify(c.profile) === '{"expire":0}');

describe.skipIf(!hasDb)('list cache invalidation', () => {
  let orgId = '';
  let stages: { id: string }[] = [];
  let ctx: { userId: string; orgId: string; accessRole: string };

  beforeAll(async () => {
    const org = await createOrg();
    orgId = org.org.id;
    stages = org.stages;
    ctx = { userId: org.admin.id, orgId, accessRole: 'SUPER_ADMIN' };
  });
  beforeEach(() => {
    tags.calls = [];
  });

  it('expires the meta on stage, posting, department, client and org-kind changes', async () => {
    const steps: [string, () => Promise<unknown>][] = [];
    let stageId = '';
    let deptId = '';
    let clientId = '';
    steps.push(['createStage', async () => (stageId = (await createStage(ctx, 'Extra', 'SCREEN')).id)]);
    steps.push(['renameStage', () => renameStage(ctx, stageId, 'Extra 2')]);
    steps.push([
      'setStageOrder',
      async () => {
        const ids = (await db.stage.findMany({ where: { orgId: ctx.orgId }, orderBy: { order: 'asc' } })).map((s) => s.id);
        await setStageOrder(ctx, [...ids].reverse());
      },
    ]);
    steps.push(['deleteStage', () => deleteStage(ctx, stageId)]);
    steps.push(['addGroups department', async () => (deptId = (await addGroups(ctx, 'department', ['Design'])).created[0].id)]);
    steps.push(['removeDepartment', () => removeDepartment(ctx, deptId)]);
    steps.push(['addGroups client', async () => (clientId = (await addGroups(ctx, 'client', ['Acme'])).created[0].id)]);
    steps.push(['removeClientCompany', () => removeClientCompany(ctx, clientId)]);
    steps.push(['createPosting', () => createPosting(ctx, { title: 'Designer', workplaceType: 'REMOTE', commitment: 'FULL_TIME' })]);
    steps.push(['setOrgKind', () => setOrgKind(ctx, 'AGENCY')]);
    for (const [name, run] of steps) {
      tags.calls = [];
      await run();
      expect(expired(`list-meta:${orgId}`), name).toHaveLength(1);
    }
  });

  it('expires the tile counts on every opportunity change', async () => {
    const reason = await db.archiveReason.create({ data: { orgId, name: 'Not a fit' } });
    const created = await createCandidate(ctx, { name: 'Counted', stageId: stages[0].id, origin: 'SOURCED' });
    expect(expired(`pipeline-counts:${orgId}`)).toHaveLength(1);
    expect(expired(`contact-counts:${orgId}`)).toHaveLength(1);
    const steps: [string, () => Promise<unknown>][] = [
      ['moveStage', () => moveStage(ctx, created.id, stages[1].id)],
      ['archiveOpportunity', () => archiveOpportunity(ctx, created.id, reason.id)],
      ['unarchiveOpportunity', () => unarchiveOpportunity(ctx, created.id)],
      ['snooze', () => snoozeOpportunity(ctx, created.id, new Date(Date.now() + 86_400_000))],
      ['unsnooze', () => snoozeOpportunity(ctx, created.id, null)],
    ];
    for (const [name, run] of steps) {
      tags.calls = [];
      await run();
      expect(expired(`pipeline-counts:${orgId}`), name).toHaveLength(1);
    }
  });

  it('expires contact counts on tags, merges and CSV imports', async () => {
    const a = await candidate(orgId, stages, [[0, 0]], { name: 'Merge A' });
    const b = await candidate(orgId, stages, [[0, 0]], { name: 'Merge B' });
    await setContactTags(ctx, a.contact.id, ['vip']);
    expect(expired(`contact-counts:${orgId}`)).toHaveLength(1);
    tags.calls = [];
    await mergeContacts(ctx, a.contact.id, b.contact.id);
    expect(expired(`contact-counts:${orgId}`)).toHaveLength(1);
    expect(expired(`pipeline-counts:${orgId}`)).toHaveLength(1);
    tags.calls = [];
    await importContactRows(ctx, ['name'], [['From CSV']], 2);
    expect(expired(`contact-counts:${orgId}`)).toHaveLength(1);
  });

  it('builds JSON-safe meta for the data cache', async () => {
    const meta = await loadListMeta(orgId);
    expect(JSON.parse(JSON.stringify(meta))).toEqual(meta);
    expect(meta.stages.length).toBeGreaterThan(0);
    expect(meta.kind).toBe('AGENCY');
  });
});
