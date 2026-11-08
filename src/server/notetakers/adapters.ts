import type { NotetakerProviderId } from '@/lib/notetaker-providers';
import {
  describeShape,
  idOf,
  isObj,
  nextCursorOf,
  normalizeMeeting,
  recordsOf,
  ToolOutputError,
  transcriptTextOf,
  type DurationUnit,
  type NormalizedMeeting,
} from '@/server/notetakers/parse';

/**
 * One adapter per notetaker. Each reads `tools/list` at run time and picks
 * its tools by name (falling back to a pattern, since display names drift),
 * fits its arguments to the tool's declared input schema, and hands what
 * comes back to the defensive parsers in parse.ts. Tool names and argument
 * names are from each provider's MCP server and docs as of 2026-09-25; the
 * output shapes are not documented anywhere, so nothing here assumes one.
 */

/** The parts of an MCP Tool definition an adapter reads. */
export type ToolDef = {
  name: string;
  inputSchema?: { properties?: Record<string, unknown>; required?: string[] } | Record<string, unknown>;
};

/** Calls a tool and returns its payload (see toolPayload). */
export type ToolCaller = (tool: string, args: Record<string, unknown>) => Promise<unknown>;

export type SyncWindow = { from: Date; to: Date };

export type NotetakerAdapter = {
  /** Picks this adapter's tools from tools/list. Throws MissingToolsError. */
  resolve(tools: ToolDef[]): void;
  /** Meetings in the window (or around it, where the provider only takes whole days). */
  list(call: ToolCaller, window: SyncWindow, deadline: number): Promise<NormalizedMeeting[]>;
  /** Fills in attendees for meetings the list returned without them. */
  details?(call: ToolCaller, meetings: NormalizedMeeting[], deadline: number): Promise<NormalizedMeeting[]>;
  /** The meeting's transcript text, or null when there isn't one (yet). */
  transcript(call: ToolCaller, meeting: { externalId: string; startAt: Date }): Promise<string | null>;
};

export class MissingToolsError extends Error {
  constructor(provider: string, what: string, tools: ToolDef[]) {
    const names = tools.map((t) => t.name).filter((n) => /^[\w.-]{1,64}$/.test(n));
    super(`${provider}'s MCP server has no ${what}${names.length ? ` (it offers ${names.slice(0, 12).join(', ')})` : ''}`);
    this.name = 'MissingToolsError';
  }
}

/** Every provider asks why a tool is being called in some form; this is the answer. */
export const INTENT = 'Find interview recordings to attach to the matching interviews in Orqestra';

const MAX_PAGES = 10;
const DAY = 86_400_000;

// ---------- tool and argument helpers ----------

export function pickTool(tools: ToolDef[], names: string[], fallback?: RegExp): ToolDef | null {
  for (const name of names) {
    const hit = tools.find((t) => t.name.toLowerCase() === name.toLowerCase());
    if (hit) return hit;
  }
  return fallback ? (tools.find((t) => fallback.test(t.name)) ?? null) : null;
}

function schemaOf(tool: ToolDef): { properties: Record<string, unknown> | null; required: string[] } {
  const s = (tool.inputSchema ?? {}) as { properties?: unknown; required?: unknown };
  const properties = isObj(s.properties) && Object.keys(s.properties).length ? s.properties : null;
  const required = Array.isArray(s.required) ? s.required.filter((r): r is string => typeof r === 'string') : [];
  return { properties, required };
}

/**
 * The arguments this tool takes: only the ones its schema declares (when it
 * declares any), plus harmless answers for required ones we'd otherwise
 * miss — an intent or reason, an empty search query.
 */
export function fitArgs(tool: ToolDef, args: Record<string, unknown>): Record<string, unknown> {
  const { properties, required } = schemaOf(tool);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined) continue;
    if (!properties || k in properties) out[k] = v;
  }
  for (const r of required) {
    if (r in out) continue;
    if (/intent|reason|purpose/i.test(r)) out[r] = INTENT;
    else if (/^(query|q|search|keywords?|search_?term)$/i.test(r)) out[r] = '';
  }
  return out;
}

/** The first of `candidates` the tool's schema declares, else the first candidate. */
export function argName(tool: ToolDef, candidates: string[]): string {
  const { properties } = schemaOf(tool);
  return (properties && candidates.find((c) => c in properties)) || candidates[0];
}

export type DateFormat = 'iso' | 'ymd' | 'ymd-slash';

function ymd(d: Date, sep = '-'): string {
  return d.toISOString().slice(0, 10).replaceAll('-', sep);
}

