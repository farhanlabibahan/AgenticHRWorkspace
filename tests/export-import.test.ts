import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { hasDb } from './setup';
import { candidate, createOrg } from './fixtures';
import { db } from '@/lib/db';

const auth = vi.hoisted(() => ({ session: null as null | { user: { orgId: string; accessRole: string } } }));
vi.mock('@/lib/auth', () => ({ auth: async () => auth.session }));

const { GET } = await import('@/app/api/export/route');

async function counts(orgId: string) {
  const [contacts, opportunities, transitions, interviews, panel, notes, events] = await Promise.all([
    db.contact.count({ where: { orgId } }),
    db.opportunity.count({ where: { orgId } }),
    db.stageTransition.count({ where: { opportunity: { orgId } } }),
    db.interview.count({ where: { orgId } }),
    db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "_InterviewPanelists" p JOIN "Interview" i ON i.id = p."A" WHERE i."orgId" = ${orgId}`,
    db.note.count({ where: { orgId } }),
    db.event.count({ where: { orgId } }),
  ]);
  return { contacts, opportunities, transitions, interviews, panel: panel[0].n, notes, events };
}

describe.skipIf(!hasDb)('org export → import-org round trip', () => {
  let orgId = '';

  beforeAll(async () => {
    const { org, stages, admin } = await createOrg();
    orgId = org.id;
    // More rows than one export batch (1,000), so paging is exercised.
    for (let i = 0; i < 1_100; i++) {
      await db.contact.create({ data: { orgId, name: `Contact ${i}`, emails: [`c${i}@x.com`], resumeText: `resume ${i}` } });
    }
    const { opportunity } = await candidate(orgId, stages, [[0, 0], [1, 2]], { name: 'Piped' });
    await db.interview.create({
      data: { orgId, opportunityId: opportunity.id, title: 'Screen', startAt: new Date(), panelists: { connect: [{ id: admin.id }] } },
    });
    await db.note.create({ data: { orgId, opportunityId: opportunity.id, authorId: admin.id, body: 'Strong "yes", with commas' } });
    await db.event.create({ data: { orgId, actorType: 'system', verb: 'org.created', subjectType: 'organization', subjectId: orgId } });
    await db.importRef.createMany({
      data: [
        { orgId, provider: 'lever', kind: 'opportunity', externalId: 'opp-1', internalId: opportunity.id },
        { orgId, provider: 'lever', kind: 'contact', externalId: 'erased-1', internalId: 'deleted-contact-id' },
      ],
    });
  });

  it('refuses non-admins', async () => {
    auth.session = { user: { orgId, accessRole: 'TEAM_MEMBER' } };
    expect((await GET()).status).toBe(403);
  });

  it('streams a complete export that imports into an identical org', async () => {
    auth.session = { user: { orgId, accessRole: 'SUPER_ADMIN' } };
    const response = await GET();
    expect(response.headers.get('content-disposition')).toMatch(/attachment; filename="source-export-/);
    const text = await response.text();
    const dump = JSON.parse(text);
    expect(dump.exportVersion).toBe(2);
    expect(dump.contacts).toHaveLength(1_101);

    const file = path.join(mkdtempSync(path.join(tmpdir(), 'source-export-')), 'export.json');
    writeFileSync(file, text);
    const slug = `copy-${Date.now()}`;
    execFileSync('node', ['scripts/import-org.mjs', file, '--slug', slug], {
      env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL, DIRECT_URL: process.env.TEST_DATABASE_URL },
      stdio: 'pipe',
    });

    const copy = await db.organization.findUniqueOrThrow({ where: { slug } });
    expect(await counts(copy.id)).toEqual(await counts(orgId));
    const note = await db.note.findFirstOrThrow({ where: { orgId: copy.id } });
    expect(note.body).toBe('Strong "yes", with commas');
    // Import refs follow their records to the new ids; a tombstone stays one.
    const refs = await db.importRef.findMany({ where: { orgId: copy.id }, orderBy: { externalId: 'asc' } });
    const copiedOpp = await db.opportunity.findFirstOrThrow({ where: { orgId: copy.id, contact: { name: 'Piped' } } });
    expect(refs.map((r) => r.externalId)).toEqual(['erased-1', 'opp-1']);
    expect(refs[1].internalId).toBe(copiedOpp.id);
    expect(refs[0].internalId).not.toBe('deleted-contact-id');
  });

  it('exports one consistent snapshot even while the org is being written to', async () => {
    auth.session = { user: { orgId, accessRole: 'SUPER_ADMIN' } };
    const reader = (await GET()).body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    // Read until the contacts collection is finished, then write a new
    // candidate whose contact id sorts before everything already exported.
    while (!text.includes('"postings":[')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    const stages = await db.stage.findMany({ where: { orgId }, orderBy: { order: 'asc' } });
    const late = await db.contact.create({
      data: { id: '00000000-0000-4000-8000-000000000000', orgId, name: 'Arrived mid-export' },
    });
    await db.opportunity.create({ data: { orgId, contactId: late.id, stageId: stages[0].id } });
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    const dump = JSON.parse(text);
    const contactIds = new Set(dump.contacts.map((c: { id: string }) => c.id));
    const dangling = dump.opportunities.filter((o: { contactId: string }) => !contactIds.has(o.contactId));
    expect(dangling).toEqual([]);
  });
});
