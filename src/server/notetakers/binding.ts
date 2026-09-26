import type { Prisma, TranscriptConnection } from '@prisma/client';
import type { FetchLike } from '@modelcontextprotocol/client';
import { db } from '@/lib/db';
import type { SessionContext } from '@/lib/session';
import { notetakerProvider } from '@/lib/notetaker-providers';
import { createAdapter } from '@/server/notetakers/adapters';
import { withConnectionLock } from '@/server/notetakers/locks';
import { markNeedsReconnect } from '@/server/notetakers/oauth';
import type { NormalizedMeeting } from '@/server/notetakers/parse';
import { describeFailure, withConnectionSession, type AttachTarget } from '@/server/notetakers/sync';

/**
 * Binding a notetaker meeting to a person, by hand: the checks both ways in
 * share (the review card on the Interviews page, and "Attach a recording" on
 * a candidate's interview). Who may be chosen, which connections count, and
 * fetching a transcript under the connection's lock.
 */

/**
 * Opportunities the signed-in person may see, the same rule the rest of the
 * app applies: this org's (every page and action is org-scoped; Source has
 * no per-posting visibility yet), and not a candidate whose data was erased
 * (anonymized contacts drop out of lists, the portal and the sync alike).
 */
export function visibleOpportunityWhere(ctx: Pick<SessionContext, 'orgId'>): Prisma.OpportunityWhereInput {
  return { orgId: ctx.orgId, contact: { isAnonymized: false } };
}

/** Connections a person can use right now: signed in, credentials kept (ERROR is a failed sync, not a failed sign-in). */
export function usableConnectionWhere(ctx: Pick<SessionContext, 'orgId'> & { userId: string }): Prisma.TranscriptConnectionWhereInput {
  return { orgId: ctx.orgId, userId: ctx.userId, status: { in: ['ACTIVE', 'ERROR'] }, credentials: { not: null } };
}

/** Whether the person has a notetaker to pick recordings from. */
export async function hasUsableNotetaker(ctx: SessionContext): Promise<boolean> {
  if (!ctx.userId) return false;
  return (await db.transcriptConnection.count({ where: usableConnectionWhere({ orgId: ctx.orgId, userId: ctx.userId }) })) > 0;
}

export type AttachChoice = { interviewId?: string | null; opportunityId?: string | null };

export type ResolvedTarget = {
  target: AttachTarget;
  /** For the confirmation: who it went to, and on which interview. */
  contactName: string;
  interviewTitle: string | null;
};

const PROFILE_TITLE = 'Meeting transcript';

/**
 * The interview or opportunity a person chose, if they may attach to it:
 * in their org, visible to them, and (for an interview) not canceled and on
 * the opportunity they named. Null otherwise; never says which check failed.
 */
export async function resolveAttachTarget(ctx: SessionContext, choice: AttachChoice): Promise<ResolvedTarget | null> {
  if (choice.interviewId) {
    const iv = await db.interview.findFirst({
      where: { id: choice.interviewId, orgId: ctx.orgId, state: { not: 'CANCELED' }, opportunity: visibleOpportunityWhere(ctx) },
      select: { id: true, title: true, opportunityId: true, opportunity: { select: { contact: { select: { name: true } } } } },
    });
    if (!iv || (choice.opportunityId && choice.opportunityId !== iv.opportunityId)) return null;
    return {
      target: { interviewId: iv.id, opportunityId: iv.opportunityId, title: iv.title },
      contactName: iv.opportunity.contact.name,
      interviewTitle: iv.title,
    };
  }
  if (!choice.opportunityId) return null;
  const opp = await db.opportunity.findFirst({
    where: { id: choice.opportunityId, ...visibleOpportunityWhere(ctx) },
    select: { id: true, contact: { select: { name: true } } },
  });
  if (!opp) return null;
  return { target: { interviewId: null, opportunityId: opp.id, title: PROFILE_TITLE }, contactName: opp.contact.name, interviewTitle: null };
}

export type AttachedTo = { contactName: string; opportunityId: string; interviewTitle: string | null };

/** Where attached meetings' transcripts are, by transcript id. A deleted transcript has no entry. */
export async function attachedToMany(orgId: string, transcriptIds: (string | null)[]): Promise<Map<string, AttachedTo>> {
  const ids = [...new Set(transcriptIds.filter((id): id is string => Boolean(id)))];
  if (!ids.length) return new Map();
  const rows = await db.transcript.findMany({
    where: { id: { in: ids }, orgId },
    select: {
      id: true,
      opportunityId: true,
      interview: { select: { title: true } },
      opportunity: { select: { contact: { select: { name: true } } } },
    },
  });
  return new Map(
    rows.map((t) => [t.id, { contactName: t.opportunity.contact.name, opportunityId: t.opportunityId, interviewTitle: t.interview?.title ?? null }]),
  );
}

/** Where an attached meeting's transcript is. Null when the transcript was deleted since. */
export async function attachedToOf(orgId: string, transcriptId: string | null): Promise<AttachedTo | null> {
  if (!transcriptId) return null;
  return (await attachedToMany(orgId, [transcriptId])).get(transcriptId) ?? null;
}

export function providerName(provider: string) {
  return notetakerProvider(provider)?.name ?? provider;
}

/**
 * A meeting's transcript, fetched now under the connection's lock (OAuth
 * refresh tokens rotate: never two sessions of one connection at once). A
 * refused credential marks the connection for reconnecting, as the cron does.
 */
export async function fetchTranscriptLocked(
  conn: TranscriptConnection,
  meeting: Pick<NormalizedMeeting, 'externalId' | 'startAt'>,
  opts: { fetchFn?: FetchLike; timeoutMs?: number } = {},
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const name = providerName(conn.provider);
  try {
    const run = await withConnectionLock(
      conn.id,
      () =>
        withConnectionSession(
          conn,
          async (session) => {
            const adapter = createAdapter(conn.provider);
            adapter.resolve(session.tools);
            return adapter.transcript(session.call, { externalId: meeting.externalId, startAt: meeting.startAt });
          },
          { fetchFn: opts.fetchFn, timeoutMs: opts.timeoutMs },
        ),
      { timeoutMs: 120_000 },
    );
    if (!run.locked) return { ok: false, error: `${name} is syncing right now. Try again in a minute.` };
    const text = run.value?.trim();
    if (!text) return { ok: false, error: `${name} doesn't have a transcript for this meeting yet` };
    return { ok: true, text };
  } catch (err) {
    const failure = describeFailure(conn, err);
    if (failure.status === 'NEEDS_RECONNECT') await markNeedsReconnect(conn.id, failure.error);
    return { ok: false, error: failure.error };
  }
}
