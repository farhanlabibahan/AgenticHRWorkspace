import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { hasDb } from './setup';
import { createOrg } from './fixtures';
import { startFakeOpenAI, type FakeOpenAI } from './support/fake-openai';
import { db } from '@/lib/db';
import { applyAction } from '@/app/careers/actions';
import { submitApplication } from '@/server/applications';
import { findDuplicates } from '@/server/contacts';
import { requestPortalLink } from '@/server/portal';
import { parseQueueFields, processResumeParse } from '@/server/resume-parse';
import { EXTRACTOR_VERSION, FORMAT_MIME } from '@/server/text';

/**
 * The careers apply flow with real resume files: the type is read from the
 * bytes, the text lands on the contact, and a file that can't be read never
 * stops the application.
 */

const fixture = (name: string) => readFileSync(path.join(__dirname, '../src/server/text/__tests__/fixtures', name));

let orgSlug = '';
const postingSlug = 'platform-engineer';

async function apply(file: string, filename = file) {
  const email = `rowan-${randomUUID().slice(0, 8)}@example.test`;
  const opportunity = await submitApplication({
    orgSlug,
    postingSlug,
    name: 'Rowan Q. Testperson',
    email,
    resume: { data: fixture(file), filename },
  });
  const contact = await db.contact.findUniqueOrThrow({ where: { id: opportunity.contactId }, include: { resumeFile: true } });
  return { opportunity, contact, file: contact.resumeFile! };
}

