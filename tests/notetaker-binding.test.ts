import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hasDb } from './setup';
import { candidate, createOrg } from './fixtures';
import { startFakeMcp, type FakeMcp, type FakeTool } from './support/fake-mcp';
import { db } from '@/lib/db';
import type { SessionContext } from '@/lib/session';
import { attachSuggestedMeeting } from '@/server/notetakers/connections';
import { sealSecrets } from '@/server/notetakers/oauth';
import { attachRecording, recordingsNearInterview } from '@/server/notetakers/picker';
import { meetingsToReview, searchAttachCandidates } from '@/server/notetakers/review';
import { syncTranscriptConnections } from '@/server/notetakers/sync';

/**
 * Binding a notetaker meeting to a person, against the database and a fake
 * Walkie (names only, no emails) over MCP (tests/support/fake-mcp.ts):
 *
 *  - a name match is only ever a suggestion, stored with the names;
 *  - the review card's choices, worked out at render time;
 *  - attaching to a chosen interview or profile, and what's refused;
 *  - "Attach a recording" from the candidate's side: lists ±12 hours live,
 *    stores nothing until one is chosen, then attaches it once.
 */

process.env.AUTH_SECRET ??= 'notetaker-test-secret';

const MIN = 60_000;
const HOUR = 60 * MIN;
const KEY = 'walkie_test_key_0123456789';

type WalkieMeeting = { id: string; title: string; when: Date; minutes?: number; participants: string[]; transcript?: string };

/** Walkie's own tools (stt-proxy/src/mcp.ts): list_meetings newest first, get_meeting by id. */
function walkieTools(meetings: () => WalkieMeeting[]): FakeTool[] {
  return [
    {
      name: 'list_meetings',
      properties: { limit: { type: 'number' }, offset: { type: 'number' } },
      handler: () => {
        const rows = [...meetings()]
          .sort((a, b) => b.when.getTime() - a.when.getTime())
          .map((m) => ({ id: m.id, title: m.title, when: m.when.toISOString(), minutes: m.minutes ?? 45, participants: m.participants, headings: [] }));
        return { structuredContent: { meetings: rows, total: rows.length, offset: 0, returned: rows.length, next_offset: null } };
      },
    },
    {
      name: 'get_meeting',
      properties: { id: { type: 'string' } },
      required: ['id'],
      handler: (args) => {
        const m = meetings().find((x) => x.id === args.id);
        if (!m) return { structuredContent: { error: 'meeting_not_found', id: String(args.id) } };
        return { structuredContent: { id: m.id, text: '# Notes', transcript: m.transcript ?? `Sam Recruiter: Hello.\nPriya Nair: Hi, thanks for having me.` } };
      },
    },
  ];
}

const ctxOf = (user: { id: string; orgId: string }): SessionContext => ({ userId: user.id, orgId: user.orgId, accessRole: 'TEAM_MEMBER' });

