import { describe, expect, it } from 'vitest';
import { OAuthError, OAuthErrorCode, SdkErrorCode, SdkHttpError, UnauthorizedError } from '@modelcontextprotocol/client';
import { describeFailure } from '@/server/notetakers/sync';
import {
  createAdapter,
  dateArg,
  fitArgs,
  INTENT,
  MissingToolsError,
  pickTool,
  type ToolCaller,
  type ToolDef,
  WALKIE_TRANSCRIPT_OFF,
  walkieMeeting,
} from '@/server/notetakers/adapters';
import { matchMeeting, type InterviewForMatch } from '@/server/notetakers/match';
import {
  normalizeMeeting,
  recordsOf,
  ToolCallError,
  ToolOutputError,
  toolPayload,
  transcriptTextOf,
} from '@/server/notetakers/parse';

/**
 * The notetaker adapters' reading of tool output. No provider documents its
 * MCP output shapes, so each payload below says where it comes from:
 *
 *  - DOCUMENTED: the provider's public REST/GraphQL API documents these
 *    fields (Fireflies GraphQL `transcripts`, Fathom `list_meetings`), and
 *    their MCP tools very likely pass them through.
 *  - PLAUSIBLE: invented from the tool's name and arguments and the usual
 *    conventions (Metaview, Granola, Otter, Circleback). A live account has
 *    to confirm these; the parsers are written to cope if they're off.
 */

const T = new Date('2026-09-22T15:00:00Z');
const MIN = 60_000;

/** A fake tool caller: answers by tool name, records what it was asked. */
function caller(answers: Record<string, (args: Record<string, unknown>) => unknown>) {
  const log: { tool: string; args: Record<string, unknown> }[] = [];
  const call: ToolCaller = async (tool, args) => {
    log.push({ tool, args });
    const answer = answers[tool];
    if (!answer) throw new Error(`unexpected tool ${tool}`);
    return answer(args);
  };
  return { call, log };
}

const tool = (name: string, properties?: Record<string, unknown>, required?: string[]): ToolDef => ({
  name,
  inputSchema: { type: 'object', ...(properties ? { properties } : {}), ...(required ? { required } : {}) },
});

describe('tool results', () => {
  it('prefers structuredContent, then JSON text, then the text itself', () => {
    expect(toolPayload('t', { structuredContent: { a: 1 }, content: [{ type: 'text', text: '{"a":2}' }] })).toEqual({ a: 1 });
    expect(toolPayload('t', { content: [{ type: 'text', text: '{"a":2}' }] })).toEqual({ a: 2 });
    expect(toolPayload('t', { content: [{ type: 'text', text: '```json\n[{"a":3}]\n```' }] })).toEqual([{ a: 3 }]);
    expect(toolPayload('t', { content: [{ type: 'text', text: 'Alex: hello there' }] })).toBe('Alex: hello there');
    expect(toolPayload('t', { content: [{ type: 'text', text: '{"a":1}' }, { type: 'text', text: '{"a":2}' }] })).toEqual([{ a: 1 }, { a: 2 }]);
    expect(toolPayload('t', { content: [] })).toBeNull();
  });

  it('turns isError into a ToolCallError carrying the provider message', () => {
    expect(() => toolPayload('get_meeting_transcript', { isError: true, content: [{ type: 'text', text: 'Transcripts need a paid plan' }] })).toThrow(
      ToolCallError,
    );
  });

  it('describes an unreadable list by its shape, never its values', () => {
    const payload = { weird: { secretTitle: 'Therapy with Dr. K' }, n: 3 };
    let message = '';
    try {
      recordsOf(payload, 'Fireflies transcript list');
    } catch (err) {
      expect(err).toBeInstanceOf(ToolOutputError);
      message = (err as Error).message;
    }
    expect(message).toContain('weird');
    expect(message).not.toContain('Therapy');
    expect(() => recordsOf('Some prose the server wrote about your meetings', 'Granola meeting list')).toThrow(ToolOutputError);
  });
});

