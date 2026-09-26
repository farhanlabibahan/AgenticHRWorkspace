import { after, NextResponse } from 'next/server';
import { chainCron, cronAuthorized, takeCronLease } from '@/server/cron';
import { aiConfigured } from '@/server/ai';
import { logAiFailure } from '@/server/ai-client';
import { summarizeTranscript } from '@/server/transcripts';
import { syncTranscriptConnections, TRANSCRIPTS_CRON_BUDGET_MS } from '@/server/notetakers/sync';

// A run works for up to TRANSCRIPTS_CRON_BUDGET_MS; leave headroom for the response.
export const maxDuration = 300;

/**
 * Pulls interview transcripts from the meeting notetakers people connected
 * in Settings → Integrations (src/server/notetakers). Every 10 minutes; one
 * run at a time. Transcripts it attaches get the same insights step as the
 * transcripts API, after the response and only when AI is configured: the
 * sync itself never calls a model. Self-hosted, any cron + curl works:
 *   curl -H "Authorization: Bearer $CRON_SECRET" https://…/api/cron/transcripts
 */
export async function GET(request: Request) {
  if (!cronAuthorized(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const started = Date.now();
  const release = await takeCronLease('transcripts', new Date(started + TRANSCRIPTS_CRON_BUDGET_MS + 60_000));
  if (!release) return NextResponse.json({ busy: true });
  try {
    const summary = await syncTranscriptConnections({ deadline: started + TRANSCRIPTS_CRON_BUDGET_MS });
    if (aiConfigured() && summary.attached.length) {
      after(async () => {
        for (const t of summary.attached) {
          await summarizeTranscript({ userId: t.userId, orgId: t.orgId, accessRole: 'TEAM_MEMBER' }, t.transcriptId).catch((error) =>
            logAiFailure('transcript insights', error),
          );
        }
      });
    }
    if (summary.more) after(() => chainCron('/api/cron/transcripts'));
    return NextResponse.json({
      connections: summary.connections,
      synced: summary.synced,
      idle: summary.idle,
      failed: summary.failed,
      busy: summary.busy,
      attached: summary.attached.length,
      suggested: summary.suggested,
      more: summary.more,
    });
  } finally {
    await release();
  }
}
