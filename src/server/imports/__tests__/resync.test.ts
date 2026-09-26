import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { beforeAll, describe, expect, it } from 'vitest';
import { hasDb } from '../../../../tests/setup';
import { db } from '@/lib/db';
import { createLoader, type LoaderStats } from '@/server/imports/loader';
import { fingerprint, mergeField, mergeList, mergeRecord } from '@/server/imports/resync';
import { DEFAULT_IMPORT_OPTIONS, type ImportedApplication, type ImportedCandidate, type ImportOptions } from '@/server/imports/types';

/**
 * Re-imports: a second import updates what changed at the vendor and keeps
 * what the team changed in Source.
 */

describe('merge rules', () => {
  it('takes a vendor change only where Source still has what the last import wrote', () => {
    expect(mergeField('Engineer', 'Engineer', 'Staff Engineer', true)).toMatchObject({ value: 'Staff Engineer', changed: true });
    expect(mergeField('Engineer', 'Principal', 'Staff Engineer', true)).toMatchObject({ value: 'Principal', kept: true });
    expect(mergeField('Engineer', 'Principal', 'Engineer', true)).toMatchObject({ value: 'Principal', changed: false, kept: false });
  });

  it('with no record of the last import, only fills what is empty', () => {
    expect(mergeField(undefined, null, 'Berlin', false)).toMatchObject({ value: 'Berlin', changed: true });
    expect(mergeField(undefined, 'Paris', 'Berlin', false)).toMatchObject({ value: 'Paris', kept: true });
  });

  it('only grows lists, ignoring case', () => {
    expect(mergeList(['a@x.test'], ['a@x.test', 'mine@x.test'], ['A@x.test', 'new@x.test'], true).value).toEqual([
      'a@x.test',
      'mine@x.test',
      'new@x.test',
    ]);
    // Removed at the vendor: stays in Source.
    expect(mergeList(['a@x.test', 'b@x.test'], ['a@x.test', 'b@x.test'], ['a@x.test'], true)).toMatchObject({ changed: false });
  });

  it('compares dates by instant and ignores download functions in fingerprints', () => {
    // A snapshot holds the ISO string; Source and the vendor hand over Dates.
    const snapshot = { at: '2025-01-01T00:00:00.000Z' } as unknown as { at: Date };
    expect(mergeRecord(snapshot, { at: new Date('2025-01-01') }, { at: new Date('2025-01-01') }, { baseKnown: true }).update).toEqual({});
    expect(fingerprint({ id: 1, download: () => 1 })).toBe(fingerprint({ id: 1, download: () => 2 }));
    expect(fingerprint({ b: 1, a: 2 })).toBe(fingerprint({ a: 2, b: 1 }));
  });
});

let orgId = '';
let adminId = '';
const stage = async (name: string) => (await db.stage.findFirstOrThrow({ where: { orgId, name } })).id;

function run(options: Partial<ImportOptions> = {}, updates = true) {
  const stats: LoaderStats = {};
  const loader = createLoader({
    orgId,
    orgKind: 'COMPANY',
    provider: 'acme',
    providerName: 'Acme ATS',
    jobId: `job-${randomUUID()}`,
    fallbackAuthorId: adminId,
    mapping: { stages: {}, reasons: {} },
    options: { ...DEFAULT_IMPORT_OPTIONS, ...options },
    since: null,
    // A millisecond after anything already written: a real re-run starts minutes
    // later, and one begun in the same millisecond would count the last run's
    // writes (syncedAt >= startedAt) as its own and skip them.
    startedAt: new Date(Date.now() + 1),
    updates,
    stats,
    warn: () => {},
  });
  return { loader, stats };
}

const person = (id: string, over: Partial<ImportedCandidate> = {}): ImportedCandidate => ({
  externalId: id,
  name: `Person ${id}`,
  emails: [`${id}@example.test`],
  phones: [],
  links: [],
  headline: 'Engineer',
  ...over,
});