describe('Fireflies (DOCUMENTED fields: GraphQL transcripts)', () => {
  const listed = {
    data: {
      transcripts: [
        {
          id: 'ff-1',
          title: 'Onsite: Priya Raman',
          date: T.getTime(), // epoch ms
          duration: 45, // minutes
          participants: ['recruiter@acme.test,priya@example.com'],
          meeting_attendees: [{ email: 'PRIYA@example.com', name: 'Priya Raman', displayName: 'Priya' }],
        },
      ],
    },
  };

  it('normalises a transcript list entry', () => {
    const [m] = recordsOf(listed, 'list').map((r) => normalizeMeeting(r, { durationUnit: 'minutes' }));
    expect(m).toEqual({
      externalId: 'ff-1',
      title: 'Onsite: Priya Raman',
      startAt: T,
      endAt: new Date(T.getTime() + 45 * MIN),
      attendees: [{ email: 'priya@example.com', name: 'Priya Raman' }, { email: 'recruiter@acme.test' }],
    });
  });

  it('pages with skip until a short page, and sends only declared arguments', async () => {
    const adapter = createAdapter('fireflies');
    adapter.resolve([
      tool('fireflies_get_transcripts', { fromDate: { type: 'string' }, toDate: { type: 'string' }, limit: {}, skip: {}, format: {} }),
      tool('fireflies_get_transcript', { transcriptId: { type: 'string' } }),
      tool('fireflies_search'),
    ]);
    const page = (n: number, offset: number) =>
      Array.from({ length: n }, (_, i) => ({ id: `ff-${offset + i}`, title: 'x', date: T.getTime() }));
    const { call, log } = caller({
      fireflies_get_transcripts: (args) => (args.skip === 0 ? page(50, 0) : page(3, 50)),
    });
    const meetings = await adapter.list(call, { from: new Date('2026-09-20T10:00:00Z'), to: T }, Date.now() + 60_000);
    expect(meetings).toHaveLength(53);
    expect(log.map((l) => l.args.skip)).toEqual([0, 50]);
    expect(log[0].args).toEqual({ fromDate: '2026-09-20', toDate: '2026-09-23', limit: 50, skip: 0, format: 'json' });
  });

  it('reads sentences into speaker lines', async () => {
    const adapter = createAdapter('fireflies');
    adapter.resolve([tool('fireflies_get_transcripts'), tool('fireflies_get_transcript', { transcriptId: {} })]);
    const { call, log } = caller({
      fireflies_get_transcript: () => ({
        transcript: {
          id: 'ff-1',
          title: 'Onsite',
          sentences: [
            { speaker_name: 'Sam', text: 'Tell me about a hard bug.', start_time: 1.2 },
            { speaker_name: 'Priya', text: 'We had a race in the cache.', start_time: 4.0 },
            { speaker_name: 'Priya', text: 'Two writers, one lock.', start_time: 7.1 },
          ],
        },
      }),
    });
    const text = await adapter.transcript(call, { externalId: 'ff-1', startAt: T });
    expect(log[0].args).toEqual({ transcriptId: 'ff-1' });
    expect(text).toBe('Sam: Tell me about a hard bug.\nPriya: We had a race in the cache. Two writers, one lock.');
  });
});

