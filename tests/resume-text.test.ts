import { randomUUID } from 'node:crypto';
import { chmodSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { TextStatus } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasDb } from './setup';
import { createOrg } from './fixtures';
import { db } from '@/lib/db';
import { mergeContacts } from '@/server/contacts';
import { processResumeText } from '@/server/resume-text';
import { storeFile } from '@/server/storage';
import { EXTRACTOR_VERSION, MAX_EXTRACT_BYTES, type ExtractResult } from '@/server/text';

/**
 * The resume-text backfill against the database, with extraction and the
 * self-test stubbed: which files it claims, when it retries, and what it
 * refuses to write.
 */

const MIN = 60_000;
const okSelfTest = async () => ({ ok: true, worker: 'in-process' as const, results: [] });

/** A stand-in for extractText that records which files it read. The text names the file. */
function fakeExtract(status: TextStatus = 'OK', opts: { delayMs?: number; links?: string[]; onCall?: (fileId: string) => Promise<void> } = {}) {
  const calls: string[] = [];
  const extract = async ({ fileId }: { fileId?: string }): Promise<ExtractResult> => {
    calls.push(fileId!);
    await opts.onCall?.(fileId!);
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    return {
      status,
      format: 'pdf',
      text: status === 'OK' ? `Résumé of ${fileId}` : null,
      links: opts.links ?? [],
      error: status === 'FAILED' ? 'Error: synthetic failure' : undefined,
      ms: 1,
      version: EXTRACTOR_VERSION,
    };
  };
  return { extract, calls };
}

/** A contact whose resume is stored but has no text yet. */
async function pending(orgId: string, opts: { anonymized?: boolean; emails?: string[]; phones?: string[]; links?: string[] } = {}) {
  const file = await storeFile({ orgId, filename: 'resume.pdf', mime: 'application/pdf', data: Buffer.from('%PDF-1.4 synthetic') });
  const contact = await db.contact.create({
    data: {
      orgId,
      name: 'Rowan Q. Testperson',
      emails: opts.emails ?? [`rowan-${randomUUID().slice(0, 6)}@example.test`],
      phones: opts.phones ?? [],
      links: opts.links ?? [],
      resumeFileId: file.id,
      isAnonymized: opts.anonymized ?? false,
    },
  });
  return { file, contact };
}

const fileState = (id: string) =>
  db.storedFile.findUniqueOrThrow({ where: { id }, select: { textStatus: true, textVersion: true, textAttempts: true, textError: true } });

