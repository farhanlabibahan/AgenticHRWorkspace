import { describe, expect, it } from 'vitest';
import { hasDb } from './setup';
import { createOrg } from './fixtures';
import { db } from '@/lib/db';
import { addGroups, removeGroups } from '@/server/org';

/** Adding client companies and departments in bulk (onboarding and Settings). */

describe.skipIf(!hasDb)('addGroups', () => {
  it('adds new names once, skipping ones the org has in any capitalization', async () => {
    const { org, admin } = await createOrg();
    const ctx = { userId: admin.id, orgId: org.id, accessRole: 'SUPER_ADMIN' as const };
    await addGroups(ctx, 'client', ['Acme, Inc.']);

    const result = await addGroups(ctx, 'client', ['acme, inc.', 'Globex', 'GLOBEX', 'Initech']);
    expect(result.created.map((c) => c.name)).toEqual(['Globex', 'Initech']);
    expect(result.existing).toBe(1);
    const names = (await db.clientCompany.findMany({ where: { orgId: org.id }, orderBy: { name: 'asc' } })).map((c) => c.name);
    expect(names).toEqual(['Acme, Inc.', 'Globex', 'Initech']);
    // Webhooks and the activity log see each one, as when added one at a time.
    expect(await db.event.count({ where: { orgId: org.id, verb: 'client_company.created' } })).toBe(3);
  });

  it('undoes a batch without touching anything else, or another org', async () => {
    const { org, admin } = await createOrg();
    const other = await createOrg();
    const ctx = { userId: admin.id, orgId: org.id, accessRole: 'SUPER_ADMIN' as const };
    const kept = await addGroups(ctx, 'department', ['Design']);
    const batch = await addGroups(ctx, 'department', ['Sales', 'Support']);
    const theirs = await addGroups({ ...ctx, userId: other.admin.id, orgId: other.org.id }, 'department', ['Sales']);

    await removeGroups(ctx, 'department', [...batch.created.map((d) => d.id), theirs.created[0].id]);
    expect((await db.department.findMany({ where: { orgId: org.id } })).map((d) => d.id)).toEqual([kept.created[0].id]);
    expect(await db.department.count({ where: { orgId: other.org.id } })).toBe(1);
  });
});
