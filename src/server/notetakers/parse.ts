/**
 * Reading what notetaker MCP tools return. No provider documents its output
 * precisely, so everything here is defensive: take `structuredContent` when
 * the server sends it, else JSON in the text content, else the text itself,
 * then look for the fields under the names providers are known (or likely)
 * to use. Pure functions, unit-tested in tests/notetaker-adapters.test.ts.
 *
 * Errors raised here describe the *shape* of a payload (its top-level keys,
 * array lengths), never its values: they end up in the connection's
 * lastError, which must not hold meeting titles or transcript text.
 */

export type NormalizedAttendee = { email?: string; name?: string };

export type NormalizedMeeting = {
  externalId: string;
  title: string;
  startAt: Date;
  endAt?: Date;
  attendees: NormalizedAttendee[];
};

type Obj = Record<string, unknown>;

/** A tool reported an error (isError). The message is the provider's, trimmed. */
export class ToolCallError extends Error {
  constructor(
    readonly tool: string,
    message: string,
  ) {
    super(message);
    this.name = 'ToolCallError';
  }
}

/** A tool answered with something we couldn't read. The message describes its shape only. */
export class ToolOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolOutputError';
  }
}

/** The parts of an MCP CallToolResult this module reads. */
export type ToolResultLike = {
  content?: unknown;
  structuredContent?: unknown;
  isError?: boolean;
};

export function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Collapse whitespace and cut to `max`: safe to store as an error message. */
export function clip(text: string, max = 240): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function textBlocks(result: ToolResultLike): string[] {
  const blocks = Array.isArray(result.content) ? result.content : [];
  const out: string[] = [];
  for (const b of blocks) {
    if (!isObj(b)) continue;
    if (b.type === 'text' && typeof b.text === 'string') out.push(b.text);
    else if (b.type === 'resource' && isObj(b.resource) && typeof b.resource.text === 'string') out.push(b.resource.text);
  }
  return out;
}

/** JSON when the text is JSON (bare or in a ```json fence), else the text. */
export function parseMaybeJson(text: string): unknown {
  let t = text.trim();
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/i.exec(t);
  if (fence) t = fence[1].trim();
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      return JSON.parse(t);
    } catch {
      // not JSON after all: fall through to the text
    }
  }
  return text;
}

/**
 * What a tool call returned, as one value: structured content, else JSON
 * parsed from the text content (an array when several blocks are each
 * JSON), else the plain text. Throws ToolCallError on isError.
 */
export function toolPayload(tool: string, result: ToolResultLike): unknown {
  const texts = textBlocks(result);
  if (result.isError) throw new ToolCallError(tool, clip(texts.join(' ') || 'The tool reported an error', 200));
  if (result.structuredContent !== undefined && result.structuredContent !== null) return result.structuredContent;
  if (!texts.length) return null;
  if (texts.length === 1) return parseMaybeJson(texts[0]);
  const parsed = texts.map(parseMaybeJson);
  if (parsed.every((p) => typeof p === 'object' && p !== null)) return parsed.flat();
  return texts.join('\n\n');
}

/** "an object with keys items, next_cursor" — for error messages; never values. */
export function describeShape(payload: unknown): string {
  if (payload === null || payload === undefined) return 'nothing';
  if (typeof payload === 'string') return `plain text (${payload.length} characters)`;
  if (Array.isArray(payload)) return `a list of ${payload.length}`;
  if (isObj(payload)) {
    const keys = Object.keys(payload).filter((k) => /^[A-Za-z_][\w-]{0,40}$/.test(k));
    return keys.length ? `an object with keys ${keys.slice(0, 8).join(', ')}` : 'an object';
  }
  return typeof payload;
}

// ---------- field lookup ----------

