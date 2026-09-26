import { createHash } from 'crypto';
import type { Commitment, OfferStatus, Origin, StageType, WorkplaceType } from '@prisma/client';
import { ImportAuthError, ImportHttpError, type HttpClient, type QueryValue } from '@/server/imports/http';
import { nameKey } from '@/server/imports/mapping';
import { each, isRetryable, type PageCursor } from '@/server/imports/paging';
import { cleanEmails, cleanList, clip, fullName, htmlToText, toDate } from '@/server/imports/text';
import type {
  CatalogReason,
  Credentials,
  Cursor,
  DownloadedFile,
  ImportedCandidate,
  ImportedOffer,
  ImportedPosting,
  ImportedRequisition,
  JsonValue,
  Phase,
  PhaseContext,
  ProviderModule,
  ReasonKind,
  StageHistoryEntry,
  StageRef,
} from '@/server/imports/types';

/**
 * Greenhouse, through Harvest v3 (v1/v2 were switched off on 2026-08-31).
 *
 * - Auth is OAuth 2.0 client credentials: Basic(clientId:clientSecret) to
 *   auth.greenhouse.io/token mints a one-hour JWT for harvest.greenhouse.io.
 *   There are no refresh tokens; we mint again near expiry or on a 401. The
 *   token is cached in memory by a hash of the credential, so it outlives
 *   the slice (minting has its own rate window). The token host is never in
 *   `hosts`: the Basic header goes only where we send it, and the client
 *   drops it if that host redirects elsewhere. The JWT's
 *   `act["organization.name"]` claim is the account name (there is no
 *   organization endpoint), and its `scope` claim lists what the admin
 *   ticked, which we check up front.
 * - v3 is relational: flat org-wide lists joined by `*_id`, nothing embedded.
 *   The engine wants stage history, panels, answers and names inline, so the
 *   joins are lazy lookups batched 50 ids per call (Greenhouse's filter cap)
 *   from the row being handled onward.
 * - Pagination is cursor-based: follow `Link: <…>; rel="next"` verbatim (a
 *   cursor must be the only query param, or Greenhouse answers 422). Lists
 *   are id-descending, so a step that stops mid-page resumes below the last
 *   id it handled: rows that leave the page in between (rejected, deleted)
 *   would shift a position and hide an unhandled row. For the same reason,
 *   rows created during the crawl sit above its first page; each data list
 *   ends with a pass back down to where it began. Rows edited during the
 *   crawl keep the state they were read in (the engine never updates an
 *   imported record). A saved cursor Greenhouse no longer accepts restarts
 *   that list (refs dedupe).
 * - Stages are per job; discovery lists every job's plan and the engine
 *   groups them by name. Hired and prospect are statuses in Greenhouse, not
 *   stages, so discovery adds synthetic "Hired" and "Prospect" rows. There is
 *   no hired_at: the hire time is when the filled opening closed, else when
 *   the offer was accepted, else the last stage change.
 * - A missing scope fails one endpoint with 403 (or 401 even on a fresh
 *   token — the docs don't say which). Outside the core lists (jobs,
 *   candidates, applications) that becomes a warning and the data is skipped.
 * - The created-after filter is documented two ways (created_at=gte|… and
 *   created_at[gte]=…); we try both and keep the one that works. Filters we
 *   also apply after download (created-after, status, note type) are dropped
 *   if Greenhouse rejects them, and an id filter Greenhouse ignores is caught
 *   before it pages a whole table.
 * - Defaults that hide data are overridden: rejection reasons need
 *   include_defaults, users hide service accounts, job posts hide
 *   soft-deleted posts. Job templates are skipped. Neither requisition ids
 *   nor rejection-reason names are unique, so repeats are told apart before
 *   the engine would merge them.
 * - Notes Greenhouse shows only to admins are skipped (Source notes have no
 *   private setting); private notes and private scorecard notes come across
 *   labelled as such.
 * - Offers are versioned (current_only=true), carry pay only in custom
 *   fields (two undocumented value shapes), and come back as an empty list
 *   instead of a 403 when an act-as user lacks the private-data permission.
 * - Attachment URLs are signed and expire after 7 days; a failed download
 *   re-lists the attachment for a fresh URL and tries once more. A Greenhouse
 *   redirect host that refuses a download gets one retry with the bearer
 *   token, which never reaches the storage host it redirects to.
 * - harvest.greenhouse.io serves every silo. For support cases, a hidden
 *   `apiBaseUrl` credential (not on the connect form) can point the import at
 *   another https://*.greenhouse.io host.
 */

const DEFAULT_API_HOST = 'harvest.greenhouse.io';
const AUTH_HOST = 'auth.greenhouse.io';
const TOKEN_URL = `https://${AUTH_HOST}/token`;
const INTROSPECT_URL = `https://${AUTH_HOST}/introspect`;
/** `where` of token-endpoint failures: a real credentials problem, never a missing scope. */
const TOKEN_WHERE = `POST ${AUTH_HOST}/token`;
const PER_PAGE = 500;
/** Every Harvest id-list filter caps at 50 values. */
const MAX_IDS = 50;
/** Longest requisition code the loader keeps. */
const MAX_CODE = 60;

/** Synthetic stages: Greenhouse records these as application statuses. */
const HIRED_STAGE = { externalId: 'hired', name: 'Hired' } satisfies StageRef;
const PROSPECT_STAGE = { externalId: 'prospect', name: 'Prospect' } satisfies StageRef;

/** Imported as notes; FEEDBACK and INTERVIEW duplicate scorecards, ACTIVITY is system noise. */
const NOTE_TYPES: Record<string, string | null> = {
  NOTE: null,
  EMAIL: 'Email',
  LINKEDIN_NOTE: 'LinkedIn note',
  LINKEDIN_INMAIL: 'LinkedIn InMail',
  TOUCHPOINT: 'Touchpoint',
};
const OFFER_DOCUMENTS = new Set(['offer_packet', 'offer_letter', 'signed_offer_letter']);
const ADMIN_ONLY_SKIPPED =
  'Skipped Greenhouse notes visible only to admins: Source notes have no private setting, so anyone who can see the candidate would read them';

/** Focus-attribute ratings, which (unlike the overall scorecard rating) use definitely_not and mixed. */
const ATTRIBUTE_RATINGS: Record<string, string> = {
  definitely_not: 'Definitely not',
  strong_no: 'Definitely not',
  no: 'No',
  yes: 'Yes',
  strong_yes: 'Strong yes',
  mixed: 'Mixed',
  no_decision: '',
};

/** Scopes (harvest:<resource>:list) each part of the import reads. */
const SCOPES = {
  verify: ['jobs', 'candidates', 'applications'],
  core: [
    'users',
    'job_interview_stages',
    'rejection_reasons',
    'jobs',
    'openings',
    'job_posts',
    'job_post_locations',
    'job_board_custom_locations',
    'pay_inputs',
    'pay_input_ranges',
    'departments',
    'offices',
    'candidates',
    'applications',
    'application_stages',
    'prospect_details',
    'sources',
    'referrers',
  ],
  activity: [
    'notes',
    'interviews',
    'interviewers',
    'job_interviews',
    'interview_kits',
    'scorecards',
    'scorecard_question_answers',
    'scorecard_questions',
    'scorecard_question_options',
    'scorecard_candidate_attributes',
    'job_candidate_attributes',
  ],
  offers: ['offers'],
  files: ['attachments'],
};
const scopeName = (resource: string) => `harvest:${resource}:list`;

// ---------- Vendor payloads (only the fields we read) ----------

type GhId = number;
type Key = GhId | string | null | undefined;
type GhCustomField = { name?: string | null; type?: string | null; value?: unknown };
type GhCustomFields = Record<string, GhCustomField | null> | null;
type Typed = { value?: string | null; type?: string | null };

