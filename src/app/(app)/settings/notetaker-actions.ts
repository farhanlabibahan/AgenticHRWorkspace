'use server';

import { after } from 'next/server';
import { revalidatePath } from 'next/cache';
import { requireSession, type SessionContext } from '@/lib/session';
import { aiConfigured } from '@/server/ai';
import { logAiFailure } from '@/server/ai-client';
import { requestOrigin } from '@/server/request-origin';
import { summarizeTranscript } from '@/server/transcripts';
import type { AttachedTo } from '@/server/notetakers/binding';
import {
  attachSuggestedMeeting,
  connectNotetakerWithApiKey,
  disconnectNotetaker,
  dismissSuggestedMeeting,
  startNotetakerOAuth,
} from '@/server/notetakers/connections';
import { attachRecording, recordingsNearInterview, type PickerResult } from '@/server/notetakers/picker';
import { searchAttachCandidates, type PersonTarget } from '@/server/notetakers/review';

/**
 * Meeting notetaker actions. Anyone signed in manages their own
 * connections and their own meetings; nothing here reaches another
 * person's. Every choice made in the browser is checked again on the server
 * (src/server/notetakers/binding.ts).
 */

function refresh() {
  revalidatePath('/settings');
  revalidatePath('/interviews');
  revalidatePath('/candidates/[id]', 'page');
}

/** The same insights step as a pasted or pushed transcript, after the response. */
function summarizeLater(ctx: SessionContext, transcriptId: string | null) {
  if (transcriptId && aiConfigured()) {
    after(() => summarizeTranscript(ctx, transcriptId).catch((error) => logAiFailure('transcript insights', error)));
  }
}

/** Starts signing in; the client sends the browser to the returned URL. */
export async function connectNotetakerAction(provider: string): Promise<{ url: string } | { error: string }> {
  const ctx = await requireSession();
  const { origin } = await requestOrigin();
  if (!origin) return { error: "Couldn't tell which address Source is on" };
  try {
    return await startNotetakerOAuth(ctx, provider, origin);
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Something went wrong' };
  }
}

export async function connectNotetakerKeyAction(provider: string, apiKey: string): Promise<{ ok: true } | { error: string }> {
  const ctx = await requireSession();
  const result = await connectNotetakerWithApiKey(ctx, provider, apiKey);
  if (!result.ok) return { error: result.error };
  refresh();
  return { ok: true };
}

export async function disconnectNotetakerAction(provider: string) {
  const ctx = await requireSession();
  await disconnectNotetaker(ctx, provider);
  refresh();
}

export type AttachChoiceInput = { interviewId?: string | null; opportunityId?: string | null };

/** Attach a meeting on the review card to the interview or candidate chosen there. */
export async function attachMeetingAction(
  meetingId: string,
  choice?: AttachChoiceInput,
): Promise<{ ok: true; attachedTo: AttachedTo | null; linked: boolean } | { error: string }> {
  const ctx = await requireSession();
  const clean =
    choice && (typeof choice.interviewId === 'string' || typeof choice.opportunityId === 'string')
      ? {
          interviewId: typeof choice.interviewId === 'string' ? choice.interviewId : null,
          opportunityId: typeof choice.opportunityId === 'string' ? choice.opportunityId : null,
        }
      : null;
  const result = await attachSuggestedMeeting(ctx, meetingId, clean);
  if (!result.ok) return { error: result.error };
  summarizeLater(ctx, result.created ? result.transcriptId : null);
  refresh();
  return { ok: true, attachedTo: result.attachedTo, linked: result.linked };
}

export async function dismissMeetingAction(meetingId: string) {
  const ctx = await requireSession();
  await dismissSuggestedMeeting(ctx, meetingId);
  refresh();
}

/** "Someone else…" on the review card. */
export async function searchAttachCandidatesAction(query: string): Promise<PersonTarget[]> {
  const ctx = await requireSession();
  return searchAttachCandidates(ctx, typeof query === 'string' ? query : '');
}

/** "Attach a recording": the person's recordings near the interview, read live. */
export async function recordingsNearInterviewAction(interviewId: string): Promise<PickerResult> {
  const ctx = await requireSession();
  return recordingsNearInterview(ctx, interviewId);
}

export async function attachRecordingAction(interviewId: string, token: string): Promise<{ ok: true } | { error: string }> {
  const ctx = await requireSession();
  const result = await attachRecording(ctx, interviewId, token);
  if (!result.ok) return { error: result.error };
  summarizeLater(ctx, result.created ? result.transcriptId : null);
  refresh();
  return { ok: true };
}
