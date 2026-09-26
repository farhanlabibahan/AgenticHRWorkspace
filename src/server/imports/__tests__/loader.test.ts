import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import path from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import { hasDb } from '../../../../tests/setup';
import { db } from '@/lib/db';
import { ImportAuthError } from '@/server/imports/http';
import { createLoader, type LoaderStats } from '@/server/imports/loader';
import { insertStages } from '@/server/imports/pipeline';
import { DEFAULT_IMPORT_OPTIONS, type Loader } from '@/server/imports/types';
import { MAX_EXTRACT_BYTES } from '@/server/text';

/**
 * Loader edge cases straight against the database: values Postgres would
 * reject, hires, stage placement, and files that are unsafe, forbidden, or
 * orphaned.
 */

let orgId = '';
let adminId = '';
let loader: Loader;
const stats: LoaderStats = {};
const warnings: string[] = [];

async function freshLoader() {
  return createLoader({
    orgId,
    orgKind: 'COMPANY',
    provider: 'acme',
    providerName: 'Acme ATS',
    jobId: `job-${randomUUID()}`,
    fallbackAuthorId: adminId,
    mapping: { stages: {}, reasons: {} },
    options: DEFAULT_IMPORT_OPTIONS,
    since: null,
    stats,
    warn: (m) => warnings.push(m),
  });
}

const person = (id: string, email: string) => ({ externalId: id, name: `Person ${id}`, emails: [email], phones: [], links: [] });

