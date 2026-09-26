import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { deleteStoredFileBytes } from '@/server/storage';
import { invalidateContactCounts, invalidatePipelineCounts } from '@/server/lists/cache';

/**
 * GDPR retention: when an org sets retentionMonths, candidates whose every
 * opportunity has been archived longer than the window are anonymized —
 * identity fields cleared, record kept for aggregate reporting
 * (docs/02 §1 "Data retention & anonymization"). Hired candidates are
 * exempt (employment records have their own retention rules).
 *
 * Second pass: candidates who explicitly DECLINED profile storage at apply
 * time are anonymized as soon as every opportunity is archived — no
 * retention window, that was the deal on the apply form.
 */

async function anonymizeContact(
  orgId: string,
  contact: { id: string; resumeFileId: string | null },
  reason: Record<string, string | number | null>,
) {
  // The resume IS the PII — anonymization must take the file with it, and
  // every other file that is theirs (imported cover letters, older resumes).
  const files = await db.storedFile.findMany({
    where: {
      orgId,
      OR: [{ contactId: contact.id }, ...(contact.resumeFileId ? [{ id: contact.resumeFileId }] : [])],
    },
    select: { id: true, key: true },
  });
  for (const file of files) {
    await deleteStoredFileBytes(file.key).catch(() => {});
  }
  await db.$transaction(async (tx) => {
    if (files.length) {
      await tx.contact.update({
        where: { id: contact.id },
        data: { resumeFileId: null },
      });
      await tx.storedFile.deleteMany({ where: { id: { in: files.map((f) => f.id) }, orgId } });
      // Notes that only point at those files (imported attachments) name them — often after the candidate.
      for (const f of files) {
        await tx.note.deleteMany({ where: { orgId, body: { contains: `/api/files/${f.id}` } } });
      }
    }
    // Interview transcripts are verbatim candidate speech — same PII bar
    await tx.transcript.deleteMany({
      where: { orgId, opportunity: { contactId: contact.id } },
    });
    // Case studies point at their own portfolio: theirs, and identifying
    await tx.caseStudy.deleteMany({ where: { orgId, contactId: contact.id } });
    // Newsletter copies keep the address each went to
    await tx.newsletterRecipient.deleteMany({ where: { orgId, contactId: contact.id } });
    await tx.contact.update({
      where: { id: contact.id },
      data: {
        name: 'Anonymized candidate',
        headline: null,
        location: null,
        emails: [],
        phones: [],
        links: [],
        resumeFileId: null,
        resumeText: null,
        isAnonymized: true,
      },
    });
    await tx.event.create({
      data: {
        orgId,
        actorType: 'system',
        verb: 'contact.anonymized',
        subjectType: 'contact',
        subjectId: contact.id,
        payload: reason,
      },
    });
  });
  // The name changed, which search counts see.
  invalidatePipelineCounts(orgId);
  invalidateContactCounts(orgId);
}

export async function processRetention(): Promise<number> {
  let anonymized = 0;

  // Pass 1: org-configured retention windows
  // Orgs mid-import are skipped: a candidate whose old applications are past
  // the window may still have active ones on the way, and anonymizing them
  // now would make the import drop those as erased.
  const importing: Prisma.OrganizationWhereInput = {
    importJobs: { some: { status: { in: ['DISCOVERING', 'REVIEW', 'RUNNING'] } } },
  };
  const orgs = await db.organization.findMany({
    where: { retentionMonths: { not: null }, NOT: importing },
    select: { id: true, retentionMonths: true },
  });
  for (const org of orgs) {
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - (org.retentionMonths ?? 0));

    const candidates = await db.contact.findMany({
      where: {
        orgId: org.id,
        isAnonymized: false,
        opportunities: { some: {}, every: { status: 'ARCHIVED', archivedAt: { lte: cutoff } } },
      },
      select: { id: true, resumeFileId: true },
      take: 100,
    });
    for (const contact of candidates) {
      await anonymizeContact(org.id, contact, { retentionMonths: org.retentionMonths });
      anonymized++;
    }
  }

  // Pass 2: explicit "don't store my profile" refusals — anonymize as soon
  // as every process has ended, regardless of any retention window.
  const refused = await db.contact.findMany({
    where: {
      isAnonymized: false,
      consents: { some: { purpose: 'PROFILE_STORAGE' } },
      NOT: { consents: { some: { purpose: 'PROFILE_STORAGE', withdrawnAt: null } } },
      opportunities: { some: {}, every: { status: 'ARCHIVED' } },
      org: { NOT: importing },
    },
    select: { id: true, orgId: true, resumeFileId: true },
    take: 100,
  });
  for (const contact of refused) {
    await anonymizeContact(contact.orgId, contact, { reason: 'profile_storage_declined' });
    anonymized++;
  }

  return anonymized;
}
