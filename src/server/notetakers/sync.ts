import { auth, OAuthError, UnauthorizedError, type AuthProvider, type FetchLike } from '@modelcontextprotocol/client';
import type { TranscriptConnection } from '@prisma/client';
import { db } from '@/lib/db';
import type { SessionContext } from '@/lib/session';
import { notetakerProvider } from '@/lib/notetaker-providers';
import { DEMO_EMAIL } from '@/server/demo-accounts';
import { addTranscriptTx } from '@/server/transcripts';
import { createAdapter, MissingToolsError, type NotetakerAdapter, type ToolCaller } from '@/server/notetakers/adapters';
import { withConnectionLock, lockInTransaction } from '@/server/notetakers/locks';
import { matchMeeting, nearAnInterview, MATCH_TOLERANCE_MS, type InterviewForMatch } from '@/server/notetakers/match';
import {
  markNeedsReconnect,
  NotetakerOAuthProvider,
  openSecrets,
  ReconnectRequiredError,
  RefreshFailedError,
} from '@/server/notetakers/oauth';
import { clip, ToolCallError, ToolOutputError, type NormalizedMeeting } from '@/server/notetakers/parse';
import { withMcpSession, type McpSession } from '@/server/notetakers/session';

/**
 * The transcripts cron: for each connected notetaker, list the meetings since
 * the last sync, keep the ones that line up with the owner's interviews, and
 * attach their transcripts (match.ts has the rule). What it guarantees:
 *
 *  - a meeting that lines up with none of the owner's interviews is dropped
 *    in memory: no title, no attendees, no id is written anywhere;
 *  - only a candidate email among the attendees attaches on its own; the
 *    candidate's name, or the time alone, makes a suggestion for the owner
 *    to confirm (two candidates can share a name);
 *  - nothing is asked of the provider at all while the owner has no
 *    interview in the window (and at most once an hour for Fireflies, whose
 *    free plan allows 50 requests a day);
 *  - a meeting attached once is never attached again, by this connection or
 *    a teammate's (ExternalMeeting is the ledger);
 *  - no AI runs here. The route hands attached transcripts to the insights
 *    step afterwards, the same as the transcripts API does.
 *
 * Interviews created by an ATS import, and demo workspaces, are left out.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How far back a connection's first sync looks. */
export const FIRST_SYNC_LOOKBACK_MS = 14 * DAY;
/** Each sync re-reads this much before the last one, for meetings the provider published late. */
export const SYNC_OVERLAP_MS = 2 * HOUR;
/** Leaves the cron's 300s maxDuration headroom to finish and respond. */
export const TRANSCRIPTS_CRON_BUDGET_MS = 240_000;

export type AttachedTranscript = { transcriptId: string; orgId: string; userId: string };

export type ConnectionSyncResult =
  | { outcome: 'synced'; attached: AttachedTranscript[]; suggested: number; complete: boolean }
  | { outcome: 'idle' } // no interview in the window: the provider wasn't called
  | { outcome: 'failed'; status: 'NEEDS_RECONNECT' | 'ERROR'; error: string };

export type SyncSummary = {
  connections: number;
  synced: number;
  idle: number;
  failed: number;
  busy: number;
  attached: AttachedTranscript[];
  suggested: number;
  /** Stopped at the time budget with connections left. */
  more: boolean;
};

export type SyncOptions = {
  now?: Date;
  /** Epoch ms after which no new work starts. */
  deadline?: number;
  /** Only these connections (tests, "sync now"). */
  connectionIds?: string[];
  fetchFn?: FetchLike;
};

function contextFor(conn: Pick<TranscriptConnection, 'userId' | 'orgId'>): SessionContext {
  return { userId: conn.userId, orgId: conn.orgId, accessRole: 'TEAM_MEMBER' };
}

