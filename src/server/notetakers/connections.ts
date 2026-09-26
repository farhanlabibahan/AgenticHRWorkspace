import { auth, type FetchLike, type OAuthDiscoveryState } from '@modelcontextprotocol/client';
import type { NotetakerStatus, Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { isAdmin, type SessionContext } from '@/lib/session';
import { NOTETAKER_PROVIDERS, notetakerProvider } from '@/lib/notetaker-providers';
import { openJson, sealJson } from '@/server/imports/crypto';
import { createAdapter } from '@/server/notetakers/adapters';
import {
  attachedToOf,
  fetchTranscriptLocked,
  resolveAttachTarget,
  type AttachChoice,
  type AttachedTo,
} from '@/server/notetakers/binding';
import { NotetakerOAuthProvider, redirectUriFor, sealSecrets } from '@/server/notetakers/oauth';
import { clip } from '@/server/notetakers/parse';
import { withMcpSession } from '@/server/notetakers/session';
import { attachMeeting, describeFailure, isDemoOrg } from '@/server/notetakers/sync';

/**
 * Settings → Integrations → Meeting notetakers: what a person does with
 * their own connections (connect by signing in or with an API key,
 * disconnect), the suggestions waiting for them, and the admin's view of
 * who is connected. Every person manages only their own connections, and
 * suggestions are shown only to the person whose notetaker found them: a
 * meeting that merely sits next to an interview may be a private one.
 */

/** How long a started sign-in can take before its state stops being accepted. */
export const OAUTH_FLOW_TTL_MS = 15 * 60_000;

export type NotetakerConnectionView = {
  provider: string;
  status: NotetakerStatus;
  authType: 'OAUTH' | 'API_KEY';
  lastSyncedAt: string | null;
  lastError: string | null;
};

export async function myNotetakerConnections(ctx: SessionContext): Promise<NotetakerConnectionView[]> {
  if (!ctx.userId) return [];
  const rows = await db.transcriptConnection.findMany({
    where: { orgId: ctx.orgId, userId: ctx.userId },
    select: { provider: true, status: true, authType: true, lastSyncedAt: true, lastError: true },
  });
  return rows.map((r) => ({
    provider: r.provider,
    status: r.status,
    authType: r.authType,
    lastSyncedAt: r.lastSyncedAt?.toISOString() ?? null,
    lastError: r.lastError,
  }));
}

export type OrgNotetakerRow = { provider: string; people: { name: string; status: NotetakerStatus }[] };

/** Admins: who in the org has connected which notetaker. */
export async function orgNotetakerOverview(ctx: SessionContext): Promise<OrgNotetakerRow[]> {
  if (!isAdmin(ctx)) return [];
  const rows = await db.transcriptConnection.findMany({
    where: { orgId: ctx.orgId, status: { in: ['ACTIVE', 'ERROR', 'NEEDS_RECONNECT'] } },
    select: { provider: true, status: true, user: { select: { name: true } } },
    orderBy: { user: { name: 'asc' } },
  });
  return NOTETAKER_PROVIDERS.map((p) => ({
    provider: p.id,
    people: rows.filter((r) => r.provider === p.id).map((r) => ({ name: r.user.name, status: r.status })),
  })).filter((r) => r.people.length);
}

function requireUser(ctx: SessionContext): string {
  if (!ctx.userId) throw new Error('Notetakers are connected by a person, not an API key');
  return ctx.userId;
}

async function refuseDemo(orgId: string) {
  if (await isDemoOrg(orgId)) throw new Error("Notetakers can't be connected in the demo workspace");
}

/**
 * Starts signing in to a notetaker: discovery, client registration (first
 * time per authorization server), PKCE. Returns the URL to send the browser
 * to, and keeps what the callback needs on an McpOAuthFlow row.
 */
export async function startNotetakerOAuth(
  ctx: SessionContext,
  providerId: string,
  origin: string,
  opts: { fetchFn?: FetchLike; serverUrl?: string } = {},
): Promise<{ url: string }> {
  const userId = requireUser(ctx);
  const meta = notetakerProvider(providerId);
  if (!meta) throw new Error('Unknown notetaker');
  await refuseDemo(ctx.orgId);
  const serverUrl = opts.serverUrl ?? meta.serverUrl;
  const existing = await db.transcriptConnection.findUnique({ where: { userId_provider: { userId, provider: meta.id } } });
  const conn = existing
    ? await db.transcriptConnection.update({
        where: { id: existing.id },
        data: {
          serverUrl,
          // An existing working connection keeps working until the new sign-in finishes.
          ...(existing.status === 'DISCONNECTED' ? { status: 'PENDING' as const } : {}),
        },
      })
    : await db.transcriptConnection.create({
        data: { orgId: ctx.orgId, userId, provider: meta.id, serverUrl, authType: 'OAUTH', status: 'PENDING' },
      });

  const provider = new NotetakerOAuthProvider(conn, redirectUriFor(origin), { kind: 'start' }, { scope: meta.scope, fetchFn: opts.fetchFn });
  let result: string;
  try {
    result = await auth(provider, {
      serverUrl,
      resourceMetadataUrl: meta.resourceMetadataUrl && serverUrl === meta.serverUrl ? new URL(meta.resourceMetadataUrl) : undefined,
      forceReauthorization: true,
      fetchFn: opts.fetchFn,
    });
  } catch (err) {
    const message = clip(`Couldn't start signing in to ${meta.name}: ${err instanceof Error ? err.message : String(err)}`, 300);
    await db.transcriptConnection.update({ where: { id: conn.id }, data: { lastError: message } });
    throw new Error(message);
  }
  const pending = provider.pendingFlow();
  if (result !== 'REDIRECT' || !provider.authorizationUrl || !pending) {
    throw new Error(`${meta.name} didn't ask for a sign-in`);
  }
  const now = new Date();
  await db.$transaction([
    // One sign-in at a time per connection; and sweep abandoned ones.
    db.mcpOAuthFlow.deleteMany({ where: { OR: [{ connectionId: conn.id }, { expiresAt: { lt: now } }] } }),
    db.mcpOAuthFlow.create({
      data: {
        state: pending.state,
        connectionId: conn.id,
        codeVerifier: sealJson(pending.codeVerifier, 'notetaker-credentials'),
        discoveryState: pending.discoveryState as unknown as Prisma.InputJsonValue,
        expiresAt: new Date(now.getTime() + OAUTH_FLOW_TTL_MS),
      },
    }),
  ]);
  return { url: provider.authorizationUrl.toString() };
}

export type FlowCheck =
  | { ok: true; flow: { codeVerifier: string; discoveryState: OAuthDiscoveryState }; connection: Prisma.TranscriptConnectionGetPayload<object> }
  | { ok: false; reason: 'missing' | 'unknown' | 'expired' | 'wrong-user' | 'unreadable' };

/**
 * The callback's `state` check (the SDK leaves it to us). The state must
 * name a sign-in that is still open, that this signed-in person started, in
 * this org. Single use: the row is deleted before anything else happens, so
 * a replayed callback finds nothing.
 */
export async function consumeOAuthFlow(state: string | null, user: { userId: string; orgId: string }): Promise<FlowCheck> {
  if (!state || state.length < 32 || state.length > 128 || !/^[\w-]+$/.test(state)) return { ok: false, reason: 'missing' };
  const flow = await db.mcpOAuthFlow.findUnique({ where: { state }, include: { connection: true } });
  if (!flow) return { ok: false, reason: 'unknown' };
  const { count } = await db.mcpOAuthFlow.deleteMany({ where: { id: flow.id } });
  if (!count) return { ok: false, reason: 'unknown' };
  if (flow.expiresAt.getTime() < Date.now()) return { ok: false, reason: 'expired' };
  if (flow.connection.userId !== user.userId || flow.connection.orgId !== user.orgId) return { ok: false, reason: 'wrong-user' };
  const codeVerifier = openJson<string>(flow.codeVerifier, 'notetaker-credentials');
  if (!codeVerifier) return { ok: false, reason: 'unreadable' };
  return {
    ok: true,
    flow: { codeVerifier, discoveryState: flow.discoveryState as unknown as OAuthDiscoveryState },
    connection: flow.connection,
  };
}

export type CallbackResult = {
  provider: string | null;
  result: 'connected' | 'cancelled' | 'failed' | 'invalid';
  message?: string;
};

/** Finishes a sign-in from the provider's redirect: state first, then the code exchange. */
export async function completeNotetakerOAuth(
  user: { userId: string; orgId: string },
  params: URLSearchParams,
  origin: string,
  opts: { fetchFn?: FetchLike } = {},
): Promise<CallbackResult> {
  const check = await consumeOAuthFlow(params.get('state'), user);
  if (!check.ok) return { provider: null, result: 'invalid' };
  const conn = check.connection;
  const meta = notetakerProvider(conn.provider);
  const name = meta?.name ?? conn.provider;

  const error = params.get('error');
  if (error || !params.get('code')) {
    // Declining keeps whatever connection there was; a new one goes back to not connected.
    await db.transcriptConnection.updateMany({ where: { id: conn.id, status: 'PENDING' }, data: { status: 'DISCONNECTED' } });
    return { provider: conn.provider, result: error === 'access_denied' ? 'cancelled' : 'failed' };
  }

  const provider = new NotetakerOAuthProvider(
    conn,
    redirectUriFor(origin),
    { kind: 'callback', codeVerifier: check.flow.codeVerifier, discoveryState: check.flow.discoveryState },
    { scope: meta?.scope, fetchFn: opts.fetchFn },
  );
  try {
    const result = await auth(provider, {
      serverUrl: conn.serverUrl,
      authorizationCode: params.get('code')!,
      iss: params.get('iss') ?? undefined,
      fetchFn: opts.fetchFn,
    });
    if (result !== 'AUTHORIZED') throw new Error('the sign-in did not finish');
  } catch (err) {
    const message = clip(`Couldn't finish signing in to ${name}: ${err instanceof Error ? err.message : String(err)}`, 300);
    await db.transcriptConnection.update({
      where: { id: conn.id },
      data: { lastError: message, ...(conn.status === 'PENDING' ? { status: 'DISCONNECTED' as const } : {}) },
    });
    return { provider: conn.provider, result: 'failed', message };
  }
  return { provider: conn.provider, result: 'connected' };
}

/**
 * Connects with a personal API key (Fireflies, Metaview), after checking it
 * works: the key has to open a session and the server has to offer the tools
 * the sync uses.
 */
export async function connectNotetakerWithApiKey(
  ctx: SessionContext,
  providerId: string,
  apiKey: string,
  opts: { fetchFn?: FetchLike; serverUrl?: string } = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
  const userId = requireUser(ctx);
  const meta = notetakerProvider(providerId);
  if (!meta?.apiKey) return { ok: false, error: 'This notetaker connects by signing in, not with a key' };
  const key = apiKey.trim();
  if (key.length < 8 || key.length > 2000 || /\s/.test(key)) return { ok: false, error: "That doesn't look like an API key" };
  if (await isDemoOrg(ctx.orgId)) return { ok: false, error: "Notetakers can't be connected in the demo workspace" };
  const serverUrl = opts.serverUrl ?? meta.serverUrl;
  try {
    await withMcpSession(
      serverUrl,
      { token: async () => key },
      async (session) => createAdapter(meta.id).resolve(session.tools),
      { timeoutMs: 20_000, fetchFn: opts.fetchFn },
    );
  } catch (err) {
    const failure = describeFailure({ provider: meta.id, authType: 'API_KEY' }, err);
    return { ok: false, error: failure.status === 'NEEDS_RECONNECT' ? `${meta.name} didn't accept that key` : failure.error };
  }
  const credentials = sealSecrets({ kind: 'api_key', apiKey: key });
  await db.transcriptConnection.upsert({
    where: { userId_provider: { userId, provider: meta.id } },
    create: { orgId: ctx.orgId, userId, provider: meta.id, serverUrl, authType: 'API_KEY', credentials, status: 'ACTIVE' },
    update: { serverUrl, authType: 'API_KEY', credentials, status: 'ACTIVE', lastError: null, redirectUri: null },
  });
  return { ok: true };
}

/** Deletes the connection's credentials. Attached transcripts stay; open suggestions go. */
export async function disconnectNotetaker(ctx: SessionContext, providerId: string) {
  const userId = requireUser(ctx);
  const conn = await db.transcriptConnection.findUnique({ where: { userId_provider: { userId, provider: providerId } } });
  if (!conn || conn.orgId !== ctx.orgId) return;
  await db.$transaction([
    db.mcpOAuthFlow.deleteMany({ where: { connectionId: conn.id } }),
    db.externalMeeting.deleteMany({ where: { connectionId: conn.id, status: 'SUGGESTED' } }),
    db.transcriptConnection.update({
      where: { id: conn.id },
      data: { credentials: null, status: 'DISCONNECTED', lastError: null },
    }),
  ]);
}

/**
 * How many meetings the person's notetakers set aside for them to review
 * (the cards themselves are built by meetingsToReview in review.ts).
 */
export async function suggestedMeetingCount(ctx: SessionContext): Promise<number> {
  if (!ctx.userId) return 0;
  return db.externalMeeting.count({
    where: { orgId: ctx.orgId, status: 'SUGGESTED', connection: { userId: ctx.userId, status: { not: 'DISCONNECTED' } } },
  });
}

export type AttachSuggestedResult =
  | {
      ok: true;
      transcriptId: string | null;
      created: boolean;
      /** A teammate had attached this recording already; it stays where they put it. */
      linked: boolean;
      /** Who it's on now, for the confirmation. */
      attachedTo: AttachedTo | null;
    }
  | { ok: false; error: string };

/**
 * Attach a suggested meeting to the interview or candidate its owner chose
 * on the review card (by default, the interview the sync put it next to).
 * Checked here, whatever the card offered: the meeting is one of the
 * person's own connections' suggestions, and the choice is in their org and
 * visible to them. Then the transcript is fetched under the connection's
 * lock and attached the way the sync attaches.
 */
export async function attachSuggestedMeeting(
  ctx: SessionContext,
  meetingId: string,
  choice: AttachChoice | null = null,
  opts: { fetchFn?: FetchLike } = {},
): Promise<AttachSuggestedResult> {
  if (!ctx.userId) return { ok: false, error: 'Not signed in' };
  const row = await db.externalMeeting.findFirst({
    where: { id: meetingId, orgId: ctx.orgId, status: 'SUGGESTED', connection: { userId: ctx.userId } },
    include: { connection: true },
  });
  if (!row) return { ok: false, error: 'This meeting is no longer waiting for review' };
  const resolved = await resolveAttachTarget(ctx, choice ?? { interviewId: row.interviewId });
  if (!resolved) return { ok: false, error: choice ? "That interview or candidate isn't one you can attach to" : 'Choose who this meeting was with' };
  const conn = row.connection;
  const name = notetakerProvider(conn.provider)?.name ?? conn.provider;
  if (!conn.credentials || !['ACTIVE', 'ERROR'].includes(conn.status)) return { ok: false, error: `Connect ${name} again first` };

  const meeting = {
    externalId: row.externalId,
    title: row.title,
    startAt: row.startAt,
    ...(row.endAt ? { endAt: row.endAt } : {}),
    attendees: row.attendeeEmails.map((email) => ({ email })),
  };
  // A teammate's notetaker got there first: link to theirs, no need to fetch it again.
  const earlier = await db.externalMeeting.findFirst({
    where: { orgId: ctx.orgId, provider: row.provider, externalId: row.externalId, status: 'ATTACHED' },
    select: { id: true },
  });
  let text = '';
  if (!earlier) {
    const fetched = await fetchTranscriptLocked(conn, meeting, opts);
    if (!fetched.ok) return fetched;
    text = fetched.text;
  }
  const result = await attachMeeting(conn, meeting, resolved.target, text);
  const attachedTo = result.linked
    ? await attachedToOf(ctx.orgId, result.transcriptId)
    : { contactName: resolved.contactName, opportunityId: resolved.target.opportunityId, interviewTitle: resolved.interviewTitle };
  return { ok: true, transcriptId: result.transcriptId, created: result.created, linked: result.linked, attachedTo };
}

/** Not an interview: forget what was kept about it, and don't suggest it again. */
export async function dismissSuggestedMeeting(ctx: SessionContext, meetingId: string) {
  if (!ctx.userId) return;
  await db.externalMeeting.updateMany({
    where: { id: meetingId, orgId: ctx.orgId, status: 'SUGGESTED', connection: { userId: ctx.userId } },
    data: { status: 'DISMISSED', title: '', attendeeEmails: [], attendeeNames: [], interviewId: null },
  });
}