type GhUser = {
  id: GhId;
  first_name?: string | null;
  last_name?: string | null;
  name?: string | null;
  primary_email?: string | null;
  emails?: string[] | null;
};
type GhJobStage = { id: GhId; job_id: GhId; name: string; sort_order?: number | null };
type GhRejectionReason = { id: GhId; name: string; type?: { key?: string | null; name?: string | null } | null };
type GhJob = {
  id: GhId;
  name: string;
  requisition_id?: string | null;
  status?: string | null;
  confidential?: boolean | null;
  is_template?: boolean | null;
  department_id?: GhId | null;
  office_ids?: GhId[] | null;
  custom_fields?: GhCustomFields;
  created_at?: string | null;
};
type GhOpening = {
  id: GhId;
  job_id: GhId;
  open?: boolean | null;
  application_id?: GhId | null;
  closed_at?: string | null;
};
type GhJobPost = {
  id: GhId;
  job_id: GhId;
  title?: string | null;
  content?: string | null;
  internal?: boolean | null;
  active?: boolean | null;
  live?: boolean | null;
};
type GhPostLocation = {
  id: GhId;
  job_post_id?: GhId | null;
  plain_text_location?: string | null;
  office_id?: GhId | null;
  custom_location_id?: GhId | null;
};
type GhCustomLocation = { id: GhId; value?: string | null };
type GhPayInput = { id: GhId; title?: string | null; priority?: number | null };
type GhPayRange = {
  id: GhId;
  pay_input_id?: GhId | null;
  job_post_id: GhId;
  currency_type?: string | null;
  min_cents?: number | null;
  max_cents?: number | null;
};
type GhPlace = { id: GhId; name?: string | null; location?: string | null };
type GhSource = { id: GhId; name?: string | null; type?: { name?: string | null } | null };
/** Who gets credit for an application (v1's credited_to): not the same id space as users. */
type GhReferrer = { id: GhId; name?: string | null };
type GhCandidate = {
  id: GhId;
  first_name?: string | null;
  last_name?: string | null;
  preferred_name?: string | null;
  company?: string | null;
  title?: string | null;
  created_at?: string | null;
  private?: boolean | null;
  tags?: string[] | null;
  phone_numbers?: Typed[] | null;
  addresses?: Typed[] | null;
  email_addresses?: Typed[] | null;
  website_addresses?: Typed[] | null;
  social_media_addresses?: Typed[] | null;
  custom_fields?: GhCustomFields;
};
type GhApplication = {
  id: GhId;
  candidate_id: GhId;
  job_id?: GhId | null;
  status?: string | null;
  prospect?: boolean | null;
  prospective_job_ids?: GhId[] | null;
  job_interview_stage_id?: GhId | null;
  stage_name?: string | null;
  rejection_reason_id?: GhId | null;
  rejected_at?: string | null;
  source_id?: GhId | null;
  referrer_id?: GhId | null;
  agency_note_id?: GhId | null;
  recruiter_id?: GhId | null;
  answers?: { question?: string | null; answer?: string | null }[] | null;
  custom_fields?: GhCustomFields;
  created_at?: string | null;
  updated_at?: string | null;
};
type GhApplicationStage = {
  id: GhId;
  application_id: GhId;
  job_interview_stage_id?: GhId | null;
  entered_at?: string | null;
  exited_at?: string | null;
  created_at?: string | null;
};
type GhProspectDetail = { id: GhId; application_id: GhId; prospect_owner_id?: GhId | null };
type GhNote = {
  id: GhId;
  candidate_id?: GhId | null;
  application_id?: GhId | null;
  user_id?: GhId | null;
  type?: string | null;
  visibility?: string | null;
  subject?: string | null;
  body?: string | null;
  email_from?: string | null;
  email_to?: string | null;
  created_at?: string | null;
};
type GhInterview = {
  id: GhId;
  application_id: GhId;
  job_interview_id?: GhId | null;
  organizer_id?: GhId | null;
  status?: string | null;
  starts_at?: string | null;
  ends_at?: string | null;
  all_day_start_on?: string | null;
  location?: string | null;
  video_conferencing_url?: string | null;
};
type GhInterviewer = { id: GhId; interview_id: GhId; user_id?: GhId | null; scorecard_id?: GhId | null };
type GhJobInterview = { id: GhId; name?: string | null; duration?: number | null };
type GhInterviewKit = { id: GhId; job_interview_id?: GhId | null };
type GhScorecard = {
  id: GhId;
  application_id: GhId;
  interview_kit_id?: GhId | null;
  interviewer_id?: GhId | null;
  submitter_id?: GhId | null;
  status?: string | null;
  candidate_rating?: string | null;
  submitted_at?: string | null;
  notes?: string | null;
  private_notes?: string | null;
  public_notes?: string | null;
  updated_at?: string | null;
};
type GhAnswer = {
  id: GhId;
  scorecard_id: GhId;
  scorecard_question_id: GhId;
  answer?: string | null;
  answer_with_tags?: string | null;
  boolean_value?: boolean | null;
  value?: unknown;
};
type GhQuestion = { id: GhId; question?: string | null; answer_type?: string | null; sort_order?: number | null };
type GhOption = { id: GhId; name?: string | null };
type GhAttributeRating = {
  id: GhId;
  scorecard_id: GhId;
  job_candidate_attribute_id?: GhId | null;
  candidate_attribute_rating?: string | null;
  note?: string | null;
};
type GhAttribute = { id: GhId; name?: string | null; sort_order?: number | null };
type GhOffer = {
  id: GhId;
  application_id: GhId;
  job_id?: GhId | null;
  status?: string | null;
  sent_on?: string | null;
  starts_on?: string | null;
  resolved_at?: string | null;
  custom_fields?: GhCustomFields;
  created_at?: string | null;
};
type GhAttachment = {
  id: GhId;
  application_id?: GhId | null;
  candidate_id?: GhId | null;
  type?: string | null;
  filename?: string | null;
  url?: string | null;
};
type TokenResponse = { access_token?: string; expires_in?: number | string | null; expires_at?: string | null };
type Introspection = { 'https://auth.greenhouse.io/claims'?: { organization?: { name?: string | null } | null } | null };

// ---------- Hosts ----------

/** Greenhouse's own hosts other than the token host: the only ones a bearer token may go to. */
function isGreenhouseHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return /(^|\.)greenhouse\.io$/.test(host) && host !== AUTH_HOST;
}

/** The API host: harvest.greenhouse.io unless support set `apiBaseUrl`. Null when that override is unusable. */
function apiHost(credentials: Credentials): string | null {
  const raw = credentials.apiBaseUrl?.trim();
  if (!raw) return DEFAULT_API_HOST;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && isGreenhouseHost(u.hostname) ? u.host : null;
  } catch {
    return null;
  }
}

// ---------- Access tokens ----------

type Session = { token: string | null; expiresAt: number; minting: Promise<string> | null };

/**
 * Tokens by a hash of the credential. The engine opens a fresh credentials
 * object every slice, and each mint counts against the token endpoint's own
 * rate window, so a token is reused until it nears expiry.
 */
const sessions = new Map<string, Session>();

function sessionFor(credentials: Credentials): Session {
  const key = createHash('sha256')
    .update(
      JSON.stringify([
        credentials.clientId?.trim() ?? '',
        credentials.clientSecret?.trim() ?? '',
        credentials.actAsUserId?.trim() ?? '',
      ]),
    )
    .digest('hex');
  let s = sessions.get(key);
  if (!s) {
    const now = Date.now();
    for (const [k, old] of sessions) if (!old.minting && old.expiresAt < now) sessions.delete(k);
    s = { token: null, expiresAt: 0, minting: null };
    sessions.set(key, s);
  }
  return s;
}

function decodeClaims(token: string): Record<string, unknown> | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return claims && typeof claims === 'object' ? (claims as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function tokenExpiry(token: string, res: TokenResponse): number {
  const now = Date.now();
  const secs = Number(res.expires_in);
  if (Number.isFinite(secs) && secs > 0) return secs > 1e9 ? secs * 1000 : now + secs * 1000;
  const exp = decodeClaims(token)?.exp;
  if (typeof exp === 'number') return exp * 1000;
  // The OpenAPI example types expires_in as a timestamp; the partner flow returns expires_at.
  const at = toDate(res.expires_at ?? res.expires_in);
  return at ? at.getTime() : now + 3_600_000;
}

function basicAuth(credentials: Credentials): string {
  const pair = `${credentials.clientId?.trim() ?? ''}:${credentials.clientSecret?.trim() ?? ''}`;
  return `Basic ${Buffer.from(pair).toString('base64')}`;
}

async function mintToken(http: HttpClient, credentials: Credentials): Promise<{ token: string; expiresAt: number }> {
  const clientId = credentials.clientId?.trim();
  const clientSecret = credentials.clientSecret?.trim();
  if (!clientId || !clientSecret) throw new ImportAuthError(401, TOKEN_WHERE);
  const sub = credentials.actAsUserId?.trim();
  if (sub && !/^\d+$/.test(sub)) throw new Error('Act as user ID must be a numeric Greenhouse user ID, or empty');

  const headers = { authorization: basicAuth(credentials), 'content-type': 'application/x-www-form-urlencoded' };
  // sub stays a decimal string: user ids overflow the int32 the OpenAPI page declares.
  const body = new URLSearchParams({ grant_type: 'client_credentials', ...(sub ? { sub } : {}) }).toString();
  const post = (query?: Record<string, QueryValue>) =>
    http.request<TokenResponse>({ url: TOKEN_URL, method: 'POST', headers, body, query });

  let res: TokenResponse | null;
  try {
    try {
      res = (await post()).data;
    } catch (err) {
      // The guide sends grant_type in the form body; the OpenAPI page puts it in the query.
      if (!(err instanceof ImportHttpError && err.status === 400)) throw err;
      res = (await post({ grant_type: 'client_credentials' })).data;
    }
  } catch (err) {
    // auth.greenhouse.io isn't an API host, so the client reports its 401 as a plain HTTP error.
    // A 400 keeps its detail: it may be the client refusing the host, not Greenhouse refusing us.
    if (err instanceof ImportHttpError && (err.status === 401 || err.status === 403)) {
      throw new ImportAuthError(401, TOKEN_WHERE);
    }
    throw err;
  }
  const token = res?.access_token;
  if (!token) throw new ImportHttpError(502, TOKEN_WHERE, 'no access_token in the response');
  return { token, expiresAt: tokenExpiry(token, res ?? {}) };
}

async function accessToken(http: HttpClient, credentials: Credentials, refresh: boolean): Promise<string> {
  const s = sessionFor(credentials);
  if (!refresh && s.token && Date.now() < s.expiresAt - 60_000) return s.token;
  if (!s.minting) {
    s.minting = mintToken(http, credentials)
      .then(({ token, expiresAt }) => {
        s.token = token;
        s.expiresAt = expiresAt;
        return token;
      })
      .finally(() => {
        s.minting = null;
      });
  }
  return s.minting;
}

function organizationName(claims: Record<string, unknown> | null): string | null {
  const act = claims?.act;
  if (!act || typeof act !== 'object') return null;
  const name = (act as Record<string, unknown>)['organization.name'];
  return typeof name === 'string' && name.trim() ? name.trim() : null;
}

// ---------- Paging ----------

/** `rel="next"` from a Link header; a URL on another host is pinned back to the API host. */
function nextLink(header: string | null, host: string): string | null {
  if (!header) return null;
  for (const m of header.matchAll(/<([^>]+)>\s*;\s*rel="?([^";]+)"?/g)) {
    if (!m[2].split(/\s+/).includes('next')) continue;
    const u = new URL(m[1], `https://${host}`);
    return u.protocol === 'https:' && u.host === host ? u.toString() : `https://${host}${u.pathname}${u.search}`;
  }
  return null;
}

/**
 * Page token in a step cursor. `url` is the page (null = the first page) and
 * `restarts` counts stale-cursor restarts. After a mid-page stop, `below` is
 * the last id handled and `skip` its position on the page. `top` is the
 * highest id when the crawl began; `late` marks the closing pass that reads
 * back down to it for rows created while the import ran.
 */
type PageToken = {
  url: string | null;
  restarts: number;
  below: number | null;
  skip: number;
  top: number | null;
  late: boolean;
};

const FIRST_PAGE: PageToken = { url: null, restarts: 0, below: null, skip: 0, top: null, late: false };

function readToken(page: JsonValue | undefined): PageToken {
  if (typeof page === 'string') return { ...FIRST_PAGE, url: page };
  if (page && typeof page === 'object' && !Array.isArray(page)) {
    const n = (v: JsonValue | undefined) => (typeof v === 'number' ? v : null);
    return {
      url: typeof page.url === 'string' ? page.url : null,
      restarts: n(page.restarts) ?? 0,
      below: n(page.below),
      skip: n(page.skip) ?? 0,
      top: n(page.top),
      late: page.late === true,
    };
  }
  return FIRST_PAGE;
}

function writeToken(t: PageToken): JsonValue {
  if (!t.restarts && t.below == null && t.top == null && !t.late) return t.url;
  return {
    url: t.url,
    ...(t.restarts ? { restarts: t.restarts } : {}),
    ...(t.below != null ? { below: t.below, skip: t.skip } : {}),
    ...(t.top != null ? { top: t.top } : {}),
    ...(t.late ? { late: true } : {}),
  };
}

