import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasDb } from './setup';
import { createOrg } from './fixtures';
import { startFakeOpenAI, type FakeOpenAI } from './support/fake-openai';
import { db } from '@/lib/db';

/**
 * Resume parsing end to end: a careers application, the after-apply kick,
 * the cron route, and what the candidate's record and their data export
 * hold afterwards. The provider is a local fake.
 */

const hoisted = vi.hoisted(() => ({
  afterCallbacks: [] as (() => unknown)[],
  afterThrows: false,
  session: null as unknown,
}));

vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>();
  return {
    ...actual,
    after: (cb: () => unknown) => {
      if (hoisted.afterThrows) throw new Error('`after` was called outside a request scope');
      hoisted.afterCallbacks.push(cb);
    },
  };
});
vi.mock('@/lib/auth', () => ({ auth: async () => hoisted.session }));

// Imported after the mocks.
const { GET: cronGET } = await import('@/app/api/cron/resume-parse/route');
const { GET: exportGET } = await import('@/app/api/contacts/[id]/export/route');
const { applyAction } = await import('@/app/careers/actions');
const { submitApplication } = await import('@/server/applications');
const { processRetention } = await import('@/server/retention');
const { resetResumeParseCaps } = await import('@/server/resume-parse/client');

const PORT = 3842;
const SECRET = 'test-cron-secret';
const fixture = (name: string) => readFileSync(path.join(__dirname, '../src/server/text/__tests__/fixtures', name));

const AVERY = Buffer.from(
  [
    'Avery J. Example',
    'Senior Data Engineer',
    'Denver, Colorado',
    'avery.example@example.test | (303) 555-0142',
    'github.com/avery-example',
    '',
    'Experience',
    'Senior Data Engineer, Example Analytics - 2020-06 to present',
    'Skills: Python, SQL, Airflow',
  ].join('\n'),
);

const cron = (query = '', auth: string | null = `Bearer ${SECRET}`) =>
  cronGET(new Request(`http://localhost/api/cron/resume-parse${query}`, { headers: auth ? { authorization: auth } : {} }));

