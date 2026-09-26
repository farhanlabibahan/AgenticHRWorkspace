import nodemailer from 'nodemailer';
import { db } from '@/lib/db';
import { emitEvent } from '@/server/events';
import type { SessionContext } from '@/lib/session';

/**
 * Email delivery with merge tokens, scheduling, and automation.
 *
 * Transport: set SMTP_URL (smtp://user:pass@host:587) to send real email —
 * any provider (SES, Postmark, Resend SMTP, self-hosted). Without SMTP_URL
 * messages are marked sent without leaving the box (dev mode), so every
 * flow is testable locally.
 *
 * Scheduling: messages with a future scheduledAt stay SCHEDULED until
 * processDueEmails() runs — wired to /api/cron/emails (Vercel Cron in the
 * managed setup, any cron + curl when self-hosting).
 */

export const MERGE_TOKENS = [
  'candidate_name',
  'first_name',
  'job_title',
  'company_name',
  'sender_name',
  'interview_title',
  'interview_time',
] as const;

export function renderTemplate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => vars[key] ?? '');
}

function getTransport() {
  const url = process.env.SMTP_URL;
  if (!url) return null; // dev mode
  return nodemailer.createTransport(url);
}

export type EmailAttachment = { filename: string; content: string; contentType?: string };

async function deliver(messageId: string, attachments?: EmailAttachment[]) {
  const message = await db.emailMessage.findUnique({ where: { id: messageId } });
  if (!message || message.status !== 'SCHEDULED') return message;

  const transport = getTransport();
  try {
    if (transport) {
      await transport.sendMail({
        from: process.env.EMAIL_FROM ?? 'Source <no-reply@source.local>',
        to: message.toEmail,
        subject: message.subject,
        text: message.body,
        attachments,
      });
    }
    return await db.emailMessage.update({
      where: { id: message.id },
      data: { status: 'SENT', sentAt: new Date() },
    });
  } catch (error) {
    return await db.emailMessage.update({
      where: { id: message.id },
      data: { status: 'FAILED', error: error instanceof Error ? error.message : String(error) },
    });
  }
}

export type SendEmailInput = {
  orgId: string;
  actorId?: string; // user id; undefined = automation
  contactId?: string;
  opportunityId?: string;
  templateId?: string;
  toEmail: string;
  subject: string;
  body: string;
  vars?: Record<string, string>;
  scheduledAt?: Date;
  /** Delivery-time only (not persisted) — so immediate sends can carry .ics invites. */
  attachments?: EmailAttachment[];
};

export async function sendEmail(input: SendEmailInput) {
  const vars = input.vars ?? {};
  const isFuture = !!input.scheduledAt && input.scheduledAt.getTime() > Date.now();

  const message = await db.emailMessage.create({
    data: {
      orgId: input.orgId,
      contactId: input.contactId ?? null,
      opportunityId: input.opportunityId ?? null,
      templateId: input.templateId ?? null,
      senderId: input.actorId ?? null,
      toEmail: input.toEmail,
      subject: renderTemplate(input.subject, vars),
      body: renderTemplate(input.body, vars),
      scheduledAt: input.scheduledAt ?? null,
    },
  });

  if (input.opportunityId) {
    await db.$transaction(async (tx) => {
      await emitEvent(tx, {
        orgId: input.orgId,
        actorType: input.actorId ? 'user' : 'system',
        actorId: input.actorId,
        verb: isFuture ? 'email.scheduled' : 'email.sent',
        subjectType: 'opportunity',
        subjectId: input.opportunityId!,
        payload: {
          subject: message.subject,
          to: message.toEmail,
          ...(isFuture ? { scheduledAt: input.scheduledAt!.toISOString() } : {}),
        },
      });
    });
  }

  if (!isFuture) return deliver(message.id, input.attachments);
  return message;
}

export async function cancelScheduledEmail(ctx: SessionContext, messageId: string) {
  const message = await db.emailMessage.findFirst({
    where: { id: messageId, orgId: ctx.orgId, status: 'SCHEDULED' },
  });
  if (!message) throw new Error('Scheduled email not found');
  const updated = await db.emailMessage.update({
    where: { id: message.id },
    data: { status: 'CANCELED' },
  });
  if (message.opportunityId) {
    await db.$transaction(async (tx) => {
      await emitEvent(tx, {
        orgId: ctx.orgId,
        actorType: 'user',
        actorId: ctx.userId,
        verb: 'email.canceled',
        subjectType: 'opportunity',
        subjectId: message.opportunityId!,
        payload: { subject: message.subject },
      });
    });
  }
  return updated;
}