/**
 * A date argument in the format the tool's schema asks for (its `format`,
 * `pattern`, or an example in the description), else `fallback`.
 */
export function dateArg(tool: ToolDef, prop: string, date: Date, fallback: DateFormat): string {
  const { properties } = schemaOf(tool);
  const spec = properties?.[prop];
  let format = fallback;
  if (isObj(spec)) {
    const hint = `${spec.pattern ?? ''} ${spec.description ?? ''}`;
    if (spec.format === 'date-time' || /ISO ?8601|date-time|THH|HH:mm/i.test(hint)) format = 'iso';
    else if (/YYYY\/MM\/DD|\\d\{4\}\/\\d/i.test(hint)) format = 'ymd-slash';
    else if (spec.format === 'date' || /YYYY-MM-DD|\\d\{4\}-\\d/i.test(hint)) format = 'ymd';
  }
  return format === 'iso' ? date.toISOString() : format === 'ymd-slash' ? ymd(date, '/') : ymd(date);
}

function need(tool: ToolDef | null, provider: string, what: string, tools: ToolDef[]): ToolDef {
  if (!tool) throw new MissingToolsError(provider, what, tools);
  return tool;
}

/**
 * Normalises a page of records. A page whose records all fail to normalise
 * is a shape we don't understand: say so rather than silently find nothing.
 */
function normalizePage(records: Record<string, unknown>[], what: string, unit?: DurationUnit): NormalizedMeeting[] {
  const out = records.map((r) => normalizeMeeting(r, { durationUnit: unit })).filter((m): m is NormalizedMeeting => m !== null);
  if (records.length && !out.length) {
    const missing = records.some((r) => idOf(r)) ? 'a start time' : 'an id';
    throw new ToolOutputError(`Couldn't read the ${what}: its entries have no ${missing} (${describeShape(records[0])})`);
  }
  return out;
}