describe.skipIf(!hasDb)('resume parsing, end to end', () => {
  let fake: FakeOpenAI;
  let org: { id: string; slug: string };
  const posting = 'data-engineer';

  beforeAll(async () => {
    fake = await startFakeOpenAI({ port: PORT, profile: 'generic' });
    ({ org } = await createOrg());
    await db.posting.create({ data: { orgId: org.id, slug: posting, title: 'Data Engineer', state: 'PUBLISHED' } });
    // The cron route works across every organization: nothing other suites left queued.
    await db.storedFile.updateMany({ where: { parseStatus: { in: ['QUEUED', 'FAILED'] } }, data: { parseStatus: 'SKIPPED' } });
    await db.cronLease.deleteMany({ where: { name: { startsWith: 'resume-parse' } } });
  });
  afterAll(async () => {
    await fake.close();
  });
  beforeEach(() => {
    vi.stubEnv('CRON_SECRET', SECRET);
    vi.stubEnv('RESUME_PARSER_BASE_URL', fake.url);
    vi.stubEnv('RESUME_PARSER_MODEL', 'openai/gpt-oss-20b');
    hoisted.afterCallbacks.length = 0;
    hoisted.afterThrows = false;
    hoisted.session = null;
    fake.reset();
    resetResumeParseCaps();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function apply(data: Buffer, filename: string, opts: { storeProfile?: boolean } = {}) {
    const email = `applicant-${randomUUID().slice(0, 8)}@example.test`;
    const { contactId } = await submitApplication({
      orgSlug: org.slug,
      postingSlug: posting,
      name: 'Avery J. Example',
      email,
      storeProfile: opts.storeProfile,
      resume: { data, filename },
    });
    return { contactId, email };
  }

  it('fills an applicant in from the resume through the cron route, once', async () => {
    const avery = await apply(AVERY, 'avery.txt');
    const rowan = await apply(fixture('resume.docx'), 'rowan.docx');
    const before = await db.contact.findUniqueOrThrow({ where: { id: avery.contactId } });
    expect(before).toMatchObject({ headline: null, location: null, links: [], phones: ['(303) 555-0142'] });

    const res = await cron();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: 'on', claimed: 2, byStatus: { OK: 2 }, filledContacts: 2, more: false });
    expect(fake.requests).toHaveLength(2);

    expect(await db.contact.findUniqueOrThrow({ where: { id: avery.contactId } })).toMatchObject({
      name: 'Avery J. Example',
      headline: 'Senior Data Engineer',
      location: 'Denver, Colorado',
      links: ['https://github.com/avery-example'],
      phones: ['(303) 555-0142'], // it had one from the upload already
      emails: [avery.email],
    });
    const r = await db.contact.findUniqueOrThrow({ where: { id: rowan.contactId }, include: { resumeFile: true } });
    expect(r.headline).toBe('Staff engineer \u00b7 r\u00e9sum\u00e9');
    expect(r.emails).toEqual([rowan.email]);
    expect(r.resumeFile).toMatchObject({ parseStatus: 'OK', parseModel: 'openai/gpt-oss-20b' });
    expect(r.resumeFile?.parsed).toMatchObject({ v: 1, skills: ['TypeScript', 'Postgres', 'Rust'] });

    const events = await db.event.findMany({ where: { orgId: org.id, verb: 'contact.resume_parsed' } });
    expect(events.map((e) => e.subjectId).sort()).toEqual([avery.contactId, rowan.contactId].sort());

    // Nothing left: a second run claims nothing.
    expect(await (await cron()).json()).toMatchObject({ claimed: 0 });
    expect(fake.requests).toHaveLength(2);
  });

  it('refuses a request without the cron secret', async () => {
    expect((await cron('', null)).status).toBe(401);
    expect((await cron('', 'Bearer wrong')).status).toBe(401);
  });

  it('answers off and calls nothing when no model is set up', async () => {
    vi.stubEnv('RESUME_PARSER_BASE_URL', '');
    await apply(AVERY, 'avery.txt');
    const res = await cron();
    expect(await res.json()).toMatchObject({ state: 'off', claimed: 0 });
    expect(fake.requests).toHaveLength(0);
  });

  it('checks a key on a made-up resume without touching any data', async () => {
    const files = await db.storedFile.count();
    const res = await cron('?selftest=1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ state: 'on', ok: true, provider: 'Your own server', model: 'openai/gpt-oss-20b', mode: 'json_schema' });
    expect(body.fields).toEqual(expect.arrayContaining(['name', 'headline', 'location', 'emails', 'links', 'skills', 'experience']));
    expect(JSON.stringify(body)).not.toContain(new URL(fake.url).host); // where the provider is stays private
    expect(await db.storedFile.count()).toBe(files);

    fake.setRespond(() => ({ status: 401, error: { message: 'Invalid API Key' } }));
    const bad = await cron('?selftest=1');
    expect(bad.status).toBe(502);
    expect(await bad.json()).toMatchObject({ ok: false, code: 'provider_auth' });
  });

  it('spends on the key only for a caller with the cron secret, one self-test at a time', async () => {
    // docker-compose leaves CRON_SECRET empty, which leaves the cron itself open: not the self-test.
    vi.stubEnv('CRON_SECRET', '');
    const open = await cron('?selftest=1', null);
    expect(open.status).toBe(403);
    expect(await open.json()).toEqual({ error: 'selftest_needs_cron_secret' });
    expect(fake.requests).toHaveLength(0);

    vi.stubEnv('CRON_SECRET', SECRET);
    fake.setRespond(() => ({ delayMs: 400 }));
    const statuses = await Promise.all(Array.from({ length: 5 }, () => cron('?selftest=1').then((r) => r.status)));
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 429)).toHaveLength(4);
    expect(fake.requests).toHaveLength(1);
  });

  describe('the kick after a careers application', () => {
    function form(file?: File) {
      const f = new FormData();
      f.set('orgSlug', org.slug);
      f.set('postingSlug', posting);
      f.set('name', 'Avery J. Example');
      f.set('email', `kick-${randomUUID().slice(0, 8)}@example.test`);
      if (file) f.set('resume', file);
      return f;
    }
    const redirected = { message: 'NEXT_REDIRECT' };

    it('starts a run once the applicant has their answer, and it parses the resume', async () => {
      vi.stubEnv('CRON_SECRET', ''); // no self-call: the run happens right here
      await expect(applyAction(undefined, form(new File([AVERY], 'avery.txt', { type: 'text/plain' })))).rejects.toMatchObject(redirected);
      expect(fake.requests).toHaveLength(0); // nothing while the applicant waits
      expect(hoisted.afterCallbacks).toHaveLength(1);

      await hoisted.afterCallbacks[0]();
      expect(fake.requests).toHaveLength(1);
      const applied = await db.storedFile.findFirstOrThrow({ where: { orgId: org.id, filename: 'avery.txt' }, orderBy: { createdAt: 'desc' } });
      expect(applied.parseStatus).toBe('OK');
    });

    it('starts nothing without a resume, or with parsing off', async () => {
      await expect(applyAction(undefined, form())).rejects.toMatchObject(redirected);
      vi.stubEnv('RESUME_PARSER_BASE_URL', '');
      await expect(applyAction(undefined, form(new File([AVERY], 'avery.txt')))).rejects.toMatchObject(redirected);
      expect(hoisted.afterCallbacks).toHaveLength(0);
    });

    it('still sends the applicant on when the kick cannot be scheduled', async () => {
      hoisted.afterThrows = true;
      await expect(applyAction(undefined, form(new File([AVERY], 'avery.txt')))).rejects.toMatchObject(redirected);
    });
  });

  describe("the candidate's data", () => {
    it("is in the candidate's data export, for every resume they sent", async () => {
      const first = await apply(AVERY, 'avery.txt');
      await cron();
      // They apply again with a new resume: both parses stay theirs.
      await submitApplication({
        orgSlug: org.slug,
        postingSlug: posting,
        name: 'Avery J. Example',
        email: first.email,
        resume: { data: fixture('resume.docx'), filename: 'second.docx' },
      });
      await cron();

      hoisted.session = { user: { orgId: org.id, accessRole: 'ADMIN' } };
      const res = await exportGET(new Request('http://localhost/api/contacts/x/export'), { params: Promise.resolve({ id: first.contactId }) });
      expect(res.status).toBe(200);
      const body = JSON.parse(await res.text());
      expect(body.contact.resumeFile).toMatchObject({ filename: 'second.docx', parseModel: 'openai/gpt-oss-20b' });
      expect(body.contact.resumeFile.parsed).toMatchObject({ v: 1, name: 'Rowan Q. Testperson' });
      expect(body.contact.files).toHaveLength(2);
      expect(body.contact.files.map((f: { parsed: { name: string } | null }) => f.parsed?.name).sort()).toEqual(['Avery J. Example', 'Rowan Q. Testperson']);
      // The storage key names the upload; it stays out of the export.
      expect(JSON.stringify(body.contact.files)).not.toContain('"key"');
    });

    it('is erased with the resume when the candidate is anonymized', async () => {
      const { contactId } = await apply(AVERY, 'avery.txt', { storeProfile: false });
      await cron();
      const contact = await db.contact.findUniqueOrThrow({ where: { id: contactId } });
      expect(contact.headline).toBe('Senior Data Engineer');
      const fileId = contact.resumeFileId!;

      await db.opportunity.updateMany({ where: { contactId }, data: { status: 'ARCHIVED', archivedAt: new Date() } });
      await processRetention();

      expect(await db.contact.findUniqueOrThrow({ where: { id: contactId } })).toMatchObject({ isAnonymized: true, headline: null, location: null, links: [] });
      expect(await db.storedFile.count({ where: { id: fileId } })).toBe(0);
      const events = await db.event.findMany({ where: { orgId: org.id, subjectId: contactId } });
      expect(events.map((e) => e.verb)).toContain('contact.resume_parsed');
      const payloads = JSON.stringify(events.filter((e) => e.verb === 'contact.resume_parsed').map((e) => e.payload));
      for (const value of ['Senior Data', 'Denver', 'avery', 'Avery', '303']) expect(payloads).not.toContain(value);
    });
  });
});