describe.skipIf(!hasDb)('applying with a resume', () => {
  beforeAll(async () => {
    process.env.AUTH_SECRET ||= 'test-secret'; // portal links are signed
    const { org } = await createOrg();
    orgSlug = org.slug;
    await db.posting.create({ data: { orgId: org.id, slug: postingSlug, title: 'Platform Engineer', state: 'PUBLISHED' } });
  });

  it('reads a PDF, including the link behind "LinkedIn", and gives the file to the contact', async () => {
    const { contact, file } = await apply('links.pdf', 'cv.pdf');
    expect(contact.resumeText).toContain('Rowan Q. Testperson');
    expect(contact.links).toContain('https://www.linkedin.com/in/rowan-testperson');
    expect(file).toMatchObject({
      contactId: contact.id,
      mime: 'application/pdf',
      textStatus: 'OK',
      textVersion: EXTRACTOR_VERSION,
      textAttempts: 1,
      textError: null,
    });
    expect(file.textCheckedAt).toBeInstanceOf(Date);
  });

  it.each([
    ['resume.doc', 'doc'],
    ['resume.odt', 'odt'],
  ] as const)('reads %s', async (name, format) => {
    const { contact, file } = await apply(name);
    expect(contact.resumeText).toContain('Rowan Q. Testperson');
    expect(contact.resumeText).toContain('résumé');
    expect(file).toMatchObject({ mime: FORMAT_MIME[format], textStatus: 'OK' });
  });

  it('still takes the application when the PDF is corrupt', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { opportunity, contact, file } = await apply('truncated.pdf', 'cv.pdf');
    quiet.mockRestore();
    expect(await db.opportunity.count({ where: { id: opportunity.id } })).toBe(1);
    expect(contact.resumeText).toBeNull();
    expect(file).toMatchObject({ contactId: contact.id, textStatus: 'FAILED', textAttempts: 1 });
    expect(file.textError).toBeTruthy();
  });

  it('stores a mislabelled file under its real type and extension', async () => {
    const { contact, file } = await apply('resume.pdf', 'Rowan CV.docx');
    expect(file).toMatchObject({ filename: 'Rowan CV.pdf', mime: 'application/pdf', textStatus: 'OK' });
    expect(contact.resumeText).toContain('Rowan Q. Testperson');
  });

  it('replaces the text with the new resume on a re-application, and both files stay the contact’s', async () => {
    const first = await apply('resume.odt');
    const again = await submitApplication({
      orgSlug,
      postingSlug,
      name: 'Rowan Q. Testperson',
      email: first.contact.emails[0],
      resume: { data: fixture('resume.pdf'), filename: 'resume.pdf' },
    });
    const contact = await db.contact.findUniqueOrThrow({ where: { id: again.contactId } });
    expect(contact.id).toBe(first.contact.id);
    expect(contact.resumeFileId).not.toBe(first.file.id);
    expect(contact.resumeText).toContain('Staff Platform Engineer'); // resume.pdf's headline, not the ODT's
    expect(await db.storedFile.count({ where: { contactId: contact.id } })).toBe(2);
  });

  it('gives a replaced resume stored before files had an owner to the contact', async () => {
    const first = await apply('resume.odt');
    await db.storedFile.update({ where: { id: first.file.id }, data: { contactId: null } });
    await submitApplication({
      orgSlug,
      postingSlug,
      name: 'Rowan Q. Testperson',
      email: first.contact.emails[0],
      resume: { data: fixture('resume.pdf'), filename: 'resume.pdf' },
    });
    expect(await db.storedFile.findUniqueOrThrow({ where: { id: first.file.id } })).toMatchObject({ contactId: first.contact.id });
  });

  it("keeps links behind an employer's or school's name off the contact, and profiles on it", async () => {
    // RTF hyperlinks: "Stripe" and "MIT" point at the organisations, "GitHub" at Rowan.
    const rtf = (who: string) =>
      Buffer.from(
        `{\\rtf1\\ansi ${who}\\par Senior Engineer, {\\field{\\*\\fldinst HYPERLINK "https://stripe.com/"}{\\fldrslt Stripe}}\\par ` +
          `BSc, {\\field{\\*\\fldinst HYPERLINK "https://www.mit.edu/"}{\\fldrslt MIT}}\\par ` +
          `{\\field{\\*\\fldinst HYPERLINK "https://github.com/${who.split(' ')[0].toLowerCase()}"}{\\fldrslt GitHub}} \\u8226? https://${who.split(' ')[0].toLowerCase()}.example.test\\par }`,
      );
    const applyRtf = async (who: string) => {
      const { contactId } = await submitApplication({
        orgSlug,
        postingSlug,
        name: who,
        email: `${randomUUID().slice(0, 8)}@example.test`,
        resume: { data: rtf(who), filename: 'resume.rtf' },
      });
      return db.contact.findUniqueOrThrow({ where: { id: contactId } });
    };
    const rowan = await applyRtf('Rowan Testperson');
    const jamie = await applyRtf('Jamie Otherperson');
    expect(rowan.resumeText).toContain('Stripe (https://stripe.com/)'); // still searchable
    expect(rowan.links).toEqual(['https://rowan.example.test', 'https://github.com/rowan']);
    expect(await findDuplicates(rowan.orgId, rowan)).not.toContainEqual(expect.objectContaining({ id: jamie.id }));
  });

  /** The careers form, as the browser posts it. */
  function applyForm(email: string, file: File) {
    const form = new FormData();
    form.set('orgSlug', orgSlug);
    form.set('postingSlug', postingSlug);
    form.set('name', 'Rowan Q. Testperson');
    form.set('email', email);
    form.set('resume', file);
    return applyAction(undefined, form);
  }

  it('turns away a file that is not a resume document, whatever its name says', async () => {
    const before = await db.storedFile.count();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    expect(await applyForm('rowan.png@example.test', new File([png], 'resume.pdf', { type: 'application/pdf' }))).toEqual({
      error: 'Upload your resume as a PDF, Word (.doc or .docx), OpenDocument (.odt), RTF or plain-text file.',
    });
    // Word's "Web Page" export, named .doc: say what it is and how to fix it.
    expect(await applyForm('rowan.html@example.test', new File([fixture('resume.html')], 'resume.doc', { type: 'application/msword' }))).toEqual({
      error: 'That file is a web page, not a document. Open it in Word, save it as a PDF or .docx, and upload that.',
    });
    expect(await db.storedFile.count()).toBe(before);
  });

  it('turns away a PDF that needs a password, storing nothing', async () => {
    const before = await db.storedFile.count();
    const email = 'rowan.locked@example.test';
    expect(await applyForm(email, new File([fixture('encrypted.pdf')], 'cv.pdf', { type: 'application/pdf' }))).toEqual({
      error: 'That file is password-protected. Remove the password and try again.',
    });
    expect(await db.storedFile.count()).toBe(before);
    expect(await db.contact.count({ where: { emails: { has: email } } })).toBe(0);
  });

  it('takes a PDF protected by an owner password only, which opens without one', async () => {
    const { contact, file } = await apply('encrypted-empty-password.pdf', 'cv.pdf');
    expect(contact.resumeText).toContain('Protected résumé');
    expect(file).toMatchObject({ textStatus: 'OK' });
  });

  it('keeps the addresses a resume lists off the contact', async () => {
    const reference = `jordan.referee-${randomUUID().slice(0, 8)}@example.test`;
    const resume = Buffer.from(`Rowan Q. Testperson — résumé\nrowan@example.test · +1 555 010 4477\n\nReferences\nJordan Referee, Engineering Manager — ${reference}`);
    const rowan = await submitApplication({
      orgSlug,
      postingSlug,
      name: 'Rowan Q. Testperson',
      email: `rowan-${randomUUID().slice(0, 8)}@example.test`,
      resume: { data: resume, filename: 'resume.txt' },
    });
    const contact = await db.contact.findUniqueOrThrow({ where: { id: rowan.contactId } });
    expect(contact.resumeText).toContain(reference);
    expect(contact.emails).toHaveLength(1);
    expect(contact.phones).toEqual(['+1 555 010 4477']);

    // The reference applying gets a contact of their own, and can't ask for Rowan's status link.
    const jordan = await submitApplication({ orgSlug, postingSlug, name: 'Jordan Referee', email: reference });
    expect(jordan.contactId).not.toBe(rowan.contactId);
    await requestPortalLink(orgSlug, reference, 'http://localhost:3000');
    expect(await db.emailMessage.count({ where: { toEmail: reference, contactId: rowan.contactId } })).toBe(0);
  });
});