const stepAt = (t: PageToken): PageCursor => ({ page: writeToken(t), index: 0 });

/** The rows of a refetched page a resumed step hasn't handled yet. */
function unhandled<T extends { id: GhId }>(rows: T[], below: number | null, skip: number): T[] {
  if (below == null) return rows;
  // Greenhouse pages by id, descending. Should a page ever not be, fall back to its position.
  return rows.every((r, i) => i === 0 || r.id < rows[i - 1].id) ? rows.filter((r) => r.id < below) : rows.slice(skip);
}

/** A list row, with a look at the rows after it so lookups can batch ahead. */
type Row<T> = { id: GhId; row: T; ahead: <K>(pick: (row: T) => K) => K[] };

function withLookahead<T extends { id: GhId }>(list: T[]): Row<T>[] {
  return list.map((row, i) => ({ id: row.id, row, ahead: (pick) => list.slice(i, i + 4 * MAX_IDS).map(pick) }));
}

type Lookup<T> = {
  /** Rows for these keys; fetches any not cached, topping each call up from `upcoming`. */
  get(ctx: PhaseContext, ids: Key | Key[], upcoming?: Key[]): Promise<T[]>;
  peek(id: Key): T[] | undefined;
};

const keyOf = (k: Key): string | null => (k == null || k === '' ? null : String(k));

function lookup<T>(load: (ctx: PhaseContext, ids: string[]) => Promise<T[]>, keyFor: (row: T) => Key): Lookup<T> {
  const cache = new Map<string, T[]>();
  return {
    async get(ctx, ids, upcoming = []) {
      const wanted = [...new Set((Array.isArray(ids) ? ids : [ids]).map(keyOf).filter((k): k is string => !!k))];
      const need = wanted.filter((k) => !cache.has(k));
      if (need.length) {
        const room = Math.ceil(need.length / MAX_IDS) * MAX_IDS - need.length;
        const extra = [...new Set(upcoming.map(keyOf))].filter(
          (k): k is string => !!k && !cache.has(k) && !need.includes(k),
        );
        const batch = [...need, ...extra.slice(0, room)];
        for (let i = 0; i < batch.length; i += MAX_IDS) {
          const chunk = batch.slice(i, i + MAX_IDS);
          const rows = await load(ctx, chunk);
          for (const k of chunk) cache.set(k, []);
          for (const row of rows) cache.get(keyOf(keyFor(row)) ?? '')?.push(row);
        }
      }
      return wanted.flatMap((k) => cache.get(k) ?? []);
    },
    peek: (id) => cache.get(keyOf(id) ?? ''),
  };
}

// ---------- Normalization ----------

function userName(u: GhUser): string {
  return u.name?.trim() || fullName(u.first_name, u.last_name, 'Greenhouse user');
}

function reasonKind(key: string | null | undefined): ReasonKind {
  switch (key) {
    case 'WE_REJECTED_THEM':
    case 'SECURITY_CONCERN':
      return 'rejection';
    case 'THEY_REJECTED_US':
      return 'withdrawn';
    default:
      return 'other';
  }
}

/**
 * Catalog rows for rejection reasons. The engine groups reasons by name, and
 * Greenhouse reuses names across types ("Other (add notes below)" is both a
 * rejection and a withdrawal), so a reused name gets its type appended,
 * except on the rejection one, which keeps the plain name.
 */
function catalogReasons(reasons: GhRejectionReason[]): CatalogReason[] {
  const byName = new Map<string, GhRejectionReason[]>();
  for (const r of reasons) {
    if (!r.name?.trim()) continue;
    const key = nameKey(r.name);
    byName.set(key, [...(byName.get(key) ?? []), r]);
  }
  return [...byName.values()].flatMap((group) => {
    const types = new Set(group.map((r) => r.type?.key ?? null));
    const plain = types.has('WE_REJECTED_THEM')
      ? 'WE_REJECTED_THEM'
      : ([...group].sort((a, b) => a.id - b.id)[0].type?.key ?? null);
    return group.map((r) => {
      const type = r.type?.key ?? null;
      const label = r.type?.name?.trim() || (type ?? 'no type').toLowerCase().replace(/_/g, ' ');
      return {
        externalId: String(r.id),
        name: types.size > 1 && type !== plain ? `${r.name.trim()} — ${label}` : r.name,
        kind: reasonKind(type),
      };
    });
  });
}

function stageHint(s: GhJobStage): StageType | null {
  // Every Greenhouse interview plan starts with Application Review and ends with Offer.
  if (s.sort_order === 0) return 'APPLICANT';
  if (s.name.trim().toLowerCase() === 'offer') return 'OFFER';
  return null;
}

/** Smallest-unit exponent (ISO 4217) for pay ranges, which Greenhouse calls "cents" regardless. */
function minorUnits(currency: string): number {
  if (/^(BIF|CLP|DJF|GNF|ISK|JPY|KMF|KRW|PYG|RWF|UGX|UYI|VND|VUV|XAF|XOF|XPF)$/.test(currency)) return 0;
  if (/^(BHD|IQD|JOD|KWD|LYD|OMR|TND)$/.test(currency)) return 3;
  return 2;
}

function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const n = Number(value.replace(/[^\d.-]/g, ''));
    return value.trim() && Number.isFinite(n) ? n : null;
  }
  return null;
}

function currencyCode(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().toUpperCase() : null;
}

/** Currency custom field: v1 read shape {value, currency} or v3 write shape {amount, currency_code}. */
function moneyOf(value: unknown): { amount: number | null; currency: string | null } {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const v = value as Record<string, unknown>;
    return { amount: num(v.value ?? v.amount), currency: currencyCode(v.currency ?? v.currency_code ?? v.unit) };
  }
  return { amount: num(value), currency: null };
}

/** Currency-range custom field: {min_value, max_value, unit} or {min_amount, max_amount, currency_code}. */
function rangeOf(value: unknown): { min: number | null; max: number | null; currency: string | null } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const range = {
    min: num(v.min_value ?? v.min_amount),
    max: num(v.max_value ?? v.max_amount),
    currency: currencyCode(v.unit ?? v.currency_code ?? v.currency),
  };
  return range.min != null || range.max != null ? range : null;
}

function customText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return cleanList(value.map((v) => customText(v))).join(', ');
  const range = rangeOf(value);
  if (range) return [range.currency, [range.min, range.max].filter((n) => n != null).join('–')].filter(Boolean).join(' ');
  const money = moneyOf(value);
  if (money.amount != null) return [money.currency, money.amount].filter((x) => x != null).join(' ');
  const named = (value as Record<string, unknown>).name;
  return typeof named === 'string' ? named.trim() : JSON.stringify(value);
}

function findField(
  fields: GhCustomFields | undefined,
  test: (key: string, field: GhCustomField) => boolean,
): [string, GhCustomField] | null {
  for (const [key, field] of Object.entries(fields ?? {})) {
    if (field && field.value != null && test(key, field)) return [key, field];
  }
  return null;
}

const labelOf = (key: string, field: GhCustomField) => `${key} ${field.name ?? ''}`;

/** Custom-field values as labelled text, for the opportunity's imported fields. */
function fieldTexts(fields: GhCustomFields | undefined, prefix = ''): [string, string][] {
  return Object.entries(fields ?? {}).flatMap(([key, f]): [string, string][] => {
    const text = customText(f?.value);
    return text ? [[`${prefix}${f?.name?.trim() || key}`, clip(text, 2000)]] : [];
  });
}

function commitmentOf(fields: GhCustomFields | undefined): Commitment | null {
  const hit = findField(fields, (k, f) => /employment[ _]type|job[ _]type|commitment/i.test(labelOf(k, f)));
  const v = hit ? customText(hit[1].value).toLowerCase() : '';
  if (!v) return null;
  if (/intern/.test(v)) return 'INTERNSHIP';
  if (/contract|temp|freelance|consult/.test(v)) return 'CONTRACT';
  if (/part/.test(v)) return 'PART_TIME';
  if (/full|perm/.test(v)) return 'FULL_TIME';
  return null;
}

function workplaceOf(fields: GhCustomFields | undefined, location: string | null): WorkplaceType | null {
  const hit = findField(fields, (k, f) => /workplace|remote|location[ _]type/i.test(labelOf(k, f)));
  // Greenhouse has no workplace field: an org-defined one wins, else the posting's location text.
  const text = `${hit ? customText(hit[1].value) : ''} ${location ?? ''}`.toLowerCase();
  if (/hybrid/.test(text)) return 'HYBRID';
  if (/remote|anywhere|distributed/.test(text)) return 'REMOTE';
  if (hit && /on-?site|office|in[ -]person/.test(text)) return 'ONSITE';
  return null;
}

/**
 * The posting's salary among its pay ranges. A post can have several pay
 * inputs (base, on-target earnings, bonus…) in several currencies, so pick
 * the base one by its title, never by comparing amounts.
 */
function basePayRange(ranges: GhPayRange[], inputs: GhPayInput[]): GhPayRange | null {
  const input = new Map(inputs.map((p) => [p.id, p]));
  const title = (r: GhPayRange) => input.get(r.pay_input_id ?? -1)?.title ?? '';
  const rank = (r: GhPayRange) => (/base/i.test(title(r)) ? 0 : /salary/i.test(title(r)) ? 1 : 2);
  const priority = (r: GhPayRange) => input.get(r.pay_input_id ?? -1)?.priority ?? Number.MAX_SAFE_INTEGER;
  const usable = ranges.filter((r) => (r.min_cents ?? 0) > 0 || (r.max_cents ?? 0) > 0);
  return (
    usable.sort(
      (a, b) =>
        rank(a) - rank(b) || priority(a) - priority(b) || (a.pay_input_id ?? 0) - (b.pay_input_id ?? 0) || a.id - b.id,
    )[0] ?? null
  );
}

function salaryOf(range: GhPayRange | null, fields: GhCustomFields | undefined) {
  if (range) {
    const currency = currencyCode(range.currency_type) ?? 'USD';
    const scale = 10 ** minorUnits(currency);
    return {
      min: range.min_cents ? range.min_cents / scale : null,
      max: range.max_cents ? range.max_cents / scale : null,
      currency,
    };
  }
  const hit =
    findField(fields, (k, f) => f.type === 'currency_range' && /salary|pay|comp/i.test(labelOf(k, f))) ??
    findField(fields, (_k, f) => f.type === 'currency_range');
  return hit ? rangeOf(hit[1].value) : null;
}