const application = (id: string, candidate: string, over: Partial<ImportedApplication> = {}): ImportedApplication => ({
  externalId: id,
  candidateExternalId: candidate,
  stage: { name: 'Phone screen' },
  status: 'active',
  createdAt: new Date('2025-01-01T00:00:00Z'),
  history: [{ stage: { name: 'Phone screen' }, at: new Date('2025-01-02T00:00:00Z') }],
  ...over,
});

async function opportunity(externalId: string) {
  const ref = await db.importRef.findFirstOrThrow({ where: { orgId, kind: 'opportunity', externalId } });
  return db.opportunity.findUniqueOrThrow({
    where: { id: ref.internalId },
    include: { stageTransitions: { orderBy: { occurredAt: 'asc' }, include: { toStage: true } }, stage: true, contact: true },
  });
}

describe.skipIf(!hasDb)('re-imports', () => {
  beforeAll(async () => {
    const org = await db.organization.create({ data: { slug: `resync-${randomUUID().slice(0, 8)}`, name: 'Resync Co', onboardedAt: new Date() } });
    orgId = org.id;
    adminId = (await db.user.create({ data: { orgId, email: `a-${org.slug}@test.local`, name: 'Admin', accessRole: 'ADMIN' } })).id;
    await db.stage.createMany({
      data: [
        { orgId, name: 'New applicant', type: 'APPLICANT', order: 0 },
        { orgId, name: 'Phone screen', type: 'SCREEN', order: 1 },
        { orgId, name: 'On-site', type: 'ONSITE', order: 2 },
        { orgId, name: 'Offer', type: 'OFFER', order: 3 },
        { orgId, name: 'Hired', type: 'HIRED', order: 4 },
      ],
    });
    await db.archiveReason.create({ data: { orgId, name: 'Underqualified', countsAsRejection: true } });
  });

  it('leaves records alone for an importer that has not opted into updates', async () => {
    const first = run({}, false);
    await first.loader.candidate(person('c0'));
    await first.loader.application(application('a0', 'c0'));
    const again = run({}, false);
    await again.loader.candidate(person('c0', { headline: 'Staff Engineer' }));
    await again.loader.application(application('a0', 'c0', { stage: { name: 'Offer' } }));
    const a0 = await opportunity('a0');
    expect(a0.stage.name).toBe('Phone screen');
    expect(a0.contact.headline).toBe('Engineer');
    expect(again.stats).toMatchObject({ 'contact.existing': 1, 'opportunity.existing': 1 });
  });

  it('writes nothing for records that did not change', async () => {
    const first = run();
    await first.loader.candidate(person('c1'));
    await first.loader.application(application('a1', 'c1'));
    const before = await opportunity('a1');

    const again = run();
    await again.loader.candidate(person('c1'));
    await again.loader.application(application('a1', 'c1'));
    expect(again.stats).toMatchObject({ 'unchanged.contact': 1, 'unchanged.opportunity': 1 });
    const after = await opportunity('a1');
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect(after.contact.updatedAt).toEqual(before.contact.updatedAt);
  });

  it('takes what changed at the vendor and keeps what the team changed in Source', async () => {
    const first = run();
    await first.loader.candidate(person('c2', { location: null }));
    await first.loader.application(application('a2', 'c2'));
    const opp = await opportunity('a2');
    // The team renames the candidate in Source.
    await db.contact.update({ where: { id: opp.contactId }, data: { name: 'Robin Q. Person' } });

    const again = run();
    await again.loader.candidate(
      person('c2', { name: 'Person c2 (renamed at the vendor)', headline: 'Staff Engineer', location: 'Berlin', emails: ['c2@example.test', 'c2@work.test'] }),
    );
    const contact = await db.contact.findUniqueOrThrow({ where: { id: opp.contactId } });
    expect(contact).toMatchObject({ name: 'Robin Q. Person', headline: 'Staff Engineer', location: 'Berlin' });
    expect(contact.emails).toEqual(['c2@example.test', 'c2@work.test']);
    expect(again.stats).toMatchObject({ 'updated.contact': 1, 'kept.contact': 1 });
  });

  it('follows a move at the vendor, adding it to the history, unless someone moved the candidate in Source', async () => {
    const first = run();
    await first.loader.candidate(person('c3'));
    await first.loader.application(application('a3', 'c3'));
    await first.loader.candidate(person('c4'));
    await first.loader.application(application('a4', 'c4'));
    // Someone moves a4 in Source.
    const a4 = await opportunity('a4');
    await db.opportunity.update({ where: { id: a4.id }, data: { stageId: await stage('On-site'), stageChangedAt: new Date() } });

    const moved = (id: string, c: string) =>
      application(id, c, {
        stage: { name: 'Offer' },
        history: [
          { stage: { name: 'Phone screen' }, at: new Date('2025-01-02T00:00:00Z') },
          { stage: { name: 'On-site' }, at: new Date('2025-02-01T00:00:00Z') },
          { stage: { name: 'Offer' }, at: new Date('2025-03-01T00:00:00Z') },
        ],
      });
    const again = run();
    await again.loader.application(moved('a3', 'c3'));
    await again.loader.application(moved('a4', 'c4'));

    const a3 = await opportunity('a3');
    expect(a3.stage.name).toBe('Offer');
    expect(a3.stageTransitions.map((t) => t.toStage.name)).toEqual(['Phone screen', 'On-site', 'Offer']);
    expect(a3.stageChangedAt.toISOString()).toBe('2025-03-01T00:00:00.000Z');
    expect((await opportunity('a4')).stage.name).toBe('On-site');
    expect(again.stats).toMatchObject({ 'updated.opportunity': 1, 'kept.opportunity': 1 });
  });

  it('archives what the vendor archived, even when archived records are left out of the import', async () => {
    const first = run({ archived: false });
    await first.loader.candidate(person('c5'));
    await first.loader.application(application('a5', 'c5'));
    const again = run({ archived: false });
    await again.loader.application(application('a5', 'c5', { status: 'archived', archiveReason: { name: 'Underqualified' }, archivedAt: new Date('2025-04-01T00:00:00Z') }));
    // …while a new archived application still isn't imported.
    await again.loader.application(application('a5-new', 'c5', { status: 'archived' }));
    const a5 = await opportunity('a5');
    expect(a5).toMatchObject({ status: 'ARCHIVED', archivedAt: new Date('2025-04-01T00:00:00Z') });
    expect(a5.archiveReasonId).not.toBeNull();
    expect(await db.importRef.count({ where: { orgId, externalId: 'a5-new' } })).toBe(0);
  });

  it('merges records imported before re-imports carefully: untouched ones follow, contacts only fill blanks', async () => {
    const first = run();
    await first.loader.candidate(person('c6', { headline: null }));
    await first.loader.application(application('a6', 'c6'));
    // What an import from before this change left behind.
    await db.importRef.updateMany({ where: { orgId, externalId: { in: ['c6', 'a6'] } }, data: { fingerprint: null, snapshot: Prisma.DbNull } });

    const again = run();
    await again.loader.candidate(person('c6', { name: 'Someone Else', headline: 'Designer' }));
    await again.loader.application(application('a6', 'c6', { stage: { name: 'On-site' } }));
    const a6 = await opportunity('a6');
    expect(a6.stage.name).toBe('On-site');
    expect(a6.contact).toMatchObject({ name: 'Person c6', headline: 'Designer' });
    // Now it has a snapshot: the next run merges normally.
    expect((await db.importRef.findFirstOrThrow({ where: { orgId, externalId: 'a6' } })).snapshot).not.toBeNull();
  });

  it('updates an edited note, and never brings back one deleted in Source', async () => {
    const first = run();
    await first.loader.candidate(person('c7'));
    await first.loader.application(application('a7', 'c7'));
    await first.loader.note({ externalId: 'n1', applicationExternalId: 'a7', body: 'First take' });
    await first.loader.note({ externalId: 'n2', applicationExternalId: 'a7', body: 'Deleted later' });
    const n2 = await db.importRef.findFirstOrThrow({ where: { orgId, kind: 'note', externalId: 'n2' } });
    await db.note.delete({ where: { id: n2.internalId } });

    const again = run();
    await again.loader.note({ externalId: 'n1', applicationExternalId: 'a7', body: 'Second take' });
    await again.loader.note({ externalId: 'n2', applicationExternalId: 'a7', body: 'Deleted later, edited' });
    const n1 = await db.importRef.findFirstOrThrow({ where: { orgId, kind: 'note', externalId: 'n1' } });
    expect((await db.note.findUniqueOrThrow({ where: { id: n1.internalId } })).body).toContain('Second take');
    expect(await db.note.count({ where: { id: n2.internalId } })).toBe(0);
    expect(again.stats).toMatchObject({ 'updated.note': 1, 'note.gone': 1 });
  });

  it('closes a job the vendor closed while it is still a draft here, but not one the team published', async () => {
    const first = run();
    await first.loader.posting({ externalId: 'p1', title: 'Designer', state: 'open' });
    await first.loader.posting({ externalId: 'p2', title: 'Engineer', state: 'open' });
    const p2 = await db.importRef.findFirstOrThrow({ where: { orgId, kind: 'posting', externalId: 'p2' } });
    await db.posting.update({ where: { id: p2.internalId }, data: { state: 'PUBLISHED' } });

    const again = run();
    await again.loader.posting({ externalId: 'p1', title: 'Designer', state: 'closed' });
    await again.loader.posting({ externalId: 'p2', title: 'Engineer', state: 'closed' });
    const p1 = await db.importRef.findFirstOrThrow({ where: { orgId, kind: 'posting', externalId: 'p1' } });
    expect((await db.posting.findUniqueOrThrow({ where: { id: p1.internalId } })).state).toBe('CLOSED');
    expect((await db.posting.findUniqueOrThrow({ where: { id: p2.internalId } })).state).toBe('PUBLISHED');
  });

  it("replaces a resume the last import set with a newer one, but not a resume from the careers page", async () => {
    const pdf = (text: string) => Buffer.from(`Rowan Q. Testperson résumé ${text}`);
    const first = run();
    await first.loader.candidate(person('c8'));
    await first.loader.application(application('a8', 'c8'));
    await first.loader.file({ externalId: 'r1', candidateExternalId: 'c8', filename: 'old.txt', kind: 'resume', download: async () => ({ data: pdf('old'), contentType: 'text/plain' }) });

    const again = run();
    await again.loader.file({ externalId: 'r1', candidateExternalId: 'c8', filename: 'old.txt', kind: 'resume', download: async () => ({ data: pdf('old'), contentType: 'text/plain' }) });
    await again.loader.file({ externalId: 'r2', candidateExternalId: 'c8', filename: 'new.txt', kind: 'resume', download: async () => ({ data: pdf('newer'), contentType: 'text/plain' }) });
    const contact = (await opportunity('a8')).contact;
    const r2 = await db.importRef.findFirstOrThrow({ where: { orgId, kind: 'file', externalId: 'r2' } });
    expect(contact.resumeFileId).toBe(r2.internalId);
    expect(contact.resumeText).toContain('newer');

    // A resume that didn't come from the import stays.
    const careers = await db.storedFile.create({ data: { orgId, key: `${orgId}/careers.txt`, filename: 'cv.txt', mime: 'text/plain', size: 3, contactId: contact.id } });
    await db.contact.update({ where: { id: contact.id }, data: { resumeFileId: careers.id } });
    const third = run();
    await third.loader.file({ externalId: 'r3', candidateExternalId: 'c8', filename: 'newest.txt', kind: 'resume', download: async () => ({ data: pdf('newest'), contentType: 'text/plain' }) });
    expect((await db.contact.findUniqueOrThrow({ where: { id: contact.id } })).resumeFileId).toBe(careers.id);
  });
});
