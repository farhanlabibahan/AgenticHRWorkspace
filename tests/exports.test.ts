import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { hasDb } from './setup';
import { createOrg, day } from './fixtures';
import { db } from '@/lib/db';

/**
 * The CSV exports stream every row (they used to stop silently at 50,000
 * and 10,000), in keyset batches whose boundaries fall inside timestamp
 * ties; search says when a section has more than it shows.
 */
const session = vi.hoisted(() => ({ orgId: '' }));
vi.mock('@/lib/auth', () => ({
  auth: async () => ({ user: { id: 'u', orgId: session.orgId, accessRole: 'ADMIN' } }),
}));

const reports = await import('@/app/api/reports/export/route');
const audit = await import('@/app/api/audit/export/route');
const { searchAll, SEARCH_LIMITS } = await import('@/server/contacts');

const csvRows = (text: string) => text.trimEnd().split('\n').slice(1);

describe.skipIf(!hasDb)('streamed exports', () => {
  let orgId = '';

  beforeAll(async () => {
    const { org, stages } = await createOrg();
    orgId = org.id;
    session.orgId = orgId;
    const contacts = Array.from({ length: 2_500 }, (_, i) => ({
      id: randomUUID(),
      orgId,
      name: `Exp ${String(i).padStart(4, '0')}`,
    }));
    await db.contact.createMany({ data: contacts });
    // Seven createdAt values: every 1,000-row batch boundary lands inside a tie.
    await db.opportunity.createMany({
      data: contacts.map((c, i) => ({ orgId, contactId: c.id, stageId: stages[0].id, createdAt: day(i % 7) })),
    });
    await db.event.createMany({
      data: Array.from({ length: 2_600 }, (_, i) => ({
        orgId,
        actorType: 'system',
        verb: i % 2 ? 'opportunity.stage_changed' : 'contact.created',
        subjectType: 'opportunity',
        subjectId: `s-${i}`,
        occurredAt: day(i % 5),
      })),
    });
  });

  it('exports every opportunity, once each, newest first', async () => {
    const res = await reports.GET();
    expect(res.headers.get('content-type')).toContain('text/csv');
    const rows = csvRows(await res.text());
    expect(rows).toHaveLength(await db.opportunity.count({ where: { orgId } }));
    const names = rows.map((r) => r.split(',')[0]);
    expect(new Set(names).size).toBe(2_500);
    const created = rows.map((r) => r.split(',').at(-3)!);
    expect([...created].sort().reverse()).toEqual(created);
  });

  it('exports every matching audit event, once each', async () => {
    const all = csvRows(await (await audit.GET(new Request('http://x/api/audit/export'))).text());
    expect(all).toHaveLength(await db.event.count({ where: { orgId } }));
    const subjects = all.map((r) => r.split(',')[5]);
    expect(new Set(subjects).size).toBe(all.length);
    const filtered = csvRows(await (await audit.GET(new Request('http://x/api/audit/export?verb=stage_changed'))).text());
    expect(filtered).toHaveLength(1_300);
  });
});

describe.skipIf(!hasDb)('search limits', () => {
  it('orders deterministically and says when there are more', async () => {
    const { org } = await createOrg();
    await db.contact.createMany({
      data: Array.from({ length: SEARCH_LIMITS.people + 5 }, (_, i) => ({ orgId: org.id, name: `Zed ${String(i).padStart(2, '0')}` })),
    });
    const r = await searchAll(org.id, 'zed');
    expect(r.contacts).toHaveLength(SEARCH_LIMITS.people);
    expect(r.contacts.map((c) => c.name)).toEqual([...r.contacts.map((c) => c.name)].sort());
    expect(r.more.contacts).toBe(true);
    const few = await searchAll(org.id, 'zed 0');
    expect(few.more.contacts).toBe(false);
  });
});
