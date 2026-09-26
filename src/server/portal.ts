import type { StageType } from '@prisma/client';
import { db } from '@/lib/db';
import { emitEvent } from '@/server/events';
import { sendEmail } from '@/server/email';
import { createPortalToken, verifyPortalToken } from '@/lib/portal-token';

/**
 * Candidate portal: magic-link status tracking + consent management.
 * Candidates see friendly status labels derived from stage *types*, never
 * the org's internal stage names or notes.
 */

export function candidateStatus(
  status: string,
  stageType: StageType,
  countsAsRejection: boolean | null,
): string {
  if (status === 'HIRED') return 'Hired';
  if (status === 'ARCHIVED') return countsAsRejection ? 'Not selected' : 'Closed';
  switch (stageType) {
    case 'LEAD':
    case 'APPLICANT':
      return 'Application received';
    case 'SCREEN':
      return 'In review';
    case 'ONSITE':
      return 'Interviewing';
    case 'OFFER':
      return 'Offer stage';
    default:
      return 'In progress';
  }
}

/** Email a magic link. Silent when no contact matches — no email enumeration. */
export async function requestPortalLink(orgSlug: string, email: string, baseUrl: string) {
  const org = await db.organization.findUnique({ where: { slug: orgSlug } });
  if (!org) return;
  const normalized = email.toLowerCase().trim();
  const contact = await db.contact.findFirst({
    where: { orgId: org.id, emails: { has: normalized }, isAnonymized: false },
  });
  if (!contact) return;

  const token = createPortalToken(contact.id, org.id);
  const link = `${baseUrl}/portal/${token}`;
  await sendEmail({
    orgId: org.id,
    contactId: contact.id,
    toEmail: normalized,
    subject: `Your application status at ${org.name}`,
    body: `Hi ${contact.name.split(' ')[0]},\n\nUse this link to view the status of your application(s) at ${org.name} and manage your preferences:\n\n${link}\n\nThe link is valid for 14 days.\n\n${org.name} Recruiting`,
  });
}

export async function getPortalData(token: string) {
  const payload = verifyPortalToken(token);
  if (!payload) return null;

  const contact = await db.contact.findFirst({
    where: { id: payload.contactId, orgId: payload.orgId, isAnonymized: false },
    include: {
      org: true,
      opportunities: {
        orderBy: { createdAt: 'desc' },
        include: {
          posting: { include: { clientCompany: true } },
          stage: true,
          archiveReason: true,
        },
      },
      consents: { orderBy: { grantedAt: 'desc' } },
    },
  });
  if (!contact) return null;

  const networkConsent = contact.consents.find(
    (c) => c.purpose === 'NETWORK_DISCOVERY' && !c.withdrawnAt,
  );

  return {
    contact,
    org: contact.org,
    applications: contact.opportunities.map((opp) => ({
      id: opp.id,
      postingTitle: opp.posting?.title ?? 'General application',
      company: opp.posting?.clientCompany?.name ?? contact.org.name,
      appliedAt: opp.createdAt,
      status: candidateStatus(opp.status, opp.stage.type, opp.archiveReason?.countsAsRejection ?? null),
    })),
    networkOptIn: !!networkConsent,
    networkEnabled: contact.org.talentNetworkEnabled,
  };
}

/** Grant or withdraw NETWORK_DISCOVERY consent — candidate-initiated via portal token. */
export async function setNetworkConsent(token: string, granted: boolean) {
  const payload = verifyPortalToken(token);
  if (!payload) throw new Error('Invalid or expired link');

  return db.$transaction(async (tx) => {
    const contact = await tx.contact.findFirst({
      where: { id: payload.contactId, orgId: payload.orgId },
    });
    if (!contact) throw new Error('Not found');

    const active = await tx.consentRecord.findFirst({
      where: {
        contactId: contact.id,
        orgId: payload.orgId,
        purpose: 'NETWORK_DISCOVERY',
        withdrawnAt: null,
      },
    });

    if (granted && !active) {
      await tx.consentRecord.create({
        data: { orgId: payload.orgId, contactId: contact.id, purpose: 'NETWORK_DISCOVERY' },
      });
      await emitEvent(tx, {
        orgId: payload.orgId,
        actorType: 'candidate',
        verb: 'consent.granted',
        subjectType: 'contact',
        subjectId: contact.id,
        payload: { purpose: 'NETWORK_DISCOVERY' },
      });
    }
    if (!granted && active) {
      await tx.consentRecord.update({
        where: { id: active.id },
        data: { withdrawnAt: new Date() },
      });
      await emitEvent(tx, {
        orgId: payload.orgId,
        actorType: 'candidate',
        verb: 'consent.withdrawn',
        subjectType: 'contact',
        subjectId: contact.id,
        payload: { purpose: 'NETWORK_DISCOVERY' },
      });
    }
  });
}
