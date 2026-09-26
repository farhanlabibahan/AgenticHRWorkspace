import type { InterviewState } from '@prisma/client';
import { db } from '@/lib/db';
import { actorOf, emitEvent } from '@/server/events';
import { buildOpportunityVars, sendEmail } from '@/server/email';
import { buildInterviewIcs } from '@/server/ics';
import type { SessionContext } from '@/lib/session';

export type ScheduleInterviewInput = {
  opportunityId: string;
  title: string;
  startAt: Date;
  durationMins: number;
  location?: string;
  panelistIds: string[];
  /** Copied from an interview-plan step; shown to panelists on the kit page. */
  focusAreas?: string[];
};

export async function scheduleInterview(ctx: SessionContext, input: ScheduleInterviewInput) {
  const interview = await db.$transaction(async (tx) => {
    const opportunity = await tx.opportunity.findFirst({
      where: { id: input.opportunityId, orgId: ctx.orgId },
      include: { contact: true },
    });
    if (!opportunity) throw new Error('Opportunity not found');

    const panelists = await tx.user.findMany({
      where: { id: { in: input.panelistIds }, orgId: ctx.orgId },
    });

    const interview = await tx.interview.create({
      data: {
        orgId: ctx.orgId,
        opportunityId: opportunity.id,
        title: input.title,
        startAt: input.startAt,
        durationMins: input.durationMins,
        location: input.location || null,
        focusAreas: input.focusAreas ?? [],
        panelists: { connect: panelists.map((p) => ({ id: p.id })) },
      },
    });
    await emitEvent(tx, {
      orgId: ctx.orgId,
      ...actorOf(ctx),
      verb: 'interview.scheduled',
      subjectType: 'opportunity',
      subjectId: opportunity.id,
      payload: {
        contactName: opportunity.contact.name,
        title: input.title,
        startAt: input.startAt.toISOString(),
        panel: panelists.map((p) => p.name),
      },
    });
    return interview;
  });

  // Automated candidate confirmation (org setting)
  await sendInterviewConfirmation({
    orgId: ctx.orgId,
    actorId: ctx.userId,
    interviewId: interview.id,
    opportunityId: input.opportunityId,
    title: input.title,
    startAt: input.startAt,
    durationMins: input.durationMins,
    location: input.location,
  });

  return interview;
}

/**
 * Send the org's automated interview-confirmation email (with ICS attached)
 * to the candidate, if the org has one configured. Shared by recruiter-driven
 * scheduling and candidate self-scheduling.
 */
export async function sendInterviewConfirmation(input: {
  orgId: string;
  actorId: string | null;
  interviewId: string;
  opportunityId: string;
  title: string;
  startAt: Date;
  durationMins: number;
  location?: string;
}) {
  const org = await db.organization.findUnique({ where: { id: input.orgId } });
  if (!org?.autoInterviewTemplateId) return;
  const template = await db.emailTemplate.findFirst({
    where: { id: org.autoInterviewTemplateId, orgId: input.orgId },
  });
  const { vars, toEmail, contactId } = await buildOpportunityVars(input.opportunityId, {
    interview_title: input.title,
    interview_time: input.startAt.toLocaleString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }),
  });
  if (!template || !toEmail) return;
  await sendEmail({
    orgId: input.orgId,
    actorId: input.actorId ?? undefined,
    contactId,
    opportunityId: input.opportunityId,
    templateId: template.id,
    toEmail,
    subject: template.subject,
    body: template.body,
    vars,
    attachments: [
      {
        filename: 'interview.ics',
        content: buildInterviewIcs({
          uid: input.interviewId,
          title: `${input.title} — ${vars.company_name}`,
          startAt: input.startAt,
          durationMins: input.durationMins,
          location: input.location,
          organizerName: vars.company_name,
          description: `Interview for ${vars.job_title} at ${vars.company_name}.`,
        }),
        contentType: 'text/calendar; method=PUBLISH',
      },
    ],
  });
}

// ---------- Interview plans (per-posting) ----------

export async function createPlanStep(
  ctx: SessionContext,
  input: { postingId: string; title: string; durationMins: number; focusAreas: string[] },
) {
  const posting = await db.posting.findFirst({
    where: { id: input.postingId, orgId: ctx.orgId },
  });
  if (!posting) throw new Error('Posting not found');
  const last = await db.interviewPlanStep.findFirst({
    where: { postingId: posting.id },
    orderBy: { order: 'desc' },
  });
  return db.interviewPlanStep.create({
    data: {
      orgId: ctx.orgId,
      postingId: posting.id,
      title: input.title,
      durationMins: input.durationMins,
      focusAreas: input.focusAreas.slice(0, 8),
      order: (last?.order ?? -1) + 1,
    },
  });
}

export async function deletePlanStep(ctx: SessionContext, stepId: string) {
  await db.interviewPlanStep.deleteMany({ where: { id: stepId, orgId: ctx.orgId } });
}

export async function setInterviewState(
  ctx: SessionContext,
  interviewId: string,
  state: InterviewState,
) {
  return db.$transaction(async (tx) => {
    const interview = await tx.interview.findFirst({
      where: { id: interviewId, orgId: ctx.orgId },
      include: { opportunity: { include: { contact: true } } },
    });
    if (!interview) throw new Error('Interview not found');

    const updated = await tx.interview.update({
      where: { id: interview.id },
      data: { state },
    });
    await emitEvent(tx, {
      orgId: ctx.orgId,
      ...actorOf(ctx),
      verb: state === 'CANCELED' ? 'interview.canceled' : 'interview.completed',
      subjectType: 'opportunity',
      subjectId: interview.opportunityId,
      payload: { contactName: interview.opportunity.contact.name, title: interview.title },
    });
    return updated;
  });
}