describe.skipIf(!hasDb)('resume text backfill', () => {
  const env = { ...process.env };
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {}); // the per-run summary line
  });
  afterEach(() => {
    process.env = { ...env };
    vi.restoreAllMocks();
  });

  it('fills in text for resumes that have none', async () => {
    const { org } = await createOrg();
    const { file, contact } = await pending(org.id);
    const selfTest = vi.fn(okSelfTest);
    const { extract, calls } = fakeExtract();

    const run = await processResumeText({ orgId: org.id, extract, selfTest });

    expect(run).toMatchObject({ selfTest: 'ok', claimed: 1, written: 1, lost: 0, more: false, byStatus: { OK: 1 } });
    expect(selfTest).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([file.id]);
    expect((await db.contact.findUniqueOrThrow({ where: { id: contact.id } })).resumeText).toBe(`Résumé of ${file.id}`);
    expect(await fileState(file.id)).toEqual({ textStatus: 'OK', textVersion: EXTRACTOR_VERSION, textAttempts: 1, textError: null });
    // Text that arrives in the background never queues the resume for parsing.
    expect(await db.storedFile.findUniqueOrThrow({ where: { id: file.id }, select: { parseStatus: true } })).toEqual({ parseStatus: null });

    // Nothing left: no self-test, no claims.
    const again = await processResumeText({ orgId: org.id, extract, selfTest });
    expect(again).toMatchObject({ selfTest: 'skipped', claimed: 0 });
    expect(selfTest).toHaveBeenCalledTimes(1);
  });

  it('reads stored resumes with the real extractor and self-test', async () => {
    const { org } = await createOrg();
    const fixtures = path.join(__dirname, '../src/server/text/__tests__/fixtures');
    const odt = await storeFile({ orgId: org.id, filename: 'cv.odt', mime: 'application/octet-stream', data: readFileSync(path.join(fixtures, 'resume.odt')) });
    const contact = await db.contact.create({ data: { orgId: org.id, name: 'Rowan Q. Testperson', resumeFileId: odt.id } });

    const run = await processResumeText({ orgId: org.id });
    expect(run).toMatchObject({ selfTest: 'ok', claimed: 1, written: 1 });
    expect((await db.contact.findUniqueOrThrow({ where: { id: contact.id } })).resumeText).toContain('Rowan Q. Testperson');
  });

  it("doesn't retry an EMPTY resume until the extractor version changes", async () => {
    const { org } = await createOrg();
    const { file } = await pending(org.id);
    const empty = fakeExtract('EMPTY');

    await processResumeText({ orgId: org.id, extract: empty.extract, selfTest: okSelfTest });
    await processResumeText({ orgId: org.id, extract: empty.extract, selfTest: okSelfTest, now: () => new Date(Date.now() + 60 * MIN) });
    expect(empty.calls).toEqual([file.id]);
    expect(await fileState(file.id)).toMatchObject({ textStatus: 'EMPTY', textAttempts: 1 });

    const upgraded = fakeExtract();
    const run = await processResumeText({ orgId: org.id, version: EXTRACTOR_VERSION + 1, extract: upgraded.extract, selfTest: okSelfTest });
    expect(run.written).toBe(1);
    expect(await fileState(file.id)).toMatchObject({ textStatus: 'OK', textVersion: EXTRACTOR_VERSION + 1, textAttempts: 1 });
  });

  it('retries a FAILED resume after 15 minutes, at most 3 times', async () => {
    const { org } = await createOrg();
    const { file } = await pending(org.id);
    const { extract, calls } = fakeExtract('FAILED');
    const t0 = Date.now();
    const at = (minutes: number) => () => new Date(t0 + minutes * MIN);

    await processResumeText({ orgId: org.id, extract, selfTest: okSelfTest, now: at(0) });
    expect(await fileState(file.id)).toMatchObject({ textStatus: 'FAILED', textAttempts: 1, textError: 'Error: synthetic failure' });

    await processResumeText({ orgId: org.id, extract, selfTest: okSelfTest, now: at(10) });
    expect(calls).toHaveLength(1);

    await processResumeText({ orgId: org.id, extract, selfTest: okSelfTest, now: at(16) });
    await processResumeText({ orgId: org.id, extract, selfTest: okSelfTest, now: at(32) });
    expect(await fileState(file.id)).toMatchObject({ textStatus: 'FAILED', textAttempts: 3 });

    await processResumeText({ orgId: org.id, extract, selfTest: okSelfTest, now: at(120) });
    expect(calls).toHaveLength(3);
  });

  it('retries a claim that never finished (a crash mid-file) like a failure', async () => {
    const { org } = await createOrg();
    const { file } = await pending(org.id);
    const t0 = Date.now();
    await db.storedFile.update({
      where: { id: file.id },
      data: { textVersion: EXTRACTOR_VERSION, textAttempts: 1, textStatus: null, textCheckedAt: new Date(t0) },
    });
    const { extract, calls } = fakeExtract();

    await processResumeText({ orgId: org.id, extract, selfTest: okSelfTest, now: () => new Date(t0 + 5 * MIN) });
    expect(calls).toHaveLength(0);
    await processResumeText({ orgId: org.id, extract, selfTest: okSelfTest, now: () => new Date(t0 + 16 * MIN) });
    expect(await fileState(file.id)).toMatchObject({ textStatus: 'OK', textAttempts: 2 });
  });

  it('skips anonymized contacts', async () => {
    const { org } = await createOrg();
    const { file } = await pending(org.id, { anonymized: true });
    const { extract, calls } = fakeExtract();

    const run = await processResumeText({ orgId: org.id, extract, selfTest: okSelfTest });
    expect(run.claimed).toBe(0);
    expect(calls).toEqual([]);
    expect(await fileState(file.id)).toMatchObject({ textStatus: null, textVersion: null });
  });

  it("writes nothing when the resume is swapped or the contact anonymized while it's being read", async () => {
    const { org } = await createOrg();
    const swapped = await pending(org.id);
    const erased = await pending(org.id);
    const replacement = await storeFile({ orgId: org.id, filename: 'new.pdf', mime: 'application/pdf', data: Buffer.from('%PDF-1.4 new') });
    const { extract } = fakeExtract('OK', {
      onCall: async (fileId) => {
        if (fileId === swapped.file.id) {
          await db.contact.update({ where: { id: swapped.contact.id }, data: { resumeFileId: replacement.id } });
        }
        if (fileId === erased.file.id) {
          await db.contact.update({ where: { id: erased.contact.id }, data: { isAnonymized: true, name: 'Anonymized candidate' } });
        }
      },
    });

    await processResumeText({ orgId: org.id, extract, selfTest: okSelfTest });

    // The replacement became the pending resume and got its own text; the old file's text never landed.
    expect((await db.contact.findUniqueOrThrow({ where: { id: swapped.contact.id } })).resumeText).toBe(`Résumé of ${replacement.id}`);
    expect((await db.contact.findUniqueOrThrow({ where: { id: erased.contact.id } })).resumeText).toBeNull();
    expect(await fileState(swapped.file.id)).toMatchObject({ textStatus: 'OK' });
  });

  it('runs one at a time: a run that starts while another is going does nothing', async () => {
    const { org } = await createOrg();
    const files = [];
    for (let i = 0; i < 6; i++) files.push((await pending(org.id)).file.id);
    const { extract, calls } = fakeExtract('OK', { delayMs: 20 });

    const runs = await Promise.all([
      processResumeText({ orgId: org.id, extract, selfTest: okSelfTest }),
      processResumeText({ orgId: org.id, extract, selfTest: okSelfTest }),
    ]);

    expect(calls.sort()).toEqual(files.sort());
    expect(runs.map((r) => r.busy ?? false).sort()).toEqual([false, true]);
    expect(runs.find((r) => r.busy)).toMatchObject({ claimed: 0, more: false });
    expect(runs[0].written + runs[1].written).toBe(6);
    // Released at the end: the next run goes ahead.
    expect((await processResumeText({ orgId: org.id, extract, selfTest: okSelfTest })).busy).toBeUndefined();
  });

  it('waits out the lease of a live run, and takes over one a dead run left behind', async () => {
    const { org } = await createOrg();
    await pending(org.id);
    const { extract } = fakeExtract();
    const name = `resume-text:${org.id}`;
    await db.cronLease.create({ data: { name, leaseUntil: new Date(Date.now() + 60_000), token: 'another-run' } });
    expect(await processResumeText({ orgId: org.id, extract, selfTest: okSelfTest })).toMatchObject({ busy: true, claimed: 0, more: false });

    await db.cronLease.update({ where: { name }, data: { leaseUntil: new Date(Date.now() - 1) } });
    expect(await processResumeText({ orgId: org.id, extract, selfTest: okSelfTest })).toMatchObject({ claimed: 1, written: 1 });
  });

  it('stops at a file it cannot save, instead of spinning on the same batch until the budget runs out', async () => {
    const { org } = await createOrg();
    await pending(org.id);
    await pending(org.id);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Writes rejected while reads work, as on a database over its storage quota.
    await db.$executeRawUnsafe(`CREATE FUNCTION reject_write() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'project size limit exceeded'; END $$ LANGUAGE plpgsql`);
    await db.$executeRawUnsafe(`CREATE TRIGGER reject_write BEFORE UPDATE ON "StoredFile" FOR EACH ROW WHEN (OLD."orgId" = '${org.id}') EXECUTE FUNCTION reject_write()`);
    try {
      const run = await processResumeText({ orgId: org.id, budgetMs: 2_000, extract: fakeExtract().extract, selfTest: okSelfTest });
      expect(run).toMatchObject({ claimed: 0, more: false });
      expect(run.error).toContain('project size limit exceeded');
      expect(run.ms).toBeLessThan(1_000);
      expect(errors).toHaveBeenCalledTimes(1);
    } finally {
      await db.$executeRawUnsafe('DROP TRIGGER reject_write ON "StoredFile"');
      await db.$executeRawUnsafe('DROP FUNCTION reject_write');
    }
  });

  it.skipIf(process.getuid?.() === 0)('records a storage error by its code, not its message, which names the file', async () => {
    const { org } = await createOrg();
    const file = await storeFile({ orgId: org.id, filename: 'Rowan_Q_Testperson_resume.pdf', mime: 'application/pdf', data: Buffer.from('%PDF-1.4 synthetic') });
    await db.contact.create({ data: { orgId: org.id, name: 'Rowan Q. Testperson', resumeFileId: file.id } });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onDisk = path.join(process.cwd(), '.data', 'uploads', file.key);
    chmodSync(onDisk, 0o000); // exists, can't be read: EACCES
    try {
      await processResumeText({ orgId: org.id, extract: fakeExtract().extract, selfTest: okSelfTest });
    } finally {
      chmodSync(onDisk, 0o644);
    }
    expect(await fileState(file.id)).toMatchObject({ textStatus: 'FAILED', textError: 'Error: EACCES' });
    expect(JSON.stringify(errors.mock.calls)).not.toContain('Testperson');
  });

  it('stops when the budget runs out and asks to be run again', async () => {
    const { org } = await createOrg();
    for (let i = 0; i < 3; i++) await pending(org.id);
    const { extract } = fakeExtract('OK', { delayMs: 600 });

    const first = await processResumeText({ orgId: org.id, budgetMs: 1_000, extract, selfTest: okSelfTest });
    expect(first.more).toBe(true);
    expect(first.claimed).toBeGreaterThan(0);
    expect(first.claimed).toBeLessThan(3);

    const rest = await processResumeText({ orgId: org.id, extract, selfTest: okSelfTest });
    expect(rest).toMatchObject({ more: false, claimed: 3 - first.claimed });
  });

  it('marks a resume whose stored bytes are gone as MISSING', async () => {
    const { org } = await createOrg();
    const file = await db.storedFile.create({
      data: { orgId: org.id, key: `${org.id}/gone-${randomUUID()}.pdf`, filename: 'resume.pdf', mime: 'application/pdf', size: 2_000 },
    });
    await db.contact.create({ data: { orgId: org.id, name: 'Rowan Q. Testperson', resumeFileId: file.id } });
    const { extract, calls } = fakeExtract();

    const run = await processResumeText({ orgId: org.id, extract, selfTest: okSelfTest });
    expect(run.byStatus).toEqual({ MISSING: 1 });
    expect(calls).toEqual([]);
    expect(await fileState(file.id)).toMatchObject({ textStatus: 'MISSING' });
  });

  it('marks an oversized resume TOO_LARGE without reading it', async () => {
    const { org } = await createOrg();
    // No bytes behind the key: a read would come back MISSING.
    const file = await db.storedFile.create({
      data: { orgId: org.id, key: `${org.id}/big-${randomUUID()}.pdf`, filename: 'resume.pdf', mime: 'application/pdf', size: MAX_EXTRACT_BYTES + 1 },
    });
    await db.contact.create({ data: { orgId: org.id, name: 'Rowan Q. Testperson', resumeFileId: file.id } });
    const { extract, calls } = fakeExtract();

    await processResumeText({ orgId: org.id, extract, selfTest: okSelfTest });
    expect(calls).toEqual([]);
    expect(await fileState(file.id)).toMatchObject({ textStatus: 'TOO_LARGE' });
  });

  it('does nothing where files are not stored', async () => {
    const { org } = await createOrg();
    const { file } = await pending(org.id);
    process.env.VERCEL = '1'; // Vercel with no bucket or Blob store
    delete process.env.S3_BUCKET;
    delete process.env.BLOB_READ_WRITE_TOKEN;
    const selfTest = vi.fn(okSelfTest);

    const run = await processResumeText({ orgId: org.id, extract: fakeExtract().extract, selfTest });
    expect(run).toMatchObject({ selfTest: 'skipped', claimed: 0 });
    expect(selfTest).not.toHaveBeenCalled();
    expect(await fileState(file.id)).toMatchObject({ textVersion: null });
  });

  it('claims nothing when the self-test fails', async () => {
    const { org } = await createOrg();
    const { file } = await pending(org.id);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { extract, calls } = fakeExtract();
    const broken = async () => ({
      ok: false,
      worker: 'thread' as const,
      results: [{ format: 'pdf' as const, status: 'FAILED' as const, ms: 3, match: false }],
    });

    const run = await processResumeText({ orgId: org.id, extract, selfTest: broken });
    expect(run).toMatchObject({ selfTest: 'failed', claimed: 0, error: 'Self-test failed: pdf FAILED' });
    expect(calls).toEqual([]);
    expect(await fileState(file.id)).toMatchObject({ textVersion: null, textAttempts: 0 });
  });

  it('never touches logos or attachments', async () => {
    const { org } = await createOrg();
    const { contact } = await pending(org.id);
    const logo = await storeFile({ orgId: org.id, filename: 'logo.png', mime: 'image/png', data: Buffer.from('png') });
    await db.organization.update({ where: { id: org.id }, data: { logoFileId: logo.id } });
    const attachment = await storeFile({ orgId: org.id, filename: 'cover.pdf', mime: 'application/pdf', data: Buffer.from('%PDF-1.4 cover') });
    await db.storedFile.update({ where: { id: attachment.id }, data: { contactId: contact.id } });
    const { extract, calls } = fakeExtract();

    const run = await processResumeText({ orgId: org.id, extract, selfTest: okSelfTest });
    expect(run.claimed).toBe(1);
    expect(calls).not.toContain(logo.id);
    expect(calls).not.toContain(attachment.id);
    expect(await fileState(logo.id)).toMatchObject({ textVersion: null, textStatus: null });
    expect(await fileState(attachment.id)).toMatchObject({ textVersion: null, textStatus: null });
  });

  it('writes the text only, never emails, phones or links', async () => {
    const { org } = await createOrg();
    const { contact } = await pending(org.id, { emails: ['rowan@example.test'], phones: ['+1 555 010 4477'], links: ['https://rowan.example.test'] });
    const { extract } = fakeExtract('OK', { links: ['https://www.example.test/in/someone-else'] });

    await processResumeText({ orgId: org.id, extract, selfTest: okSelfTest });

    const after = await db.contact.findUniqueOrThrow({ where: { id: contact.id } });
    expect(after.resumeText).toMatch(/^Résumé of /);
    expect(after).toMatchObject({ emails: ['rowan@example.test'], phones: ['+1 555 010 4477'], links: ['https://rowan.example.test'] });
  });
});