describe('Fathom (DOCUMENTED fields: public API list_meetings)', () => {
  it('follows next_cursor and reads calendar invitees', async () => {
    const adapter = createAdapter('fathom');
    adapter.resolve([tool('list_meetings'), tool('get_meeting_transcript')]);
    const { call, log } = caller({
      list_meetings: (args) =>
        args.cursor
          ? { items: [], next_cursor: null }
          : {
              items: [
                {
                  recording_id: 987,
                  title: 'Screen — Jordan',
                  url: 'https://fathom.video/calls/987',
                  scheduled_start_time: '2026-09-22T15:00:00Z',
                  scheduled_end_time: '2026-09-22T15:30:00Z',
                  recorded_by: { name: 'Sam Recruiter', email: 'sam@acme.test' },
                  calendar_invitees: [
                    { name: 'Jordan Lee', email: 'jordan@example.com', is_external: true },
                    { name: 'Sam Recruiter', email: 'sam@acme.test', is_external: false },
                  ],
                },
              ],
              next_cursor: 'c2',
            },
    });
    const [m, ...rest] = await adapter.list(call, { from: new Date(T.getTime() - 3_600_000), to: T }, Date.now() + 60_000);
    expect(rest).toEqual([]);
    expect(log.map((l) => l.args.cursor)).toEqual([undefined, 'c2']);
    expect(log[0].args.created_after).toBe(new Date(T.getTime() - 3_600_000).toISOString());
    expect(m.externalId).toBe('987');
    expect(m.endAt).toEqual(new Date('2026-09-22T15:30:00Z'));
    expect(m.attendees.map((a) => a.email)).toEqual(['jordan@example.com', 'sam@acme.test']);
  });

  it('reads a transcript of speaker objects (PLAUSIBLE: mirrors the REST transcript)', async () => {
    const adapter = createAdapter('fathom');
    adapter.resolve([tool('list_meetings'), tool('get_meeting_transcript', { recording_id: {} })]);
    const { call } = caller({
      get_meeting_transcript: () => ({
        transcript: [
          { speaker: { display_name: 'Sam Recruiter', matched_calendar_invitee_email: 'sam@acme.test' }, text: 'Hi Jordan.', timestamp: '00:00:02' },
          { speaker: { display_name: 'Jordan Lee' }, text: 'Hi!', timestamp: '00:00:04' },
        ],
      }),
    });
    expect(await adapter.transcript(call, { externalId: '987', startAt: T })).toBe('Sam Recruiter: Hi Jordan.\nJordan Lee: Hi!');
  });
});

describe('Metaview (PLAUSIBLE payloads)', () => {
  it('applies the window itself and finds the transcript by id', async () => {
    const adapter = createAdapter('metaview');
    adapter.resolve([tool('get_user_context'), tool('search_conversations', { filters: {}, fields: {}, limit: {} }), tool('list_field_values')]);
    const { call, log } = caller({
      search_conversations: (args) =>
        Array.isArray(args.fields)
          ? {
              conversations: [
                { id: 'mv-2', transcript: 'someone else' },
                { id: 'mv-1', transcript: [{ speaker: 'Interviewer', text: 'Walk me through it.' }] },
              ],
            }
          : {
              conversations: [
                { id: 'mv-1', title: 'Interview: Ana', start_time: T.toISOString(), participants: [{ name: 'Ana', email: 'ana@example.com', role: 'candidate' }] },
                { id: 'mv-old', title: 'Old', start_time: '2026-08-01T10:00:00Z' },
              ],
            },
    });
    const meetings = await adapter.list(call, { from: new Date(T.getTime() - 3_600_000), to: T }, Date.now() + 60_000);
    expect(meetings.map((m) => m.externalId)).toEqual(['mv-1']);
    expect(log[0].args).toEqual({ filters: [], limit: 50 });
    expect(await adapter.transcript(call, { externalId: 'mv-1', startAt: T })).toBe('Interviewer: Walk me through it.');
    // Several conversations and none is this one: never guess.
    expect(await adapter.transcript(call, { externalId: 'mv-9', startAt: T })).toBeNull();
  });
});

