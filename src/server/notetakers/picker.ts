import type { FetchLike } from '@modelcontextprotocol/client';
import type { TranscriptConnection } from '@prisma/client';
import { db } from '@/lib/db';
import type { SessionContext } from '@/lib/session';
import { openJson, sealJson } from '@/server/imports/crypto';
import { createAdapter } from '@/server/notetakers/adapters';
import {
  attachedToMany,
  attachedToOf,
  fetchTranscriptLocked,
  providerName,
  usableConnectionWhere,
  visibleOpportunityWhere,
  type AttachedTo,
} from '@/server/notetakers/binding';
import { withConnectionLock } from '@/server/notetakers/locks';
import { attendeeNameSet, fullNameKey } from '@/server/notetakers/match';
import { markNeedsReconnect } from '@/server/notetakers/oauth';
import type { NormalizedMeeting } from '@/server/notetakers/parse';
import { participantsOf } from '@/server/notetakers/review';
import { attachMeeting, attendeeEmailsOf, attendeeNamesOf, describeFailure, interviewTarget, withConnectionSession } from '@/server/notetakers/sync';

/**
 * "Attach a recording" on a candidate's interview: the person's own
 * meetings from each notetaker they've connected, within 12 hours of the
 * interview, read live through the adapters. Nothing is stored while they
 * look: each meeting travels to the browser with a sealed token (what the
 * attach needs, readable only by this server), and only the one they choose
 * is fetched and recorded, as ATTACHED, like the sync does.
 */

const HOUR = 3_600_000;

/** How far either side of the interview a recording is looked for. */
export const PICKER_WINDOW_MS = 12 * HOUR;
/** The whole look, across every notetaker at once. */
export const PICKER_BUDGET_MS = 20_000;
/** How long a listed meeting's token can be used to attach it. */
const PICK_TTL_MS = 30 * 60_000;

export type PickerSuggestion = { reason: 'email' | 'name'; text: string };

export type PickerMeeting = {
  token: string;
  externalId: string;
  title: string;
  startAt: string;
  durationMins: number | null;
  participants: string[];
  /** This candidate's email or full name is among the participants. */
  suggested: PickerSuggestion | null;
  /** Already attached in this org (by anyone): where to, when that transcript still exists. */
  attached: { to: AttachedTo | null; here: boolean } | null;
};

export type PickerGroup = {
  provider: string;
  name: string;
  error: string | null;
  /** The error is a sign-in that stopped working: connecting again fixes it. */
  reconnect: boolean;
  meetings: PickerMeeting[];
};

export type PickerResult =
  | { ok: true; interview: { id: string; title: string; startAt: string }; connected: boolean; groups: PickerGroup[] }
  | { ok: false; error: string };

type PickToken = {
  v: 1;
  u: string;
  o: string;
  c: string;
  i: string;
  x: number;
  m: { id: string; t: string; s: string; e: string | null; a: string[] };
};

const NOT_FOUND = "This interview isn't available";

async function loadInterview(ctx: SessionContext, interviewId: string) {
  return db.interview.findFirst({
    where: { id: interviewId, orgId: ctx.orgId, state: { in: ['SCHEDULED', 'COMPLETED'] }, opportunity: visibleOpportunityWhere(ctx) },
    select: {
      id: true,
      title: true,
      startAt: true,
      opportunityId: true,
      opportunity: { select: { contact: { select: { name: true, emails: true } } } },
    },
  });
}

/** Why a listed meeting looks like this candidate's: one of their emails was invited, or their full name was there. */
export function suggestionFor(
  meeting: Pick<NormalizedMeeting, 'attendees'>,
  candidate: { name: string; emails: string[] },
): PickerSuggestion | null {
  const invited = new Set(meeting.attendees.map((a) => a.email?.trim().toLowerCase()).filter(Boolean));
  const email = candidate.emails.find((e) => invited.has(e.trim().toLowerCase()));
  if (email) return { reason: 'email', text: `${email} was invited` };
  const key = fullNameKey(candidate.name);
  if (key && attendeeNameSet(meeting.attendees.map((a) => a.name)).has(key)) {
    return { reason: 'name', text: `${candidate.name.trim().replace(/\s+/g, ' ')} was in this meeting` };
  }
  return null;
}

class TimedOut extends Error {}

