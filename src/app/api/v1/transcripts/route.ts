import { after, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiError, apiSessionContext, paginated, parsePagination, withApiAuth } from '@/lib/api';
import { addTranscript, MAX_TRANSCRIPT_CHARS, summarizeTranscript } from '@/server/transcripts';
import { aiConfigured } from '@/server/ai';
import { logAiFailure } from '@/server/ai-client';

/**
 * Transcript ingestion for external transcription tools (Walkie, Tactiq,
 * Fireflies, Google Meet exporters, Zapier…). Push each meeting transcript
 * here and it lands on the candidate's profile and joins the AI-searchable
 * corpus. Attach by opportunity_id (required) and interview_id (optional).
 */
export async function GET(request: Request) {
  return withApiAuth(request, async (api) => {
    const { limit, cursor } = parsePagination(request.url);
    const opportunityId = new URL(request.url).searchParams.get('opportunity_id');
    const transcripts = await db.transcript.findMany({
      where: {
        orgId: api.orgId,
        ...(opportunityId ? { opportunityId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      take: limit + 1,
    });
    return paginated(
      transcripts.map((t) => ({
        id: t.id,
        opportunity_id: t.opportunityId,
        interview_id: t.interviewId,
        title: t.title,
        source: t.source,
        content_length: t.content.length,
        created_at: t.createdAt.toISOString(),
      })),
      limit,
    );
  });
}

export async function POST(request: Request) {
  return withApiAuth(request, async (api) => {
    const body = (await request.json().catch(() => null)) as {
      opportunity_id?: string;
      interview_id?: string;
      title?: string;
      content?: string;
      source?: string;
    } | null;
    if (!body?.opportunity_id) return apiError(422, 'invalid', 'opportunity_id is required');
    if (!body.content?.trim()) return apiError(422, 'invalid', 'content is required');
    if (body.content.length > MAX_TRANSCRIPT_CHARS)
      return apiError(422, 'invalid', `content exceeds ${MAX_TRANSCRIPT_CHARS} characters`);

    const ctx = apiSessionContext(api);
    const transcript = await addTranscript(ctx, {
      opportunityId: body.opportunity_id,
      interviewId: body.interview_id,
      title: body.title ?? 'Interview transcript',
      content: body.content,
      source: body.source ?? 'api',
    });
    // Questions and facts are pulled out after the response, so a push from a
    // transcription tool never waits on the model.
    if (aiConfigured()) {
      after(() => summarizeTranscript(ctx, transcript.id).catch((error) => logAiFailure('transcript insights', error)));
    }
    return NextResponse.json(
      {
        id: transcript.id,
        opportunity_id: transcript.opportunityId,
        interview_id: transcript.interviewId,
        title: transcript.title,
        source: transcript.source,
        created_at: transcript.createdAt.toISOString(),
      },
      { status: 201 },
    );
  });
}