describe.skipIf(!hasDb)('import loader', () => {
  beforeAll(async () => {
    const org = await db.organization.create({ data: { slug: `loader-${randomUUID().slice(0, 8)}`, name: 'Loader Co', onboardedAt: new Date() } });
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
    loader = await freshLoader();
  });

  it('imports records containing NUL characters, lone surrogates, and out-of-range numbers', async () => {
    await loader.posting({ externalId: 'p-nul', title: 'Engi\u0000neer', state: 'open', salaryMin: 5_000_000_000, salaryMax: 9e15, description: 'a\u0000b\ud800c' });
    await loader.candidate({ ...person('c-nul', 'nul@example.test'), name: 'Ada\u0000 Lovelace', tags: ['x\u0000y'] });
    await loader.application({
      externalId: 'a-nul',
      candidateExternalId: 'c-nul',
      postingExternalId: 'p-nul',
      stage: { name: 'Phone screen' },
      status: 'active',
      fields: { 'Note\u0000': 'value\u0000' },
    });
    const posting = await db.posting.findFirstOrThrow({ where: { orgId, title: 'Engineer' } });
    expect(posting.salaryMin).toBe(2_147_483_647);
    expect(posting.content).toEqual({ description: 'ab�c' });
    const contact = await db.contact.findFirstOrThrow({ where: { orgId, name: 'Ada Lovelace' } });
    expect(contact.tags).toEqual(['xy']);
    const opp = await db.opportunity.findFirstOrThrow({ where: { orgId, contactId: contact.id } });
    expect(opp.customFields).toMatchObject({ imported: { fields: { Note: 'value' } } });
  });

  it('matches existing contacts by email regardless of case', async () => {
    const existing = await db.contact.create({ data: { orgId, name: 'Existing', emails: ['grace@example.test'], phones: [], links: [], tags: [] } });
    await loader.candidate(person('c-grace', 'Grace@Example.TEST'));
    expect(await db.contact.count({ where: { orgId, emails: { has: 'grace@example.test' } } })).toBe(1);
    const ref = await db.importRef.findFirstOrThrow({ where: { orgId, kind: 'contact', externalId: 'c-grace' } });
    expect(ref).toMatchObject({ internalId: existing.id, created: false });

    // A second address from the other system joins the existing contact.
    await loader.candidate({ ...person('c-grace-2', 'grace@example.test'), emails: ['grace@example.test', 'g.hopper@navy.test'] });
    expect((await db.contact.findUniqueOrThrow({ where: { id: existing.id } })).emails.sort()).toEqual(['g.hopper@navy.test', 'grace@example.test']);
  });

  it('puts a hired application in the Hired stage, like a hire made in Source', async () => {
    await loader.candidate(person('c-hire', 'hire@example.test'));
    await loader.application({
      externalId: 'a-hire',
      candidateExternalId: 'c-hire',
      stage: { name: 'Offer' },
      status: 'hired',
      archiveReason: { name: 'Hired' },
      archivedAt: new Date('2025-03-01T00:00:00Z'),
      createdAt: new Date('2025-01-01T00:00:00Z'),
      history: [{ stage: { name: 'Offer' }, at: new Date('2025-02-20T00:00:00Z') }],
    });
    const opp = await db.opportunity.findFirstOrThrow({
      where: { orgId, contact: { name: 'Person c-hire' } },
      include: { stage: true, stageTransitions: { orderBy: { occurredAt: 'asc' }, include: { toStage: true } } },
    });
    expect(opp).toMatchObject({ status: 'HIRED', archivedAt: null, archiveReasonId: null });
    expect(opp.stage.type).toBe('HIRED');
    expect(opp.stageTransitions.map((t) => t.toStage.name)).toEqual(['Offer', 'Hired']);
    expect(opp.stageChangedAt.toISOString()).toBe('2025-03-01T00:00:00.000Z');
  });

  it('places new stages where their type belongs, not after Hired', async () => {
    await db.$transaction((tx) =>
      insertStages(tx, orgId, [
        { name: 'Tech interview', type: 'SCREEN' },
        { name: 'Take-home', type: 'SCREEN' },
        { name: 'Sourced', type: 'LEAD' },
      ]),
    );
    // A stage seen only in data (not in the review) goes through the same path.
    await loader.candidate(person('c-stage', 'stage@example.test'));
    await loader.application({ externalId: 'a-stage', candidateExternalId: 'c-stage', stage: { name: 'Reference check' }, status: 'active' });
    const names = (await db.stage.findMany({ where: { orgId }, orderBy: { order: 'asc' } })).map((s) => s.name);
    expect(names).toEqual(['Sourced', 'New applicant', 'Phone screen', 'Tech interview', 'Take-home', 'On-site', 'Offer', 'Reference check', 'Hired']);
  });

  it('turns an offer waiting on approval into a draft', async () => {
    await loader.offer({ externalId: 'o-pending', applicationExternalId: 'a-stage', status: 'PENDING_APPROVAL', salaryAmount: 1e12 });
    const offer = await db.offer.findFirstOrThrow({ where: { orgId } });
    expect(offer.status).toBe('DRAFT');
    expect(offer.token).toMatch(/^[\w-]{32}$/); // so it can be sent from Source
    expect(offer.salaryAmount).toBe(2_147_483_647);
  });

  it('stores an HTML "resume" as a plain download and owns it by the candidate', async () => {
    await loader.file({
      externalId: 'f-html',
      candidateExternalId: 'c-stage',
      filename: 'resume.html',
      kind: 'resume',
      download: async () => ({ data: Buffer.from('<script>alert(1)</script>'), contentType: 'text/html' }),
    });
    const file = await db.storedFile.findFirstOrThrow({ where: { orgId, filename: 'resume.html' } });
    expect(file.mime).toBe('application/octet-stream');
    const contact = await db.contact.findFirstOrThrow({ where: { orgId, name: 'Person c-stage' } });
    expect(file.contactId).toBe(contact.id);
    expect(contact.resumeFileId).toBe(file.id);
  });

  it('stores a file whose name and extracted text contain NUL characters', async () => {
    await loader.candidate(person('c-nulfile', 'nulfile@example.test'));
    await loader.application({ externalId: 'a-nulfile', candidateExternalId: 'c-nulfile', stage: { name: 'Phone screen' }, status: 'active' });
    const pdf = readFileSync(path.join(__dirname, 'fixtures', 'nul-glyph.pdf'));
    await loader.file({
      externalId: 'f-nul',
      candidateExternalId: 'c-nulfile',
      filename: 'resume.pdf',
      kind: 'resume',
      download: async () => ({ data: pdf, contentType: 'application/pdf', filename: 'cv\u0000.pdf' }),
    });
    const contact = await db.contact.findFirstOrThrow({ where: { orgId, name: 'Person c-nulfile' }, include: { resumeFile: true } });
    expect(contact.resumeFile?.filename).toBe('cv.pdf');
    expect(contact.resumeText).not.toContain('\u0000');
    expect(contact.resumeText?.length).toBeGreaterThan(0);
  });

  it('reads the text of any resume format, whatever type the vendor sends', async () => {
    await loader.candidate(person('c-odt', 'odt@example.test'));
    const odt = readFileSync(path.join(__dirname, '../../text/__tests__/fixtures/resume.odt'));
    await loader.file({
      externalId: 'f-odt',
      candidateExternalId: 'c-odt',
      filename: 'resume.odt',
      kind: 'resume',
      download: async () => ({ data: odt, contentType: 'application/octet-stream' }),
    });
    const contact = await db.contact.findFirstOrThrow({ where: { orgId, name: 'Person c-odt' }, include: { resumeFile: true } });
    expect(contact.resumeText).toContain('Rowan Q. Testperson');
    expect(contact.resumeFile).toMatchObject({ mime: 'application/vnd.oasis.opendocument.text', textStatus: 'OK', textAttempts: 1 });
    // Imported resumes are never queued for parsing (src/server/resume-parse).
    expect(contact.resumeFile).toMatchObject({ parseStatus: null, parseQueuedAt: null, parseAttempts: 0 });
  });

  it('stores a resume too large to read, marked TOO_LARGE', async () => {
    await loader.candidate(person('c-big', 'big@example.test'));
    const big = Buffer.alloc(MAX_EXTRACT_BYTES + 1, 0x20);
    big.write('%PDF-1.7\n');
    await loader.file({
      externalId: 'f-big',
      candidateExternalId: 'c-big',
      filename: 'resume.pdf',
      kind: 'resume',
      download: async () => ({ data: big, contentType: 'application/pdf' }),
    });
    const contact = await db.contact.findFirstOrThrow({ where: { orgId, name: 'Person c-big' }, include: { resumeFile: true } });
    expect(contact.resumeText).toBeNull();
    expect(contact.resumeFile).toMatchObject({ size: MAX_EXTRACT_BYTES + 1, textStatus: 'TOO_LARGE' });
  });

  it('skips one forbidden download without failing, and leaves orphan attachments for a later run', async () => {
    await loader.file({
      externalId: 'f-403',
      candidateExternalId: 'c-stage',
      filename: 'cover.pdf',
      kind: 'other',
      download: async () => {
        throw new ImportAuthError(403, 'GET api.acme.test/files/9');
      },
    });
    expect(warnings.some((w) => w.includes('cover.pdf'))).toBe(true);
    expect(await db.importRef.count({ where: { orgId, kind: 'file', externalId: 'f-403' } })).toBe(0);

    await loader.candidate(person('c-noapp', 'noapp@example.test'));
    let fetched = false;
    await loader.file({
      externalId: 'f-orphan',
      candidateExternalId: 'c-noapp',
      filename: 'portfolio.pdf',
      kind: 'other',
      download: async () => {
        fetched = true;
        return { data: Buffer.from('%PDF'), contentType: 'application/pdf' };
      },
    });
    expect(fetched).toBe(false);
    expect(await db.importRef.count({ where: { orgId, kind: 'file', externalId: 'f-orphan' } })).toBe(0);
  });

  it('deletes imported attachments when retention anonymizes the candidate', async () => {
    await loader.file({
      externalId: 'f-cover',
      candidateExternalId: 'c-stage',
      filename: 'cover.pdf',
      kind: 'other',
      download: async () => ({ data: Buffer.from('%PDF-1.4'), contentType: 'application/pdf' }),
    });
    const contact = await db.contact.findFirstOrThrow({ where: { orgId, name: 'Person c-stage' } });
    expect(await db.storedFile.count({ where: { contactId: contact.id } })).toBe(2);

    await db.opportunity.updateMany({ where: { contactId: contact.id }, data: { status: 'ARCHIVED', archivedAt: new Date('2020-01-01') } });
    await db.organization.update({ where: { id: orgId }, data: { retentionMonths: 12 } });
    const { processRetention } = await import('@/server/retention');

    // Not while an import is still running for the org...
    const job = await db.importJob.create({ data: { orgId, provider: 'acme', status: 'RUNNING', options: {} } });
    await processRetention();
    expect((await db.contact.findUniqueOrThrow({ where: { id: contact.id } })).isAnonymized).toBe(false);

    // ...then files and all.
    await db.importJob.update({ where: { id: job.id }, data: { status: 'SUCCEEDED' } });
    await processRetention();
    expect((await db.contact.findUniqueOrThrow({ where: { id: contact.id } })).isAnonymized).toBe(true);
    expect(await db.storedFile.count({ where: { orgId, filename: { in: ['cover.pdf', 'resume.html'] } } })).toBe(0);
    expect(await db.note.count({ where: { orgId, body: { contains: 'Attachment: cover.pdf' } } })).toBe(0);
  });
});