/** Deliver everything due. Called from /api/cron/emails. */
export async function processDueEmails(): Promise<number> {
  const due = await db.emailMessage.findMany({
    where: { status: 'SCHEDULED', scheduledAt: { not: null, lte: new Date() } },
    take: 100,
  });
  for (const message of due) {
    await deliver(message.id);
    if (message.opportunityId) {
      await db.$transaction(async (tx) => {
        await emitEvent(tx, {
          orgId: message.orgId,
          actorType: 'system',
          verb: 'email.sent',
          subjectType: 'opportunity',
          subjectId: message.opportunityId!,
          payload: { subject: message.subject, to: message.toEmail },
        });
      });
    }
  }
  return due.length;
}

/** Merge vars for an opportunity: candidate, role, and hiring company names. */
export async function buildOpportunityVars(
  opportunityId: string,
  extra: Record<string, string> = {},
): Promise<{ vars: Record<string, string>; toEmail: string | null; contactId: string }> {
  const opp = await db.opportunity.findUnique({
    where: { id: opportunityId },
    include: {
      contact: true,
      org: true,
      posting: { include: { clientCompany: true } },
    },
  });
  if (!opp) throw new Error('Opportunity not found');
  return {
    toEmail: opp.contact.emails[0] ?? null,
    contactId: opp.contactId,
    vars: {
      candidate_name: opp.contact.name,
      first_name: opp.contact.name.split(' ')[0] ?? opp.contact.name,
      job_title: opp.posting?.title ?? 'the role',
      company_name: opp.posting?.clientCompany?.name ?? opp.org.name,
      ...extra,
    },
  };
}

// ---------- Templates ----------

export const DEFAULT_TEMPLATES = [
  {
    name: 'Application received',
    subject: 'We received your application — {{job_title}}',
    body: 'Hi {{first_name}},\n\nThanks for applying to {{job_title}} at {{company_name}}. Our team is reviewing applications and will be in touch about next steps.\n\nBest,\n{{company_name}} Recruiting',
  },
  {
    name: 'Rejection',
    subject: 'Update on your application — {{job_title}}',
    body: 'Hi {{first_name}},\n\nThank you for taking the time to apply to {{job_title}} at {{company_name}}. After careful consideration we have decided not to move forward at this time.\n\nWe appreciate your interest and encourage you to apply to future openings.\n\nBest,\n{{company_name}} Recruiting',
  },
  {
    name: 'Interview scheduled',
    subject: 'Interview confirmed: {{interview_title}} — {{job_title}}',
    body: 'Hi {{first_name}},\n\nYour {{interview_title}} for {{job_title}} at {{company_name}} is confirmed for {{interview_time}}.\n\nWe look forward to speaking with you!\n\nBest,\n{{company_name}} Recruiting',
  },
];

export async function createTemplate(
  ctx: SessionContext,
  input: { name: string; subject: string; body: string },
) {
  return db.emailTemplate.create({ data: { orgId: ctx.orgId, ...input } });
}

export async function updateTemplate(
  ctx: SessionContext,
  templateId: string,
  input: { name: string; subject: string; body: string },
) {
  const template = await db.emailTemplate.findFirst({
    where: { id: templateId, orgId: ctx.orgId },
  });
  if (!template) throw new Error('Template not found');
  return db.emailTemplate.update({ where: { id: template.id }, data: input });
}

export async function deleteTemplate(ctx: SessionContext, templateId: string) {
  const template = await db.emailTemplate.findFirst({
    where: { id: templateId, orgId: ctx.orgId },
  });
  if (!template) throw new Error('Template not found');
  // Detach from automation slots that reference it
  await db.organization.updateMany({
    where: { id: ctx.orgId, autoConfirmTemplateId: template.id },
    data: { autoConfirmTemplateId: null },
  });
  await db.organization.updateMany({
    where: { id: ctx.orgId, autoRejectTemplateId: template.id },
    data: { autoRejectTemplateId: null },
  });
  await db.organization.updateMany({
    where: { id: ctx.orgId, autoInterviewTemplateId: template.id },
    data: { autoInterviewTemplateId: null },
  });
  return db.emailTemplate.delete({ where: { id: template.id } });
}

export async function updateEmailAutomation(
  ctx: SessionContext,
  input: {
    autoConfirmTemplateId: string | null;
    autoRejectTemplateId: string | null;
    autoInterviewTemplateId: string | null;
    autoRejectDelayHours: number;
  },
) {
  return db.organization.update({
    where: { id: ctx.orgId },
    data: {
      autoConfirmTemplateId: input.autoConfirmTemplateId,
      autoRejectTemplateId: input.autoRejectTemplateId,
      autoInterviewTemplateId: input.autoInterviewTemplateId,
      autoRejectDelayHours: Math.max(0, input.autoRejectDelayHours),
    },
  });
}
