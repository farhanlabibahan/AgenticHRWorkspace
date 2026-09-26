import { db } from '@/lib/db';
import type { SessionContext } from '@/lib/session';
import { actorOf, emitEvent } from '@/server/events';
import { fetchLinkPreview } from '@/server/link-preview';

/** A candidate's case studies: links to their work, shown as thumbnails on their presentation. */

export const MAX_CASE_STUDIES = 12;

export class CaseStudyError extends Error {}

/** A link as typed ("jordan.design/pipeline") or with its scheme; http(s) only. */
export function normalizeWorkUrl(raw: string): string {
  const value = raw.trim();
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    throw new CaseStudyError('That isn’t a link.');
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !url.hostname.includes('.')) {
    throw new CaseStudyError('That isn’t a link.');
  }
  url.hash = '';
  return url.toString().slice(0, 1000);
}

/** "…/pipeline-redesign" → "Pipeline redesign"; the host when the path says nothing. */
export function titleFromUrl(raw: string): string {
  const url = new URL(raw);
  const last = url.pathname.split('/').filter(Boolean).pop();
  const words = last?.replace(/\.[a-z0-9]+$/i, '').replace(/[-_+]+/g, ' ').trim();
  if (!words || /^\d+$/.test(words)) return url.hostname.replace(/^www\./, '');
  return (words.charAt(0).toUpperCase() + words.slice(1)).slice(0, 120);
}

export async function addCaseStudy(ctx: SessionContext, contactId: string, rawUrl: string) {
  const url = normalizeWorkUrl(rawUrl);
  const contact = await db.contact.findFirst({
    where: { id: contactId, orgId: ctx.orgId },
    select: { id: true, _count: { select: { caseStudies: true } } },
  });
  if (!contact) throw new CaseStudyError('Candidate not found.');
  if (contact._count.caseStudies >= MAX_CASE_STUDIES) throw new CaseStudyError(`Up to ${MAX_CASE_STUDIES} case studies.`);
  // Outside the transaction: a slow page must not hold a database connection.
  const preview = await fetchLinkPreview(url);
  return db.$transaction(async (tx) => {
    const last = await tx.caseStudy.findFirst({ where: { contactId: contact.id }, orderBy: { position: 'desc' }, select: { position: true } });
    const study = await tx.caseStudy.create({
      data: {
        orgId: ctx.orgId,
        contactId: contact.id,
        url,
        title: preview.title ?? titleFromUrl(url),
        summary: preview.description,
        imageUrl: preview.image,
        position: (last?.position ?? -1) + 1,
      },
    });
    await emitEvent(tx, {
      orgId: ctx.orgId,
      ...actorOf(ctx),
      verb: 'contact.case_study_added',
      subjectType: 'contact',
      subjectId: contact.id,
      payload: { title: study.title },
    });
    return study;
  });
}

export async function removeCaseStudy(ctx: SessionContext, id: string) {
  const study = await db.caseStudy.findFirst({ where: { id, orgId: ctx.orgId }, select: { id: true } });
  if (!study) throw new CaseStudyError('Case study not found.');
  await db.caseStudy.delete({ where: { id: study.id } });
}