function bestPost(posts: GhJobPost[]): GhJobPost | null {
  // Live external, then active external, then any active, then soft-deleted.
  const rank = (p: GhJobPost) => (p.active === false ? 4 : 0) + (p.internal ? 2 : 0) + (p.live ? 0 : 1);
  return [...posts].sort((a, b) => rank(a) - rank(b) || a.id - b.id)[0] ?? null;
}

function postingState(job: GhJob, post: GhJobPost | null): ImportedPosting['state'] {
  if (job.status === 'closed') return 'closed';
  if (job.status === 'draft') return 'draft';
  return post?.live && post.internal && post.active !== false ? 'internal' : 'open';
}

function toRequisition(job: GhJob, openings: GhOpening[], code: string): ImportedRequisition {
  const salary = salaryOf(null, job.custom_fields);
  const state: ImportedRequisition['state'] =
    job.status === 'closed'
      ? 'closed'
      : job.status === 'draft'
        ? 'on_hold'
        : openings.length && !openings.some((o) => o.open)
          ? 'closed'
          : 'open';
  return {
    externalId: String(job.id),
    code,
    title: job.name,
    state,
    openings: openings.length || null,
    filled: openings.length ? openings.filter((o) => o.application_id != null).length : null,
    salaryMin: salary?.min ?? null,
    salaryMax: salary?.max ?? null,
    salaryCurrency: salary?.currency ?? null,
  };
}

function toCandidate(c: GhCandidate): ImportedCandidate {
  const values = (list: Typed[] | null | undefined) => (list ?? []).map((x) => x?.value);
  return {
    externalId: String(c.id),
    name: fullName(c.preferred_name?.trim() || c.first_name, c.last_name),
    emails: cleanEmails(values(c.email_addresses)),
    phones: cleanList(values(c.phone_numbers)),
    links: cleanList([...values(c.website_addresses), ...values(c.social_media_addresses)]),
    headline: cleanList([c.title, c.company]).join(' at ') || null,
    location: cleanList((c.addresses?.[0]?.value ?? '').split('\n')).join(', ') || null,
    tags: cleanList(c.tags ?? []),
    createdAt: toDate(c.created_at),
  };
}

/** A prospect's job when it was considered for exactly one. */
function prospectiveJob(app: GhApplication): GhId | null {
  const [only, ...more] = app.prospective_job_ids ?? [];
  return more.length ? null : (only ?? null);
}

function originOf(app: GhApplication, source: GhSource | undefined): Origin {
  const type = source?.type?.name?.trim().toLowerCase() ?? '';
  const name = source?.name?.trim().toLowerCase() ?? '';
  // The source says how someone came in. referrer_id is v1's credited_to ("who gets credit"),
  // which sourced and agency candidates carry too, so it decides only when there's no source.
  if (type === 'referral') return 'REFERRED';
  if (app.agency_note_id != null || type === 'agencies') return 'AGENCY';
  if (app.prospect || type === 'prospecting') return 'SOURCED';
  if (/internal/.test(name)) return 'INTERNAL';
  if (/universit|campus|college/.test(name)) return 'UNIVERSITY';
  if (app.referrer_id != null && !source) return 'REFERRED';
  return 'APPLIED';
}

function ratingOf(value: string | null | undefined): 1 | 2 | 3 | 4 | null {
  switch (value?.trim().toLowerCase()) {
    case 'strong_no':
    case 'definitely_not':
      return 1;
    case 'no':
      return 2;
    case 'yes':
      return 3;
    case 'strong_yes':
      return 4;
    default:
      return null; // no_decision (or mixed): the engine keeps the scorecard as a note
  }
}

function interviewState(status: string | null | undefined): 'scheduled' | 'completed' | 'canceled' | null {
  switch (status) {
    case 'complete':
    case 'awaiting_feedback':
    case 'collect_feedback':
    case 'received':
      return 'completed';
    case 'skipped':
      return 'canceled';
    case 'scheduled':
    case 'to_be_scheduled':
    case 'to_be_sent':
    case 'sent':
      return 'scheduled';
    default:
      return null;
  }
}

function offerStatus(o: GhOffer): OfferStatus | null {
  switch (o.status?.trim().toLowerCase()) {
    case 'accepted':
      return 'ACCEPTED';
    case 'rejected':
      return 'DECLINED';
    case 'deprecated':
      return null; // superseded version
    default:
      return o.sent_on ? 'SENT' : 'DRAFT';
  }
}

function noteBody(n: GhNote): string {
  const lines: string[] = [];
  if (n.visibility && n.visibility !== 'publicly_visible') lines.push('(Private note in Greenhouse)');
  const label = n.type && Object.hasOwn(NOTE_TYPES, n.type) ? NOTE_TYPES[n.type] : null;
  if (label) {
    lines.push(n.subject?.trim() ? `${label}: ${n.subject.trim()}` : label);
    if (n.type === 'EMAIL') {
      const route = cleanList([n.email_from && `From ${n.email_from}`, n.email_to && `to ${n.email_to}`]).join(' ');
      if (route) lines.push(route);
    }
    lines.push('');
  }
  const body = n.body?.trim() ?? '';
  if (!body && !n.subject?.trim()) return '';
  return [...lines, body].join('\n').trim();
}

function answerText(a: GhAnswer, q: GhQuestion | undefined, option: (id: unknown) => string | null): string {
  const type = q?.answer_type;
  const bool = a.boolean_value ?? (typeof a.value === 'boolean' ? a.value : null);
  if (type === 'yes_no' || bool != null) return bool == null ? '' : bool ? 'Yes' : 'No';
  if (type === 'single_select' || type === 'multi_select' || typeof a.value === 'number' || Array.isArray(a.value)) {
    const ids = Array.isArray(a.value) ? a.value : [a.value];
    return cleanList(ids.map((id) => option(id) ?? (typeof id === 'string' ? id : null))).join(', ');
  }
  return a.answer?.trim() || htmlToText(a.answer_with_tags) || (typeof a.value === 'string' ? a.value.trim() : '');
}

function optionIds(a: GhAnswer): GhId[] {
  const values = Array.isArray(a.value) ? a.value : [a.value];
  return values.filter((v): v is number => typeof v === 'number');
}

/** "Strong yes — note". A no_decision rating without a note says nothing. */
function attributeText(r: GhAttributeRating): string {
  const key = r.candidate_attribute_rating?.trim().toLowerCase() ?? '';
  const rating = Object.hasOwn(ATTRIBUTE_RATINGS, key) ? ATTRIBUTE_RATINGS[key] : key.replace(/_/g, ' ');
  return cleanList([rating, r.note]).join(' — ');
}

function scorecardSummary(s: GhScorecard): string {
  return cleanList([
    s.notes,
    s.public_notes?.trim() ? `Public notes: ${s.public_notes.trim()}` : null,
    s.private_notes?.trim() ? `Private notes: ${s.private_notes.trim()}` : null,
  ]).join('\n\n');
}

/**
 * Optional data Greenhouse won't serve. A 403, or a 401 even after the client
 * minted a fresh token, means the endpoint's scope is missing; other 4xx mean
 * the endpoint or a filter isn't available. Token-endpoint failures are real
 * credential problems and never count.
 */
function isUnavailable(err: unknown): boolean {
  if (err instanceof ImportAuthError) return err.where !== TOKEN_WHERE;
  return err instanceof ImportHttpError && err.status >= 400 && err.status < 500 && err.status !== 429;
}

const isRefusal = (err: unknown) =>
  (err instanceof ImportHttpError || err instanceof ImportAuthError) && (err.status === 401 || err.status === 403);

// ---------- The provider ----------