function providerName(provider: string) {
  return notetakerProvider(provider)?.name ?? provider;
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Orgs made by the demo login: notetakers never run there (it's a shared sandbox). */
export async function isDemoOrg(orgId: string): Promise<boolean> {
  return Boolean(await db.user.findFirst({ where: { orgId, email: DEMO_EMAIL }, select: { id: true } }));
}

/**
 * The owner's interviews between `from` and `to`: scheduled or completed, on
 * a panel they sit on or an opportunity they own, for a candidate who hasn't
 * been anonymized, and not brought in by an ATS import.
 */
export async function interviewsForMatching(
  conn: Pick<TranscriptConnection, 'orgId' | 'userId'>,
  from: Date,
  to: Date,
): Promise<InterviewForMatch[]> {
  const rows = await db.interview.findMany({
    where: {
      orgId: conn.orgId,
      state: { in: ['SCHEDULED', 'COMPLETED'] },
      startAt: { gte: from, lte: to },
      opportunity: { contact: { isAnonymized: false } },
      OR: [{ panelists: { some: { id: conn.userId } } }, { opportunity: { ownerId: conn.userId } }],
    },
    select: {
      id: true,
      title: true,
      startAt: true,
      opportunityId: true,
      opportunity: { select: { contact: { select: { emails: true, name: true } } } },
    },
    orderBy: { startAt: 'asc' },
    take: 500,
  });
  if (!rows.length) return [];
  const imported = await db.importRef.findMany({
    where: { orgId: conn.orgId, kind: 'interview', internalId: { in: rows.map((r) => r.id) } },
    select: { internalId: true },
  });
  const skip = new Set(imported.map((r) => r.internalId));
  return rows
    .filter((r) => !skip.has(r.id))
    .map((r) => ({
      id: r.id,
      title: r.title,
      startAt: r.startAt,
      opportunityId: r.opportunityId,
      candidateEmails: r.opportunity.contact.emails,
      candidateName: r.opportunity.contact.name,
    }));
}

/** The auth a connection's session sends: its API key, or its OAuth tokens in background mode. */
export function authForConnection(
  conn: TranscriptConnection,
  fetchFn?: FetchLike,
): { authProvider: AuthProvider | NotetakerOAuthProvider; oauth: NotetakerOAuthProvider | null } {
  const name = providerName(conn.provider);
  if (conn.authType === 'API_KEY') {
    const secrets = openSecrets(conn.credentials);
    if (secrets?.kind !== 'api_key') throw new ReconnectRequiredError(`Orqestra can't read the saved ${name} API key. Add it again.`);
    return { authProvider: { token: async () => secrets.apiKey }, oauth: null };
  }
  if (!conn.redirectUri || !conn.credentials) throw new ReconnectRequiredError(`${name} needs you to sign in again`);
  const oauth = new NotetakerOAuthProvider(conn, conn.redirectUri, { kind: 'background' }, { scope: notetakerProvider(conn.provider)?.scope, fetchFn });
  return { authProvider: oauth, oauth };
}

/**
 * Opens a session for a connection, refreshing an expired access token
 * first (a refresh that fails marks the connection NEEDS_RECONNECT).
 * `timeoutMs` bounds each request of the session (60s by default).
 */
export async function withConnectionSession<T>(
  conn: TranscriptConnection,
  fn: (session: McpSession) => Promise<T>,
  opts: { fetchFn?: FetchLike; timeoutMs?: number } = {},
): Promise<T> {
  const { authProvider, oauth } = authForConnection(conn, opts.fetchFn);
  if (oauth?.accessTokenExpired() && oauth.hasRefreshToken()) {
    await auth(oauth, {
      serverUrl: conn.serverUrl,
      resourceMetadataUrl: resourceMetadataUrlFor(conn),
      fetchFn: opts.fetchFn,
    });
  }
  return withMcpSession(conn.serverUrl, authProvider, fn, { fetchFn: opts.fetchFn, timeoutMs: opts.timeoutMs });
}

function resourceMetadataUrlFor(conn: TranscriptConnection): URL | undefined {
  const meta = notetakerProvider(conn.provider);
  // Only for the provider's own endpoint (a test or self-hosted server discovers its own).
  return meta?.resourceMetadataUrl && meta.serverUrl === conn.serverUrl ? new URL(meta.resourceMetadataUrl) : undefined;
}

/** What went wrong, in words for the connection's owner; never meeting content. */
export function describeFailure(conn: Pick<TranscriptConnection, 'provider' | 'authType'>, err: unknown): { status: 'NEEDS_RECONNECT' | 'ERROR'; error: string } {
  const name = providerName(conn.provider);
  if (err instanceof ReconnectRequiredError) return { status: 'NEEDS_RECONNECT', error: err.message };
  if (err instanceof RefreshFailedError) return { status: 'ERROR', error: err.message };
  // Any other answer from the token endpoint (temporarily_unavailable…): a refused
  // grant or client never gets here, the SDK turns those into a new sign-in.
  if (OAuthError.isInstance(err)) {
    return { status: 'ERROR', error: `Couldn't refresh the ${name} sign-in (${clip(String(err.code), 40)}). Orqestra will try again.` };
  }
  const httpStatus = (err as { data?: { status?: unknown } } | null)?.data?.status;
  // A refused credential: 401, or 403 as Fireflies answers a key it doesn't know.
  if (UnauthorizedError.isInstance(err) || httpStatus === 401 || httpStatus === 403) {
    return {
      status: 'NEEDS_RECONNECT',
      error: conn.authType === 'API_KEY' ? `${name} didn't accept the API key` : `${name} needs you to sign in again`,
    };
  }
  if (err instanceof MissingToolsError || err instanceof ToolOutputError) return { status: 'ERROR', error: clip(err.message, 300) };
  if (err instanceof ToolCallError) return { status: 'ERROR', error: clip(`${name} returned an error from ${err.tool}: ${err.message}`, 300) };
  // The response body of an HTTP error can be anything; the status says enough.
  if (typeof httpStatus === 'number') return { status: 'ERROR', error: `${name} answered with HTTP ${httpStatus}. Orqestra will try again.` };
  const message = err instanceof Error ? err.message : String(err);
  return { status: 'ERROR', error: clip(`Couldn't sync with ${name}: ${message}`, 300) };
}

/** Where a transcript goes: an interview, or the candidate's profile (an opportunity) without one. */
export type AttachTarget = { interviewId: string | null; opportunityId: string; title: string };

/** An interview as an attach target. */
export function interviewTarget(iv: Pick<InterviewForMatch, 'id' | 'opportunityId' | 'title'>): AttachTarget {
  return { interviewId: iv.id, opportunityId: iv.opportunityId, title: iv.title };
}

/** The attendees' emails, as the ledger keeps them. */
export function attendeeEmailsOf(meeting: Pick<NormalizedMeeting, 'attendees'>): string[] {
  return meeting.attendees.map((a) => a.email).filter((e): e is string => Boolean(e));
}

/** The attendees' names worth keeping on a suggestion: trimmed, distinct, bounded. */
export function attendeeNamesOf(meeting: Pick<NormalizedMeeting, 'attendees'>): string[] {
  const out = new Map<string, string>();
  for (const a of meeting.attendees) {
    const name = a.name ? clip(a.name, 120) : '';
    if (name && !out.has(name.toLowerCase())) out.set(name.toLowerCase(), name);
  }
  return [...out.values()].slice(0, 50);
}

export type AttachOutcome = {
  transcriptId: string | null;
  created: boolean;
  /** A teammate's connection had attached this meeting already: this one links to theirs. */
  linked: boolean;
  /** The interview the transcript is on: the target's, or the earlier attach's. */
  interviewId: string | null;
};

/**
 * Attach a meeting's transcript to an interview (or a profile), once. Under
 * a lock on the external meeting, so two connections that both see it (two
 * panelists on Fireflies) can't both create a transcript: the second links
 * to the first, wherever that one went.
 */
export async function attachMeeting(
  conn: Pick<TranscriptConnection, 'id' | 'orgId' | 'userId' | 'provider'>,
  meeting: NormalizedMeeting,
  target: AttachTarget,
  text: string,
): Promise<AttachOutcome> {
  return db.$transaction(
    async (tx) => {
      await lockInTransaction(tx, 'meeting', `${conn.orgId} ${conn.provider} ${meeting.externalId}`);
      const mine = await tx.externalMeeting.findUnique({
        where: { connectionId_externalId: { connectionId: conn.id, externalId: meeting.externalId } },
      });
      if (mine?.status === 'ATTACHED') {
        return { transcriptId: mine.transcriptId, created: false, linked: false, interviewId: mine.interviewId };
      }
      const earlier = await tx.externalMeeting.findFirst({
        where: { orgId: conn.orgId, provider: conn.provider, externalId: meeting.externalId, status: 'ATTACHED' },
        select: { transcriptId: true, interviewId: true },
      });
      let transcriptId = earlier ? earlier.transcriptId : null;
      let created = false;
      if (!earlier) {
        // Only linking was asked for, and there's nothing to link to after all.
        if (!text.trim()) return { transcriptId: null, created: false, linked: false, interviewId: null };
        const transcript = await addTranscriptTx(tx, contextFor(conn), {
          opportunityId: target.opportunityId,
          ...(target.interviewId ? { interviewId: target.interviewId } : {}),
          title: meeting.title || target.title,
          content: text,
          source: conn.provider,
        });
        transcriptId = transcript.id;
        created = true;
      }
      const interviewId = earlier ? earlier.interviewId : target.interviewId;
      const data = {
        status: 'ATTACHED' as const,
        transcriptId,
        interviewId,
        title: meeting.title,
        startAt: meeting.startAt,
        endAt: meeting.endAt ?? null,
        attendeeEmails: attendeeEmailsOf(meeting),
        // Names are kept for the review card only.
        attendeeNames: [],
      };
      if (mine) await tx.externalMeeting.update({ where: { id: mine.id }, data });
      else
        await tx.externalMeeting.create({
          data: { ...data, orgId: conn.orgId, connectionId: conn.id, provider: conn.provider, externalId: meeting.externalId },
        });
      return { transcriptId, created, linked: Boolean(earlier), interviewId };
    },
    { timeout: 30_000, maxWait: 15_000 },
  );
}

/**
 * The part of a sync that talks to the provider: list, match, attach or
 * suggest. Returns whether it got through everything before the deadline.
 */
async function processMeetings(
  conn: TranscriptConnection,
  adapter: NotetakerAdapter,
  call: ToolCaller,
  window: { from: Date; to: Date },
  interviews: InterviewForMatch[],
  deadline: number,
) {
  const attached: AttachedTranscript[] = [];
  let suggested = 0;
  let complete = true;
  let warning: string | null = null;

  const listed = await adapter.list(call, window, deadline);
  // Anything not next to an interview goes no further than this line (and
  // nothing that hasn't happened yet, should a provider list calendar events).
  let near = listed.filter((m) => m.startAt <= window.to && nearAnInterview(m, interviews));
  if (!near.length) return { attached, suggested, complete, warning };

  const known = await db.externalMeeting.findMany({
    where: { connectionId: conn.id, externalId: { in: near.map((m) => m.externalId) } },
    select: { externalId: true },
  });
  const seen = new Set(known.map((k) => k.externalId));
  near = near.filter((m) => !seen.has(m.externalId));
  if (!near.length) return { attached, suggested, complete, warning };

  if (adapter.details && near.some((m) => !m.attendees.some((a) => a.email))) {
    near = await adapter.details(call, near, deadline);
  }

  // Meetings a teammate's connection already attached (the same recording,
  // shared with both): link to that transcript instead of fetching it again.
  const elsewhere = new Set(
    (
      await db.externalMeeting.findMany({
        where: { orgId: conn.orgId, provider: conn.provider, status: 'ATTACHED', externalId: { in: near.map((m) => m.externalId) } },
        select: { externalId: true },
      })
    ).map((r) => r.externalId),
  );

  for (const meeting of near) {
    const match = matchMeeting(meeting, interviews);
    if (!match) continue;
    if (elsewhere.has(meeting.externalId)) {
      await attachMeeting(conn, meeting, interviewTarget(match.interview), '');
      continue;
    }
    if (match.kind === 'suggest') {
      // The candidate's name or the time alone: its owner says which candidate
      // it was on the review card, which needs the names to tell them apart.
      const res = await db.externalMeeting.createMany({
        data: [
          {
            orgId: conn.orgId,
            connectionId: conn.id,
            provider: conn.provider,
            externalId: meeting.externalId,
            title: meeting.title,
            startAt: meeting.startAt,
            endAt: meeting.endAt ?? null,
            attendeeEmails: attendeeEmailsOf(meeting),
            attendeeNames: attendeeNamesOf(meeting),
            interviewId: match.interview.id,
            status: 'SUGGESTED',
          },
        ],
        skipDuplicates: true,
      });
      suggested += res.count;
      continue;
    }
    if (Date.now() > deadline) {
      complete = false;
      break;
    }
    try {
      const text = await adapter.transcript(call, meeting);
      // Not transcribed yet: leave no trace, and pick it up on a later run.
      if (!text?.trim()) continue;
      const result = await attachMeeting(conn, meeting, interviewTarget(match.interview), text);
      if (result.created && result.transcriptId) {
        attached.push({ transcriptId: result.transcriptId, orgId: conn.orgId, userId: conn.userId });
      }
    } catch (err) {
      // A refused credential stops the whole sync; anything else (a paid-plan
      // error for one transcript, an interview deleted meanwhile) is this
      // meeting's alone. It's left unrecorded, so a later run tries again.
      const failure = describeFailure(conn, err);
      if (failure.status === 'NEEDS_RECONNECT') throw err;
      warning ??= failure.error;
    }
  }
  return { attached, suggested, complete, warning };
}

/** One connection's sync. The caller holds its lock. */
export async function syncConnection(
  conn: TranscriptConnection,
  opts: { now: Date; deadline: number; fetchFn?: FetchLike },
): Promise<ConnectionSyncResult> {
  const { now, deadline } = opts;
  const window = {
    from: new Date(conn.lastSyncedAt ? conn.lastSyncedAt.getTime() - SYNC_OVERLAP_MS : now.getTime() - FIRST_SYNC_LOOKBACK_MS),
    to: now,
  };
  // Providers that take whole days return meetings from the start of that
  // day, so interviews from then on are the ones a listed meeting can match.
  const interviews = await interviewsForMatching(
    conn,
    new Date(startOfUtcDay(window.from).getTime() - MATCH_TOLERANCE_MS),
    new Date(now.getTime() + MATCH_TOLERANCE_MS),
  );
  if (!interviews.length) {
    await db.transcriptConnection.updateMany({
      where: { id: conn.id, status: { in: ['ACTIVE', 'ERROR'] } },
      data: { lastSyncedAt: now, status: 'ACTIVE', lastError: null },
    });
    return { outcome: 'idle' };
  }

  try {
    const result = await withConnectionSession(
      conn,
      async (session) => {
        const adapter = createAdapter(conn.provider);
        adapter.resolve(session.tools);
        return processMeetings(conn, adapter, session.call, window, interviews, deadline);
      },
      { fetchFn: opts.fetchFn },
    );
    // Only while still connected: a disconnect during the run wins.
    await db.transcriptConnection.updateMany({
      where: { id: conn.id, status: { in: ['ACTIVE', 'ERROR'] } },
      data: {
        // One meeting's failure shows as an error without holding up the rest.
        status: result.warning ? 'ERROR' : 'ACTIVE',
        lastError: result.warning,
        // A run cut short by the budget reads the same window again next time.
        ...(result.complete ? { lastSyncedAt: now } : {}),
      },
    });
    const { warning: _warning, ...rest } = result;
    return { outcome: 'synced', ...rest };
  } catch (err) {
    const failure = describeFailure(conn, err);
    if (failure.status === 'NEEDS_RECONNECT') await markNeedsReconnect(conn.id, failure.error);
    else {
      // The OAuth provider may already have marked it NEEDS_RECONNECT mid-call; keep that.
      await db.transcriptConnection.updateMany({
        where: { id: conn.id, status: { in: ['ACTIVE', 'ERROR'] } },
        data: { status: 'ERROR', lastError: failure.error },
      });
    }
    const current = await db.transcriptConnection.findUnique({ where: { id: conn.id }, select: { status: true, lastError: true } });
    if (current?.status === 'NEEDS_RECONNECT') {
      return { outcome: 'failed', status: 'NEEDS_RECONNECT', error: current.lastError ?? failure.error };
    }
    return { outcome: 'failed', ...failure };
  }
}

/** Connections due for a sync: active (or retrying after an error), owner still active, interval passed. */
async function dueConnections(now: Date, ids?: string[]) {
  const rows = await db.transcriptConnection.findMany({
    where: {
      status: { in: ['ACTIVE', 'ERROR'] },
      credentials: { not: null },
      user: { deactivatedAt: null },
      ...(ids ? { id: { in: ids } } : {}),
    },
    orderBy: [{ lastSyncedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
    take: 500,
  });
  const orgIds = [...new Set(rows.map((r) => r.orgId))];
  const demo = new Set(
    (
      await db.user.findMany({ where: { orgId: { in: orgIds }, email: DEMO_EMAIL }, select: { orgId: true } })
    ).map((u) => u.orgId),
  );
  return rows.filter((r) => {
    if (demo.has(r.orgId)) return false;
    const min = (notetakerProvider(r.provider)?.minSyncMinutes ?? 10) * MINUTE;
    // A minute of slack so a 10-minute schedule doesn't skip every other run.
    return !r.lastSyncedAt || now.getTime() - r.lastSyncedAt.getTime() >= min - MINUTE;
  });
}

/** One cron run over every due connection, bounded by the deadline. */
export async function syncTranscriptConnections(opts: SyncOptions = {}): Promise<SyncSummary> {
  const now = opts.now ?? new Date();
  const deadline = opts.deadline ?? Date.now() + TRANSCRIPTS_CRON_BUDGET_MS;
  const due = await dueConnections(now, opts.connectionIds);
  const summary: SyncSummary = { connections: due.length, synced: 0, idle: 0, failed: 0, busy: 0, attached: [], suggested: 0, more: false };
  for (const conn of due) {
    if (Date.now() > deadline) {
      summary.more = true;
      break;
    }
    const run = await withConnectionLock(conn.id, async () => {
      // Re-read under the lock: an attach or a disconnect may have just changed it.
      const fresh = await db.transcriptConnection.findUnique({ where: { id: conn.id } });
      if (!fresh || !fresh.credentials || !['ACTIVE', 'ERROR'].includes(fresh.status)) return null;
      return syncConnection(fresh, { now, deadline, fetchFn: opts.fetchFn });
    });
    if (!run.locked) {
      summary.busy++;
      continue;
    }
    const result = run.value;
    if (!result) continue;
    if (result.outcome === 'idle') summary.idle++;
    else if (result.outcome === 'failed') summary.failed++;
    else {
      summary.synced++;
      summary.attached.push(...result.attached);
      summary.suggested += result.suggested;
      if (!result.complete) summary.more = true;
    }
  }
  return summary;
}