describe('Granola (PLAUSIBLE payloads)', () => {
  it('reads XML-ish text lists and fills attendees from get_meetings', async () => {
    const adapter = createAdapter('granola');
    adapter.resolve([tool('list_meetings'), tool('get_meetings', { meeting_ids: {} }), tool('get_meeting_transcript')]);
    const { call, log } = caller({
      list_meetings: () =>
        `<meetings>\n<meeting id="g-1" title="Chat with Lee" date="2026-09-22T15:05:00Z">\n</meeting>\n</meetings>`,
      get_meetings: () => ({ meetings: [{ id: 'g-1', attendees: [{ name: 'Lee', email: 'lee@example.com' }] }] }),
      get_meeting_transcript: () => 'Me: Thanks for coming in.\nThem: Glad to be here.',
    });
    const listed = await adapter.list(call, { from: new Date(T.getTime() - 3_600_000), to: T }, Date.now() + 60_000);
    expect(listed[0]).toMatchObject({ externalId: 'g-1', title: 'Chat with Lee', attendees: [] });
    expect(log[0].args).toMatchObject({ time_range: 'custom' });
    const detailed = await adapter.details!(call, listed, Date.now() + 60_000);
    expect(detailed[0].attendees).toEqual([{ name: 'Lee', email: 'lee@example.com' }]);
    expect(log[1].args).toEqual({ meeting_ids: ['g-1'] });
    expect(await adapter.transcript(call, { externalId: 'g-1', startAt: T })).toBe('Me: Thanks for coming in.\nThem: Glad to be here.');
  });

  it('reads "Key: value" text blocks too', () => {
    const recs = recordsOf('Meeting ID: abc\nTitle: Screen\nDate: 2026-09-22T15:00:00Z\n\nMeeting ID: def\nTitle: Lunch\nDate: 2026-09-22T12:00:00Z', 'list');
    expect(recs.map((r) => normalizeMeeting(r)?.externalId)).toEqual(['abc', 'def']);
  });
});

describe('Otter (PLAUSIBLE payloads: OpenAI-style search/fetch)', () => {
  it('fetches undated search results to learn their time, and reuses the fetch for the transcript', async () => {
    const adapter = createAdapter('otter');
    adapter.resolve([tool('search', { query: {}, created_after: {}, created_before: {}, page_size: {}, cursor: {} }, ['query']), tool('fetch', { id: {} })]);
    const { call, log } = caller({
      search: () => ({ results: [{ id: 'ot-1', title: 'Interview — Kim', url: 'https://otter.ai/u/ot-1' }] }),
      fetch: () => ({
        id: 'ot-1',
        title: 'Interview — Kim',
        text: 'Speaker 1: Hello Kim.',
        metadata: { created_at: Math.floor(T.getTime() / 1000), attendees: ['kim@example.com'] },
      }),
    });
    const [m] = await adapter.list(call, { from: new Date('2026-09-22T10:00:00Z'), to: T }, Date.now() + 60_000);
    expect(m).toMatchObject({ externalId: 'ot-1', startAt: T, attendees: [{ email: 'kim@example.com' }] });
    expect(log[0].args).toEqual({ query: '', created_after: '2026/09/22', created_before: '2026/09/23', page_size: 25 });
    expect(await adapter.transcript(call, { externalId: 'ot-1', startAt: T })).toBe('Speaker 1: Hello Kim.');
    expect(log.filter((l) => l.tool === 'fetch')).toHaveLength(1);
  });
});

