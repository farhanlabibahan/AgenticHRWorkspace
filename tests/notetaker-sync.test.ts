import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hasDb } from './setup';
import { candidate, createOrg } from './fixtures';
import { startFakeMcp, type FakeMcp, type FakeOAuthOptions, type FakeTool } from './support/fake-mcp';
import { db } from '@/lib/db';
import type { SessionContext } from '@/lib/session';
import { DEMO_EMAIL } from '@/server/demo';
import {
  attachSuggestedMeeting,
  completeNotetakerOAuth,
  connectNotetakerWithApiKey,
  consumeOAuthFlow,
  dismissSuggestedMeeting,
  disconnectNotetaker,
  startNotetakerOAuth,
} from '@/server/notetakers/connections';
import { openSecrets, sealSecrets } from '@/server/notetakers/oauth';
import { meetingsToReview } from '@/server/notetakers/review';
import { syncTranscriptConnections } from '@/server/notetakers/sync';

/**
 * The notetaker sync against the database and a fake notetaker MCP server
 * (tests/support/fake-mcp.ts, built with the official server SDK): which
 * meetings are attached, suggested, or left alone without a trace; that a
 * meeting is never attached twice; the OAuth sign-in with its state check;
 * and what the cron does when a token or key stops working.
 */

process.env.AUTH_SECRET ??= 'notetaker-test-secret';

const MIN = 60_000;
const KEY = 'ff_live_key_0123456789';

type FakeMeeting = {
  id: string;
  title: string;
  start: Date;
  emails: string[];
  sentences?: { speaker: string; text: string }[];
  /** The transcript tool answers this error (isError) instead. */
  fail?: string;
};

/** A Fireflies-shaped server: list by whole days, transcripts by id. Returns text JSON and structured content. */
function firefliesTools(meetings: () => FakeMeeting[]): FakeTool[] {
  return [
    {
      name: 'fireflies_get_transcripts',
      properties: { fromDate: { type: 'string' }, toDate: { type: 'string' }, limit: { type: 'number' }, skip: { type: 'number' }, format: { type: 'string' } },
      handler: (args) => {
        const from = new Date(`${args.fromDate}T00:00:00Z`).getTime();
        const to = new Date(`${args.toDate}T23:59:59Z`).getTime();
        const skip = Number(args.skip ?? 0);
        const limit = Number(args.limit ?? 50);
        const page = meetings()
          .filter((m) => m.start.getTime() >= from && m.start.getTime() <= to)
          .slice(skip, skip + limit)
          .map((m) => ({ id: m.id, title: m.title, date: m.start.getTime(), duration: 45, participants: m.emails }));
        return { content: [{ type: 'text', text: JSON.stringify(page) }] };
      },
    },
    {
      name: 'fireflies_get_transcript',
      properties: { transcriptId: { type: 'string' } },
      required: ['transcriptId'],
      handler: (args) => {
        const m = meetings().find((x) => x.id === args.transcriptId);
        if (!m) return { isError: true, content: [{ type: 'text', text: 'Transcript not found' }] };
        if (m.fail) return { isError: true, content: [{ type: 'text', text: m.fail }] };
        return {
          structuredContent: {
            transcript: {
              id: m.id,
              title: m.title,
              sentences: (m.sentences ?? [{ speaker: 'Sam', text: 'Tell me about a hard bug.' }]).map((s, i) => ({
                index: i,
                speaker_name: s.speaker,
                text: s.text,
                start_time: i * 3,
              })),
            },
          },
        };
      },
    },
  ];
}

/** A Fathom-shaped server for the OAuth tests. */
function fathomTools(meetings: () => FakeMeeting[]): FakeTool[] {
  return [
    {
      name: 'list_meetings',
      properties: { created_after: { type: 'string' }, created_before: { type: 'string' }, cursor: { type: 'string' } },
      handler: () => ({
        structuredContent: {
          items: meetings().map((m) => ({
            recording_id: m.id,
            title: m.title,
            scheduled_start_time: m.start.toISOString(),
            calendar_invitees: m.emails.map((email) => ({ email })),
          })),
          next_cursor: null,
        },
      }),
    },
    {
      name: 'get_meeting_transcript',
      properties: { recording_id: { type: 'string' } },
      handler: (args) => ({
        content: [{ type: 'text', text: JSON.stringify({ transcript: [{ speaker: { display_name: 'Sam' }, text: `Transcript of ${args.recording_id}` }] }) }],
      }),
    },
  ];
}

