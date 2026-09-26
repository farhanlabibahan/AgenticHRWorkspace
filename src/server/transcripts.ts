import { db } from '@/lib/db';
import { actorOf, emitEvent } from '@/server/events';
import type { SessionContext } from '@/lib/session';
import type { Prisma } from '@prisma/client';
import { extractInterviewInsights } from '@/server/ai';

/**
 * Interview/meeting transcripts — the searchable corpus. Attached to a
 * candidate's opportunity (so a transcript belongs to the person-in-process
 * for a specific role) and optionally to the exact interview. Ingestion:
 * paste in the app, or external transcription tools (Walkie, Tactiq,
 * Fireflies, a Google Meet exporter…) push via POST /api/v1/transcripts, and
 * the meeting notetakers people connect in Settings (over MCP) are pulled by
 * the transcripts cron (src/server/notetakers).
 */

export const MAX_TRANSCRIPT_CHARS = 500_000;

export type AddTranscriptInput = {
  opportunityId: string;
  interviewId?: string;
  title: string;
  content: string;
  source?: string;
};

export async function addTranscript(ctx: SessionContext, input: AddTranscriptInput) {
  return db.$transaction((tx) => addTranscriptTx(tx, ctx, input));
}

/**
 * addTranscript inside the caller's transaction, for callers that record
 * something alongside it atomically (a notetaker meeting's ledger row).
 */
export async function addTranscriptTx(tx: Prisma.TransactionClient, ctx: SessionContext, input: AddTranscriptInput) {
  const content = input.content.trim().slice(0, MAX_TRANSCRIPT_CHARS);
  if (!content) throw new Error('Transcript text is required');
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
  const transcript = await tx.transcript.create({
    data: {
      orgId: ctx.orgId,
      opportunityId: opportunity.id,
      interviewId: input.interviewId ?? null,
      title: input.title.trim() || 'Interview transcript',
      content,
      source: (input.source ?? 'manual').slice(0, 40),
    },
  });
  await emitEvent(tx, {
    orgId: ctx.orgId,
    ...actorOf(ctx),
    verb: 'transcript.added',
    subjectType: 'opportunity',
    subjectId: opportunity.id,
    payload: {
      contactName: opportunity.contact.name,
      title: transcript.title,
      source: transcript.source,
    },
  });
  return transcript;
}

/**
 * Pull the questions, answers and stated facts out of a transcript and keep
 * them on it. Run when a transcript arrives (with AI on) or on request.
 */
export async function summarizeTranscript(ctx: SessionContext, transcriptId: string) {
  const transcript = await db.transcript.findFirst({
    where: { id: transcriptId, orgId: ctx.orgId },
    select: { id: true, content: true, opportunityId: true, title: true },
  });
  if (!transcript) throw new Error('Transcript not found');
  const insights = await extractInterviewInsights(transcript.content);
  await db.$transaction(async (tx) => {
    await tx.transcript.update({ where: { id: transcript.id }, data: { insights: insights as Prisma.InputJsonValue } });
    await emitEvent(tx, {
      orgId: ctx.orgId,
      ...actorOf(ctx),
      verb: 'transcript.summarized',
      subjectType: 'opportunity',
      subjectId: transcript.opportunityId,
      payload: { title: transcript.title, questions: insights.qa.length },
    });
  });
  return insights;
}

export async function deleteTranscript(ctx: SessionContext, transcriptId: string) {
  const transcript = await db.transcript.findFirst({
    where: { id: transcriptId, orgId: ctx.orgId },
  });
  if (!transcript) throw new Error('Transcript not found');
  return db.transcript.delete({ where: { id: transcript.id } });
}

export function snippetAround(text: string, q: string, radius = 80): string {
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx === -1) return text.slice(0, radius * 2);
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + q.length + radius);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}
