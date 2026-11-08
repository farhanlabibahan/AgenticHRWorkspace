import { db } from '@/lib/db';
import { actorOf, emitEvent } from '@/server/events';
import { sendEmail } from '@/server/email';
import type { SessionContext } from '@/lib/session';

export const RATING_LABELS: Record<number, string> = {
  1: 'Strong no',
  2: 'No',
  3: 'Yes',
  4: 'Strong yes',
};

export type SubmitFeedbackInput = {
  opportunityId: string;
  interviewId?: string;
  overallRating: number; // 1-4
  summary: string;
  /** Raw responses keyed by ScorecardQuestion id; validated + snapshotted. */
  answers?: Record<string, string>;
};

/** Snapshot shape stored in FeedbackSubmission.answers. */
export type ScorecardAnswer = { label: string; kind: 'RATING' | 'TEXT'; value: string };

export async function submitFeedback(ctx: SessionContext, input: SubmitFeedbackInput) {
  if (!ctx.userId) throw new Error('Feedback requires a user author');
  const authorId = ctx.userId;
  if (input.overallRating < 1 || input.overallRating > 4) throw new Error('Invalid rating');

  // Validate answers against the org's live questions and snapshot label+kind
  // so past feedback renders unchanged after questions are edited or archived.
  let answers: Record<string, ScorecardAnswer> | undefined;
  if (input.answers && Object.keys(input.answers).length) {
    const questions = await db.scorecardQuestion.findMany({
      where: { orgId: ctx.orgId, archivedAt: null },
    });
    answers = {};
    for (const q of questions) {
      const raw = (input.answers[q.id] ?? '').trim();
      if (!raw) continue;
      if (q.kind === 'RATING') {
        const n = Number.parseInt(raw, 10);
        if (!Number.isFinite(n) || n < 1 || n > 4) throw new Error(`Invalid rating for "${q.label}"`);
        answers[q.id] = { label: q.label, kind: 'RATING', value: String(n) };
      } else {
        answers[q.id] = { label: q.label, kind: 'TEXT', value: raw.slice(0, 4000) };
      }
    }
    if (!Object.keys(answers).length) answers = undefined;
  }

  return db.$transaction(async (tx) => {
    const opportunity = await tx.opportunity.findFirst({
      where: { id: input.opportunityId, orgId: ctx.orgId },
      include: { contact: true },
    });
    if (!opportunity) throw new Error('Opportunity not found');

    if (input.interviewId) {
      const interview = await tx.interview.findFirst({
        where: { id: input.interviewId, orgId: ctx.orgId, opportunityId: opportunity.id },
      });
      if (!interview) throw new Error('Interview not found');
    }

    const feedback = await tx.feedbackSubmission.create({
      data: {
        orgId: ctx.orgId,
        opportunityId: opportunity.id,
        interviewId: input.interviewId || null,
        authorId,
        overallRating: input.overallRating,
        summary: input.summary,
        answers: answers ?? undefined,
      },
    });
    await emitEvent(tx, {
      orgId: ctx.orgId,
      ...actorOf(ctx),
      verb: 'feedback.submitted',
      subjectType: 'opportunity',
      subjectId: opportunity.id,
      payload: {
        contactName: opportunity.contact.name,
        rating: RATING_LABELS[input.overallRating],
      },
    });
    return feedback;
  });
}

const REMINDER_GRACE_HOURS = 20;

/**
 * Nag panelists who haven't submitted a scorecard for an interview that
 * completed more than REMINDER_GRACE_HOURS ago. One reminder per
 * panelist-interview, tracked via the event stream. Wired to
 * /api/cron/emails alongside scheduled sends.
 */
export async function processFeedbackReminders(): Promise<number> {
  const cutoff = new Date(Date.now() - REMINDER_GRACE_HOURS * 3_600_000);
  // Interviews brought in by an ATS import happened in the other system —
  // never nag teammates about them. Filtered in SQL so a large import can't
  // crowd real interviews out of the batch.
  const due = await db.$queryRaw<{ id: string }[]>`
    SELECT i.id FROM "Interview" i
    WHERE i.state = 'COMPLETED'
      AND i."startAt" <= ${cutoff}
      AND i."startAt" >= ${new Date(Date.now() - 14 * 86_400_000)}
      AND NOT EXISTS (SELECT 1 FROM "ImportRef" r WHERE r."internalId" = i.id AND r.kind = 'interview')
    LIMIT 100`;
  const interviews = await db.interview.findMany({
    where: { id: { in: due.map((r) => r.id) } },
    include: {
      panelists: true,
      opportunity: { include: { contact: true, feedback: true, posting: true } },
    },
  });

  let sent = 0;
  for (const interview of interviews) {
    for (const panelist of interview.panelists) {
      if (panelist.deactivatedAt) continue;
      const hasFeedback = interview.opportunity.feedback.some(
        (f) => f.authorId === panelist.id,
      );
      if (hasFeedback) continue;
      const alreadyReminded = await db.event.findFirst({
        where: {
          orgId: interview.orgId,
          verb: 'feedback.reminder_sent',
          subjectType: 'interview',
          subjectId: interview.id,
          payload: { path: ['panelistId'], equals: panelist.id },
        },
      });
      if (alreadyReminded) continue;

      const candidate = interview.opportunity.contact.name;
      const role = interview.opportunity.posting?.title ?? 'the role';
      await sendEmail({
        orgId: interview.orgId,
        toEmail: panelist.email,
        subject: `Scorecard missing: ${candidate} — ${interview.title}`,
        body: `Hi ${panelist.name.split(' ')[0]},\n\nYou interviewed ${candidate} for ${role} (${interview.title}) and your scorecard hasn't been submitted yet. Feedback loses fidelity fast — please add it while it's fresh.\n\nOpen the candidate: /candidates/${interview.opportunityId}\n\n— Orqestra`,
      });
      await db.event.create({
        data: {
          orgId: interview.orgId,
          actorType: 'system',
          verb: 'feedback.reminder_sent',
          subjectType: 'interview',
          subjectId: interview.id,
          payload: { panelistId: panelist.id, panelistName: panelist.name },
        },
      });
      sent++;
    }
  }
  return sent;
}