describe.skipIf(!hasDb)('binding a notetaker meeting to a person', () => {
  let meetings: WalkieMeeting[] = [];
  let mcp: FakeMcp;

  beforeAll(async () => {
    mcp = await startFakeMcp({ apiKey: KEY, tools: walkieTools(() => meetings) });
  });
  afterAll(async () => {
    await mcp?.close();
  });
  beforeEach(() => {
    meetings = [];
    mcp.calls.length = 0;
  });

  /** A Walkie connection with a key (Walkie signs in with OAuth; the session code is the same). */
  async function connectWalkie(user: { id: string; orgId: string }, opts: { provider?: string; key?: string } = {}) {
    return db.transcriptConnection.create({
      data: {
        orgId: user.orgId,
        userId: user.id,
        provider: opts.provider ?? 'walkie',
        serverUrl: mcp.url,
        authType: 'API_KEY',
        credentials: sealSecrets({ kind: 'api_key', apiKey: opts.key ?? KEY }),
        status: 'ACTIVE',
      },
    });
  }

  /**
   * A recruiter (Sam) on the panel of Priya Nair's onsite three hours ago and
   * Jordan Lee's screen 90 minutes after it; a second Priya Nair elsewhere
   * in the org, for another role; an erased Priya Nair; and another org.
   */
  async function world() {
    const { org, stages, admin } = await createOrg();
    const sam = await db.user.update({ where: { id: admin.id }, data: { name: 'Sam Recruiter' } });
    const designer = await db.posting.create({ data: { orgId: org.id, slug: `d-${randomUUID().slice(0, 8)}`, title: 'Product Designer' } });
    const engineer = await db.posting.create({ data: { orgId: org.id, slug: `e-${randomUUID().slice(0, 8)}`, title: 'Staff Engineer' } });
    const priya = await candidate(org.id, stages, [[1, 0]], { name: 'Priya Nair', emails: ['priya@acme-mail.test'], postingId: designer.id });
    const priya2 = await candidate(org.id, stages, [[1, 0]], { name: 'Priya  Nair', emails: ['pnair@other-mail.test'], postingId: engineer.id });
    const jordan = await candidate(org.id, stages, [[1, 0]], { name: 'Jordan Lee', emails: ['jordan@example.test'], postingId: engineer.id });
    const erased = await candidate(org.id, stages, [[1, 0]], { name: 'Priya Nair', emails: [] });
    await db.contact.update({ where: { id: erased.contact.id }, data: { isAnonymized: true } });
    const at = new Date(Date.now() - 3 * HOUR);
    const onsite = await db.interview.create({
      data: { orgId: org.id, opportunityId: priya.opportunity.id, title: 'Onsite', startAt: at, panelists: { connect: [{ id: sam.id }] } },
    });
    const screen = await db.interview.create({
      data: { orgId: org.id, opportunityId: jordan.opportunity.id, title: 'Screen', startAt: new Date(at.getTime() + 90 * MIN), panelists: { connect: [{ id: sam.id }] } },
    });
    // Sam isn't on this one: only reachable through "People named" or the search.
    const priya2Screen = await db.interview.create({
      data: { orgId: org.id, opportunityId: priya2.opportunity.id, title: 'Phone screen', startAt: new Date(at.getTime() + 26 * HOUR) },
    });
    const later = await db.interview.create({
      data: { orgId: org.id, opportunityId: jordan.opportunity.id, title: 'Final', startAt: new Date(at.getTime() + 3 * HOUR), panelists: { connect: [{ id: sam.id }] } },
    });
    const other = await createOrg();
    const outsider = await candidate(other.org.id, other.stages, [[1, 0]], { name: 'Priya Nair', emails: ['priya@acme-mail.test'] });
    const outsiderInterview = await db.interview.create({
      data: { orgId: other.org.id, opportunityId: outsider.opportunity.id, title: 'Onsite', startAt: at },
    });
    return { org, sam, priya, priya2, jordan, erased, onsite, screen, priya2Screen, later, outsider, outsiderInterview, at };
  }

  it('suggests a name-only match with its names instead of attaching it, and keeps nothing about other meetings', async () => {
    const w = await world();
    meetings = [
      { id: 'wk-onsite', title: 'Onsite with Priya', when: new Date(w.at.getTime() + 3 * MIN), participants: ['Sam Recruiter', 'Priya Nair'] },
      { id: 'wk-lunch', title: 'Lunch', when: new Date(w.at.getTime() - 5 * HOUR), participants: ['Sam Recruiter', 'Dana Friend'] },
    ];
    const conn = await connectWalkie(w.sam);
    const summary = await syncTranscriptConnections({ connectionIds: [conn.id] });
    expect(summary).toMatchObject({ synced: 1, suggested: 1, attached: [] });
    // No transcript was read, none was made.
    expect(mcp.calls.filter((c) => c.tool === 'get_meeting')).toEqual([]);
    expect(await db.transcript.count({ where: { orgId: w.org.id } })).toBe(0);
    const rows = await db.externalMeeting.findMany({ where: { connectionId: conn.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      externalId: 'wk-onsite',
      status: 'SUGGESTED',
      interviewId: w.onsite.id,
      attendeeEmails: [],
      attendeeNames: ['Sam Recruiter', 'Priya Nair'],
    });
    expect(await db.externalMeeting.count({ where: { OR: [{ externalId: 'wk-lunch' }, { attendeeNames: { has: 'Dana Friend' } }] } })).toBe(0);
  });

  it('builds the review card at render time: interviews within two hours with reasons, people with the name, the warning, quick picks', async () => {
    const w = await world();
    meetings = [
      { id: 'wk-onsite', title: 'Onsite with Priya', when: new Date(w.at.getTime() + 3 * MIN), participants: ['Sam Recruiter', 'Priya Nair', 'Alex Guest'] },
    ];
    const conn = await connectWalkie(w.sam);
    await syncTranscriptConnections({ connectionIds: [conn.id] });

    const [card] = await meetingsToReview(ctxOf(w.sam));
    expect(card).toMatchObject({ provider: 'walkie', title: 'Onsite with Priya', durationMins: 45, participants: ['Sam Recruiter', 'Priya Nair', 'Alex Guest'] });
    // Priya's onsite (her name was there) before Jordan's screen (only the time); the final, three hours on, isn't offered.
    expect(card.options.map((o) => [o.interviewId, o.reason, o.candidate.name, o.candidate.email, o.candidate.postingTitle])).toEqual([
      [w.onsite.id, 'name', 'Priya Nair', 'priya@acme-mail.test', 'Product Designer'],
      [w.screen.id, 'time', 'Jordan Lee', 'jordan@example.test', 'Staff Engineer'],
    ]);
    expect(card.preselect).toBe(w.onsite.id);
    // The other Priya Nair, from anywhere in the org; not the erased one, not the other org's.
    expect(card.peopleNamed).toHaveLength(1);
    expect(card.peopleNamed[0]).toMatchObject({ name: 'Priya Nair', alsoAbove: true });
    expect(card.peopleNamed[0].people).toEqual([
      expect.objectContaining({
        contactId: w.priya2.contact.id,
        email: 'pnair@other-mail.test',
        role: 'Staff Engineer',
        interview: { when: 'next', title: 'Phone screen', startAt: w.priya2Screen.startAt.toISOString() },
      }),
    ]);
    expect(card.sameName).toEqual([{ name: 'Priya Nair', count: 2 }]);
    // Sam is on the team; the others are quick picks for the search.
    expect(card.quickPicks).toEqual(['Priya Nair', 'Alex Guest']);
    // Nothing about the card was stored.
    expect(await db.externalMeeting.findFirstOrThrow({ where: { connectionId: conn.id } })).toMatchObject({ interviewId: w.onsite.id, status: 'SUGGESTED' });
  });

  it('attaches to the interview or profile chosen, and refuses other orgs, erased candidates and other people’s meetings', async () => {
    const w = await world();
    meetings = [{ id: 'wk-onsite', title: 'Onsite with Priya', when: new Date(w.at.getTime() + 3 * MIN), participants: ['Sam Recruiter', 'Priya Nair'] }];
    const conn = await connectWalkie(w.sam);
    await syncTranscriptConnections({ connectionIds: [conn.id] });
    const [card] = await meetingsToReview(ctxOf(w.sam));
    const refused = { ok: false, error: "That interview or candidate isn't one you can attach to" };

    // Another org's interview or opportunity: refused, whatever the card offered.
    expect(await attachSuggestedMeeting(ctxOf(w.sam), card.id, { interviewId: w.outsiderInterview.id })).toEqual(refused);
    expect(await attachSuggestedMeeting(ctxOf(w.sam), card.id, { opportunityId: w.outsider.opportunity.id })).toEqual(refused);
    // An erased candidate is hidden: refused.
    expect(await attachSuggestedMeeting(ctxOf(w.sam), card.id, { opportunityId: w.erased.opportunity.id })).toEqual(refused);
    // An interview that isn't on the opportunity named with it: refused.
    expect(await attachSuggestedMeeting(ctxOf(w.sam), card.id, { interviewId: w.onsite.id, opportunityId: w.priya2.opportunity.id })).toEqual(refused);
    // Someone else's meeting: not theirs to attach.
    const teammate = await db.user.create({ data: { orgId: w.org.id, email: `t-${randomUUID()}@acme.test`, name: 'Teammate' } });
    expect(await attachSuggestedMeeting(ctxOf(teammate), card.id, { interviewId: w.onsite.id })).toEqual({
      ok: false,
      error: 'This meeting is no longer waiting for review',
    });
    // None of that fetched or stored anything.
    expect(mcp.calls.filter((c) => c.tool === 'get_meeting')).toEqual([]);
    expect(await db.transcript.count({ where: { orgId: w.org.id } })).toBe(0);

    // It was the other Priya Nair, on her profile: no interview.
    const result = await attachSuggestedMeeting(ctxOf(w.sam), card.id, { opportunityId: w.priya2.opportunity.id });
    expect(result).toEqual({
      ok: true,
      transcriptId: expect.any(String),
      created: true,
      linked: false,
      attachedTo: { contactName: 'Priya  Nair', opportunityId: w.priya2.opportunity.id, interviewTitle: null },
    });
    const transcript = await db.transcript.findFirstOrThrow({ where: { orgId: w.org.id } });
    expect(transcript).toMatchObject({ opportunityId: w.priya2.opportunity.id, interviewId: null, source: 'walkie', title: 'Onsite with Priya' });
    expect(transcript.content).toContain('Priya Nair: Hi, thanks for having me.');
    expect(await db.externalMeeting.findUniqueOrThrow({ where: { id: card.id } })).toMatchObject({
      status: 'ATTACHED',
      transcriptId: transcript.id,
      interviewId: null,
      attendeeNames: [],
    });
    // Once.
    expect(await attachSuggestedMeeting(ctxOf(w.sam), card.id, { opportunityId: w.priya2.opportunity.id })).toMatchObject({ ok: false });
    expect(await meetingsToReview(ctxOf(w.sam))).toEqual([]);
  });

  it('attaches to an interview the viewer is not on, found through the search', async () => {
    const w = await world();
    meetings = [{ id: 'wk-onsite', title: 'Onsite with Priya', when: new Date(w.at.getTime() + 3 * MIN), participants: ['Sam Recruiter', 'Priya Nair'] }];
    const conn = await connectWalkie(w.sam);
    await syncTranscriptConnections({ connectionIds: [conn.id] });
    const [card] = await meetingsToReview(ctxOf(w.sam));

    const byName = await searchAttachCandidates(ctxOf(w.sam), 'priya');
    expect(byName.map((p) => p.contactId).sort()).toEqual([w.priya.contact.id, w.priya2.contact.id].sort());
    expect(await searchAttachCandidates(ctxOf(w.sam), 'PNAIR@other-mail.test')).toEqual([expect.objectContaining({ contactId: w.priya2.contact.id })]);
    expect(await searchAttachCandidates(ctxOf(w.sam), 'p')).toEqual([]);
    const pick = byName.find((p) => p.contactId === w.priya2.contact.id)!;
    expect(pick.applications).toEqual([
      { opportunityId: w.priya2.opportunity.id, postingTitle: 'Staff Engineer', archived: false, interviews: [expect.objectContaining({ id: w.priya2Screen.id })] },
    ]);

    const result = await attachSuggestedMeeting(ctxOf(w.sam), card.id, { interviewId: w.priya2Screen.id, opportunityId: w.priya2.opportunity.id });
    expect(result).toMatchObject({ ok: true, created: true, attachedTo: { contactName: 'Priya  Nair', interviewTitle: 'Phone screen' } });
    expect(await db.transcript.findFirstOrThrow({ where: { orgId: w.org.id } })).toMatchObject({ interviewId: w.priya2Screen.id });
  });

  it('lists recordings within 12 hours of an interview live, stores nothing until one is chosen, then attaches it once', async () => {
    const w = await world();
    meetings = [
      { id: 'wk-onsite', title: 'Onsite', when: new Date(w.at.getTime() + 4 * MIN), participants: ['Sam Recruiter', 'Priya Nair'] },
      { id: 'wk-early', title: 'Morning sync', when: new Date(w.at.getTime() - 11 * HOUR), participants: ['Sam Recruiter', 'Dana Friend'] },
      { id: 'wk-old', title: 'Two days ago', when: new Date(w.at.getTime() - 13 * HOUR), participants: ['Sam Recruiter'] },
    ];
    const conn = await connectWalkie(w.sam);
    // A second notetaker whose key stopped working: its error line, and the rest still listed.
    await connectWalkie(w.sam, { provider: 'fireflies', key: 'ff_revoked_key_000000' });

    const listed = await recordingsNearInterview(ctxOf(w.sam), w.onsite.id);
    if (!listed.ok) throw new Error(listed.error);
    expect(listed.connected).toBe(true);
    expect(listed.groups.map((g) => [g.provider, g.error])).toEqual([
      ['fireflies', "Fireflies didn't accept the API key"],
      ['walkie', null],
    ]);
    const walkie = listed.groups.find((g) => g.provider === 'walkie')!;
    // ±12 hours; this candidate's first, marked with why; nothing picked for them.
    expect(walkie.meetings.map((m) => [m.externalId, m.suggested, m.attached])).toEqual([
      ['wk-onsite', { reason: 'name', text: 'Priya Nair was in this meeting' }, null],
      ['wk-early', null, null],
    ]);
    expect(walkie.meetings[0]).toMatchObject({ title: 'Onsite', durationMins: 45, participants: ['Sam Recruiter', 'Priya Nair'] });
    // Looking stored nothing and read no transcript.
    expect(await db.externalMeeting.count({ where: { orgId: w.org.id } })).toBe(0);
    expect(mcp.calls.filter((c) => c.tool === 'get_meeting')).toEqual([]);

    // Tokens are this person's, for this interview.
    const token = walkie.meetings[0].token;
    const teammate = await db.user.create({ data: { orgId: w.org.id, email: `t-${randomUUID()}@acme.test`, name: 'Teammate' } });
    expect(await attachRecording(ctxOf(teammate), w.onsite.id, token)).toEqual({ ok: false, error: "That recording can't be attached from here" });
    expect(await attachRecording(ctxOf(w.sam), w.screen.id, token)).toEqual({ ok: false, error: "That recording can't be attached from here" });
    expect(await attachRecording(ctxOf(w.sam), w.onsite.id, `${token}x`)).toMatchObject({ ok: false });
    expect(await attachRecording(ctxOf(w.sam), w.onsite.id, token, { now: new Date(Date.now() + 2 * HOUR) })).toEqual({
      ok: false,
      error: 'This list is out of date. Open it again.',
    });

    const attached = await attachRecording(ctxOf(w.sam), w.onsite.id, token);
    expect(attached).toMatchObject({ ok: true, created: true });
    const transcript = await db.transcript.findFirstOrThrow({ where: { orgId: w.org.id } });
    expect(transcript).toMatchObject({ opportunityId: w.priya.opportunity.id, interviewId: w.onsite.id, source: 'walkie', title: 'Onsite' });
    const rows = await db.externalMeeting.findMany({ where: { orgId: w.org.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      connectionId: conn.id,
      externalId: 'wk-onsite',
      status: 'ATTACHED',
      interviewId: w.onsite.id,
      transcriptId: transcript.id,
      attendeeNames: [],
    });

    // Never twice: not here, not on another of their interviews.
    expect(await attachRecording(ctxOf(w.sam), w.onsite.id, token)).toEqual({ ok: false, error: 'Already attached to this interview' });
    const again = await recordingsNearInterview(ctxOf(w.sam), w.onsite.id);
    if (!again.ok) throw new Error(again.error);
    // The refused key was marked for reconnecting: still shown, with its reason, and not asked again.
    expect(again.groups.map((g) => [g.provider, g.error])).toEqual([
      ['fireflies', "Fireflies didn't accept the API key"],
      ['walkie', null],
    ]);
    expect(await db.transcriptConnection.findFirstOrThrow({ where: { userId: w.sam.id, provider: 'fireflies' } })).toMatchObject({
      status: 'NEEDS_RECONNECT',
    });
    expect(again.groups.find((g) => g.provider === 'walkie')!.meetings[0].attached).toEqual({
      here: true,
      to: { contactName: 'Priya Nair', opportunityId: w.priya.opportunity.id, interviewTitle: 'Onsite' },
    });
    const fromScreen = await recordingsNearInterview(ctxOf(w.sam), w.screen.id);
    if (!fromScreen.ok) throw new Error(fromScreen.error);
    const same = fromScreen.groups.find((g) => g.provider === 'walkie')!.meetings.find((m) => m.externalId === 'wk-onsite')!;
    expect(same.attached).toMatchObject({ here: false, to: { contactName: 'Priya Nair', interviewTitle: 'Onsite' } });
    expect(await attachRecording(ctxOf(w.sam), w.screen.id, same.token)).toEqual({ ok: false, error: 'Already attached to Priya Nair · Onsite' });
    expect(await db.transcript.count({ where: { orgId: w.org.id } })).toBe(1);
  });

  it('says so when there is no notetaker to look in, and refuses interviews it may not see', async () => {
    const w = await world();
    expect(await recordingsNearInterview(ctxOf(w.sam), w.onsite.id)).toMatchObject({ ok: true, connected: false, groups: [] });
    await connectWalkie(w.sam);
    expect(await recordingsNearInterview(ctxOf(w.sam), w.outsiderInterview.id)).toEqual({ ok: false, error: "This interview isn't available" });
    const erasedInterview = await db.interview.create({
      data: { orgId: w.org.id, opportunityId: w.erased.opportunity.id, title: 'Onsite', startAt: w.at },
    });
    expect(await recordingsNearInterview(ctxOf(w.sam), erasedInterview.id)).toEqual({ ok: false, error: "This interview isn't available" });
    // Nothing recorded yet: an interview days away asks no notetaker anything.
    const future = await db.interview.create({
      data: { orgId: w.org.id, opportunityId: w.priya.opportunity.id, title: 'Final', startAt: new Date(Date.now() + 3 * 24 * HOUR) },
    });
    const calls = mcp.calls.length;
    const none = await recordingsNearInterview(ctxOf(w.sam), future.id);
    expect(none).toMatchObject({ ok: true, connected: true, groups: [{ provider: 'walkie', error: null, meetings: [] }] });
    expect(mcp.calls.length).toBe(calls);
  });
});