describe('Circleback (PLAUSIBLE payloads; arguments from its docs)', () => {
  it('pages by index, reads attendees with ReadMeetings, and picks its transcript', async () => {
    const adapter = createAdapter('circleback');
    adapter.resolve([
      tool('SearchMeetings', { intent: {}, pageIndex: {}, startDate: {}, endDate: {}, searchTerm: {} }, ['intent', 'pageIndex']),
      tool('ReadMeetings', { intent: {}, meetingIds: {} }, ['intent', 'meetingIds']),
      tool('GetTranscriptsForMeetings', { intent: {}, meetingIds: {} }, ['intent', 'meetingIds']),
    ]);
    const { call, log } = caller({
      SearchMeetings: (args) => (args.pageIndex === 0 ? [{ id: 42, name: 'Final round', createdAt: T.toISOString(), duration: 1800 }] : []),
      ReadMeetings: () => [{ id: 42, attendees: [{ name: 'Rae', email: 'rae@example.com' }] }],
      GetTranscriptsForMeetings: () => [
        { meetingId: 41, transcript: [{ speaker: 'Other', text: 'not this one' }] },
        { meetingId: 42, transcript: [{ speaker: 'Rae', text: 'I led the migration.', timestamp: 12 }] },
      ],
    });
    const listed = await adapter.list(call, { from: new Date('2026-09-22T10:00:00Z'), to: T }, Date.now() + 60_000);
    expect(listed[0]).toMatchObject({ externalId: '42', title: 'Final round', endAt: new Date(T.getTime() + 30 * MIN) });
    expect(log[0].args).toEqual({ intent: INTENT, pageIndex: 0, startDate: '2026-09-22', endDate: '2026-09-23' });
    const [detailed] = await adapter.details!(call, listed, Date.now() + 60_000);
    expect(detailed.attendees).toEqual([{ name: 'Rae', email: 'rae@example.com' }]);
    expect(await adapter.transcript(call, { externalId: '42', startAt: T })).toBe('Rae: I led the migration.');
  });
});

describe('Walkie (EXACT payloads: stt-proxy/src/mcp.ts in the walkie repo)', () => {
  const meeting = (id: string, when: Date, participants: string[] = []) => ({
    id,
    title: `Meeting ${id}`,
    url: `https://trywalkie.com/dashboard/meetings/${id}`,
    when: when.toISOString(),
    minutes: 45,
    participants,
    headings: [],
  });

  it('pages newest first until it passes the window, and reads names as attendees', async () => {
    const adapter = createAdapter('walkie');
    adapter.resolve([tool('search_meetings'), tool('list_meetings', { limit: {}, offset: {} }), tool('get_meeting', { id: {} }), tool('search'), tool('fetch')]);
    const from = new Date(T.getTime() - 3 * 60 * MIN);
    const { call, log } = caller({
      list_meetings: (args) =>
        args.offset === 0
          ? { meetings: [meeting('new', new Date(T.getTime() + 10 * 60 * MIN)), meeting('in', T, ['Adam', 'Priya Nair'])], total: 3, offset: 0, returned: 2, next_offset: 2 }
          : { meetings: [meeting('old', new Date(from.getTime() - MIN))], total: 3, offset: 2, returned: 1, next_offset: null },
    });
    const listed = await adapter.list(call, { from, to: new Date(T.getTime() + MIN) }, Date.now() + 60_000);
    expect(listed).toEqual([
      { externalId: 'in', title: 'Meeting in', startAt: T, endAt: new Date(T.getTime() + 45 * MIN), attendees: [{ name: 'Adam' }, { name: 'Priya Nair' }] },
    ]);
    expect(log.map((l) => l.args)).toEqual([{ limit: 100, offset: 0 }, { limit: 100, offset: 2 }]);
  });

  it('reads the transcript alone, and says so when transcript access is off', async () => {
    const adapter = createAdapter('walkie');
    adapter.resolve([tool('list_meetings'), tool('get_meeting', { id: {} })]);
    const on = caller({ get_meeting: () => ({ id: 'm', text: '# Meeting\n## Notes…', transcript: 'Adam: Tell me about the migration.\nPriya: I led it.' }) });
    expect(await adapter.transcript(on.call, { externalId: 'm', startAt: T })).toBe('Adam: Tell me about the migration.\nPriya: I led it.');
    const off = caller({ get_meeting: () => ({ id: 'm', transcript: WALKIE_TRANSCRIPT_OFF }) });
    await expect(adapter.transcript(off.call, { externalId: 'm', startAt: T })).rejects.toThrow(/without transcripts/);
    const gone = caller({ get_meeting: () => ({ error: 'meeting_not_found', id: 'm' }) });
    expect(await adapter.transcript(gone.call, { externalId: 'm', startAt: T })).toBeNull();
  });

  it('skips entries without an id or a real start time', () => {
    expect(walkieMeeting({ id: 'x', title: 'Quick sync', when: new Date(0).toISOString() })).toBeNull();
    expect(walkieMeeting({ title: 'No id', when: T.toISOString() })).toBeNull();
    expect(walkieMeeting({ id: 'y', when: T.toISOString() })).toMatchObject({ title: 'Walkie meeting', attendees: [] });
  });
});