/** One notetaker's meetings in the window, or its error line. Under its lock: a sign-in refresh must not race the cron. */
async function listFor(
  conn: TranscriptConnection,
  window: { from: Date; to: Date },
  budgetMs: number,
  fetchFn?: FetchLike,
): Promise<{ ok: true; meetings: NormalizedMeeting[] } | { ok: false; error: string; reconnect?: boolean }> {
  const name = providerName(conn.provider);
  const deadline = Date.now() + budgetMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const run = withConnectionLock(
      conn.id,
      () =>
        withConnectionSession(
          conn,
          async (session) => {
            const adapter = createAdapter(conn.provider);
            adapter.resolve(session.tools);
            let listed = (await adapter.list(session.call, window, deadline)).filter(
              (m) => m.startAt >= window.from && m.startAt <= window.to,
            );
            if (adapter.details && listed.some((m) => !m.attendees.length) && Date.now() < deadline) {
              listed = await adapter.details(session.call, listed, deadline);
            }
            return listed;
          },
          { fetchFn, timeoutMs: budgetMs },
        ),
      { timeoutMs: budgetMs + 10_000 },
    );
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TimedOut()), budgetMs + 1_000);
    });
    // The answer never waits past the budget; a straggler finishes on its own.
    run.catch(() => undefined);
    const result = await Promise.race([run, timeout]);
    if (!result.locked) return { ok: false, error: `${name} is syncing right now. Try again in a minute.` };
    return { ok: true, meetings: result.value };
  } catch (err) {
    if (err instanceof TimedOut) return { ok: false, error: `${name} took too long to answer. Try again in a minute.` };
    const failure = describeFailure(conn, err);
    if (failure.status === 'NEEDS_RECONNECT') await markNeedsReconnect(conn.id, failure.error);
    return { ok: false, error: failure.error, reconnect: failure.status === 'NEEDS_RECONNECT' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The recordings near an interview, from each of the person's notetakers,
 * read now. Stores nothing: not the meetings, not that anyone looked.
 */
export async function recordingsNearInterview(
  ctx: SessionContext,
  interviewId: string,
  opts: { fetchFn?: FetchLike; budgetMs?: number; now?: Date } = {},
): Promise<PickerResult> {
  if (!ctx.userId) return { ok: false, error: 'Not signed in' };
  const userId = ctx.userId;
  const interview = await loadInterview(ctx, interviewId);
  if (!interview) return { ok: false, error: NOT_FOUND };
  const now = opts.now ?? new Date();
  // Usable connections are asked; one that needs signing in again is shown
  // with its reason and not asked (it would only fail again).
  const conns = await db.transcriptConnection.findMany({
    where: { orgId: ctx.orgId, userId, status: { in: ['ACTIVE', 'ERROR', 'NEEDS_RECONNECT'] } },
    orderBy: { provider: 'asc' },
  });
  const usable = (c: TranscriptConnection) => c.status !== 'NEEDS_RECONNECT' && c.credentials !== null;
  const summary = { id: interview.id, title: interview.title, startAt: interview.startAt.toISOString() };
  if (!conns.length) return { ok: true, interview: summary, connected: false, groups: [] };

  const window = {
    from: new Date(interview.startAt.getTime() - PICKER_WINDOW_MS),
    // Nothing is recorded ahead of time.
    to: new Date(Math.min(interview.startAt.getTime() + PICKER_WINDOW_MS, now.getTime())),
  };
  const budget = opts.budgetMs ?? PICKER_BUDGET_MS;
  const listed = await Promise.all(
    conns.map(async (conn) => ({
      conn,
      result: !usable(conn)
        ? { ok: false as const, error: conn.lastError ?? `${providerName(conn.provider)} needs you to connect it again`, reconnect: true }
        : window.from < window.to
          ? await listFor(conn, window, budget, opts.fetchFn)
          : { ok: true as const, meetings: [] },
    })),
  );

  // Which of these are attached already, anywhere in the org.
  const wanted = listed.flatMap(({ conn, result }) => (result.ok ? result.meetings.map((m) => ({ provider: conn.provider, externalId: m.externalId })) : []));
  const attachedRows = wanted.length
    ? await db.externalMeeting.findMany({
        where: {
          orgId: ctx.orgId,
          status: 'ATTACHED',
          OR: [...new Set(wanted.map((w) => w.provider))].map((provider) => ({
            provider,
            externalId: { in: wanted.filter((w) => w.provider === provider).map((w) => w.externalId) },
          })),
        },
        select: { provider: true, externalId: true, transcriptId: true, interviewId: true },
      })
    : [];
  const where = await attachedToMany(
    ctx.orgId,
    attachedRows.map((r) => r.transcriptId),
  );
  const attached = new Map<string, { to: AttachedTo | null; here: boolean }>();
  for (const row of attachedRows) {
    const key = `${row.provider} ${row.externalId}`;
    const to = row.transcriptId ? (where.get(row.transcriptId) ?? null) : null;
    if (attached.get(key)?.to && !to) continue;
    attached.set(key, { to, here: row.interviewId === interview.id });
  }

  const candidate = interview.opportunity.contact;
  const t = interview.startAt.getTime();
  const exp = now.getTime() + PICK_TTL_MS;
  const groups: PickerGroup[] = listed.map(({ conn, result }) => {
    const name = providerName(conn.provider);
    if (!result.ok) return { provider: conn.provider, name, error: result.error, reconnect: Boolean(result.reconnect), meetings: [] };
    const meetings = result.meetings
      .map((m) => {
        const token: PickToken = {
          v: 1,
          u: userId,
          o: ctx.orgId,
          c: conn.id,
          i: interview.id,
          x: exp,
          m: { id: m.externalId, t: m.title, s: m.startAt.toISOString(), e: m.endAt?.toISOString() ?? null, a: attendeeEmailsOf(m) },
        };
        return {
          token: sealJson(token, 'notetaker-pick'),
          externalId: m.externalId,
          title: m.title,
          startAt: m.startAt.toISOString(),
          durationMins: m.endAt && m.endAt > m.startAt ? Math.round((m.endAt.getTime() - m.startAt.getTime()) / 60_000) : null,
          participants: participantsOf({ attendeeNames: attendeeNamesOf(m), attendeeEmails: attendeeEmailsOf(m) }),
          suggested: suggestionFor(m, candidate),
          attached: attached.get(`${conn.provider} ${m.externalId}`) ?? null,
          gap: Math.abs(m.startAt.getTime() - t),
        };
      })
      // This candidate's first, then the closest to the interview.
      .sort((a, b) => Number(Boolean(b.suggested)) - Number(Boolean(a.suggested)) || a.gap - b.gap)
      .map(({ gap: _gap, ...m }) => m);
    return { provider: conn.provider, name, error: null, reconnect: false, meetings };
  });
  return { ok: true, interview: summary, connected: true, groups };
}

export type AttachRecordingResult =
  | { ok: true; transcriptId: string | null; created: boolean }
  | { ok: false; error: string };

/**
 * Attach the recording a person chose in the picker to the interview. The
 * token says which meeting and which of their connections; the interview is
 * checked again here, and a meeting already attached in the org can't be
 * attached a second time.
 */
export async function attachRecording(
  ctx: SessionContext,
  interviewId: string,
  token: string,
  opts: { fetchFn?: FetchLike; now?: Date } = {},
): Promise<AttachRecordingResult> {
  if (!ctx.userId) return { ok: false, error: 'Not signed in' };
  const pick = openJson<PickToken>(token, 'notetaker-pick');
  const now = opts.now ?? new Date();
  if (!pick || pick.v !== 1 || pick.u !== ctx.userId || pick.o !== ctx.orgId || pick.i !== interviewId) {
    return { ok: false, error: "That recording can't be attached from here" };
  }
  if (pick.x < now.getTime()) return { ok: false, error: 'This list is out of date. Open it again.' };
  const interview = await loadInterview(ctx, interviewId);
  if (!interview) return { ok: false, error: NOT_FOUND };
  const conn = await db.transcriptConnection.findFirst({ where: { id: pick.c, ...usableConnectionWhere({ orgId: ctx.orgId, userId: ctx.userId }) } });
  if (!conn) return { ok: false, error: 'Connect the notetaker again first' };

  const already = await db.externalMeeting.findFirst({
    where: { orgId: ctx.orgId, provider: conn.provider, externalId: pick.m.id, status: 'ATTACHED' },
    select: { transcriptId: true, interviewId: true },
  });
  if (already) {
    const to = await attachedToOf(ctx.orgId, already.transcriptId);
    if (already.interviewId === interview.id) return { ok: false, error: 'Already attached to this interview' };
    return { ok: false, error: to ? `Already attached to ${describeTarget(to)}` : 'Already attached once, and that transcript was deleted' };
  }

  const meeting: NormalizedMeeting = {
    externalId: pick.m.id,
    title: pick.m.t,
    startAt: new Date(pick.m.s),
    ...(pick.m.e ? { endAt: new Date(pick.m.e) } : {}),
    attendees: pick.m.a.map((email) => ({ email })),
  };
  const fetched = await fetchTranscriptLocked(conn, meeting, opts);
  if (!fetched.ok) return fetched;
  const result = await attachMeeting(conn, meeting, interviewTarget(interview), fetched.text);
  // Someone attached it in the moments between: theirs stands.
  if (result.linked) return { ok: false, error: 'Someone attached this recording a moment ago' };
  return { ok: true, transcriptId: result.transcriptId, created: result.created };
}

export function describeTarget(to: AttachedTo): string {
  return to.interviewTitle ? `${to.contactName} · ${to.interviewTitle}` : to.contactName;
}
