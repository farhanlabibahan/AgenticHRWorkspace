'use server';

import { redirect } from 'next/navigation';
import { isSampleSlug } from '@/server/sample-boards';
import { headers } from 'next/headers';
import { after } from 'next/server';
import { submitApplication } from '@/server/applications';
import { kickResumeParse, resumeParsingOn } from '@/server/resume-parse';
import { requestPortalLink } from '@/server/portal';
import { MAX_RESUME_BYTES } from '@/server/resume';
import { RESUME_UPLOAD_FORMATS, sniffFormat } from '@/server/text';
import { EncryptedDocumentError } from '@/server/text/types';

export type ApplyFormState = { error?: string } | undefined;

const PASSWORD_PROTECTED = 'That file is password-protected. Remove the password and try again.';

export async function applyAction(_prev: ApplyFormState, formData: FormData): Promise<ApplyFormState> {
  const orgSlug = String(formData.get('orgSlug') ?? '');
  const postingSlug = String(formData.get('postingSlug') ?? '');
  const name = String(formData.get('name') ?? '').trim();
  const email = String(formData.get('email') ?? '').trim();

  if (isSampleSlug(orgSlug)) return { error: 'This is a sample job board; applying is off.' };
  if (!name || !email) return { error: 'Name and email are required.' };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: 'Enter a valid email address.' };

  let resume: { data: Buffer; filename: string } | undefined;
  const file = formData.get('resume');
  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_RESUME_BYTES) return { error: 'Resume must be under 5 MB.' };
    const data = Buffer.from(await file.arrayBuffer());
    // The bytes decide the type: browsers guess MIME types from the extension, or send none.
    const { format, reason } = sniffFormat(data);
    // Office files show it here; a PDF only once it's opened, in submitApplication.
    if (reason === 'encrypted') return { error: PASSWORD_PROTECTED };
    // Resume builders and Word's "Web Page" export save HTML under a .doc name.
    if (format === 'html') {
      return { error: 'That file is a web page, not a document. Open it in Word, save it as a PDF or .docx, and upload that.' };
    }
    if (!format || !RESUME_UPLOAD_FORMATS.includes(format)) {
      return { error: 'Upload your resume as a PDF, Word (.doc or .docx), OpenDocument (.odt), RTF or plain-text file.' };
    }
    resume = { data, filename: file.name };
  }

  try {
    await submitApplication({
      orgSlug,
      postingSlug,
      name,
      email,
      location: String(formData.get('location') ?? '').trim() || undefined,
      linkedin: String(formData.get('linkedin') ?? '').trim() || undefined,
      coverNote: String(formData.get('coverNote') ?? '').trim() || undefined,
      networkOptIn: formData.get('networkOptIn') === 'on',
      storeProfile: formData.get('storeProfile') === 'on',
      resume,
      utm: {
        source: String(formData.get('utm_source') ?? '').trim() || undefined,
        medium: String(formData.get('utm_medium') ?? '').trim() || undefined,
        campaign: String(formData.get('utm_campaign') ?? '').trim() || undefined,
      },
      eeo: formData.has('eeo_gender')
        ? {
            gender: String(formData.get('eeo_gender') ?? 'declined'),
            race: String(formData.get('eeo_race') ?? 'declined'),
            veteran: String(formData.get('eeo_veteran') ?? 'declined'),
            disability: String(formData.get('eeo_disability') ?? 'declined'),
          }
        : undefined,
    });
  } catch (err) {
    if (err instanceof EncryptedDocumentError) return { error: PASSWORD_PROTECTED };
    return { error: 'Something went wrong submitting your application. Please try again.' };
  }

  // Read the resume once the applicant has their answer (src/server/resume-parse).
  if (resume && resumeParsingOn()) {
    try {
      after(() => kickResumeParse().catch(() => undefined));
    } catch {
      // No request scope to run after: the resume-parse cron picks it up.
    }
  }
  redirect(`/careers/${orgSlug}/${postingSlug}?applied=1`);
}

export async function requestPortalLinkAction(
  _prev: ApplyFormState,
  formData: FormData,
): Promise<ApplyFormState> {
  const orgSlug = String(formData.get('orgSlug') ?? '');
  const email = String(formData.get('email') ?? '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: 'Enter a valid email address.' };

  const h = await headers();
  const proto = h.get('x-forwarded-proto') ?? 'http';
  const host = h.get('host') ?? 'localhost:3000';
  await requestPortalLink(orgSlug, email, `${proto}://${host}`);

  redirect(`/careers/${orgSlug}/status?sent=1`);
}