const ctxOf = (user: { id: string; orgId: string; accessRole?: string }): SessionContext => ({
  userId: user.id,
  orgId: user.orgId,
  accessRole: user.accessRole ?? 'SUPER_ADMIN',
});

/** An org with a recruiter, a candidate, and an interview three hours ago with the recruiter on the panel. */
async function world(opts: { interviewAt?: Date; candidateEmails?: string[] } = {}) {
  const { org, stages, admin } = await createOrg();
  const { opportunity, contact } = await candidate(org.id, stages, [[1, 0]], {
    name: 'Priya Raman',
    emails: opts.candidateEmails ?? ['priya@example.com'],
  });
  const interview = await db.interview.create({
    data: {
      orgId: org.id,
      opportunityId: opportunity.id,
      title: 'Onsite',
      startAt: opts.interviewAt ?? new Date(Date.now() - 180 * MIN),
      panelists: { connect: [{ id: admin.id }] },
    },
  });
  return { org, stages, admin, opportunity, contact, interview };
}

describe.skipIf(!hasDb)('notetaker sync', () => {
  let meetings: FakeMeeting[] = [];
  let mcp: FakeMcp;

  beforeAll(async () => {
    mcp = await startFakeMcp({ apiKey: KEY, tools: firefliesTools(() => meetings) });
  });
  afterAll(async () => {
    await mcp?.close();
  });
  beforeEach(() => {
    meetings = [];
    mcp.calls.length = 0;
  });

  async function connect(user: { id: string; orgId: string }) {
    const result = await connectNotetakerWithApiKey(ctxOf(user), 'fireflies', KEY, { serverUrl: mcp.url });
    expect(result).toEqual({ ok: true });
    return db.transcriptConnection.findUniqueOrThrow({ where: { userId_provider: { userId: user.id, provider: 'fireflies' } } });
  }

  it('attaches the transcript of a meeting the candidate attended, end to end over an API key, and keeps nothing about the others', async () => {
    const { admin, interview, opportunity } = await world();
    meetings = [
      {
        id: 'ff-interview',
        title: 'Onsite: Priya Raman',
        start: new Date(interview.startAt.getTime() + 4 * MIN),
        emails: ['recruiter@acme.test', 'Priya@Example.com'],
        sentences: [
          { speaker: 'Sam', text: 'Walk me through the migration.' },
          { speaker: 'Priya', text: 'We moved forty services in a quarter.' },
        ],
      },
      { id: 'ff-lunch', title: 'Lunch with Dana', start: new Date(interview.startAt.getTime() - 3 * 60 * MIN), emails: ['dana@friends.test'] },
    ];
    const conn = await connect(admin);
    expect(conn).toMatchObject({ status: 'ACTIVE', authType: 'API_KEY', serverUrl: mcp.url });
    expect(openSecrets(conn.credentials)).toEqual({ kind: 'api_key', apiKey: KEY });
    expect(conn.credentials).not.toContain(KEY);

    const summary = await syncTranscriptConnections({ connectionIds: [conn.id] });
    expect(summary).toMatchObject({ synced: 1, failed: 0, suggested: 0 });
    expect(summary.attached).toHaveLength(1);

    const transcripts = await db.transcript.findMany({ where: { opportunityId: opportunity.id } });
    expect(transcripts).toHaveLength(1);
    expect(transcripts[0]).toMatchObject({
      interviewId: interview.id,
      source: 'fireflies',
      title: 'Onsite: Priya Raman',
      content: 'Sam: Walk me through the migration.\nPriya: We moved forty services in a quarter.',
    });
    expect(summary.attached[0]).toEqual({ transcriptId: transcripts[0].id, orgId: admin.orgId, userId: admin.id });

    const rows = await db.externalMeeting.findMany({ where: { connectionId: conn.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ externalId: 'ff-interview', status: 'ATTACHED', transcriptId: transcripts[0].id, interviewId: interview.id });
    // The lunch left no trace: no row, no title anywhere, and its transcript was never read.
    expect(await db.externalMeeting.count({ where: { OR: [{ externalId: 'ff-lunch' }, { title: { contains: 'Dana' } }] } })).toBe(0);
    expect(mcp.calls.filter((c) => c.tool === 'fireflies_get_transcript').map((c) => c.args.transcriptId)).toEqual(['ff-interview']);

    const after = await db.transcriptConnection.findUniqueOrThrow({ where: { id: conn.id } });
    expect(after.status).toBe('ACTIVE');
    expect(after.lastError).toBeNull();
    expect(after.lastSyncedAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it('suggests a meeting that lines up only by time, without reading its transcript; Attach and Dismiss are its owner’s', async () => {
    const { org, admin, interview, opportunity, stages } = await world();
    const { opportunity: opp2 } = await candidate(org.id, stages, [[1, 0]], { name: 'Jordan Lee', emails: ['jordan@example.com'] });
    const second = await db.interview.create({
      data: { orgId: org.id, opportunityId: opp2.id, title: 'Screen', startAt: new Date(Date.now() - 26 * 60 * MIN), panelists: { connect: [{ id: admin.id }] } },
    });
    meetings = [
      { id: 'ff-a', title: 'Onsite', start: new Date(interview.startAt.getTime() + 5 * MIN), emails: ['recruiter@acme.test'] },
      { id: 'ff-b', title: 'Catch-up', start: new Date(second.startAt.getTime() - 10 * MIN), emails: ['someone@else.test'] },
    ];
    const conn = await connect(admin);
    const summary = await syncTranscriptConnections({ connectionIds: [conn.id] });
    expect(summary).toMatchObject({ synced: 1, suggested: 2, attached: [] });
    expect(mcp.calls.some((c) => c.tool === 'fireflies_get_transcript')).toBe(false);
    expect(await db.transcript.count({ where: { orgId: org.id } })).toBe(0);

    const mine = await meetingsToReview(ctxOf(admin));
    expect(mine.map((m) => [m.title, m.preselect])).toEqual([
      ['Onsite', interview.id],
      ['Catch-up', second.id],
    ]);
    // A teammate, even an admin, doesn't see someone else's meetings.
    const teammate = await db.user.create({ data: { orgId: org.id, email: `t-${randomUUID()}@acme.test`, name: 'Teammate', accessRole: 'ADMIN' } });
    expect(await meetingsToReview(ctxOf(teammate))).toEqual([]);
    const a = mine.find((m) => m.title === 'Onsite')!;
    const b = mine.find((m) => m.title === 'Catch-up')!;
    expect(await attachSuggestedMeeting(ctxOf(teammate), a.id)).toEqual({ ok: false, error: 'This meeting is no longer waiting for review' });

    const attached = await attachSuggestedMeeting(ctxOf(admin), a.id);
    expect(attached).toMatchObject({ ok: true, created: true });
    const transcript = await db.transcript.findFirstOrThrow({ where: { opportunityId: opportunity.id } });
    expect(transcript).toMatchObject({ interviewId: interview.id, source: 'fireflies' });
    expect(await db.externalMeeting.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ status: 'ATTACHED', transcriptId: transcript.id });

    await dismissSuggestedMeeting(ctxOf(admin), b.id);
    expect(await db.externalMeeting.findUniqueOrThrow({ where: { id: b.id } })).toMatchObject({
      status: 'DISMISSED',
      title: '',
      attendeeEmails: [],
      attendeeNames: [],
      interviewId: null,
    });
    expect(await meetingsToReview(ctxOf(admin))).toEqual([]);

    // The next sync reads the same meetings again and changes nothing.
    await db.transcriptConnection.update({ where: { id: conn.id }, data: { lastSyncedAt: null } });
    const again = await syncTranscriptConnections({ connectionIds: [conn.id] });
    expect(again).toMatchObject({ synced: 1, suggested: 0, attached: [] });
    expect(await db.transcript.count({ where: { orgId: org.id } })).toBe(1);
  });

  it('never makes a second transcript for the same meeting, across syncs and across teammates', async () => {
    const { org, admin, interview } = await world();
    const panelist = await db.user.create({ data: { orgId: org.id, email: `p-${randomUUID()}@acme.test`, name: 'Panelist' } });
    await db.interview.update({ where: { id: interview.id }, data: { panelists: { connect: [{ id: panelist.id }] } } });
    meetings = [{ id: 'ff-shared', title: 'Onsite', start: interview.startAt, emails: ['priya@example.com'] }];

    const mine = await connect(admin);
    await syncTranscriptConnections({ connectionIds: [mine.id] });
    await db.transcriptConnection.update({ where: { id: mine.id }, data: { lastSyncedAt: null } });
    const second = await syncTranscriptConnections({ connectionIds: [mine.id] });
    expect(second.attached).toEqual([]);

    // A teammate whose notetaker sees the same recording links to the same transcript.
    const theirs = await connect(panelist);
    const reads = mcp.calls.filter((c) => c.tool === 'fireflies_get_transcript').length;
    const third = await syncTranscriptConnections({ connectionIds: [theirs.id] });
    expect(third.attached).toEqual([]);
    expect(mcp.calls.filter((c) => c.tool === 'fireflies_get_transcript')).toHaveLength(reads);

    const transcripts = await db.transcript.findMany({ where: { orgId: org.id } });
    expect(transcripts).toHaveLength(1);
    const rows = await db.externalMeeting.findMany({ where: { orgId: org.id }, orderBy: { createdAt: 'asc' } });
    expect(rows.map((r) => [r.connectionId, r.status, r.transcriptId])).toEqual([
      [mine.id, 'ATTACHED', transcripts[0].id],
      [theirs.id, 'ATTACHED', transcripts[0].id],
    ]);

    // Deleted by a person: it stays deleted.
    await db.transcript.delete({ where: { id: transcripts[0].id } });
    await db.transcriptConnection.updateMany({ where: { id: { in: [mine.id, theirs.id] } }, data: { lastSyncedAt: null } });
    await syncTranscriptConnections({ connectionIds: [mine.id, theirs.id] });
    expect(await db.transcript.count({ where: { orgId: org.id } })).toBe(0);
  });

  it('keeps going when one transcript fails, shows the error, and tries that meeting again later', async () => {
    const { org, admin, interview, stages } = await world();
    const { opportunity: opp2 } = await candidate(org.id, stages, [[1, 0]], { name: 'Jordan Lee', emails: ['jordan@example.com'] });
    const second = await db.interview.create({
      data: { orgId: org.id, opportunityId: opp2.id, title: 'Screen', startAt: new Date(Date.now() - 26 * 60 * MIN), panelists: { connect: [{ id: admin.id }] } },
    });
    meetings = [
      { id: 'ff-locked', title: 'Screen', start: second.startAt, emails: ['jordan@example.com'], fail: 'Upgrade your plan to read transcripts' },
      { id: 'ff-ok', title: 'Onsite', start: interview.startAt, emails: ['priya@example.com'] },
    ];
    const conn = await connect(admin);
    const summary = await syncTranscriptConnections({ connectionIds: [conn.id] });
    expect(summary).toMatchObject({ synced: 1, failed: 0 });
    expect(summary.attached).toHaveLength(1);
    expect(await db.transcriptConnection.findUniqueOrThrow({ where: { id: conn.id } })).toMatchObject({
      status: 'ERROR',
      lastError: 'Fireflies returned an error from fireflies_get_transcript: Upgrade your plan to read transcripts',
    });
    expect((await db.externalMeeting.findMany({ where: { connectionId: conn.id } })).map((r) => r.externalId)).toEqual(['ff-ok']);

    // Fixed at the provider: the next run attaches it and clears the error.
    meetings[0].fail = undefined;
    await db.transcriptConnection.update({ where: { id: conn.id }, data: { lastSyncedAt: null } });
    const again = await syncTranscriptConnections({ connectionIds: [conn.id] });
    expect(again.attached).toHaveLength(1);
    expect(await db.transcriptConnection.findUniqueOrThrow({ where: { id: conn.id } })).toMatchObject({ status: 'ACTIVE', lastError: null });
  });

  it('leaves imported interviews and demo workspaces alone, and asks nothing of the provider without an interview', async () => {
    const { org, admin, interview } = await world();
    await db.importRef.create({ data: { orgId: org.id, provider: 'lever', kind: 'interview', externalId: 'lv-1', internalId: interview.id } });
    meetings = [{ id: 'ff-imported', title: 'Onsite', start: interview.startAt, emails: ['priya@example.com'] }];
    const conn = await connect(admin);
    const calls = mcp.calls.length;
    const summary = await syncTranscriptConnections({ connectionIds: [conn.id] });
    expect(summary).toMatchObject({ idle: 1, synced: 0 });
    expect(mcp.calls.length).toBe(calls); // the provider wasn't called at all
    expect(await db.externalMeeting.count({ where: { orgId: org.id } })).toBe(0);
    expect((await db.transcriptConnection.findUniqueOrThrow({ where: { id: conn.id } })).lastSyncedAt).not.toBeNull();

    const demo = await world();
    await db.user.create({ data: { orgId: demo.org.id, email: DEMO_EMAIL, name: 'Demo Recruiter' } });
    expect(await connectNotetakerWithApiKey(ctxOf(demo.admin), 'fireflies', KEY, { serverUrl: mcp.url })).toEqual({
      ok: false,
      error: "Notetakers can't be connected in the demo workspace",
    });
    const planted = await db.transcriptConnection.create({
      data: {
        orgId: demo.org.id,
        userId: demo.admin.id,
        provider: 'fireflies',
        serverUrl: mcp.url,
        authType: 'API_KEY',
        credentials: sealSecrets({ kind: 'api_key', apiKey: KEY }),
        status: 'ACTIVE',
      },
    });
    expect((await syncTranscriptConnections({ connectionIds: [planted.id] })).connections).toBe(0);
  });

  it('marks an API-key connection NEEDS_RECONNECT when the key is refused, and a disconnect deletes the key', async () => {
    const { admin } = await world();
    meetings = [];
    expect(await connectNotetakerWithApiKey(ctxOf(admin), 'fireflies', 'ff_wrong_key_000000', { serverUrl: mcp.url })).toEqual({
      ok: false,
      error: "Fireflies didn't accept that key",
    });
    const conn = await db.transcriptConnection.create({
      data: {
        orgId: admin.orgId,
        userId: admin.id,
        provider: 'fireflies',
        serverUrl: mcp.url,
        authType: 'API_KEY',
        credentials: sealSecrets({ kind: 'api_key', apiKey: 'ff_revoked_key_000000' }),
        status: 'ACTIVE',
      },
    });
    const summary = await syncTranscriptConnections({ connectionIds: [conn.id] });
    expect(summary).toMatchObject({ failed: 1 });
    expect(await db.transcriptConnection.findUniqueOrThrow({ where: { id: conn.id } })).toMatchObject({
      status: 'NEEDS_RECONNECT',
      lastError: "Fireflies didn't accept the API key",
    });
    // Not retried until its owner reconnects.
    expect((await syncTranscriptConnections({ connectionIds: [conn.id] })).connections).toBe(0);

    await disconnectNotetaker(ctxOf(admin), 'fireflies');
    expect(await db.transcriptConnection.findUniqueOrThrow({ where: { id: conn.id } })).toMatchObject({
      status: 'DISCONNECTED',
      credentials: null,
    });
  });
});

describe.skipIf(!hasDb)('notetaker OAuth', () => {
  let meetings: FakeMeeting[] = [];
  let mcp: FakeMcp;
  const oauthOpts: FakeOAuthOptions = { refresh: 'rotate' };
  const ORIGIN = 'http://localhost:3480';

  beforeAll(async () => {
    mcp = await startFakeMcp({ oauth: oauthOpts, tools: fathomTools(() => meetings) });
  });
  afterAll(async () => {
    await mcp?.close();
  });
  beforeEach(() => {
    oauthOpts.refresh = 'rotate';
    meetings = [];
  });

  /** Start, approve at the fake authorization server, come back: what a person does in the browser. */
  async function signIn(user: { id: string; orgId: string }) {
    const { url } = await startNotetakerOAuth(ctxOf(user), 'fathom', ORIGIN, { serverUrl: mcp.url });
    const { code, state, redirectUri } = mcp.oauth.approve(url);
    expect(redirectUri).toBe(`${ORIGIN}/api/integrations/mcp/callback`);
    const params = new URLSearchParams({ code, state: state ?? '' });
    return { url, state: state!, params };
  }

  it('signs in with discovery, one shared registration, PKCE and the state check', async () => {
    const { admin, org } = await world();
    const registrationsBefore = mcp.oauth.registrations.length;
    const { url, params } = await signIn(admin);
    const auth = new URL(url);
    expect(auth.origin).toBe(mcp.origin);
    expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
    expect(auth.searchParams.get('scope')).toBe('meetings offline_access');
    expect(mcp.oauth.registrations.length).toBe(registrationsBefore + 1);
    expect(mcp.oauth.registrations.at(-1)).toMatchObject({
      client_name: 'Source ATS',
      redirect_uris: [`${ORIGIN}/api/integrations/mcp/callback`],
      grant_types: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_method: 'none',
      application_type: 'web',
    });
    const pending = await db.transcriptConnection.findUniqueOrThrow({ where: { userId_provider: { userId: admin.id, provider: 'fathom' } } });
    expect(pending).toMatchObject({ status: 'PENDING', credentials: null });

    const outcome = await completeNotetakerOAuth({ userId: admin.id, orgId: org.id }, params, ORIGIN);
    expect(outcome).toEqual({ provider: 'fathom', result: 'connected' });
    const conn = await db.transcriptConnection.findUniqueOrThrow({ where: { id: pending.id } });
    expect(conn).toMatchObject({ status: 'ACTIVE', authType: 'OAUTH', redirectUri: `${ORIGIN}/api/integrations/mcp/callback` });
    const secrets = openSecrets(conn.credentials);
    expect(secrets?.kind).toBe('oauth');
    expect(mcp.oauth.validTokens.has(secrets?.kind === 'oauth' ? secrets.tokens.access_token : '')).toBe(true);
    expect(await db.mcpOAuthFlow.count({ where: { connectionId: conn.id } })).toBe(0);

    // The registration is keyed by issuer (no trailing slash) and redirect URI, and shared.
    const client = await db.mcpOAuthClient.findUniqueOrThrow({
      where: { issuer_redirectUri: { issuer: mcp.origin, redirectUri: `${ORIGIN}/api/integrations/mcp/callback` } },
    });
    expect(client.clientId).toMatch(/^client_/);
    const other = await world();
    await signIn(other.admin);
    expect(mcp.oauth.registrations.length).toBe(registrationsBefore + 1);
  });

  it('checks the state before anything else: unknown, replayed, someone else’s, and expired sign-ins are refused', async () => {
    const { admin, org } = await world();
    const me = { userId: admin.id, orgId: org.id };
    expect(await consumeOAuthFlow(null, me)).toEqual({ ok: false, reason: 'missing' });
    expect(await consumeOAuthFlow('x'.repeat(43), me)).toEqual({ ok: false, reason: 'unknown' });

    // Someone else's state: refused, and burned so it can't be tried again.
    const intruder = await world();
    const theirs = await signIn(intruder.admin);
    expect(await consumeOAuthFlow(theirs.state, me)).toEqual({ ok: false, reason: 'wrong-user' });
    expect(await completeNotetakerOAuth({ userId: intruder.admin.id, orgId: intruder.org.id }, theirs.params, ORIGIN)).toEqual({
      provider: null,
      result: 'invalid',
    });

    // Replayed: the first use consumes it.
    const mine = await signIn(admin);
    expect(await completeNotetakerOAuth(me, mine.params, ORIGIN)).toMatchObject({ result: 'connected' });
    expect(await completeNotetakerOAuth(me, mine.params, ORIGIN)).toEqual({ provider: null, result: 'invalid' });

    // Expired.
    const late = await signIn(admin);
    await db.mcpOAuthFlow.update({ where: { state: late.state }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await consumeOAuthFlow(late.state, me)).toEqual({ ok: false, reason: 'expired' });

    // Declined at the provider: a new connection goes back to not connected.
    const declined = await world();
    const d = await signIn(declined.admin);
    const params = new URLSearchParams({ error: 'access_denied', state: d.state });
    expect(await completeNotetakerOAuth({ userId: declined.admin.id, orgId: declined.org.id }, params, ORIGIN)).toEqual({
      provider: 'fathom',
      result: 'cancelled',
    });
    expect(
      await db.transcriptConnection.findUniqueOrThrow({ where: { userId_provider: { userId: declined.admin.id, provider: 'fathom' } } }),
    ).toMatchObject({ status: 'DISCONNECTED', credentials: null });
  });

  it('refreshes an expired token in the cron, saving the rotated refresh token, and syncs', async () => {
    const { admin, org, interview } = await world();
    const { params } = await signIn(admin);
    await completeNotetakerOAuth({ userId: admin.id, orgId: org.id }, params, ORIGIN);
    const conn = await db.transcriptConnection.findUniqueOrThrow({ where: { userId_provider: { userId: admin.id, provider: 'fathom' } } });
    const before = openSecrets(conn.credentials);
    if (before?.kind !== 'oauth') throw new Error('expected OAuth tokens');
    // An hour-long token saved two hours ago, and already revoked at the server.
    mcp.oauth.validTokens.delete(before.tokens.access_token);
    await db.transcriptConnection.update({
      where: { id: conn.id },
      data: { credentials: sealSecrets({ ...before, savedAt: Date.now() - 2 * 3_600_000 }) },
    });
    meetings = [{ id: 'rec-1', title: 'Onsite', start: interview.startAt, emails: ['priya@example.com'] }];

    const summary = await syncTranscriptConnections({ connectionIds: [conn.id] });
    expect(summary).toMatchObject({ synced: 1, failed: 0 });
    expect(summary.attached).toHaveLength(1);
    const after = await db.transcriptConnection.findUniqueOrThrow({ where: { id: conn.id } });
    const rotated = openSecrets(after.credentials);
    expect(rotated?.kind === 'oauth' && rotated.tokens.refresh_token).not.toBe(before.tokens.refresh_token);
    expect(after.status).toBe('ACTIVE');
    expect(mcp.oauth.tokenRequests.at(-1)?.get('grant_type')).toBe('refresh_token');
  });

  it('keeps the tokens and tries again later when the token endpoint is down', async () => {
    const { admin, org } = await world();
    const { params } = await signIn(admin);
    await completeNotetakerOAuth({ userId: admin.id, orgId: org.id }, params, ORIGIN);
    const conn = await db.transcriptConnection.findUniqueOrThrow({ where: { userId_provider: { userId: admin.id, provider: 'fathom' } } });
    const secrets = openSecrets(conn.credentials);
    if (secrets?.kind !== 'oauth') throw new Error('expected OAuth tokens');
    mcp.oauth.validTokens.delete(secrets.tokens.access_token);
    oauthOpts.refresh = 'server_error';

    expect(await syncTranscriptConnections({ connectionIds: [conn.id] })).toMatchObject({ failed: 1 });
    const after = await db.transcriptConnection.findUniqueOrThrow({ where: { id: conn.id } });
    expect(after).toMatchObject({ status: 'ERROR', lastError: "Couldn't refresh the Fathom sign-in. Source will try again." });
    expect(openSecrets(after.credentials)).toEqual(secrets);
  });

  it('marks the connection NEEDS_RECONNECT when the refresh is refused, instead of silently doing nothing', async () => {
    const { admin, org } = await world();
    const { params } = await signIn(admin);
    await completeNotetakerOAuth({ userId: admin.id, orgId: org.id }, params, ORIGIN);
    const conn = await db.transcriptConnection.findUniqueOrThrow({ where: { userId_provider: { userId: admin.id, provider: 'fathom' } } });
    const secrets = openSecrets(conn.credentials);
    if (secrets?.kind !== 'oauth') throw new Error('expected OAuth tokens');
    mcp.oauth.validTokens.delete(secrets.tokens.access_token); // revoked: the server answers 401
    oauthOpts.refresh = 'invalid_grant';

    const summary = await syncTranscriptConnections({ connectionIds: [conn.id] });
    expect(summary).toMatchObject({ failed: 1, synced: 0 });
    expect(await db.transcriptConnection.findUniqueOrThrow({ where: { id: conn.id } })).toMatchObject({
      status: 'NEEDS_RECONNECT',
      lastError: 'Fathom needs you to sign in again',
      credentials: null,
    });
  });
});