export const greenhouseProvider: ProviderModule = {
  id: 'greenhouse',
  // Harvest v3 publishes no number: a fixed 30 s window whose documented example is 75
  // (2.5/s), shared by every client of the credential. 2/s leaves headroom; 429s honor Retry-After.
  minIntervalMs: 500,

  auth(credentials) {
    return {
      hosts: [apiHost(credentials) ?? DEFAULT_API_HOST],
      getHeaders: async (http, { refresh }) => ({
        authorization: `Bearer ${await accessToken(http, credentials, refresh)}`,
      }),
    };
  },

  create(credentials, http) {
    const host = apiHost(credentials) ?? DEFAULT_API_HOST;
    const api = `https://${host}`;
    /** Endpoints Greenhouse refused during this slice; not asked again. */
    const denied = new Set<string>();
    const refused = (path: string) => [...denied].some((d) => d === path || d.startsWith(`${path} `));

    async function fetchPage<T>(
      url: string | null,
      path: string,
      query: Record<string, QueryValue>,
    ): Promise<{ rows: T[]; next: string | null }> {
      // Filters go on the first request only; the next link already carries them.
      const res = url
        ? await http.request<T[]>({ url })
        : await http.request<T[]>({ url: `${api}${path}`, query: { per_page: PER_PAGE, ...query } });
      return { rows: Array.isArray(res.data) ? res.data : [], next: nextLink(res.headers.get('link'), host) };
    }

    /**
     * Every page of a filtered list (id-filtered lists are small). `accept`
     * spots a filter Greenhouse ignored, which would otherwise page the whole
     * table for every batch.
     */
    async function listAll<T>(
      path: string,
      query: Record<string, QueryValue>,
      accept?: (row: T) => boolean,
    ): Promise<T[]> {
      const out: T[] = [];
      let url: string | null = null;
      for (let i = 0; i < 100; i++) {
        const page: { rows: T[]; next: string | null } = await fetchPage<T>(url, path, query);
        if (accept && !page.rows.every(accept)) {
          throw new ImportHttpError(400, `GET ${host}${path}`, 'Greenhouse ignored the id filter');
        }
        out.push(...page.rows);
        if (!page.next || !page.rows.length) break;
        url = page.next;
      }
      return out;
    }

    /** Run a fetch for optional data; if Greenhouse won't serve it, warn once and carry on without it. */
    async function soft<T>(
      ctx: PhaseContext,
      path: string,
      what: string,
      fn: () => Promise<T>,
      fallback: T,
      opts: { rethrow422?: boolean } = {},
    ): Promise<T> {
      // A missing scope rules out the whole endpoint; a rejected filter only this use of it.
      if (denied.has(path) || denied.has(`${path} ${what}`)) return fallback;
      try {
        return await fn();
      } catch (err) {
        if (!isUnavailable(err) || (opts.rethrow422 && err instanceof ImportHttpError && err.status === 422)) throw err;
        denied.add(err instanceof ImportAuthError ? path : `${path} ${what}`);
        const resource = path.replace(/^\/v3\//, '');
        const hint = err instanceof ImportAuthError ? ` Grant the ${scopeName(resource)} scope to include them.` : '';
        ctx.warn(`Skipped ${what}: ${(err as Error).message}.${hint}`, { entity: resource });
        return fallback;
      }
    }

    /** Id-filtered list as a lookup loader, for optional data. */
    const byIds =
      <T>(path: string, param: string, what: string, keyFor: (row: T) => Key, extra: Record<string, QueryValue> = {}) =>
      (ctx: PhaseContext, ids: string[]) => {
        const wanted = new Set(ids);
        return soft(
          ctx,
          path,
          what,
          () => listAll<T>(path, { ...extra, [param]: ids.join(',') }, (row) => wanted.has(keyOf(keyFor(row)) ?? '')),
          [] as T[],
        );
      };
    const idLookup = <T>(
      path: string,
      param: string,
      what: string,
      keyFor: (row: T) => Key,
      extra?: Record<string, QueryValue>,
    ) => lookup<T>(byIds(path, param, what, keyFor, extra), keyFor);

    type ListSpec = {
      path: string;
      query?: Record<string, QueryValue>;
      /** Send a created-after filter for ctx.since. */
      since?: boolean;
      /** Optional data: a refused endpoint warns (naming this) instead of failing the job. */
      optional?: string;
      /** Filters also applied after download, so they can be dropped if Greenhouse rejects them. */
      loose?: string[];
      /** Finish with a pass over rows created while the list was being read. */
      catchUp?: boolean;
    };

    /** The created-after syntax Greenhouse accepted this slice; 'none' once it refused both. */
    let dateSyntax: 'pipe' | 'bracket' | 'none' = 'pipe';

    async function firstPage<T>(ctx: PhaseContext, spec: ListSpec) {
      const query: Record<string, QueryValue> = { ...spec.query };
      const since = spec.since && ctx.since ? ctx.since.toISOString() : null;
      if (since && dateSyntax !== 'none') {
        for (const syntax of dateSyntax === 'pipe' ? (['pipe', 'bracket'] as const) : (['bracket'] as const)) {
          const createdAfter = syntax === 'pipe' ? { created_at: `gte|${since}` } : { 'created_at[gte]': since };
          try {
            const page = await fetchPage<T>(null, spec.path, { ...query, ...createdAfter });
            dateSyntax = syntax;
            return page;
          } catch (err) {
            if (!(err instanceof ImportHttpError && err.status === 422)) throw err;
          }
        }
        dateSyntax = 'none';
        ctx.warn(`Greenhouse rejected the created_at filter on ${spec.path}; filtering after download instead`);
      }
      try {
        return await fetchPage<T>(null, spec.path, query);
      } catch (err) {
        const loose = (spec.loose ?? []).filter((k) => query[k] != null);
        if (!(err instanceof ImportHttpError && err.status === 422 && loose.length)) throw err;
        ctx.warn(`Greenhouse rejected the ${loose.join(', ')} filter on ${spec.path}; filtering after download instead`);
        for (const k of loose) delete query[k];
        return fetchPage<T>(null, spec.path, query);
      }
    }

    type PageRead<T> = {
      /** Rows on the page still to handle. */
      todo: T[];
      /** The page's rows in scope (positions for `skip`). */
      rows: T[];
      at: PageToken;
      next: PageToken | null;
    };

    /** The page a token points at, trimmed to what's left to handle; empty pages already done are stepped over. */
    async function readPage<T extends { id: GhId }>(
      ctx: PhaseContext,
      spec: ListSpec,
      token: PageToken,
    ): Promise<PageRead<T>> {
      let url = token.url;
      let res = url ? await fetchPage<T>(url, spec.path, {}) : await firstPage<T>(ctx, spec);
      // Rows arriving mid-crawl get higher ids than any page still ahead, so note where the crawl began.
      const top =
        token.top ?? (spec.catchUp && !token.late && !url ? res.rows.reduce((m, r) => Math.max(m, r.id), 0) : null);
      // The closing pass reads down only as far as the rows the main pass saw.
      const floor = token.late ? top : null;
      const scope = (rows: T[]) => (floor == null ? rows : rows.filter((r) => r.id > floor));
      const reachedTop = (rows: T[]) => floor != null && rows.some((r) => r.id <= floor);
      let rows = scope(res.rows);
      let todo = unhandled(rows, token.below, token.skip);
      // Everything still on this page was handled before the rest of it left: move on.
      while (!todo.length && res.rows.length && res.next && !reachedTop(res.rows)) {
        url = res.next;
        res = await fetchPage<T>(url, spec.path, {});
        rows = scope(res.rows);
        todo = unhandled(rows, token.below, 0);
      }
      const at: PageToken = { ...token, url, below: null, skip: 0, top };
      const more = !!res.next && res.rows.length > 0 && !reachedTop(res.rows);
      return {
        todo,
        rows,
        at,
        next: more ? { ...at, url: res.next } : top != null && !token.late ? { ...at, url: null, late: true } : null,
      };
    }

    /**
     * One step of a list: a page, handled row by row until the slice runs out
     * of time. A stop mid-page resumes below the last id handled, never at a
     * position, since rows can leave a page between slices. With `catchUp`,
     * a closing pass reads the top of the list again for rows created while
     * the crawl ran (about one request when there are none).
     */
    async function pagedList<T extends { id: GhId }>(
      ctx: PhaseContext,
      cursor: Cursor | null,
      spec: ListSpec,
      handle: (item: Row<T>) => Promise<void>,
    ): Promise<Cursor | null> {
      const token = readToken((cursor as PageCursor | null)?.page);
      try {
        const read = () => readPage<T>(ctx, spec, token);
        // A 422 on a saved cursor goes to the restart below, not to "unavailable".
        const page = spec.optional
          ? await soft<PageRead<T> | null>(ctx, spec.path, spec.optional, read, null, { rethrow422: !!token.url })
          : await read();
        if (!page) return null;
        const items = withLookahead(page.todo);
        for (let i = 0; i < items.length; i++) {
          // Always make progress: at least one row per step, even if already late.
          if (i > 0 && ctx.outOfTime()) {
            const last = page.todo[i - 1];
            return stepAt({ ...page.at, below: last.id, skip: page.rows.indexOf(last) + 1 });
          }
          await each(ctx, items[i], handle);
        }
        return page.next ? stepAt(page.next) : null;
      } catch (err) {
        // Cursors are opaque and not meant to outlive a crawl; a long pause can strand one.
        if (err instanceof ImportHttpError && err.status === 422 && token.url && token.restarts < 2) {
          ctx.warn(
            `Greenhouse no longer accepts a saved page cursor for ${spec.path}; ` +
              'restarting that list (records already imported are skipped)',
          );
          return stepAt({ ...FIRST_PAGE, restarts: token.restarts + 1, top: token.late ? token.top : null, late: token.late });
        }
        throw err;
      }
    }

    // Lookups live for one slice (the engine builds a fresh adapter per slice).
    const byId = (r: { id: GhId }) => r.id;
    const byJob = (r: { job_id: GhId }) => r.job_id;
    const byApplication = (r: { application_id?: GhId | null }) => r.application_id;
    const openingsByJob = idLookup<GhOpening>('/v3/openings', 'job_ids', 'openings', byJob);
    const openingsByApp = idLookup<GhOpening>('/v3/openings', 'application_ids', 'hire dates from openings', byApplication);
    const offersByApp = idLookup<GhOffer>('/v3/offers', 'application_ids', 'hire dates from offers', byApplication);
    const postsByJob = lookup<GhJobPost>(async (ctx, ids) => {
      const active = await byIds<GhJobPost>('/v3/job_posts', 'job_ids', 'job posts', byJob)(ctx, ids);
      const found = new Set(active.map((p) => String(p.job_id)));
      const rest = ids.filter((id) => !found.has(id));
      // Closed jobs often keep only soft-deleted posts, which Greenhouse hides unless asked.
      const inactive = rest.length
        ? await byIds<GhJobPost>('/v3/job_posts', 'job_ids', 'job posts', byJob, { active: false })(ctx, rest)
        : [];
      return [...active, ...inactive];
    }, byJob);
    const locationsByPost = idLookup<GhPostLocation>(
      '/v3/job_post_locations',
      'job_post_ids',
      'job post locations',
      (r) => r.job_post_id,
    );
    const customLocations = idLookup<GhCustomLocation>(
      '/v3/job_board_custom_locations',
      'ids',
      'job board locations',
      byId,
    );
    /** Every pay range, listed once per slice, if Greenhouse won't filter them by post. */
    let allPay: Promise<GhPayRange[]> | null = null;
    const payByPost = lookup<GhPayRange>(
      (ctx, ids) =>
        soft(
          ctx,
          '/v3/pay_input_ranges',
          'pay ranges',
          async () => {
            const wanted = new Set(ids);
            const mine = (r: GhPayRange) => wanted.has(String(r.job_post_id));
            if (!allPay) {
              try {
                return await listAll<GhPayRange>('/v3/pay_input_ranges', { job_post_ids: ids.join(',') }, mine);
              } catch (err) {
                // The reference documents no filters for this table: without job_post_ids, page it whole.
                if (!(err instanceof ImportHttpError && (err.status === 400 || err.status === 422))) throw err;
                allPay = listAll<GhPayRange>('/v3/pay_input_ranges', {});
              }
            }
            return (await allPay).filter(mine);
          },
          [] as GhPayRange[],
        ),
      (r) => r.job_post_id,
    );
    const payInputs = idLookup<GhPayInput>('/v3/pay_inputs', 'ids', 'pay range names', byId);
    const departments = idLookup<GhPlace>('/v3/departments', 'ids', 'departments', byId);
    const offices = idLookup<GhPlace>('/v3/offices', 'ids', 'offices', byId);
    const jobs = idLookup<GhJob>('/v3/jobs', 'ids', 'jobs', byId);
    const sources = idLookup<GhSource>('/v3/sources', 'ids', 'sources', byId);
    const referrers = idLookup<GhReferrer>('/v3/referrers', 'ids', 'referrer names', byId);
    // Core data: a refusal here should fail loudly, like the candidates list itself.
    const candidates = lookup<GhCandidate>((_ctx, ids) => {
      const wanted = new Set(ids);
      return listAll<GhCandidate>('/v3/candidates', { ids: ids.join(',') }, (r) => wanted.has(String(r.id)));
    }, byId);
    const stagesByApp = idLookup<GhApplicationStage>(
      '/v3/application_stages',
      'application_ids',
      'stage history',
      byApplication,
    );
    const prospectByApp = idLookup<GhProspectDetail>(
      '/v3/prospect_details',
      'application_ids',
      'prospect owners',
      byApplication,
    );
    const users = idLookup<GhUser>('/v3/users', 'ids', 'author names', byId, { show_service_accounts: true });
    const jobInterviews = idLookup<GhJobInterview>('/v3/job_interviews', 'ids', 'interview names', byId);
    const panelByInterview = idLookup<GhInterviewer>(
      '/v3/interviewers',
      'interview_ids',
      'interview panels',
      (r) => r.interview_id,
    );
    const panelByScorecard = idLookup<GhInterviewer>(
      '/v3/interviewers',
      'scorecard_ids',
      'scorecard-to-interview links',
      (r) => r.scorecard_id,
    );
    const kits = idLookup<GhInterviewKit>('/v3/interview_kits', 'ids', 'interview kits', byId);
    const answersByScorecard = idLookup<GhAnswer>(
      '/v3/scorecard_question_answers',
      'scorecard_ids',
      'scorecard answers',
      (r) => r.scorecard_id,
    );
    const questions = idLookup<GhQuestion>('/v3/scorecard_questions', 'ids', 'scorecard questions', byId);
    const options = idLookup<GhOption>('/v3/scorecard_question_options', 'ids', 'scorecard answer options', byId);
    const ratingsByScorecard = idLookup<GhAttributeRating>(
      '/v3/scorecard_candidate_attributes',
      'scorecard_ids',
      'scorecard attribute ratings',
      (r) => r.scorecard_id,
    );
    const attributes = idLookup<GhAttribute>('/v3/job_candidate_attributes', 'ids', 'scorecard attribute names', byId);

    /** Byline name for an author the engine can't match to a teammate (matched ones need none). */
    async function authorName(ctx: PhaseContext, userId: Key, upcoming: Key[]): Promise<string | null> {
      const id = keyOf(userId);
      if (!id || (await ctx.load.has('user', id))) return null;
      const [u] = await users.get(ctx, id, upcoming);
      return u ? userName(u) : null;
    }

    async function warnMissingScopes(ctx: PhaseContext) {
      // A fresh token: scopes are frozen into a token when it's minted.
      const scope = decodeClaims(await accessToken(http, credentials, true))?.scope;
      if (typeof scope !== 'string') return;
      const granted = new Set(scope.split(/\s+/));
      const wanted = [
        ...SCOPES.core,
        ...(ctx.options.activity ? SCOPES.activity : []),
        ...(ctx.options.offers ? SCOPES.offers : []),
        ...(ctx.options.files ? SCOPES.files : []),
      ].map(scopeName);
      const missing = [...new Set(wanted)].filter((s) => !granted.has(s));
      if (missing.length) {
        ctx.warn(
          `This Greenhouse credential is missing ${missing.length} scope(s), so that data will be skipped: ${missing.join(', ')}`,
        );
      }
    }

    /** Lowest non-template job id per requisition_id, listed once per slice (the ids aren't unique). */
    let codeOwners: Promise<Map<string, GhId>> | null = null;

    async function requisitionCode(job: GhJob): Promise<string> {
      const code = job.requisition_id?.trim();
      if (!code) return `GH-${job.id}`;
      codeOwners ??= listAll<GhJob>('/v3/jobs', {}).then((all) => {
        const owners = new Map<string, GhId>();
        for (const j of all) {
          const c = j.requisition_id?.trim();
          if (c && !j.is_template && (owners.get(c) ?? Number.MAX_SAFE_INTEGER) > j.id) owners.set(c, j.id);
        }
        return owners;
      });
      const owner = (await codeOwners).get(code);
      if (owner == null || owner === job.id) return code;
      // The loader links a repeated code to the first job's requisition, dropping this one's openings.
      const suffix = ` (GH-${job.id})`;
      return `${code.slice(0, MAX_CODE - suffix.length)}${suffix}`;
    }

    /** Where the posting says the job is: the post's locations, else the job's offices. */
    async function postingLocation(ctx: PhaseContext, item: Row<GhJob>, post: GhJobPost | null): Promise<string | null> {
      const job = item.row;
      const postOf = (j: GhJob) => bestPost(postsByJob.peek(j.id) ?? [])?.id;
      const spots = post
        ? [...(await locationsByPost.get(ctx, post.id, item.ahead(postOf)))].sort((a, b) => a.id - b.id)
        : [];
      const upcoming = () => item.ahead((j) => locationsByPost.peek(postOf(j)) ?? []).flat();
      const places = await offices.get(
        ctx,
        [...spots.map((s) => s.office_id), ...(job.office_ids ?? [])],
        [...upcoming().map((s) => s.office_id), ...item.ahead((j) => j.office_ids ?? []).flat()],
      );
      const custom = await customLocations.get(
        ctx,
        spots.map((s) => s.custom_location_id),
        upcoming().map((s) => s.custom_location_id),
      );
      const office = (id: Key) => {
        const o = places.find((p) => p.id === id);
        return o ? o.location || o.name : null;
      };
      const posted = cleanList(
        spots.map(
          (s) =>
            s.plain_text_location ||
            office(s.office_id) ||
            custom.find((c) => c.id === s.custom_location_id)?.value,
        ),
      );
      return (posted.length ? posted : cleanList((job.office_ids ?? []).map(office))).join('; ') || null;
    }

    /** No hired_at in v3: the opening the hire filled, else the accepted offer, else the last stage change. */
    async function hiredAt(ctx: PhaseContext, item: Row<GhApplication>, moves: GhApplicationStage[]): Promise<Date | null> {
      const app = item.row;
      const hired = (a: GhApplication) => a.status?.toLowerCase() === 'hired';
      const filled = await openingsByApp.get(ctx, app.id, item.ahead((a) => (hired(a) ? a.id : null)));
      const closed = filled.map((o) => toDate(o.closed_at)).find((d) => d != null);
      if (closed) return closed;
      const unfilled = (a: GhApplication) => hired(a) && !!openingsByApp.peek(a.id)?.every((o) => !o.closed_at);
      const offers = await offersByApp.get(ctx, app.id, item.ahead((a) => (unfilled(a) ? a.id : null)));
      const accepted = offers
        .filter((o) => o.status?.trim().toLowerCase() === 'accepted')
        .map((o) => toDate(o.resolved_at))
        .find((d) => d != null);
      if (accepted) return accepted;
      const last = moves.at(-1);
      return toDate(last?.exited_at) ?? toDate(last?.entered_at) ?? toDate(app.updated_at);
    }

    // ---------- Discover ----------

    const discover: Phase[] = [
      {
        id: 'users',
        label: 'Team members',
        async run(ctx, cursor) {
          if (cursor === null) await warnMissingScopes(ctx);
          // Service accounts are hidden by default; notes they wrote must still resolve.
          return pagedList<GhUser>(
            ctx,
            cursor,
            { path: '/v3/users', query: { show_service_accounts: true }, optional: 'team members' },
            async ({ row: u }) => {
              ctx.catalog.user({
                externalId: String(u.id),
                name: userName(u),
                email: cleanEmails([u.primary_email, ...(u.emails ?? [])])[0] ?? null,
              });
            },
          );
        },
      },
      {
        id: 'stages',
        label: 'Interview plans',
        async run(ctx, cursor) {
          const next = await pagedList<GhJobStage>(
            ctx,
            cursor,
            { path: '/v3/job_interview_stages', optional: 'interview plans' },
            async ({ row: s }) => {
              if (!s.name?.trim()) return;
              ctx.catalog.stage({
                externalId: String(s.id),
                name: s.name,
                position: s.sort_order ?? null,
                typeHint: stageHint(s),
              });
            },
          );
          if (next !== null) return next;
          // Hired and prospect are application statuses in Greenhouse, not stages.
          ctx.catalog.stage({ ...HIRED_STAGE, typeHint: 'HIRED', position: 99 });
          const prospects = await fetchPage<GhApplication>(null, '/v3/applications', { prospect: true, per_page: 1 });
          if (prospects.rows.length) {
            ctx.catalog.stage({ ...PROSPECT_STAGE, typeHint: 'LEAD', position: -1 });
          }
          return null;
        },
      },
      {
        id: 'reasons',
        label: 'Rejection reasons',
        async run(ctx) {
          // One step: the list is short, and a name reused across types must be seen whole to tell them apart.
          // Without include_defaults Greenhouse returns only org-created reasons.
          const reasons = await soft(
            ctx,
            '/v3/rejection_reasons',
            'rejection reasons',
            () => listAll<GhRejectionReason>('/v3/rejection_reasons', { include_defaults: true }),
            [],
          );
          for (const r of catalogReasons(reasons)) ctx.catalog.reason(r);
          return null;
        },
      },
    ];

    // ---------- Load ----------

    const load: Phase[] = [
      {
        id: 'requisitions',
        label: 'Requisitions',
        run: (ctx, cursor) =>
          pagedList<GhJob>(ctx, cursor, { path: '/v3/jobs', catchUp: true }, async (item) => {
            const job = item.row;
            if (job.is_template || (await ctx.load.has('requisition', String(job.id)))) return;
            const openings = await openingsByJob.get(ctx, job.id, item.ahead((j) => (j.is_template ? null : j.id)));
            await ctx.load.requisition(toRequisition(job, openings, await requisitionCode(job)));
          }),
      },
      {
        id: 'postings',
        label: 'Jobs',
        run: (ctx, cursor) =>
          pagedList<GhJob>(ctx, cursor, { path: '/v3/jobs', catchUp: true }, async (item) => {
            const job = item.row;
            if (job.is_template || (await ctx.load.has('posting', String(job.id)))) return;
            const post = bestPost(await postsByJob.get(ctx, job.id, item.ahead((j) => (j.is_template ? null : j.id))));
            const postOf = (j: GhJob) => bestPost(postsByJob.peek(j.id) ?? [])?.id;
            const ranges = post ? await payByPost.get(ctx, post.id, item.ahead(postOf)) : [];
            const inputs = await payInputs.get(
              ctx,
              ranges.map((r) => r.pay_input_id),
              item.ahead((j) => (payByPost.peek(postOf(j)) ?? []).map((r) => r.pay_input_id)).flat(),
            );
            const [dept] = await departments.get(ctx, job.department_id, item.ahead((j) => j.department_id));
            const location = await postingLocation(ctx, item, post);
            const salary = salaryOf(basePayRange(ranges, inputs), job.custom_fields);
            await ctx.load.posting({
              externalId: String(job.id),
              title: post?.title?.trim() || job.name,
              state: postingState(job, post),
              department: dept?.name ?? null,
              location,
              commitment: commitmentOf(job.custom_fields),
              workplaceType: workplaceOf(job.custom_fields, location),
              description: post?.content ? htmlToText(post.content) : null,
              salaryMin: salary?.min ?? null,
              salaryMax: salary?.max ?? null,
              salaryCurrency: salary?.currency ?? null,
              confidential: !!job.confidential,
              requisitionExternalId: String(job.id),
              createdAt: toDate(job.created_at),
            });
          }),
      },
      {
        id: 'candidates',
        label: 'Candidates',
        // Active-only imports take candidates from their applications instead, so people
        // whose every application is archived don't arrive as contacts.
        enabled: (o) => o.archived,
        run: (ctx, cursor) =>
          pagedList<GhCandidate>(ctx, cursor, { path: '/v3/candidates', since: true, catchUp: true }, ({ row }) =>
            ctx.load.candidate(toCandidate(row)),
          ),
      },
      {
        id: 'applications',
        label: 'Applications and stage history',
        run: (ctx, cursor) =>
          pagedList<GhApplication>(
            ctx,
            cursor,
            // The filter says "active"; the rows say "in_process".
            {
              path: '/v3/applications',
              since: true,
              query: ctx.options.archived ? {} : { status: 'active' },
              loose: ['status'],
              catchUp: true,
            },
            async (item) => {
              const app = item.row;
              const id = String(app.id);
              const status = app.status?.toLowerCase();
              const createdAt = toDate(app.created_at);
              // Server-side filters normally did this already; don't spend lookups on rows the loader drops.
              if (!ctx.options.archived && status && status !== 'in_process') return;
              if (ctx.since && createdAt && createdAt < ctx.since) return;
              if (await ctx.load.has('opportunity', id)) return;

              // Greenhouse never embeds the candidate, whose row also holds custom fields and the private flag.
              const [person] = await candidates.get(ctx, app.candidate_id, item.ahead((a) => a.candidate_id));

              const moves = [...(await stagesByApp.get(ctx, app.id, item.ahead((a) => a.id)))].sort(
                (a, b) =>
                  (toDate(a.entered_at)?.getTime() ?? 0) - (toDate(b.entered_at)?.getTime() ?? 0) || a.id - b.id,
              );
              const history: StageHistoryEntry[] = [];
              for (const m of moves) {
                const at = toDate(m.entered_at) ?? toDate(m.created_at);
                if (m.job_interview_stage_id == null || !at) continue;
                const current = m.job_interview_stage_id === app.job_interview_stage_id;
                history.push({
                  stage: { externalId: String(m.job_interview_stage_id), name: current ? app.stage_name : null },
                  at,
                });
              }

              // Current stage: the application's own, else (rejected, hired, prospects) where it stopped.
              let stage: StageRef | null = app.job_interview_stage_id
                ? { externalId: String(app.job_interview_stage_id), name: app.stage_name ?? null }
                : (history.at(-1)?.stage ?? (app.prospect ? PROSPECT_STAGE : null));
              let archivedAt: Date | null = null;
              if (status === 'hired') {
                archivedAt = await hiredAt(ctx, item, moves);
                stage = HIRED_STAGE;
                const lastMove = history.at(-1)?.at;
                if (archivedAt) {
                  history.push({ stage: HIRED_STAGE, at: lastMove && lastMove > archivedAt ? lastMove : archivedAt });
                }
              } else if (status === 'rejected') {
                archivedAt = toDate(app.rejected_at);
              } else if (status === 'converted') {
                archivedAt = toDate(app.updated_at);
              }

              const jobId = app.job_id ?? prospectiveJob(app);
              const [source] = await sources.get(ctx, app.source_id, item.ahead((a) => a.source_id));
              const [referrer] = await referrers.get(ctx, app.referrer_id, item.ahead((a) => a.referrer_id));
              const [job] = await jobs.get(ctx, jobId, item.ahead((a) => a.job_id ?? prospectiveJob(a)));
              let owner: Key = app.recruiter_id;
              if (owner == null && app.prospect) {
                const [detail] = await prospectByApp.get(ctx, app.id, item.ahead((a) => (a.prospect ? a.id : null)));
                owner = detail?.prospect_owner_id;
              }

              const fields: Record<string, string> = Object.fromEntries(fieldTexts(app.custom_fields));
              for (const a of app.answers ?? []) {
                if (a?.question?.trim() && a.answer?.trim()) {
                  fields[clip(a.question.trim(), 200)] = clip(a.answer.trim(), 4000);
                }
              }
              // Most org-defined data (desired salary, sponsorship…) lives on the candidate.
              Object.assign(fields, Object.fromEntries(fieldTexts(person?.custom_fields, 'Candidate · ')));
              if (status === 'converted') fields['Greenhouse status'] = 'Prospect converted to a candidate';
              const origin = originOf(app, source);
              // Referral credit (bonuses, reports) has no field in Source; keep who it went to.
              if (referrer?.name?.trim()) fields[origin === 'REFERRED' ? 'Referred by' : 'Credited to'] = referrer.name.trim();

              await ctx.load.application({
                externalId: id,
                candidateExternalId: String(app.candidate_id),
                candidate: person ? toCandidate(person) : null,
                postingExternalId: keyOf(jobId),
                stage,
                status:
                  status === 'hired' ? 'hired' : status === 'rejected' || status === 'converted' ? 'archived' : 'active',
                archiveReason: app.rejection_reason_id != null ? { externalId: String(app.rejection_reason_id) } : null,
                archivedAt,
                origin,
                source: source?.name?.trim() || null,
                ownerExternalUserId: keyOf(owner),
                // Confidential jobs and private candidates are visible only to some users in Greenhouse.
                confidential: !!job?.confidential || !!person?.private,
                createdAt,
                history,
                fields,
              });
            },
          ),
      },
      {
        id: 'interviews',
        label: 'Interviews',
        enabled: (o) => o.activity,
        run: (ctx, cursor) =>
          pagedList<GhInterview>(ctx, cursor, { path: '/v3/interviews', since: true, optional: 'interviews', catchUp: true }, async (item) => {
            const iv = item.row;
            const startAt = toDate(iv.starts_at) ?? toDate(iv.all_day_start_on);
            if (!startAt) return; // not scheduled yet
            if (await ctx.load.has('interview', String(iv.id))) return;
            if (!(await ctx.load.has('opportunity', String(iv.application_id)))) return;
            const [slot] = await jobInterviews.get(ctx, iv.job_interview_id, item.ahead((r) => r.job_interview_id));
            const panel = await panelByInterview.get(ctx, iv.id, item.ahead((r) => r.id));
            // The organizer has a panel row of their own, without a scorecard.
            const panelists = panel.filter((p) => p.scorecard_id != null || p.user_id !== iv.organizer_id);
            const endAt = toDate(iv.ends_at);
            await ctx.load.interview({
              externalId: String(iv.id),
              applicationExternalId: String(iv.application_id),
              title: slot?.name?.trim() || 'Interview',
              startAt,
              durationMins:
                endAt && iv.starts_at ? Math.round((endAt.getTime() - startAt.getTime()) / 60_000) : (slot?.duration ?? null),
              location: cleanList([iv.location, iv.video_conferencing_url]).join(' · ') || null,
              panelistExternalUserIds: cleanList(panelists.map((p) => keyOf(p.user_id))),
              state: interviewState(iv.status),
            });
          }),
      },
      {
        id: 'feedback',
        label: 'Scorecards',
        enabled: (o) => o.activity,
        run: (ctx, cursor) =>
          pagedList<GhScorecard>(
            ctx,
            cursor,
            {
              path: '/v3/scorecards',
              query: { status: 'complete' },
              since: true,
              optional: 'scorecards',
              loose: ['status'],
              catchUp: true,
            },
            async (item) => {
              const s = item.row;
              if (s.status && s.status !== 'complete') return; // drafts were never submitted
              const id = String(s.id);
              if (await ctx.load.has('feedback', id)) return;
              if (!(await ctx.load.has('opportunity', String(s.application_id)))) return;

              // No interview_id on a scorecard: the panel row that owns it has one.
              const [link] = await panelByScorecard.get(ctx, s.id, item.ahead((r) => r.id));
              const [kit] = await kits.get(ctx, s.interview_kit_id, item.ahead((r) => r.interview_kit_id));
              const [slot] = await jobInterviews.get(
                ctx,
                kit?.job_interview_id,
                item.ahead((r) => kits.peek(r.interview_kit_id)?.[0]?.job_interview_id),
              );

              const rows = await answersByScorecard.get(ctx, s.id, item.ahead((r) => r.id));
              const upcomingAnswers = () => item.ahead((r) => answersByScorecard.peek(r.id) ?? []).flat();
              const qs = await questions.get(
                ctx,
                rows.map((a) => a.scorecard_question_id),
                upcomingAnswers().map((a) => a.scorecard_question_id),
              );
              const opts = await options.get(ctx, rows.flatMap(optionIds), upcomingAnswers().flatMap(optionIds));
              const question = new Map(qs.map((q) => [q.id, q]));
              const option = (oid: unknown) => opts.find((o) => o.id === oid)?.name?.trim() || null;
              const answers = rows
                .map((a) => ({ a, q: question.get(a.scorecard_question_id) }))
                .filter(({ q }) => q?.answer_type !== 'instruction')
                .sort((x, y) => (x.q?.sort_order ?? 0) - (y.q?.sort_order ?? 0) || x.a.id - y.a.id)
                .map(({ a, q }) => ({ label: htmlToText(q?.question) || 'Question', value: answerText(a, q, option) }));

              // The "key attributes" section: each focus attribute rated, often with a note.
              const ratings = await ratingsByScorecard.get(ctx, s.id, item.ahead((r) => r.id));
              const named = await attributes.get(
                ctx,
                ratings.map((r) => r.job_candidate_attribute_id),
                item
                  .ahead((r) => ratingsByScorecard.peek(r.id) ?? [])
                  .flat()
                  .map((r) => r.job_candidate_attribute_id),
              );
              const attribute = new Map(named.map((x) => [x.id, x]));
              const rated = ratings
                .map((r) => ({ r, attr: attribute.get(r.job_candidate_attribute_id ?? -1) }))
                .sort((x, y) => (x.attr?.sort_order ?? 0) - (y.attr?.sort_order ?? 0) || x.r.id - y.r.id)
                .map(({ r, attr }) => ({ label: attr?.name?.trim() || 'Attribute', value: attributeText(r) }));

              const author = s.interviewer_id ?? s.submitter_id;
              await ctx.load.feedback({
                externalId: id,
                applicationExternalId: String(s.application_id),
                interviewExternalId: keyOf(link?.interview_id),
                authorExternalUserId: keyOf(author),
                authorName: await authorName(ctx, author, item.ahead((r) => r.interviewer_id ?? r.submitter_id)),
                rating: ratingOf(s.candidate_rating),
                title: slot?.name?.trim() || null,
                summary: scorecardSummary(s),
                answers: [...answers, ...rated].filter((x) => x.value),
                createdAt: toDate(s.submitted_at) ?? toDate(s.updated_at),
              });
            },
          ),
      },
      {
        id: 'notes',
        label: 'Notes and emails',
        enabled: (o) => o.activity,
        run: (ctx, cursor) =>
          pagedList<GhNote>(
            ctx,
            cursor,
            // Not date-filtered: candidate-level notes can predate the application they land on.
            {
              path: '/v3/notes',
              query: { type: Object.keys(NOTE_TYPES).join(',') },
              optional: 'notes',
              loose: ['type'],
              catchUp: true,
            },
            async (item) => {
              const n = item.row;
              if (!n.type || !Object.hasOwn(NOTE_TYPES, n.type)) return;
              const id = String(n.id);
              if (await ctx.load.has('note', id)) return;
              const parent =
                n.application_id != null
                  ? await ctx.load.has('opportunity', String(n.application_id))
                  : await ctx.load.has('contact', String(n.candidate_id));
              if (!parent) return;
              // Source notes have no private setting, and these were for admins' eyes only.
              if (n.visibility === 'admin_only_visible') return ctx.warn(ADMIN_ONLY_SKIPPED, { entity: 'note' });
              await ctx.load.note({
                externalId: id,
                applicationExternalId: keyOf(n.application_id),
                candidateExternalId: keyOf(n.candidate_id),
                authorExternalUserId: keyOf(n.user_id),
                authorName: await authorName(ctx, n.user_id, item.ahead((r) => r.user_id)),
                body: noteBody(n),
                createdAt: toDate(n.created_at),
              });
            },
          ),
      },
      {
        id: 'offers',
        label: 'Offers',
        enabled: (o) => o.offers,
        async run(ctx, cursor) {
          let seen = 0;
          const next = await pagedList<GhOffer>(
            ctx,
            cursor,
            // Offers are versioned; current_only keeps the latest (older ones read "Deprecated").
            {
              path: '/v3/offers',
              query: { current_only: true },
              since: true,
              optional: 'offers',
              loose: ['current_only'],
              catchUp: true,
            },
            async (item) => {
              seen++;
              const o = item.row;
              const status = offerStatus(o);
              if (!status) return;
              const id = String(o.id);
              if (await ctx.load.has('offer', id)) return;
              if (!(await ctx.load.has('opportunity', String(o.application_id)))) return;
              const [job] = await jobs.get(ctx, o.job_id, item.ahead((r) => r.job_id));
              await ctx.load.offer({ ...toOffer(o, status), jobTitle: job?.name?.trim() || null });
            },
          );
          // The first step reads the first page, so nothing seen there means Greenhouse listed none.
          if (cursor === null && !seen && credentials.actAsUserId?.trim() && !refused('/v3/offers')) {
            ctx.warn(
              'Greenhouse returned no offers. When an act-as user is set, it needs the permission to see ' +
                'private fields and salary, or offers come back empty.',
            );
          }
          return next;
        },
      },
      {
        id: 'files',
        label: 'Resumes and attachments',
        enabled: (o) => o.files,
        run: (ctx, cursor) =>
          pagedList<GhAttachment>(
            ctx,
            cursor,
            { path: '/v3/attachments', optional: 'attachments', catchUp: true },
            async ({ row: a }) => {
              if (a.candidate_id == null) return;
              if (!ctx.options.offers && a.type && OFFER_DOCUMENTS.has(a.type)) return;
              const resume = a.type === 'resume';
              // Files are reached through their application, so one on an application this import
              // skipped (archived, before `since`) would point nowhere. A resume can still become
              // the contact's own when it has none; the engine decides that.
              if (!resume && a.application_id != null && !(await ctx.load.has('opportunity', String(a.application_id)))) {
                return;
              }
              await ctx.load.file({
                externalId: String(a.id),
                candidateExternalId: String(a.candidate_id),
                applicationExternalId: keyOf(a.application_id),
                filename: a.filename?.trim() || `${a.type || 'attachment'}-${a.id}`,
                kind: resume ? 'resume' : 'other',
                download: () => downloadAttachment(a),
              });
            },
          ),
      },
    ];

    function toOffer(o: GhOffer, status: OfferStatus): Omit<ImportedOffer, 'jobTitle'> {
      const fields = o.custom_fields;
      const salary =
        findField(fields, (k, f) => f.type === 'currency' && /salary|base|pay|comp/i.test(labelOf(k, f))) ??
        findField(fields, (_k, f) => f.type === 'currency') ??
        findField(fields, (k, f) => /salary/i.test(labelOf(k, f)));
      const equity = findField(fields, (k, f) => /equity|stock|options?\b|rsu/i.test(labelOf(k, f)));
      const money = salary ? moneyOf(salary[1].value) : { amount: null, currency: null };
      const used = new Set([salary?.[0], equity?.[0]]);
      const rest = Object.entries(fields ?? {})
        .filter(([key, f]) => !used.has(key) && customText(f?.value))
        .map(([key, f]) => `${f?.name?.trim() || key}: ${customText(f?.value)}`);
      return {
        externalId: String(o.id),
        applicationExternalId: String(o.application_id),
        status,
        salaryAmount: money.amount,
        salaryCurrency: money.currency,
        equity: equity ? customText(equity[1].value) || null : null,
        startDate: toDate(o.starts_on),
        sentAt: toDate(o.sent_on),
        respondedAt: toDate(o.resolved_at),
        createdAt: toDate(o.created_at),
        notes: rest.join('\n') || null,
      };
    }

    /** Greenhouse download hosts that wanted the bearer token this slice. */
    const bearerHosts = new Set<string>();

    /**
     * One download. Signed storage URLs carry their own auth and never get
     * ours. A Greenhouse redirect endpoint that refuses (401/403) is asked
     * once more with the bearer token as a plain header: the client drops
     * caller headers when a redirect leaves the host, so the token never
     * reaches the storage host it points at.
     */
    async function fetchFile(url: string, a: GhAttachment): Promise<DownloadedFile> {
      let target: URL;
      try {
        target = new URL(url);
      } catch {
        throw new ImportHttpError(400, `attachment ${a.id}`, 'invalid download URL');
      }
      const get = async (headers?: Record<string, string>): Promise<DownloadedFile> => {
        const f = await http.bytes(url, headers ? { headers } : undefined);
        return { data: f.data, contentType: f.contentType, filename: f.filename };
      };
      // Only Greenhouse's own https hosts may see the token (the API host gets it from the client anyway).
      if (target.protocol !== 'https:' || !isGreenhouseHost(target.hostname) || target.host === host) return get();
      const withBearer = async () => get({ authorization: `Bearer ${await accessToken(http, credentials, false)}` });
      if (bearerHosts.has(target.host)) return withBearer();
      try {
        return await get();
      } catch (err) {
        if (!isRefusal(err)) throw err;
        const file = await withBearer();
        bearerHosts.add(target.host);
        return file;
      }
    }

    /** Signed URLs expire after 7 days: on refusal, re-list the attachment for a fresh one. */
    async function downloadAttachment(a: GhAttachment): Promise<DownloadedFile> {
      // The loader skips a file on ImportHttpError; an auth error would fail the whole job.
      const asHttp = (err: unknown) =>
        err instanceof ImportAuthError ? new ImportHttpError(err.status, err.where, 'download refused') : err;
      let first: unknown = new ImportHttpError(404, `attachment ${a.id}`, 'no download URL');
      if (a.url) {
        try {
          return await fetchFile(a.url, a);
        } catch (err) {
          const expired =
            (err instanceof ImportHttpError || err instanceof ImportAuthError) && [401, 403, 404, 410].includes(err.status);
          if (!expired) throw asHttp(err);
          first = err;
        }
      }
      let fresh: string | null = null;
      try {
        // Checked by id: a filter Greenhouse ignored must not hand this candidate someone else's file.
        const rows = await listAll<GhAttachment>('/v3/attachments', { ids: String(a.id) }, (r) => r.id === a.id);
        fresh = rows.find((r) => r.id === a.id)?.url ?? null;
      } catch (err) {
        if (!(err instanceof ImportAuthError) && isRetryable(err)) throw err;
      }
      if (!fresh || fresh === a.url) throw asHttp(first);
      try {
        return await fetchFile(fresh, a);
      } catch (err) {
        throw asHttp(err);
      }
    }

    return {
      async verify() {
        if (!apiHost(credentials)) {
          throw new Error('The Greenhouse API address override must be an https:// address on greenhouse.io');
        }
        // Always a fresh token: scopes are frozen into it at mint time.
        const token = await accessToken(http, credentials, true);
        const claims = decodeClaims(token);
        if (typeof claims?.scope === 'string') {
          const granted = new Set(claims.scope.split(/\s+/));
          const missing = SCOPES.verify.map(scopeName).filter((s) => !granted.has(s));
          if (missing.length) {
            throw new ImportAuthError(403, `the ${missing.join(', ')} scope${missing.length > 1 ? 's' : ''}`);
          }
        }
        // Proves list access; Harvest lists answer only for a Site Admin acting user.
        await http.json(`${api}/v3/jobs`, { per_page: 1 });
        let name = organizationName(claims);
        if (!name) {
          try {
            const res = await http.request<Introspection>({
              url: INTROSPECT_URL,
              method: 'POST',
              headers: { authorization: basicAuth(credentials), 'content-type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({ token, token_type_hint: 'access_token' }).toString(),
            });
            name = res.data?.['https://auth.greenhouse.io/claims']?.organization?.name?.trim() || null;
          } catch {
            name = null;
          }
        }
        return { accountName: name ?? 'Greenhouse' };
      },
      discover,
      load,
    };
  },
};