function first(o: Obj, keys: readonly string[]): unknown {
  for (const k of keys) {
    const v = o[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

const ID_KEYS = [
  'id',
  'recording_id',
  'recordingId',
  'meeting_id',
  'meetingId',
  'transcript_id',
  'transcriptId',
  'conversation_id',
  'conversationId',
  'call_id',
  'callId',
  'note_id',
  'document_id',
  'otid',
  'speech_id',
  'uuid',
] as const;

const TITLE_KEYS = ['title', 'meeting_title', 'meetingTitle', 'name', 'subject', 'topic'] as const;

const START_KEYS = [
  'scheduled_start_time',
  'scheduledStartTime',
  'start_time',
  'startTime',
  'started_at',
  'startedAt',
  'start_at',
  'startAt',
  'start',
  'recording_start_time',
  'recordingStartTime',
  'dateString',
  'date',
  'datetime',
  'meeting_date',
  'meetingDate',
  'created_at',
  'createdAt',
  'created',
] as const;

const END_KEYS = [
  'scheduled_end_time',
  'scheduledEndTime',
  'end_time',
  'endTime',
  'ended_at',
  'endedAt',
  'end_at',
  'endAt',
  'end',
  'recording_end_time',
  'recordingEndTime',
] as const;

const PEOPLE_KEYS = [
  'attendees',
  'meeting_attendees',
  'meetingAttendees',
  'calendar_invitees',
  'calendarInvitees',
  'participants',
  'invitees',
  'guests',
  'people',
  'members',
  'attendee_emails',
  'attendeeEmails',
  'participant_emails',
  'participantEmails',
  'candidate',
  'candidates',
  'interviewers',
  'speakers',
] as const;

const PERSON_KEYS = [
  'organizer',
  'organizer_email',
  'organizerEmail',
  'host',
  'host_email',
  'hostEmail',
  'recorded_by',
  'recordedBy',
  'owner',
  'creator',
] as const;

export function idOf(o: Obj): string | null {
  const v = first(o, ID_KEYS);
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

const MIN_YEAR = 2000;
const MAX_YEAR = 2100;

/** A date from epoch ms or seconds, ISO text, "YYYY/MM/DD", or a { dateTime } object. */
export function parseDate(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === 'number' && Number.isFinite(v)) {
    const ms = v > 1e12 ? v : v > 1e9 ? v * 1000 : NaN;
    return inRange(new Date(ms));
  }
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;
    if (/^\d{10,13}(\.\d+)?$/.test(s)) return parseDate(Number(s));
    const slashed = /^(\d{4})\/(\d{2})\/(\d{2})(.*)$/.exec(s);
    const iso = slashed ? `${slashed[1]}-${slashed[2]}-${slashed[3]}${slashed[4]}` : s;
    return inRange(new Date(iso));
  }
  if (isObj(v)) return parseDate(first(v, ['dateTime', 'date_time', 'datetime', 'iso', 'date', 'value']));
  return null;
}

function inRange(d: Date): Date | null {
  const t = d.getTime();
  if (Number.isNaN(t)) return null;
  const y = d.getUTCFullYear();
  return y >= MIN_YEAR && y <= MAX_YEAR ? d : null;
}

const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;

export function normalizeEmail(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const e = v.trim().toLowerCase();
  return EMAIL.test(e) ? e : undefined;
}

/** One attendee entry: an email, "Name <email>", a list of emails in one string, or an object. */
function peopleFrom(v: unknown): NormalizedAttendee[] {
  if (Array.isArray(v)) return v.flatMap(peopleFrom);
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return [];
    const angled = /^(.*)<([^>]+)>$/.exec(s);
    if (angled) {
      const email = normalizeEmail(angled[2]);
      const name = angled[1].trim().replace(/^"|"$/g, '') || undefined;
      return email || name ? [{ ...(email ? { email } : {}), ...(name ? { name } : {}) }] : [];
    }
    if (s.includes('@')) {
      return s
        .split(/[,;\s]+/)
        .map(normalizeEmail)
        .filter((e): e is string => Boolean(e))
        .map((email) => ({ email }));
    }
    return [{ name: s }];
  }
  if (isObj(v)) {
    const email = normalizeEmail(first(v, ['email', 'email_address', 'emailAddress', 'mail', 'matched_calendar_invitee_email']));
    const rawName = first(v, ['name', 'display_name', 'displayName', 'full_name', 'fullName', 'speaker_name']);
    const name = typeof rawName === 'string' && rawName.trim() ? rawName.trim() : undefined;
    if (email || name) return [{ ...(email ? { email } : {}), ...(name ? { name } : {}) }];
  }
  return [];
}

export function attendeesOf(o: Obj): NormalizedAttendee[] {
  const all = [...PEOPLE_KEYS, ...PERSON_KEYS].flatMap((k) => (o[k] === undefined ? [] : peopleFrom(o[k])));
  const out: NormalizedAttendee[] = [];
  const seenEmail = new Set<string>();
  const seenName = new Set<string>();
  for (const a of all) {
    if (a.email) {
      if (seenEmail.has(a.email)) continue;
      seenEmail.add(a.email);
    } else if (a.name) {
      const key = a.name.toLowerCase();
      if (seenName.has(key)) continue;
      seenName.add(key);
    }
    out.push(a);
  }
  return out;
}

export type DurationUnit = 'minutes' | 'seconds';

function durationMs(o: Obj, unit?: DurationUnit): number | null {
  const mins = first(o, ['duration_minutes', 'durationMinutes', 'duration_mins']);
  if (typeof mins === 'number' && mins > 0) return mins * 60_000;
  const secs = first(o, ['duration_seconds', 'durationSeconds', 'duration_secs', 'duration_sec']);
  if (typeof secs === 'number' && secs > 0) return secs * 1000;
  const d = o.duration;
  if (typeof d !== 'number' || !(d > 0)) return null;
  // A bare number: the adapter says which unit; otherwise more than ten
  // hours of minutes is implausible, so large values are seconds.
  const asMinutes = unit ? unit === 'minutes' : d <= 600;
  return asMinutes ? d * 60_000 : d * 1000;
}

/** A provider's meeting record, normalised; null without an id or a start time. */
export function normalizeMeeting(raw: unknown, opts: { durationUnit?: DurationUnit } = {}): NormalizedMeeting | null {
  if (!isObj(raw)) return null;
  const externalId = idOf(raw);
  if (!externalId) return null;
  const startAt = parseDate(first(raw, START_KEYS));
  if (!startAt) return null;
  let endAt = parseDate(first(raw, END_KEYS)) ?? undefined;
  if (endAt && endAt < startAt) endAt = undefined;
  if (!endAt) {
    const ms = durationMs(raw, opts.durationUnit);
    if (ms) endAt = new Date(startAt.getTime() + ms);
  }
  const t = first(raw, TITLE_KEYS);
  const title = typeof t === 'string' ? clip(t, 300) : '';
  return { externalId, title, startAt, ...(endAt ? { endAt } : {}), attendees: attendeesOf(raw) };
}

// ---------- lists ----------

const LIST_KEYS = [
  'items',
  'meetings',
  'transcripts',
  'results',
  'conversations',
  'recordings',
  'records',
  'documents',
  'calls',
  'notes',
  'speeches',
  'hits',
  'edges',
  'nodes',
  'entries',
  'data',
  'list',
] as const;

function looksLikeMeeting(o: Obj): boolean {
  return idOf(o) !== null && first(o, START_KEYS) !== undefined;
}

/** GraphQL connections wrap each record in { node }. */
function unwrap(o: Obj): Obj {
  return isObj(o.node) ? o.node : o;
}

/**
 * The meeting records in a list payload, wherever they sit: a bare array,
 * `{ items }`, `{ data: { transcripts } }`, GraphQL edges… Null when there's
 * no list at all (an empty list is []).
 */
export function findRecords(payload: unknown, depth = 0): Obj[] | null {
  if (depth > 4) return null;
  if (Array.isArray(payload)) {
    const objs = payload.filter(isObj);
    if (payload.length && !objs.length) return null;
    return objs.map(unwrap);
  }
  if (!isObj(payload)) return null;
  for (const key of LIST_KEYS) {
    if (!(key in payload)) continue;
    const found = findRecords(payload[key], depth + 1);
    if (found) return found;
  }
  if (looksLikeMeeting(payload)) return [payload];
  for (const v of Object.values(payload)) {
    if (Array.isArray(v) && v.some(isObj)) {
      const found = findRecords(v, depth + 1);
      if (found) return found;
    }
  }
  for (const v of Object.values(payload)) {
    if (isObj(v)) {
      const found = findRecords(v, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Plain-text meeting lists, for servers that answer in prose rather than
 * JSON: XML-ish `<meeting id="…" title="…" date="…">` tags, or blocks of
 * "Key: value" lines separated by blank lines. Records here have string
 * values only; normalizeMeeting reads them like any other.
 */
export function recordsFromText(text: string): Obj[] {
  const out: Obj[] = [];
  const tag = /<(meeting|note|document|transcript|conversation)\b([^>]*)>([\s\S]*?)<\/\1>|<(meeting|note|document|transcript|conversation)\b([^>]*)\/>/gi;
  for (const m of text.matchAll(tag)) {
    const attrs = m[2] ?? m[5] ?? '';
    const body = m[3] ?? '';
    const rec: Obj = {};
    for (const a of attrs.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) rec[a[1]] = a[2];
    const emails = body.match(/[^\s<>"'(),;:]+@[^\s<>"'(),;:]+\.[A-Za-z]{2,}/g);
    if (emails) rec.attendees = emails;
    const title = /<title>([\s\S]*?)<\/title>/i.exec(body);
    if (title && !rec.title) rec.title = title[1].trim();
    if (idOf(rec)) out.push(rec);
  }
  if (out.length) return out;
  for (const block of text.split(/\n\s*\n/)) {
    const rec: Obj = {};
    for (const line of block.split('\n')) {
      const kv = /^\s*[-*]?\s*\**([A-Za-z][\w ]{0,30}?)\**\s*:\s*(.+)$/.exec(line);
      if (!kv) continue;
      const key = kv[1].trim().toLowerCase().replace(/\s+/g, '_');
      rec[key === 'meeting_id' || key === 'identifier' ? 'id' : key] = kv[2].trim();
    }
    if (idOf(rec)) out.push(rec);
  }
  return out;
}

/** Records from any list payload, or a ToolOutputError naming its shape. */
export function recordsOf(payload: unknown, what: string): Obj[] {
  if (typeof payload === 'string') {
    const recs = recordsFromText(payload);
    if (recs.length || !payload.trim() || /\bno (meetings|results|transcripts|notes|conversations)\b/i.test(payload)) return recs;
    throw new ToolOutputError(`Couldn't read the ${what}: the server sent ${describeShape(payload)}`);
  }
  if (payload === null || payload === undefined) return [];
  const recs = findRecords(payload);
  if (!recs) throw new ToolOutputError(`Couldn't read the ${what}: the server sent ${describeShape(payload)}`);
  return recs;
}

/** The cursor for the next page, if the payload names one. */
export function nextCursorOf(payload: unknown): string | null {
  if (!isObj(payload)) return null;
  const direct = first(payload, ['next_cursor', 'nextCursor', 'cursor', 'next_page_token', 'nextPageToken', 'next']);
  if (typeof direct === 'string' && direct.trim()) return direct;
  if (typeof direct === 'number') return String(direct);
  for (const k of ['pagination', 'page_info', 'pageInfo', 'meta']) {
    const inner = payload[k];
    if (isObj(inner)) {
      const hasNext = inner.hasNextPage ?? inner.has_next_page ?? inner.has_more ?? inner.hasMore;
      const c = first(inner, ['next_cursor', 'nextCursor', 'endCursor', 'end_cursor', 'cursor']);
      if (hasNext !== false && (typeof c === 'string' || typeof c === 'number') && String(c).trim()) return String(c);
    }
  }
  return null;
}

// ---------- transcripts ----------

const SENTENCE_KEYS = [
  'sentences',
  'segments',
  'utterances',
  'transcript',
  'transcripts',
  'entries',
  'lines',
  'paragraphs',
  'monologues',
  'turns',
  'dialogue',
  'messages',
] as const;

const TEXT_KEYS = [
  'transcript',
  'transcript_text',
  'transcriptText',
  'text',
  'content',
  'full_text',
  'fullText',
  'raw_text',
  'body',
  'markdown',
] as const;

const WRAPPER_KEYS = ['data', 'result', 'meeting', 'recording', 'conversation', 'document', 'transcript', 'note'] as const;

function speakerOf(o: Obj): string | null {
  const s = o.speaker;
  if (isObj(s)) {
    const n = first(s, ['display_name', 'displayName', 'name', 'full_name', 'email']);
    if (typeof n === 'string' && n.trim()) return n.trim();
  }
  const n = first(o, ['speaker_name', 'speakerName', 'speaker', 'speaker_label', 'speakerLabel', 'participant', 'name', 'author']);
  return typeof n === 'string' && n.trim() ? n.trim() : null;
}

function utteranceText(o: Obj): string | null {
  const t = first(o, ['text', 'raw_text', 'content', 'sentence', 'words', 'transcript', 'value']);
  return typeof t === 'string' && t.trim() ? t.trim() : null;
}

/** A line of speech rather than a meeting: it has words and no meeting title. */
function isUtterance(o: Obj): boolean {
  return utteranceText(o) !== null && first(o, ['title', 'meeting_title', 'meetingTitle', 'subject']) === undefined;
}

/** "Speaker: words" lines from utterance objects, consecutive turns merged. Null when they aren't utterances. */
function sentencesToText(items: unknown[]): string | null {
  const turns: { speaker: string | null; text: string }[] = [];
  let seen = 0;
  for (const item of items) {
    if (!isObj(item) || !isUtterance(item)) continue;
    const text = utteranceText(item);
    if (!text) continue;
    seen++;
    const speaker = speakerOf(item);
    const last = turns[turns.length - 1];
    if (last && last.speaker === speaker) last.text += ` ${text}`;
    else turns.push({ speaker, text });
  }
  if (!seen) return null;
  return turns.map((t) => (t.speaker ? `${t.speaker}: ${t.text}` : t.text)).join('\n');
}

function findById(payload: unknown, id: string, depth = 0): Obj | null {
  if (depth > 5) return null;
  if (Array.isArray(payload)) {
    for (const p of payload) {
      const hit = findById(p, id, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (!isObj(payload)) return null;
  if (idOf(payload) === id) return payload;
  for (const v of Object.values(payload)) {
    if (typeof v !== 'object' || v === null) continue;
    const hit = findById(v, id, depth + 1);
    if (hit) return hit;
  }
  return null;
}

/**
 * The transcript text in a payload: plain text, a string field, or a list
 * of utterances (speaker + text). `externalId` picks the right entry when a
 * tool returns several meetings' transcripts at once. Null when none.
 */
export function transcriptTextOf(payload: unknown, externalId?: string, depth = 0): string | null {
  if (depth > 5 || payload === null || payload === undefined) return null;
  if (typeof payload === 'string') return payload.trim() || null;
  if (externalId) {
    // The entry for this meeting, wherever it sits ({ conversations: [...] }, [{ meetingId }]…).
    const mine = findById(payload, externalId);
    if (mine && mine !== payload) return transcriptTextOf(mine, undefined, depth + 1);
  }
  if (Array.isArray(payload)) {
    const asSentences = sentencesToText(payload);
    if (asSentences) return asSentences;
    if (payload.length && payload.every((p) => typeof p === 'string')) return (payload as string[]).join('\n').trim() || null;
    // Several meetings' transcripts and none of them is this one: never guess.
    if (externalId && payload.some((p) => isObj(p) && idOf(p) !== null)) return null;
    if (payload.length === 1) return transcriptTextOf(payload[0], undefined, depth + 1);
    return null;
  }
  if (!isObj(payload)) return null;
  for (const key of SENTENCE_KEYS) {
    const v = payload[key];
    if (Array.isArray(v)) {
      const t = transcriptTextOf(v, externalId, depth + 1);
      if (t) return t;
    }
  }
  for (const key of TEXT_KEYS) {
    const v = payload[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  for (const key of WRAPPER_KEYS) {
    const v = payload[key];
    if (isObj(v)) {
      const t = transcriptTextOf(v, externalId, depth + 1);
      if (t) return t;
    }
  }
  return null;
}
