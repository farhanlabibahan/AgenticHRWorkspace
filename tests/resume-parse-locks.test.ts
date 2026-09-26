import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hasDb } from './setup';
import { createOrg } from './fixtures';
import { startFakeOpenAI, type FakeOpenAI } from './support/fake-openai';
import { db } from '@/lib/db';
import { processResumeParse } from '@/server/resume-parse';
import { resumeParserConfig } from '@/server/resume-parse/config';
import { processRetention } from '@/server/retention';
import { EXTRACTOR_VERSION } from '@/server/text';

/**
 * A parse writing its result while the candidate is being erased. The write
 * is slowed down here, the way a slow database round trip would, so the two
 * transactions overlap: they must take the rows in the same order, or
 * Postgres aborts one of them as a deadlock, and it can be the erasure.
 */
vi.mock('@/server/resume-parse/fill', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/server/resume-parse/fill')>();
  return {
    ...real,
    fillContactFromResume: async (...args: Parameters<typeof real.fillContactFromResume>) => {
      await new Promise((r) => setTimeout(r, 400));
      return real.fillContactFromResume(...args);
    },
  };
});

let fake: FakeOpenAI;

describe.skipIf(!hasDb)('resume parsing and erasure at the same time', () => {
  beforeAll(async () => {
    fake = await startFakeOpenAI({ port: 3843, profile: 'generic' });
  });
  afterAll(async () => {
    await fake.close();
  });

  it('erases the candidate, whichever gets there first', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { org, stages } = await createOrg();
    const file = await db.storedFile.create({
      data: {
        orgId: org.id,
        key: `test/${randomUUID()}.txt`,
        filename: 'r.txt',
        mime: 'text/plain',
        size: 10,
        textStatus: 'OK',
        textVersion: EXTRACTOR_VERSION,
        textAttempts: 1,
        parseStatus: 'QUEUED',
        parseQueuedAt: new Date(),
      },
    });
    const contact = await db.contact.create({
      data: {
        orgId: org.id,
        name: 'Pat Example',
        emails: ['pat.locks@example.test'],
        resumeFileId: file.id,
        resumeText: 'Pat Example\nStaff Engineer\nPorto, Portugal',
      },
    });
    await db.storedFile.update({ where: { id: file.id }, data: { contactId: contact.id } });
    // Archived, and the candidate declined to have their profile kept: retention erases them now.
    await db.opportunity.create({ data: { orgId: org.id, contactId: contact.id, stageId: stages[0].id, status: 'ARCHIVED', archivedAt: new Date() } });
    await db.consentRecord.create({ data: { orgId: org.id, contactId: contact.id, purpose: 'PROFILE_STORAGE', withdrawnAt: new Date() } });

    const config = resumeParserConfig({ RESUME_PARSER_BASE_URL: fake.url, RESUME_PARSER_MODEL: 'openai/gpt-oss-20b' });
    const parse = processResumeParse({ orgId: org.id, config, sleep: async () => {} });
    await new Promise((r) => setTimeout(r, 200)); // the parse is inside its write
    const erasure = processRetention().then(
      () => 'ok',
      (e: Error) => (/deadlock|40P01/i.test(e.message) ? 'deadlock' : e.message.slice(-200)),
    );
    const [run, erased] = await Promise.all([parse, erasure]);

    expect(erased).toBe('ok');
    expect(run.error).toBeUndefined();
    const after = await db.contact.findUniqueOrThrow({ where: { id: contact.id } });
    expect(after).toMatchObject({ isAnonymized: true, resumeFileId: null, resumeText: null });
    expect(await db.storedFile.count({ where: { id: file.id } })).toBe(0);
  });
});