describe('tool and argument helpers', () => {
  it('picks tools by exact name first, then by pattern, and says what is missing', () => {
    const tools = [tool('otter_fetch'), tool('otter_search'), tool('search')];
    expect(pickTool(tools, ['otter_search', 'search'])?.name).toBe('otter_search');
    expect(pickTool([tool('Search_Recordings')], ['otter_search'], /search/i)?.name).toBe('Search_Recordings');
    expect(() => createAdapter('fathom').resolve([tool('whoami')])).toThrow(MissingToolsError);
    expect(() => createAdapter('fathom').resolve([tool('whoami')])).toThrow(/Fathom's MCP server has no tool that lists meetings \(it offers whoami\)/);
  });

  it('fits arguments to the schema and fills required intents and queries', () => {
    const t = tool('SearchMeetings', { intent: {}, pageIndex: {}, q: {} }, ['intent', 'q']);
    expect(fitArgs(t, { pageIndex: 0, startDate: '2026-09-01' })).toEqual({ pageIndex: 0, intent: INTENT, q: '' });
    // No declared properties: send everything.
    expect(fitArgs(tool('x'), { a: 1, b: undefined })).toEqual({ a: 1 });
  });

  it('formats dates the way the schema asks', () => {
    const d = new Date('2026-09-22T15:00:00Z');
    expect(dateArg(tool('t', { from: { type: 'string', format: 'date' } }), 'from', d, 'iso')).toBe('2026-09-22');
    expect(dateArg(tool('t', { from: { type: 'string', description: 'Start, YYYY/MM/DD' } }), 'from', d, 'iso')).toBe('2026/09/22');
    expect(dateArg(tool('t', { from: { type: 'string', format: 'date-time' } }), 'from', d, 'ymd')).toBe(d.toISOString());
    expect(dateArg(tool('t'), 'from', d, 'ymd')).toBe('2026-09-22');
  });

  it('reads epoch seconds, epoch ms, ISO, and slashed dates; rejects nonsense', () => {
    const base = { id: 'x' };
    expect(normalizeMeeting({ ...base, start_time: 1790089200 })?.startAt).toEqual(new Date(1790089200 * 1000));
    expect(normalizeMeeting({ ...base, date: '1790089200000' })?.startAt).toEqual(new Date(1790089200000));
    expect(normalizeMeeting({ ...base, created_at: '2026/09/22 15:00:00Z' })?.startAt).toEqual(new Date('2026-09-22T15:00:00Z'));
    expect(normalizeMeeting({ ...base, start: { dateTime: '2026-09-22T15:00:00Z' } })?.startAt).toEqual(T);
    expect(normalizeMeeting({ ...base, date: 42 })).toBeNull();
    expect(normalizeMeeting({ title: 'no id', date: T.toISOString() })).toBeNull();
  });

  it('reads plain transcript text and Otter-style fetch documents', () => {
    expect(transcriptTextOf('  Alex: hi  ')).toBe('Alex: hi');
    expect(transcriptTextOf({ id: 'a', title: 't', text: 'Body text', url: 'u' })).toBe('Body text');
    expect(transcriptTextOf({ nothing: true })).toBeNull();
  });
});

describe('what a failed sync tells the connection owner', () => {
  const key = { provider: 'fireflies', authType: 'API_KEY' as const };
  const http = (status: number, text: string) =>
    new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, `Error POSTing to endpoint: ${text}`, { status, statusText: '', text });

  it('treats a refused key as needing a reconnect: 401, and the 403 Fireflies really answers', () => {
    // Observed live 2026-09-25: Fireflies' MCP endpoint answers an unknown key with
    // 403 {"code":"forbidden","message":"Forbidden resource"}.
    expect(describeFailure(key, http(403, '{"code":"forbidden","message":"Forbidden resource"}'))).toEqual({
      status: 'NEEDS_RECONNECT',
      error: "Fireflies didn't accept the API key",
    });
    expect(describeFailure({ provider: 'fathom', authType: 'OAUTH' }, new UnauthorizedError())).toEqual({
      status: 'NEEDS_RECONNECT',
      error: 'Fathom needs you to sign in again',
    });
  });

  it('keeps the connection when the token endpoint is only unavailable', () => {
    expect(describeFailure({ provider: 'granola', authType: 'OAUTH' }, new OAuthError(OAuthErrorCode.TemporarilyUnavailable, 'down'))).toEqual({
      status: 'ERROR',
      error: "Couldn't refresh the Granola sign-in (temporarily_unavailable). Source will try again.",
    });
  });

  it('keeps response bodies out of the message', () => {
    const failure = describeFailure(key, http(502, '<html>upstream said something about Priya</html>'));
    expect(failure).toEqual({ status: 'ERROR', error: 'Fireflies answered with HTTP 502. Source will try again.' });
  });
});