describe.skipIf(!hasDb)('merging contacts', () => {
  it("keeps the kept resume's own text, never the other contact's", async () => {
    const { org, admin } = await createOrg();
    const ctx = { userId: admin.id, orgId: org.id, accessRole: 'SUPER_ADMIN' };
    const withFile = await pending(org.id); // resume not read yet
    const otherFile = await storeFile({ orgId: org.id, filename: 'other.pdf', mime: 'application/pdf', data: Buffer.from('%PDF-1.4 other') });
    const withText = await db.contact.create({
      data: { orgId: org.id, name: 'R. Testperson', resumeFileId: otherFile.id, resumeText: 'Text of the other résumé' },
    });

    const merged = await mergeContacts(ctx, withFile.contact.id, withText.id);
    expect(merged).toMatchObject({ resumeFileId: withFile.file.id, resumeText: null });

    // A primary without a resume takes the duplicate's file and text together.
    const bare = await db.contact.create({ data: { orgId: org.id, name: 'Rowan Testperson' } });
    const fromDuplicate = await mergeContacts(ctx, bare.id, merged.id);
    expect(fromDuplicate).toMatchObject({ resumeFileId: withFile.file.id, resumeText: null });
    const third = await db.contact.create({ data: { orgId: org.id, name: 'Rowan T.', resumeFileId: otherFile.id, resumeText: 'Text of the other résumé' } });
    const empty = await db.contact.create({ data: { orgId: org.id, name: 'Rowan' } });
    expect(await mergeContacts(ctx, empty.id, third.id)).toMatchObject({ resumeFileId: otherFile.id, resumeText: 'Text of the other résumé' });
  });

  it("takes the duplicate's readable resume over a primary's that will never have text", async () => {
    const { org, admin } = await createOrg();
    const ctx = { userId: admin.id, orgId: org.id, accessRole: 'SUPER_ADMIN' };
    const scanned = await pending(org.id);
    await db.storedFile.update({
      where: { id: scanned.file.id },
      data: { textStatus: 'EMPTY', textVersion: EXTRACTOR_VERSION, textAttempts: 1, contactId: scanned.contact.id },
    });
    // Stored before files had an owner.
    const readable = await storeFile({ orgId: org.id, filename: 'cv.pdf', mime: 'application/pdf', data: Buffer.from('%PDF-1.4 readable') });
    const duplicate = await db.contact.create({
      data: { orgId: org.id, name: 'R. Testperson', resumeFileId: readable.id, resumeText: 'Kubernetes and Postgres' },
    });

    const merged = await mergeContacts(ctx, scanned.contact.id, duplicate.id);
    expect(merged).toMatchObject({ resumeFileId: readable.id, resumeText: 'Kubernetes and Postgres' });
    // Both files belong to the merged contact, so anonymizing it deletes both.
    const owners = await db.storedFile.findMany({ where: { id: { in: [scanned.file.id, readable.id] } }, select: { contactId: true } });
    expect(owners.map((f) => f.contactId)).toEqual([scanned.contact.id, scanned.contact.id]);
  });
});