/**
 * Resume parsing never happens while the applicant waits: the application
 * only marks its resume QUEUED, and whatever the provider does later, the
 * application stands.
 */
describe.skipIf(!hasDb)('applying while resume parsing is on', () => {
  let fake: FakeOpenAI;
  let org: { id: string; slug: string };
  const posting = 'data-engineer';

  beforeAll(async () => {
    fake = await startFakeOpenAI({ port: 3842, profile: 'generic' });
    ({ org } = await createOrg());
    await db.posting.create({ data: { orgId: org.id, slug: posting, title: 'Data Engineer', state: 'PUBLISHED' } });
    const template = await db.emailTemplate.create({ data: { orgId: org.id, name: 'Thanks', subject: 'Thanks for applying', body: 'Hi {{first_name}}' } });
    await db.organization.update({ where: { id: org.id }, data: { autoConfirmTemplateId: template.id } });
  });
  afterAll(async () => {
    await fake.close();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    fake.reset();
  });

  const parsingOn = () => {
    vi.stubEnv('RESUME_PARSER_BASE_URL', fake.url);
    vi.stubEnv('RESUME_PARSER_MODEL', 'openai/gpt-oss-20b');
  };

  async function applyWith(file: string) {
    const email = `avery-${randomUUID().slice(0, 8)}@example.test`;
    const opportunity = await submitApplication({ orgSlug: org.slug, postingSlug: posting, name: 'Avery J. Example', email, resume: { data: fixture(file), filename: file } });
    const contact = await db.contact.findUniqueOrThrow({ where: { id: opportunity.contactId }, include: { resumeFile: true } });
    return { opportunity, contact, file: contact.resumeFile!, email };
  }

  it('queues the resume and sends nothing while the applicant waits', async () => {
    parsingOn();
    const { file } = await applyWith('resume.docx');
    expect(file).toMatchObject({ textStatus: 'OK', parseStatus: 'QUEUED', parseAttempts: 0, parseCheckedAt: null });
    expect(file.parseQueuedAt).toBeInstanceOf(Date);
    expect(fake.requests).toHaveLength(0);
  });

  it('leaves the resume alone when parsing is off', async () => {
    const { file } = await applyWith('resume.docx');
    expect(file).toMatchObject({ parseStatus: null, parseQueuedAt: null });
  });

  it('queues a scanned resume, which waits there for OCR (src/server/resume-ocr.ts)', async () => {
    parsingOn();
    const { file } = await applyWith('scanned.pdf');
    expect(file).toMatchObject({ textStatus: 'EMPTY', parseStatus: 'QUEUED' });
    expect(fake.requests).toHaveLength(0);
  });

  it('takes the application whatever the provider does, and a provider outage costs the resume no attempt', async () => {
    parsingOn();
    fake.setRespond(() => ({ status: 500, error: { message: 'Internal server error', type: 'internal_server_error' } }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { opportunity, contact, file, email } = await applyWith('resume.docx');

    expect(await db.opportunity.count({ where: { id: opportunity.id } })).toBe(1);
    expect(await db.consentRecord.count({ where: { contactId: contact.id, purpose: 'APPLICATION' } })).toBe(1);
    expect(await db.emailMessage.count({ where: { contactId: contact.id, toEmail: email } })).toBe(1);

    const run = await processResumeParse({ orgId: org.id, sleep: async () => {} });
    expect(run).toMatchObject({ claimed: 0 });
    expect(run.held).toBeGreaterThanOrEqual(1);
    expect(fake.requests).toHaveLength(2 * run.held); // one retry per resume; two resumes in a row and the queue pauses
    expect(await db.storedFile.findUniqueOrThrow({ where: { id: file.id } })).toMatchObject({ parseStatus: 'QUEUED', parseAttempts: 0, parseError: null });
    expect(await db.opportunity.findUniqueOrThrow({ where: { id: opportunity.id } })).toMatchObject({ stageId: opportunity.stageId, status: 'ACTIVE' });
  });

  it('takes the application with a broken parser configuration, and queues nothing', async () => {
    vi.stubEnv('RESUME_PARSER_BASE_URL', 'ftp://models.example.test/v1');
    vi.stubEnv('RESUME_PARSER_MODEL', 'openai/gpt-oss-20b');
    expect(parseQueueFields('OK')).toEqual({});
    const { opportunity, file } = await applyWith('resume.docx');
    expect(await db.opportunity.count({ where: { id: opportunity.id } })).toBe(1);
    expect(file.parseStatus).toBeNull();
  });
});