/** Adds what `details` records say (attendees, end time) to the meetings with the same id. */
export function mergeDetails(meetings: NormalizedMeeting[], detailRecords: Record<string, unknown>[], unit?: DurationUnit): NormalizedMeeting[] {
  const byId = new Map<string, Record<string, unknown>>();
  for (const r of detailRecords) {
    const id = idOf(r);
    if (id) byId.set(id, r);
  }
  return meetings.map((m) => {
    const record = byId.get(m.externalId);
    if (!record) return m;
    // Detail records needn't repeat the start time; the listed one stands in.
    const d = normalizeMeeting({ start_time: m.startAt.toISOString(), ...record }, { durationUnit: unit });
    if (!d) return m;
    return {
      ...m,
      title: m.title || d.title,
      endAt: m.endAt ?? d.endAt,
      attendees: m.attendees.length ? m.attendees : d.attendees,
    };
  });
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ---------- providers ----------

/** Fireflies: list with fireflies_get_transcripts (whole days, skip/limit), read with fireflies_get_transcript. */
function fireflies(): NotetakerAdapter {
  let list!: ToolDef;
  let get!: ToolDef;
  return {
    resolve(tools) {
      list = need(pickTool(tools, ['fireflies_get_transcripts', 'get_transcripts'], /get_transcripts$/i), 'Fireflies', 'tool that lists transcripts', tools);
      get = need(pickTool(tools, ['fireflies_get_transcript', 'get_transcript'], /get_transcript$/i), 'Fireflies', 'tool that reads a transcript', tools);
    },
    async list(call, window, deadline) {
      const out: NormalizedMeeting[] = [];
      const limit = 50;
      for (let page = 0, skip = 0; page < MAX_PAGES && Date.now() < deadline; page++) {
        const payload = await call(
          list.name,
          fitArgs(list, {
            fromDate: dateArg(list, 'fromDate', window.from, 'ymd'),
            // The day after, so a toDate that excludes its own day still covers today.
            toDate: dateArg(list, 'toDate', new Date(window.to.getTime() + DAY), 'ymd'),
            limit,
            skip,
            format: 'json',
          }),
        );
        const records = recordsOf(payload, 'Fireflies transcript list');
        out.push(...normalizePage(records, 'Fireflies transcript list', 'minutes'));
        if (records.length < limit) break;
        skip += records.length;
      }
      return out;
    },
    async transcript(call, meeting) {
      const payload = await call(get.name, fitArgs(get, { [argName(get, ['transcriptId', 'transcript_id', 'id'])]: meeting.externalId, format: 'json' }));
      return transcriptTextOf(payload, meeting.externalId);
    },
  };
}

/** Fathom: list_meetings by recording creation time (cursor pages), get_meeting_transcript by recording_id. */
function fathom(): NotetakerAdapter {
  let list!: ToolDef;
  let get!: ToolDef;
  return {
    resolve(tools) {
      list = need(pickTool(tools, ['list_meetings'], /list.*meetings?$/i), 'Fathom', 'tool that lists meetings', tools);
      get = need(pickTool(tools, ['get_meeting_transcript'], /transcript/i), 'Fathom', 'tool that reads a transcript', tools);
    },
    async list(call, window, deadline) {
      const out: NormalizedMeeting[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < MAX_PAGES && Date.now() < deadline; page++) {
        const payload: unknown = await call(
          list.name,
          fitArgs(list, {
            created_after: dateArg(list, 'created_after', window.from, 'iso'),
            created_before: dateArg(list, 'created_before', window.to, 'iso'),
            include_summary: false,
            include_transcript: false,
            ...(cursor ? { cursor } : {}),
          }),
        );
        out.push(...normalizePage(recordsOf(payload, 'Fathom meeting list'), 'Fathom meeting list', 'seconds'));
        const next = nextCursorOf(payload);
        if (!next || next === cursor) break;
        cursor = next;
      }
      return out;
    },
    async transcript(call, meeting) {
      const payload = await call(get.name, fitArgs(get, { [argName(get, ['recording_id', 'recordingId', 'id'])]: meeting.externalId }));
      return transcriptTextOf(payload, meeting.externalId);
    },
  };
}

/**
 * Metaview: search_conversations. Its date-filter field ids aren't
 * documented, so it's asked for the latest conversations and the window is
 * applied here; the transcript is read by asking for the transcript field
 * and picking the conversation by id.
 */
function metaview(): NotetakerAdapter {
  let search!: ToolDef;
  return {
    resolve(tools) {
      search = need(pickTool(tools, ['search_conversations'], /search.*conversations?|conversations?.*search/i), 'Metaview', 'tool that searches conversations', tools);
    },
    async list(call, window) {
      const payload = await call(search.name, fitArgs(search, { filters: [], limit: 50 }));
      const meetings = normalizePage(recordsOf(payload, 'Metaview conversation list'), 'Metaview conversation list');
      const from = window.from.getTime() - DAY;
      const to = window.to.getTime() + DAY;
      return meetings.filter((m) => m.startAt.getTime() >= from && m.startAt.getTime() <= to);
    },
    async transcript(call, meeting) {
      const payload = await call(search.name, fitArgs(search, { filters: [], fields: ['default:transcript'], limit: 50 }));
      return transcriptTextOf(payload, meeting.externalId);
    },
  };
}

/** Granola: list_meetings over a custom range, get_meetings for attendees, get_meeting_transcript (paid plans). */
function granola(): NotetakerAdapter {
  let list!: ToolDef;
  let details: ToolDef | null = null;
  let get!: ToolDef;
  return {
    resolve(tools) {
      list = need(pickTool(tools, ['list_meetings'], /list.*meetings?$/i), 'Granola', 'tool that lists meetings', tools);
      details = pickTool(tools, ['get_meetings'], /^get_meetings$/i);
      get = need(pickTool(tools, ['get_meeting_transcript'], /transcript/i), 'Granola', 'tool that reads a transcript', tools);
    },
    async list(call, window) {
      const payload = await call(
        list.name,
        fitArgs(list, {
          time_range: 'custom',
          custom_start: dateArg(list, 'custom_start', window.from, 'iso'),
          custom_end: dateArg(list, 'custom_end', window.to, 'iso'),
        }),
      );
      return normalizePage(recordsOf(payload, 'Granola meeting list'), 'Granola meeting list');
    },
    async details(call, meetings, deadline) {
      if (!details) return meetings;
      let out = meetings;
      for (const batch of chunks(meetings, 10)) {
        if (Date.now() > deadline) break;
        const payload = await call(details.name, fitArgs(details, { [argName(details, ['meeting_ids', 'meetingIds', 'ids'])]: batch.map((m) => m.externalId) }));
        out = mergeDetails(out, recordsOf(payload, 'Granola meeting details'));
      }
      return out;
    },
    async transcript(call, meeting) {
      const payload = await call(get.name, fitArgs(get, { [argName(get, ['meeting_id', 'meetingId', 'id'])]: meeting.externalId }));
      return transcriptTextOf(payload, meeting.externalId);
    },
  };
}

/**
 * Otter: search (whole days, "YYYY/MM/DD", cursor pages) and fetch. Search
 * results in the OpenAI search/fetch style may carry no date; those are
 * fetched (up to a cap) to learn it, and what fetch returned is kept for
 * this run so a matched meeting isn't fetched twice.
 */
function otter(): NotetakerAdapter {
  let search!: ToolDef;
  let fetchTool!: ToolDef;
  const fetched = new Map<string, unknown>();
  const HYDRATE_CAP = 25;
  const fetchOne = async (call: ToolCaller, id: string) => {
    if (fetched.has(id)) return fetched.get(id);
    const payload = await call(fetchTool.name, fitArgs(fetchTool, { [argName(fetchTool, ['id', 'speech_id', 'otid'])]: id }));
    fetched.set(id, payload);
    return payload;
  };
  return {
    resolve(tools) {
      search = need(pickTool(tools, ['otter_search', 'search'], /search/i), 'Otter', 'search tool', tools);
      fetchTool = need(pickTool(tools, ['otter_fetch', 'fetch'], /fetch/i), 'Otter', 'fetch tool', tools);
    },
    async list(call, window, deadline) {
      const out: NormalizedMeeting[] = [];
      const undated: Record<string, unknown>[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < MAX_PAGES && Date.now() < deadline; page++) {
        const payload: unknown = await call(
          search.name,
          fitArgs(search, {
            query: '',
            created_after: dateArg(search, 'created_after', window.from, 'ymd-slash'),
            created_before: dateArg(search, 'created_before', new Date(window.to.getTime() + DAY), 'ymd-slash'),
            page_size: 25,
            ...(cursor ? { cursor } : {}),
          }),
        );
        for (const r of recordsOf(payload, 'Otter search results')) {
          const m = normalizeMeeting(r);
          if (m) out.push(m);
          else if (idOf(r)) undated.push(r);
        }
        const next = nextCursorOf(payload);
        if (!next || next === cursor) break;
        cursor = next;
      }
      for (const r of undated.slice(0, HYDRATE_CAP)) {
        if (Date.now() > deadline) break;
        const payload = await fetchOne(call, idOf(r)!);
        const full = isObj(payload) ? { ...r, ...(isObj(payload.metadata) ? payload.metadata : {}), ...payload } : r;
        const m = normalizeMeeting(full);
        if (m) out.push(m);
      }
      if (!out.length && undated.length) {
        throw new ToolOutputError(`Couldn't read the Otter search results: its entries have no start time (${describeShape(undated[0])})`);
      }
      return out;
    },
    async transcript(call, meeting) {
      return transcriptTextOf(await fetchOne(call, meeting.externalId), meeting.externalId);
    },
  };
}

/** Circleback: SearchMeetings (whole days, page index), ReadMeetings for attendees, GetTranscriptsForMeetings. */
function circleback(): NotetakerAdapter {
  let search!: ToolDef;
  let read: ToolDef | null = null;
  let get!: ToolDef;
  return {
    resolve(tools) {
      search = need(pickTool(tools, ['SearchMeetings', 'search_meetings'], /search.*meetings?/i), 'Circleback', 'tool that searches meetings', tools);
      read = pickTool(tools, ['ReadMeetings', 'read_meetings'], /read.*meetings?/i);
      get = need(pickTool(tools, ['GetTranscriptsForMeetings', 'get_transcripts_for_meetings'], /transcripts?/i), 'Circleback', 'tool that reads transcripts', tools);
    },
    async list(call, window, deadline) {
      const out: NormalizedMeeting[] = [];
      const seen = new Set<string>();
      for (let pageIndex = 0; pageIndex < MAX_PAGES && Date.now() < deadline; pageIndex++) {
        const payload = await call(
          search.name,
          fitArgs(search, {
            intent: INTENT,
            pageIndex,
            startDate: dateArg(search, 'startDate', window.from, 'ymd'),
            endDate: dateArg(search, 'endDate', new Date(window.to.getTime() + DAY), 'ymd'),
          }),
        );
        const page = normalizePage(recordsOf(payload, 'Circleback meeting list'), 'Circleback meeting list');
        const fresh = page.filter((m) => !seen.has(m.externalId));
        if (!fresh.length) break;
        for (const m of fresh) seen.add(m.externalId);
        out.push(...fresh);
      }
      return out;
    },
    async details(call, meetings, deadline) {
      if (!read) return meetings;
      let out = meetings;
      for (const batch of chunks(meetings, 10)) {
        if (Date.now() > deadline) break;
        const payload = await call(read.name, fitArgs(read, { intent: INTENT, meetingIds: batch.map((m) => m.externalId) }));
        out = mergeDetails(out, recordsOf(payload, 'Circleback meeting details'));
      }
      return out;
    },
    async transcript(call, meeting) {
      const payload = await call(get.name, fitArgs(get, { intent: INTENT, meetingIds: [meeting.externalId] }));
      return transcriptTextOf(payload, meeting.externalId);
    },
  };
}

/**
 * Walkie: list_meetings (newest first, limit/offset) and get_meeting. Its
 * shapes are known exactly (stt-proxy/src/mcp.ts in the walkie repo), so
 * they're read directly: meetings are { id, title, when (ISO), minutes,
 * participants (names, not emails) }, and get_meeting's `transcript` is the
 * speaker-labelled transcript alone, without Walkie's notes. A connection
 * granted without transcript access gets a placeholder there instead.
 */
export const WALKIE_TRANSCRIPT_OFF = '[transcript access is off for this endpoint]';

function walkie(): NotetakerAdapter {
  let list!: ToolDef;
  let get!: ToolDef;
  const LIMIT = 100;
  return {
    resolve(tools) {
      list = need(pickTool(tools, ['list_meetings']), 'Walkie', 'tool that lists meetings', tools);
      get = need(pickTool(tools, ['get_meeting', 'fetch']), 'Walkie', 'tool that reads a meeting', tools);
    },
    async list(call, window, deadline) {
      const out: NormalizedMeeting[] = [];
      for (let page = 0, offset = 0; page < MAX_PAGES && Date.now() < deadline; page++) {
        const payload = await call(list.name, fitArgs(list, { limit: LIMIT, offset }));
        const rows = isObj(payload) && Array.isArray(payload.meetings) ? payload.meetings : null;
        if (!rows) throw new ToolOutputError(`Couldn't read Walkie's meeting list (${describeShape(payload)})`);
        let older = false;
        for (const row of rows) {
          const m = walkieMeeting(row);
          if (!m) continue;
          if (m.startAt.getTime() < window.from.getTime()) older = true;
          else if (m.startAt.getTime() <= window.to.getTime()) out.push(m);
        }
        // Newest first: once a page reaches past the window, the rest is older still.
        const next = isObj(payload) && typeof payload.next_offset === 'number' ? payload.next_offset : null;
        if (older || next === null || !rows.length) break;
        offset = next;
      }
      return out;
    },
    async transcript(call, meeting) {
      const payload = await call(get.name, fitArgs(get, { id: meeting.externalId }));
      if (isObj(payload) && payload.error === 'meeting_not_found') return null;
      const text = isObj(payload) && typeof payload.transcript === 'string' ? payload.transcript.trim() : '';
      if (text === WALKIE_TRANSCRIPT_OFF) {
        throw new ToolOutputError('Walkie is sharing this connection without transcripts. Reconnect and allow transcript access.');
      }
      return text || null;
    },
  };
}

/** One Walkie list entry, or null when it lacks an id or a start time. */
export function walkieMeeting(row: unknown): NormalizedMeeting | null {
  if (!isObj(row) || typeof row.id !== 'string' || typeof row.when !== 'string') return null;
  const startAt = new Date(row.when);
  if (Number.isNaN(startAt.getTime()) || startAt.getTime() <= 0) return null;
  const minutes = typeof row.minutes === 'number' && row.minutes > 0 ? row.minutes : null;
  const names = Array.isArray(row.participants) ? row.participants.filter((p): p is string => typeof p === 'string' && p.trim() !== '') : [];
  return {
    externalId: row.id,
    title: typeof row.title === 'string' && row.title.trim() ? row.title.trim() : 'Walkie meeting',
    startAt,
    ...(minutes ? { endAt: new Date(startAt.getTime() + minutes * 60_000) } : {}),
    attendees: names.map((name) => ({ name: name.trim() })),
  };
}

const FACTORIES: Record<NotetakerProviderId, () => NotetakerAdapter> = {
  fireflies,
  fathom,
  metaview,
  granola,
  otter,
  circleback,
  walkie,
};

/** A fresh adapter for one session (adapters keep per-run state, like Otter's fetch cache). */
export function createAdapter(provider: string): NotetakerAdapter {
  const factory = FACTORIES[provider as NotetakerProviderId];
  if (!factory) throw new Error(`Unknown notetaker: ${provider}`);
  return factory();
}