describe('matching a meeting to an interview', () => {
  const iv = (id: string, minutes: number, emails: string[] = []): InterviewForMatch => ({
    id,
    opportunityId: `opp-${id}`,
    title: 'Interview',
    startAt: new Date(T.getTime() + minutes * MIN),
    candidateEmails: emails,
  });

  it('attaches when a candidate email is among the attendees (any case)', () => {
    const match = matchMeeting({ startAt: T, attendees: [{ email: 'priya@example.com' }] }, [iv('a', 10, ['Priya@Example.com']), iv('b', 2)]);
    expect(match).toEqual({ kind: 'attach', reason: 'email', interview: expect.objectContaining({ id: 'a' }) });
  });

  it('suggests the closest interview when only the time lines up', () => {
    const match = matchMeeting({ startAt: T, attendees: [{ email: 'someone@else.test' }] }, [iv('a', 25), iv('b', -5)]);
    expect(match).toEqual({ kind: 'suggest', reason: 'time', interview: expect.objectContaining({ id: 'b' }) });
  });

  it("only suggests on the candidate's full name, naming that interview and the reason: two people can share a name", () => {
    const named = { ...iv('a', 20), candidateName: 'Priya  Nair' };
    // The name picks its interview over a closer one, but never attaches.
    expect(matchMeeting({ startAt: T, attendees: [{ name: 'Adam' }, { name: 'priya nair' }] }, [iv('b', 2), named])).toEqual({
      kind: 'suggest',
      reason: 'name',
      interview: expect.objectContaining({ id: 'a' }),
    });
    // An email still wins over a name.
    expect(
      matchMeeting({ startAt: T, attendees: [{ name: 'Priya Nair' }, { email: 'sam@example.com' }] }, [named, iv('c', 25, ['sam@example.com'])]),
    ).toMatchObject({ kind: 'attach', reason: 'email', interview: { id: 'c' } });
    // A first name alone, or a one-word candidate name, is only the time.
    expect(matchMeeting({ startAt: T, attendees: [{ name: 'Priya' }] }, [named])).toMatchObject({ kind: 'suggest', reason: 'time' });
    expect(matchMeeting({ startAt: T, attendees: [{ name: 'Priya' }] }, [{ ...iv('b', 5), candidateName: 'Priya' }])).toMatchObject({
      kind: 'suggest',
      reason: 'time',
    });
  });

  it('ignores meetings more than 30 minutes from every interview', () => {
    expect(matchMeeting({ startAt: T, attendees: [{ email: 'priya@example.com' }] }, [iv('a', 31, ['priya@example.com'])])).toBeNull();
    expect(matchMeeting({ startAt: T, attendees: [] }, [])).toBeNull();
  });
});
