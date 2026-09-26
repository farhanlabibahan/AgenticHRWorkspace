import { AsyncLocalStorage } from 'async_hooks';
import { createHash } from 'crypto';
import type { Commitment, OfferStatus, Origin, StageType, WorkplaceType } from '@prisma/client';
import { ImportAuthError, ImportHttpError, type AuthConfig, type HttpClient, type HttpResponse } from '@/server/imports/http';
import { each, optional, pagedStep, type Page, type PageCursor } from '@/server/imports/paging';
import { cleanEmails, cleanList, clip, fullName, htmlToText, toDate } from '@/server/imports/text';
import type {
  CatalogReason,
  CatalogWriter,
  Credentials,
  Cursor,
  DownloadedFile,
  ImportedCandidate,
  ImportedOffer,
  ImportedPosting,
  JsonValue,
  Phase,
  PhaseContext,
  ProviderModule,
  ReasonRef,
  StageRef,
} from '@/server/imports/types';

/**
 * SmartRecruiters (Customer API) → Source.
 *
 * Vendor quirks this adapter handles:
 * - Auth is an OAuth client-credentials pair (read-only scopes, Administrator
 *   system role). The secret goes in the form body (client_secret_post), not a
 *   Basic header: the engine re-sends request headers on a redirect but drops
 *   the body. The token endpoint lives on the API host itself, so the token
 *   request runs in an async context that tells getHeaders() to stay out of
 *   it. Tokens last ~30 minutes and have no refresh token. They are cached
 *   per credential across slices, and re-minted early or after a 401.
 * - A 401 is not always bad credentials: candidate, job and review endpoints
 *   answer 401 for a single record the credential may not see. Those records
 *   are skipped with a warning; a failure at the token endpoint stays fatal.
 * - The pipeline is a fixed status enum (LEAD, NEW, IN_REVIEW, INTERVIEW,
 *   OFFERED, HIRED) with free-text sub-statuses per hiring process. Stage ids
 *   are "STATUS" or "STATUS/Sub-status". REJECTED, WITHDRAWN and TRANSFERRED
 *   are outcomes, not stages: the stage is the last one before the outcome.
 * - Stage history needs its own scope (candidate_status_read). Without it an
 *   application has no moves, and its date comes from the Job Applications
 *   API instead of the candidate profile, which can be years older.
 * - An application's own id costs a call per application, and only
 *   interviews (and that date fallback) need it, so applications are keyed
 *   "candidateId:jobId".
 * - GET /candidates returns one row per application, so a candidate can
 *   appear on several pages. Its rows carry only job ids, which means each
 *   candidate also needs a detail call. Every phase walks this list with a
 *   window of recently seen ids in the cursor.
 * - Four paging styles: nextPageId (candidates, jobs, users), the Link header
 *   only (messages, a bare array), and offset (offers). Jobs must be sorted
 *   by job_id to page at all.
 * - Job pay carries a period. Monthly pay is annualized; hourly, daily and
 *   weekly pay has no annual figure and stays readable in the description.
 * - Candidate properties and screening answers are per-application calls and
 *   become application fields. EEO answers are left out.
 * - Messages have no id (hashed from candidate, author, time and text) and
 *   carry @[USER:id] tokens. Reviews are only a 1–5 rating plus a comment.
 * - Offers come from the org-wide offer search, where the job link is
 *   optional; without one, the offer is found in the candidate's
 *   per-application lists. Offer fields are account-defined strings, typed by
 *   /configuration/offer-properties; salary is read only from NUMBER or
 *   CURRENCY fields. Signed DocuSign documents download at 2 req/s.
 * - Files live in two lists, the candidate's and each application's, and the
 *   same id can be in both. The candidate-level entry may lack type and name,
 *   so the two are merged by id.
 * - A 403 on reviews, interviews, messages, properties or screening answers
 *   means the credential can't read that kind of data at all, so the phase
 *   warns once and stops.
 * - SAP's API Policy governs this API. The import is a customer-initiated
 *   data-portability export: deterministic code, the customer's own
 *   credential, published endpoints only, well inside the rate limit.
 */

const API_HOST = 'api.smartrecruiters.com';
const API = `https://${API_HOST}`;
const TOKEN_PATH = '/identity/oauth/token';
const PAGE_SIZE = 100;
/** Candidate ids remembered across pages to skip GET /candidates duplicates (~40 bytes each in the cursor). */
const SEEN_WINDOW = 500;
/** Re-mint this long before the token's stated expiry. */
const TOKEN_MARGIN_MS = 5 * 60_000;
/** Offer-document downloads have their own limit of 2 requests a second. */
const DOCUMENT_INTERVAL_MS = 550;
const RECRUITER_TTL_MS = 60 * 60_000;
const RECRUITER_CACHE_MAX = 5_000;

const enc = encodeURIComponent;

// ---------- Vendor payloads (only the fields we read) ----------

type SrList<T> = { content?: T[]; nextPageId?: string | null; totalFound?: number };
type SrLink = { url?: string };
type SrToken = { access_token?: string; expires_in?: number };
type SrCompany = { identifier?: string; name?: string };
type SrUser = { id: string; firstName?: string; lastName?: string; email?: string | null };
type SrHiringProcess = { id: string; subStatuses?: Partial<Record<string, string[]>> | null };
type SrReason = { id: string | number; label?: string };
type SrLocation = {
  city?: string;
  region?: string;
  regionCode?: string;
  country?: string;
  remote?: boolean;
  hybrid?: boolean;
};
type SrJobRow = { id: string };
type SrJob = {
  id: string;
  title?: string;
  createdOn?: string;
  status?: string;
  postingStatus?: string;
  template?: boolean;
  department?: { label?: string } | null;
  location?: SrLocation | null;
  typeOfEmployment?: { id?: string; label?: string } | null;
  compensation?: { min?: number; max?: number; currency?: string; period?: string } | null;
  jobAd?: { sections?: Record<string, { title?: string; text?: string } | undefined> } | null;
};
type SrPosition = { id: string; positionId?: string; type?: string; status?: string };
type SrHiringMember = { id: string; role?: string };
type SrJobRef = { job?: { id?: string | null } | null };
type SrAssignment = SrJobRef & {
  status?: string;
  subStatus?: string | null;
  source?: string | null;
  startsOn?: string | null;
  reasonOfRejection?: SrReason | null;
  reasonOfWithdrawal?: SrReason | null;
  actions?: { sourceDetails?: SrLink } | null;
};
type SrCandidateRow = { id: string; primaryAssignment?: SrJobRef | null; secondaryAssignments?: SrJobRef[] | null };
type SrCandidate = {
  id: string;
  internal?: boolean;
  firstName?: string;
  lastName?: string;
  email?: string | null;
  phoneNumber?: string | null;
  location?: SrLocation | null;
  web?: Record<string, string | null | undefined> | null;
  createdOn?: string;
  tags?: string[] | null;
  experience?: { title?: string; company?: string; current?: boolean }[] | null;
  primaryAssignment?: SrAssignment | null;
  secondaryAssignments?: SrAssignment[] | null;
};
type SrStatusChange = { changedOn?: string; status?: string; subStatus?: string | null };
type SrApplication = { applicationId?: string };
type SrJobApplication = { createDate?: string };
/** Unset properties come back as {}. CURRENCY is { code, value }; MULTI_SELECT is a list of value ids. */
type SrPropertyValue = string | number | boolean | string[] | { code?: string; value?: number | string } | null;
type SrProperty = {
  id?: string;
  key?: string;
  label?: string;
  type?: string;
  value?: SrPropertyValue;
  valueLabel?: string | null;
  selectedValueLabels?: { label?: string }[] | null;
};
type SrScreeningAnswer = {
  type?: string;
  category?: string;
  name?: string;
  label?: string;
  records?: { fields?: { label?: string; values?: { id?: string; label?: string }[] | null }[] | null }[] | null;
};
type SrReview = { id: string; reviewerId?: string; overallRating?: number | null; comment?: string | null; createdOn?: string };
type SrTimeslot = {
  id?: string;
  interviewType?: string;
  title?: string;
  place?: string;
  startsOn?: string;
  endsOn?: string;
  interviewers?: { id: string; status?: string }[];
  noShow?: boolean;
};
type SrInterview = { id: string; location?: string | null; timeslots?: SrTimeslot[] };
type SrMessage = {
  content?: string;
  createdOn?: string;
  visibility?: string;
  authorId?: string | null;
  context?: { applications?: { candidateId?: string; jobId?: string }[] } | null;
};
type SrOffer = {
  id: string;
  status?: string;
  createdOn?: string;
  updatedOn?: string;
  properties?: Record<string, string | number | boolean | null> | null;
  actions?: { candidate?: SrLink; job?: SrLink; details?: SrLink } | null;
};
type SrOfferProperty = { key: string; label?: string; type?: string };
type SrOfferConfig = { categories?: { properties?: SrOfferProperty[] }[] };
type SrOfferDocuments = { documents?: { id: string; name?: string }[] | null; isCurrentlySyncing?: boolean };
type SrAttachment = { id: string; name?: string; type?: string; contentType?: string; actions?: { download?: SrLink } | null };

/** Several endpoints return a bare array where others wrap it in { content }; accept both. */
function items<T>(data: T[] | { content?: T[] | null } | null | undefined): T[] {
  if (Array.isArray(data)) return data;
  return data?.content ?? [];
}

// ---------- Auth ----------

/**
 * The engine rebuilds auth and the adapter every slice (~20 s), but a token
 * lives 30 minutes and a hiring team doesn't change mid-import. These caches
 * outlive a slice, keyed by a hash of the credential; a cold start refetches.
 */
const tokenCache = new Map<string, { value: string; expiresAt: number }>();
const tokenMints = new Map<string, Promise<void>>();
const recruiterCache = new Map<string, { id: string | null; at: number }>();

function credentialKey(credentials: Credentials): string {
  const id = credentials.clientId?.trim() ?? '';
  const secret = credentials.clientSecret?.trim() ?? '';
  return createHash('sha256').update(`${id}\n${secret}`).digest('hex');
}

function oauth(credentials: Credentials): AuthConfig {
  const clientId = credentials.clientId?.trim() ?? '';
  const clientSecret = credentials.clientSecret?.trim() ?? '';
  const key = credentialKey(credentials);
  const tokenWhere = `POST ${API_HOST}${TOKEN_PATH}`;
  // Marks the token request's own async context, so getHeaders() neither recurses nor adds a bearer to it.
  const minting = new AsyncLocalStorage<true>();

  async function mint(http: HttpClient) {
    if (!clientId || !clientSecret) throw new ImportAuthError(401, tokenWhere);
    let res: HttpResponse<SrToken>;
    try {
      res = await minting.run(true, () =>
        http.request<SrToken>({
          url: `${API}${TOKEN_PATH}`,
          method: 'POST',
          body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }).toString(),
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
        }),
      );
    } catch (err) {
      // OAuth servers often answer a wrong client id or secret with 400 invalid_client.
      if (err instanceof ImportHttpError && err.status === 400) throw new ImportAuthError(401, tokenWhere);
      throw err;
    }
    const value = res.data?.access_token;
    if (!value) throw new ImportAuthError(401, tokenWhere);
    const ttlMs = (Number(res.data.expires_in) || 1800) * 1000;
    tokenCache.set(key, { value, expiresAt: Date.now() + Math.max(ttlMs / 2, ttlMs - TOKEN_MARGIN_MS) });
  }

  return {
    hosts: [API_HOST],
    // Job, department and property labels are localized; keep them in English.
    headers: { 'accept-language': 'en' },
    async getHeaders(http, { refresh }): Promise<Record<string, string>> {
      if (minting.getStore()) return {};
      const cached = tokenCache.get(key);
      if (refresh || !cached || Date.now() >= cached.expiresAt) {
        let pending = tokenMints.get(key);
        if (!pending) {
          pending = mint(http).finally(() => tokenMints.delete(key));
          tokenMints.set(key, pending);
        }
        await pending;
      }
      const token = tokenCache.get(key);
      if (!token) throw new ImportAuthError(401, tokenWhere);
      return { authorization: `Bearer ${token.value}` };
    },
  };
}

// ---------- Errors ----------

type WarnDetail = { entity?: string; externalId?: string };
type Denial = 401 | 403 | 404;

/** 401 on a record path (not the token endpoint) = SmartRecruiters withholding that one record. */
function denial(err: unknown): Denial | null {
  if (err instanceof ImportAuthError) {
    if (err.status === 403) return 403;
    return err.where.includes(TOKEN_PATH) ? null : 401;
  }
  if (err instanceof ImportHttpError && err.status === 404) return 404;
  return null;
}

const DENIAL_TEXT: Record<Denial, string> = {
  401: 'SmartRecruiters withheld some records from this credential (HTTP 401); they were skipped',
  403: "the credential's scopes or system role don't allow it (HTTP 403)",
  404: 'some records were no longer there (HTTP 404); they were skipped',
};

function absorb<T>(ctx: PhaseContext, what: string | null, err: unknown, fallback: T, detail?: WarnDetail): T {
  const status = denial(err);
  if (!status) throw err;
  if (what) ctx.warn(`${what}: ${DENIAL_TEXT[status]}`, detail);
  return fallback;
}

/**
 * Like optional(), for record-scoped sub-resources: also absorbs per-record
 * 401s, and words the warning without ids so repeats group into one issue.
 * `what: null` skips quietly (lookups whose absence is harmless).
 */
async function soft<T>(ctx: PhaseContext, what: string | null, fn: () => Promise<T>, fallback: T, detail?: WarnDetail): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    return absorb(ctx, what, err, fallback, detail);
  }
}

/** For data whose 403 means the whole credential lacks access: warn once, then stop calling. */
function scopeGate(ctx: PhaseContext, what: string) {
  let closed = false;
  return {
    isClosed: () => closed,
    async run<T>(fn: () => Promise<T>, fallback: T, detail?: WarnDetail): Promise<T> {
      if (closed) return fallback;
      try {
        return await fn();
      } catch (err) {
        if (!(err instanceof ImportAuthError && err.status === 403)) return absorb(ctx, what, err, fallback, detail);
        closed = true;
        ctx.warn(`${what} were not imported: ${DENIAL_TEXT[403]}`);
        return fallback;
      }
    },
  };
}

type ScopeGate = ReturnType<typeof scopeGate>;

/** A 401/403 on a download concerns that one file (access, or the malware scan): skip it, keep importing. */
function releaseError(err: unknown): unknown {
  return err instanceof ImportAuthError && !err.where.includes(TOKEN_PATH)
    ? new ImportHttpError(err.status, err.where, 'SmartRecruiters would not release this file')
    : err;
}

// ---------- Paging ----------

function linkNext(headers: Headers): string | null {
  for (const part of (headers.get('link') ?? '').split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="?next"?/i.exec(part);
    if (!m) continue;
    try {
      return new URL(m[1], API).searchParams.get('pageId');
    } catch {
      return null;
    }
  }
  return null;
}

/** The next cursor from the body or the Link header; a repeated cursor ends the list. */
function nextPage(res: HttpResponse<unknown>, current: string | undefined): string | null {
  const body = res.data && !Array.isArray(res.data) ? (res.data as { nextPageId?: string | null }).nextPageId : null;
  const next = body || linkNext(res.headers);
  return next && next !== current ? next : null;
}

type CandidateCursor = PageCursor & { seen?: string[] };

// ---------- Stages & reasons ----------

const PIPELINE = ['LEAD', 'NEW', 'IN_REVIEW', 'INTERVIEW', 'OFFERED', 'HIRED'] as const;
const WITH_SUBSTATUSES = new Set(['IN_REVIEW', 'INTERVIEW', 'OFFERED']);
const OUTCOMES = new Set(['REJECTED', 'WITHDRAWN', 'TRANSFERRED']);
const STATUS_LABEL: Record<string, string> = {
  LEAD: 'Lead',
  NEW: 'New',
  IN_REVIEW: 'In Review',
  INTERVIEW: 'Interview',
  OFFERED: 'Offered',
  HIRED: 'Hired',
};
/** Interview sub-statuses span phone screens to onsites, so their names decide (inferStageType). */
const TYPE_HINT: Record<string, StageType | null> = {
  LEAD: 'LEAD',
  NEW: 'APPLICANT',
  IN_REVIEW: 'SCREEN',
  INTERVIEW: null,
  OFFERED: 'OFFER',
  HIRED: 'HIRED',
};

function stageRef(status: string, subStatus?: string | null): StageRef {
  const sub = subStatus?.trim();
  return sub ? { externalId: `${status}/${sub}`, name: sub } : { externalId: status, name: STATUS_LABEL[status] ?? status };
}

/** One hiring process in pipeline order; a status without sub-statuses is a stage of its own. */
function emitPipeline(catalog: CatalogWriter, subStatuses: Partial<Record<string, string[]>> | null) {
  let position = 0;
  for (const status of PIPELINE) {
    const subs = WITH_SUBSTATUSES.has(status) ? cleanList(subStatuses?.[status] ?? []) : [];
    for (const sub of subs.length ? subs : [null]) {
      const ref = stageRef(status, sub);
      catalog.stage({ externalId: ref.externalId!, name: ref.name!, typeHint: TYPE_HINT[status], position: position++ });
    }
  }
}

/** Outcomes that carry no vendor reason still get one, so hires and withdrawals aren't counted as rejections. */
const OUTCOME_REASONS: Record<string, CatalogReason> = {
  HIRED: { externalId: 'status:HIRED', name: 'Hired', kind: 'hired' },
  REJECTED: { externalId: 'status:REJECTED', name: 'Rejected', kind: 'rejection' },
  WITHDRAWN: { externalId: 'status:WITHDRAWN', name: 'Withdrawn', kind: 'withdrawn' },
  // A move to another job, not a rejection. ReasonKind has no neutral kind; 'withdrawn' keeps it out of rejection counts.
  TRANSFERRED: { externalId: 'status:TRANSFERRED', name: 'Transferred to another job', kind: 'withdrawn' },
};

function archiveReason(a: SrAssignment): ReasonRef | null {
  const vendor = a.status === 'REJECTED' ? a.reasonOfRejection : a.status === 'WITHDRAWN' ? a.reasonOfWithdrawal : null;
  const label = vendor?.label?.trim();
  if (vendor?.id != null && label) {
    if (a.status === 'REJECTED') return { externalId: `rejection:${vendor.id}`, name: label };
    // A reason discovery listed resolves by id. One it couldn't list (403, or since removed) is created from its
    // name, and the loader decides from the name whether it counts as a rejection; say it was a withdrawal.
    return { externalId: `withdrawal:${vendor.id}`, name: /withdr[ae]w|declined/i.test(label) ? label : `Withdrew: ${label}` };
  }
  const outcome = OUTCOME_REASONS[a.status ?? ''];
  return outcome ? { externalId: outcome.externalId, name: outcome.name } : null;
}

function appStatus(status: string | undefined): 'active' | 'archived' | 'hired' {
  if (status === 'HIRED') return 'hired';
  return status && OUTCOMES.has(status) ? 'archived' : 'active';
}

function appKey(candidateId: string, jobId: string): string {
  return `${candidateId}:${jobId}`;
}

/** Referral/agency/sourcing from the source type in the sourceDetails link (…/sources/{TYPE}/values/…) and label. */
function origin(a: SrAssignment, statuses: string[], internal: boolean): Origin {
  if (a.status === 'LEAD' || statuses.includes('LEAD')) return 'SOURCED';
  const type = /\/configuration\/sources\/([^/]+)\//.exec(a.actions?.sourceDetails?.url ?? '')?.[1] ?? '';
  const hay = `${type} ${a.source ?? ''}`;
  if (/referr/i.test(hay)) return 'REFERRED';
  if (/agenc/i.test(hay)) return 'AGENCY';
  if (/universit|campus|college/i.test(hay)) return 'UNIVERSITY';
  if (internal || /internal|mobility/i.test(hay)) return 'INTERNAL';
  if (/\bcrm\b|sourc|talent.?pool|prospect|headhunt/i.test(hay)) return 'SOURCED';
  return 'APPLIED';
}

// ---------- Jobs ----------

function place(l: SrLocation | null | undefined): string | null {
  if (!l) return null;
  return cleanList([l.city, l.region || l.regionCode, l.country]).join(', ') || null;
}

function workplace(l: SrLocation | null | undefined): WorkplaceType | null {
  if (!l) return null;
  return l.remote ? 'REMOTE' : l.hybrid ? 'HYBRID' : 'ONSITE';
}

/** typeOfEmployment ids/labels are per-account ("permanent"/"Full-time"), so match loosely. */
function commitment(t: SrJob['typeOfEmployment']): Commitment | null {
  const s = `${t?.id ?? ''} ${t?.label ?? ''}`.toLowerCase();
  if (/intern|trainee|apprentic/.test(s)) return 'INTERNSHIP';
  if (/part/.test(s)) return 'PART_TIME';
  if (/contract|temporary|freelance|fixed.?term/.test(s)) return 'CONTRACT';
  if (/full|permanent|regular/.test(s)) return 'FULL_TIME';
  return null;
}

function jobState(j: SrJob): ImportedPosting['state'] {
  switch (j.status) {
    case 'CREATED':
      return 'draft';
    case 'SOURCING':
    case 'INTERVIEW':
    case 'OFFER':
      return j.postingStatus === 'INTERNAL' ? 'internal' : 'open';
    default:
      return 'closed'; // FILLED, CANCELLED, ON_HOLD, OTHER
  }
}

const AD_SECTIONS = ['companyDescription', 'jobDescription', 'qualifications', 'additionalInformation'];

function description(j: SrJob): string | null {
  const sections = j.jobAd?.sections ?? {};
  const parts = AD_SECTIONS.map((key) => {
    const body = htmlToText(sections[key]?.text);
    const title = sections[key]?.title?.trim();
    return body && title ? `${title}\n${body}` : body;
  }).filter(Boolean);
  return parts.join('\n\n') || null;
}

function positionState(p: SrPosition, jobClosed: boolean): 'open' | 'on_hold' | 'closed' {
  // Position status is a free string in the schema; the values below are the likely ones.
  const s = (p.status ?? '').toUpperCase();
  if (s.includes('HOLD')) return 'on_hold';
  if (/FILL|CLOS|CANCEL|REMOV/.test(s)) return 'closed';
  if (/OPEN|ACTIVE|APPROVED/.test(s)) return 'open';
  return jobClosed ? 'closed' : 'open';
}

function money(n: unknown): number | null {
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

const PAY_PERIOD: Record<string, string> = { HOURLY: 'hour', DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month' };

/** Source stores annual pay: yearly (or no period) passes through, monthly is ×12, shorter periods have no annual figure. */
function annualPay(j: SrJob): { min: number | null; max: number | null; currency: string | null } {
  const comp = j.compensation;
  const factor = !comp?.period || comp.period === 'YEARLY' ? 1 : comp.period === 'MONTHLY' ? 12 : null;
  const min = money(comp?.min);
  const max = money(comp?.max);
  if (factor == null || (min == null && max == null)) return { min: null, max: null, currency: null };
  return { min: min != null ? min * factor : null, max: max != null ? max * factor : null, currency: comp?.currency ?? null };
}

/** Pay in any period but yearly, as SmartRecruiters states it ("Salary: 45–60 EUR per hour"). */
function payText(j: SrJob): string | null {
  const comp = j.compensation;
  if (!comp?.period || comp.period === 'YEARLY') return null;
  const range = [...new Set([money(comp.min), money(comp.max)].filter((n): n is number => n != null))];
  if (!range.length) return null;
  return cleanList(['Salary:', range.join('–'), comp.currency, `per ${PAY_PERIOD[comp.period] ?? comp.period.toLowerCase()}`]).join(' ');
}

// ---------- Candidates ----------

function links(web: SrCandidate['web']): string[] {
  const out: (string | null)[] = [];
  for (const [kind, raw] of Object.entries(web ?? {})) {
    const v = raw?.trim();
    if (!v || kind === 'skype') continue;
    if (/^https?:\/\//i.test(v)) out.push(v);
    else if (kind === 'twitter') out.push(`https://x.com/${v.replace(/^@/, '')}`);
    else if (/^[\w.-]+\.[a-z]{2,}(\/\S*)?$/i.test(v)) out.push(`https://${v}`);
  }
  return cleanList(out);
}

function toCandidate(c: SrCandidate): ImportedCandidate {
  const current = c.experience?.find((e) => e.current && (e.title || e.company));
  return {
    externalId: String(c.id),
    name: fullName(c.firstName, c.lastName),
    emails: cleanEmails([c.email]),
    phones: cleanList([c.phoneNumber]),
    links: links(c.web),
    headline: current ? cleanList([current.title, current.company]).join(' at ') : null,
    location: place(c.location),
    tags: cleanList(c.tags ?? []),
    createdAt: toDate(c.createdOn),
  };
}

function rowJobIds(row: SrCandidateRow): string[] {
  const refs = [row.primaryAssignment, ...(row.secondaryAssignments ?? [])];
  return cleanList(refs.map((r) => (r?.job?.id != null ? String(r.job.id) : null)));
}

// ---------- Application fields ----------

/** Select values are option ids; only their labels mean anything. */
const SELECT_TYPES = new Set(['SINGLE_SELECT', 'MULTI_SELECT', 'SELECT']);

/** A candidate property as text, or null when unset. USER values are user ids (the caller names them). */
function propertyText(p: SrProperty): string | null {
  const labels = cleanList((p.selectedValueLabels ?? []).map((l) => l?.label));
  if (labels.length) return labels.join(', ');
  if (p.valueLabel?.trim()) return p.valueLabel.trim();
  const v = p.value;
  if (v == null || Array.isArray(v) || SELECT_TYPES.has(p.type ?? '')) return null;
  if (typeof v === 'object') return v.value == null || v.value === '' ? null : cleanList([String(v.value), v.code]).join(' ');
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  const s = String(v).trim();
  if (!s) return null;
  if (p.type === 'PERCENT') return `${s}%`;
  return p.type === 'DATE' && /^\d{4}-\d{2}-\d{2}T/.test(s) ? s.slice(0, 10) : s;
}

/** EEO and OFCCP answers belong in a restricted store, not in fields every teammate can read. */
const EEO_CATEGORIES = new Set([
  'eeoInformation',
  'ofccpDisability',
  'ofccpVeteransForm',
  'veteranStatus',
  'disabilityStatus',
  'ofccpReasonableAccommodation',
  'ethnicity',
  'ethnicGroupsDescriptions',
]);
/** Question types with no answer to keep: EEO, info blocks, and uploads (those arrive as attachments). */
const SKIP_ANSWER_TYPES = new Set(['eeo', 'info', 'files']);

/** One answer per record ("Language: English; Proficiency level: Advanced | …"). */
function screeningText(q: SrScreeningAnswer): string | null {
  const records = (q.records ?? []).map((r) => {
    const fields = (r.fields ?? [])
      .map((f) => ({ label: f.label?.trim(), value: cleanList((f.values ?? []).map((v) => v?.label ?? v?.id)).join(', ') }))
      .filter((f) => f.value);
    // The vendor's guidance: ignore labels for answers with a single field.
    return fields.length === 1 ? fields[0].value : fields.map((f) => (f.label ? `${f.label}: ${f.value}` : f.value)).join('; ');
  });
  return cleanList(records).join(' | ') || null;
}

function putField(fields: Record<string, string>, label: string, value: string) {
  let key = clip(label, 200);
  for (let n = 2; Object.hasOwn(fields, key); n++) key = `${clip(label, 190)} (${n})`;
  fields[key] = clip(value, 2000);
}

// ---------- Feedback ----------

/** overallRating is 1–5 stars. 3 is neutral; with no neutral in Source it reads as "no", and the raw score is kept. */
const RATING: Record<number, 1 | 2 | 3 | 4> = { 1: 1, 2: 2, 3: 2, 4: 3, 5: 4 };

// ---------- Offers ----------

const OFFER_STATUS: Record<string, OfferStatus> = {
  CREATED: 'DRAFT',
  APPROVED: 'DRAFT', // approved, not sent yet
  PENDING_APPROVAL: 'PENDING_APPROVAL',
  NOT_APPROVED: 'WITHDRAWN', // turned down by an approver; never reached the candidate
  PENDING_ACCEPTANCE: 'SENT',
  ACCEPTED: 'ACCEPTED',
  NOT_ACCEPTED: 'DECLINED',
  ABANDONED: 'WITHDRAWN',
};

/** Offers that reached the candidate: the only ones that can have signed documents. */
const SENT_OFFER = new Set(['PENDING_ACCEPTANCE', 'ACCEPTED', 'NOT_ACCEPTED']);

/** Salary lives in a NUMBER or CURRENCY field named like one; bands, grades, bonuses and review dates only look like it. */
const SALARY_FIELD = /salary|base.?pay|compensation/;
const NOT_SALARY_FIELD = /bonus|band|grade|range|review|date|%|percent|increase|commission|allowance|relocation|sign.?on|equity|stock|expect/;
const SALARY_TYPES = new Set(['NUMBER', 'CURRENCY']);

function salaryScore(hay: string): number {
  if (!SALARY_FIELD.test(hay) || NOT_SALARY_FIELD.test(hay)) return 0;
  return /base/.test(hay) ? 3 : /salary/.test(hay) ? 2 : 1;
}

/**
 * Digits with thousands and decimal separators in either convention: "172,500.00", "60.000,00", "65.000".
 * The last separator is the decimal point unless it's the only kind, repeated or followed by exactly three digits.
 */
function toNumber(raw: string): number | null {
  const s = raw.replace(/[\s' ]/g, '');
  if (!/^\d[\d.,]*$/.test(s)) return null;
  const seps = s.match(/[.,]/g) ?? [];
  let normalized = s;
  if (seps.length) {
    const last = Math.max(s.lastIndexOf('.'), s.lastIndexOf(','));
    const int = s.slice(0, last);
    const frac = s.slice(last + 1);
    const grouping = new Set(seps).size === 1 && (seps.length > 1 || (frac.length === 3 && int !== '0'));
    normalized = grouping ? s.replace(/[.,]/g, '') : `${int.replace(/[.,]/g, '')}.${frac}`;
  }
  return money(Number(normalized));
}

/** An amount, optionally with an ISO code or symbol ("USD 120,000", "65.000 EUR"); nothing else ("B3", "2027-01-01") is one. */
const AMOUNT = /^(?:([A-Za-z]{3})\s*|[$€£¥]\s*)?(\d[\d.,'\s ]*?)\s*(?:([A-Za-z]{3})|[$€£¥])?$/;

function parseAmount(value: string): { amount: number | null; currency: string | null } {
  const v = value.trim();
  if (v.startsWith('{')) {
    try {
      const parsed = JSON.parse(v) as { value?: unknown; code?: unknown };
      return { amount: money(Number(parsed.value)), currency: typeof parsed.code === 'string' ? parsed.code.toUpperCase() : null };
    } catch {
      return { amount: null, currency: null };
    }
  }
  const m = AMOUNT.exec(v);
  if (!m) return { amount: null, currency: null };
  return { amount: toNumber(m[2]), currency: (m[1] ?? m[3])?.toUpperCase() ?? null };
}

function pathId(url: string | undefined, re: RegExp, group = 1): string | null {
  const raw = re.exec(url ?? '')?.[group];
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * Candidate and job ids of an offer search result, from actions.candidate and
 * actions.job (optional in the schema). The details link has the
 * /candidates/{id}/jobs/{id}/offers/{id} shape in the per-application list;
 * its shape in the search is undocumented, so it is only a second guess.
 */
function offerRefs(o: SrOffer): { candidateId: string | null; jobId: string | null } {
  const details = o.actions?.details?.url;
  const nested = /\/candidates\/([^/?#]+)\/jobs\/([^/?#]+)\/offers\//;
  return {
    candidateId: pathId(o.actions?.candidate?.url, /\/candidates\/([^/?#]+)/) ?? pathId(details, nested, 1),
    jobId: pathId(o.actions?.job?.url, /\/jobs\/([^/?#]+)/) ?? pathId(details, nested, 2),
  };
}

// ---------- Files ----------

/** Profile pictures and company logos aren't documents. */
const SKIP_FILE_TYPES = new Set(['AVATAR', 'LOGO', 'URL']);

/** One attachment seen in two lists: keep what each knows (the candidate-level entry may lack type, name and content type). */
function mergeAttachment(a: SrAttachment, b: SrAttachment): SrAttachment {
  return {
    id: a.id,
    name: a.name?.trim() || b.name,
    type: a.type || b.type,
    contentType: a.contentType || b.contentType,
    actions: a.actions?.download?.url ? a.actions : b.actions,
  };
}

// ---------- The adapter ----------

export const smartrecruitersProvider: ProviderModule = {
  id: 'smartrecruiters',
  // Published limit: 10 req/s and 8 in flight per credential. We stay near 6.7/s, one request at a time.
  minIntervalMs: 150,
  auth: oauth,

  create(credentials, http) {
    const cacheKey = credentialKey(credentials);
    // Per-slice state; the engine builds a fresh adapter for every slice.
    const userNames = new Map<string, string | null>();
    let jobApplicationsDenied = false;
    let lastDocumentAt = 0;

    async function lookupUser(ctx: PhaseContext, id: string): Promise<string | null> {
      if (userNames.has(id)) return userNames.get(id)!;
      const u = await soft(ctx, null, () => http.json<SrUser>(`${API}/user-api/v201804/users/${enc(id)}`), null);
      const name = u ? fullName(u.firstName, u.lastName, u.email?.trim() || '') || null : null;
      userNames.set(id, name);
      return name;
    }

    /** The original author's name, needed only when they aren't a teammate in Source (for the byline). */
    async function authorName(ctx: PhaseContext, id: string | null): Promise<string | null> {
      if (!id || (await ctx.load.has('user', id))) return null;
      return lookupUser(ctx, id);
    }

    /** Applications carry no owner; SmartRecruiters' equivalent is the job's recruiter. */
    async function recruiterFor(ctx: PhaseContext, jobId: string): Promise<string | null> {
      const key = `${cacheKey}:${jobId}`;
      const hit = recruiterCache.get(key);
      if (hit && Date.now() - hit.at < RECRUITER_TTL_MS) return hit.id;
      const team = await soft(
        ctx,
        'Hiring teams',
        () => http.json<SrList<SrHiringMember>>(`${API}/jobs/${enc(jobId)}/hiring-team`),
        null,
        { entity: 'job', externalId: jobId },
      );
      const found = items(team).find((m) => m.role === 'RECRUITER')?.id;
      const id = found != null ? String(found) : null;
      if (recruiterCache.size >= RECRUITER_CACHE_MAX) {
        const oldest = recruiterCache.keys().next().value;
        if (oldest !== undefined) recruiterCache.delete(oldest);
      }
      recruiterCache.set(key, { id, at: Date.now() });
      return id;
    }

    async function candidatePage(ctx: PhaseContext, page: JsonValue): Promise<Page<SrCandidateRow>> {
      const pageId = typeof page === 'string' ? page : undefined;
      const res = await http.request<SrList<SrCandidateRow>>({
        url: `${API}/candidates`,
        // The candidate search has no created-after filter; updated-after is a superset, and the loader trims to `since`.
        query: { limit: PAGE_SIZE, pageId, updatedAfter: ctx.since?.toISOString() },
      });
      const unique = new Map<string, SrCandidateRow>();
      for (const row of res.data?.content ?? []) if (row?.id != null && !unique.has(String(row.id))) unique.set(String(row.id), row);
      return { items: [...unique.values()], next: nextPage(res, pageId) };
    }

    /** Walk GET /candidates once per phase, handling each candidate once despite the per-application rows. */
    async function eachCandidate(
      ctx: PhaseContext,
      cursor: Cursor | null,
      handle: (row: SrCandidateRow) => Promise<void>,
    ): Promise<Cursor | null> {
      const at = cursor as CandidateCursor | null;
      const seen = new Set(at?.seen ?? []);
      const next = await pagedStep(ctx, at ? { page: at.page, index: at.index } : null, (p) => candidatePage(ctx, p), async (row) => {
        const id = String(row.id);
        if (seen.has(id)) return;
        seen.add(id);
        await handle(row);
      });
      if (next === null) return null;
      return { ...(next as PageCursor), seen: [...seen].slice(-SEEN_WINDOW) };
    }

    /** Job ids of this candidate's applications that made it into Source. */
    async function importedJobs(ctx: PhaseContext, row: SrCandidateRow): Promise<string[]> {
      const out: string[] = [];
      for (const jobId of rowJobIds(row)) if (await ctx.load.has('opportunity', appKey(String(row.id), jobId))) out.push(jobId);
      return out;
    }

    // ---------- load: jobs ----------

    async function importJob(ctx: PhaseContext, row: SrJobRow) {
      const jobId = String(row.id);
      if (await ctx.load.has('posting', jobId)) return; // imported by an earlier run; skip the detail calls
      const job = await soft(ctx, 'Jobs', () => http.json<SrJob>(`${API}/jobs/${enc(jobId)}`), null, { entity: 'job', externalId: jobId });
      if (!job || job.template) return; // templates are blueprints, not roles
      const state = jobState(job);
      const title = job.title?.trim() || 'Untitled job';
      const pay = annualPay(job);

      const positions = items(
        await soft(ctx, 'Job positions', () => http.json<SrList<SrPosition>>(`${API}/jobs/${enc(jobId)}/positions`), null, {
          entity: 'job',
          externalId: jobId,
        }),
      );
      // Each position is one headcount slot with its own code; the posting links the first still-open one.
      for (const p of positions) {
        await each(ctx, p, () =>
          ctx.load.requisition({
            externalId: String(p.id),
            code: p.positionId?.trim() || String(p.id),
            title,
            state: positionState(p, state === 'closed'),
            openings: 1,
            filled: /FILL/i.test(p.status ?? '') ? 1 : 0,
            backfill: p.type === 'REPLACEMENT',
            salaryMin: pay.min,
            salaryMax: pay.max,
            salaryCurrency: pay.currency,
          }),
        );
      }
      const linked = positions.find((p) => positionState(p, state === 'closed') === 'open') ?? positions[0];

      await ctx.load.posting({
        externalId: jobId,
        title,
        state,
        department: job.department?.label ?? null,
        location: place(job.location),
        workplaceType: workplace(job.location),
        commitment: commitment(job.typeOfEmployment),
        description: cleanList([description(job), payText(job)]).join('\n\n') || null,
        salaryMin: pay.min,
        salaryMax: pay.max,
        salaryCurrency: pay.currency,
        requisitionExternalId: linked ? String(linked.id) : null,
        createdAt: toDate(job.createdOn),
      });
    }

    // ---------- load: candidates & applications ----------

    type Change = { status: string; subStatus: string | null | undefined; at: Date };

    /** An application's status changes, oldest first; null when the credential can't read them. */
    async function statusHistory(ctx: PhaseContext, candidateId: string, jobId: string): Promise<Change[] | null> {
      let list: SrList<SrStatusChange>;
      try {
        list = await http.json<SrList<SrStatusChange>>(`${API}/candidates/${enc(candidateId)}/jobs/${enc(jobId)}/status/history`);
      } catch (err) {
        const status = denial(err);
        if (!status) throw err;
        ctx.warn(
          status === 403
            ? "Stage history: the credential can't read it (HTTP 403; it needs the candidate_status_read scope). Those applications were imported without their stage moves"
            : `Stage history: ${DENIAL_TEXT[status]}`,
          { entity: 'application', externalId: appKey(candidateId, jobId) },
        );
        return null;
      }
      return items(list)
        .map((h) => ({ status: h.status ?? '', subStatus: h.subStatus, at: toDate(h.changedOn) }))
        .filter((h): h is Change => !!h.status && !!h.at)
        .sort((x, y) => x.at.getTime() - y.at.getTime());
    }

    /** Created date without status history: the Job Applications API's createDate, keyed by the application's own id. */
    async function applicationCreated(ctx: PhaseContext, candidateId: string, jobId: string): Promise<Date | null> {
      if (jobApplicationsDenied) return null;
      const app = await soft(ctx, null, () => http.json<SrApplication>(`${API}/candidates/${enc(candidateId)}/jobs/${enc(jobId)}`), null);
      if (!app?.applicationId) return null;
      try {
        const record = await http.json<SrJobApplication>(`${API}/job-applications-api/v202112/job-applications/${enc(app.applicationId)}`);
        return toDate(record?.createDate);
      } catch (err) {
        // No job_applications_read scope: stop asking for the rest of this slice.
        if (err instanceof ImportAuthError && err.status === 403) jobApplicationsDenied = true;
        return absorb(ctx, null, err, null);
      }
    }

    type FieldGates = { properties: ScopeGate; screening: ScopeGate };

    /** Start date, candidate properties and screening answers, as the application's custom fields. */
    async function applicationFields(
      ctx: PhaseContext,
      candidateId: string,
      jobId: string,
      a: SrAssignment,
      gates: FieldGates,
    ): Promise<Record<string, string> | undefined> {
      const fields: Record<string, string> = {};
      if (a.startsOn) fields['Start date'] = a.startsOn.slice(0, 10);
      const base = `${API}/candidates/${enc(candidateId)}/jobs/${enc(jobId)}`;
      const detail = { entity: 'application', externalId: appKey(candidateId, jobId) };

      const properties = await gates.properties.run(
        // The per-application endpoint; the candidate-level one is deprecated and never returns MULTI_SELECT.
        () => http.json<SrList<SrProperty>>(`${base}/properties`, { includeMultiSelect: true }),
        null,
        detail,
      );
      for (const p of items(properties)) {
        let value = propertyText(p);
        if (value && p.type === 'USER') value = (await lookupUser(ctx, value)) ?? value;
        const label = p.label?.trim() || p.key?.trim() || p.id;
        if (value && label) putField(fields, label, value);
      }

      const answers = await gates.screening.run(() => http.json<SrList<SrScreeningAnswer>>(`${base}/screening-answers`), null, detail);
      for (const q of items(answers)) {
        if (EEO_CATEGORIES.has(q.category ?? '') || SKIP_ANSWER_TYPES.has(q.type ?? '')) continue;
        const value = screeningText(q);
        const label = q.label?.trim() || q.name?.trim();
        if (value && label) putField(fields, label, value);
      }
      return Object.keys(fields).length ? fields : undefined;
    }

    async function importApplication(ctx: PhaseContext, c: SrCandidate, candidate: ImportedCandidate, a: SrAssignment, gates: FieldGates) {
      const candidateId = String(c.id);
      const jobId = String(a.job!.id);
      const key = appKey(candidateId, jobId);
      if (await ctx.load.has('opportunity', key)) return;
      const status = appStatus(a.status);

      // History, fields and the owner cost calls; not worth them for an application the loader will skip.
      const wanted = ctx.options.archived || status === 'active';
      const history = wanted ? await statusHistory(ctx, candidateId, jobId) : [];
      const changes = history ?? [];
      const moves = changes.filter((h) => !OUTCOMES.has(h.status));
      const last = moves[moves.length - 1];
      const stage =
        a.status && !OUTCOMES.has(a.status) ? stageRef(a.status, a.subStatus) : last ? stageRef(last.status, last.subStatus) : null;
      const outcomeAt = changes.filter((h) => h.status === a.status).pop()?.at ?? null;
      const profileCreated = toDate(c.createdOn);
      const createdAt =
        changes[0]?.at ??
        (history === null ? await applicationCreated(ctx, candidateId, jobId) : null) ??
        // The profile can predate this application by years; don't let it push a recent one before `since`.
        (ctx.since && profileCreated && profileCreated < ctx.since ? null : profileCreated);

      await ctx.load.application({
        externalId: key,
        candidateExternalId: candidateId,
        candidate,
        postingExternalId: jobId,
        stage,
        status,
        archiveReason: status === 'active' ? null : archiveReason(a),
        archivedAt: status === 'active' ? null : outcomeAt,
        origin: origin(a, changes.map((h) => h.status), !!c.internal),
        source: a.source?.trim() || null,
        ownerExternalUserId: wanted ? await recruiterFor(ctx, jobId) : null,
        createdAt,
        history: moves.map((h) => ({ stage: stageRef(h.status, h.subStatus), at: h.at })),
        fields: wanted ? await applicationFields(ctx, candidateId, jobId, a, gates) : undefined,
      });
    }

    async function importCandidate(ctx: PhaseContext, row: SrCandidateRow, gates: FieldGates) {
      const candidateId = String(row.id);
      const jobIds = rowJobIds(row);
      let fresh = !jobIds.length;
      for (const jobId of jobIds) if (!(await ctx.load.has('opportunity', appKey(candidateId, jobId)))) fresh = true;
      if (!fresh) return; // re-run, or a duplicate row: nothing new, so skip the detail call

      // The list has no phone, links, or status of secondary applications; the detail has all of it.
      const c = await soft(ctx, 'Candidates', () => http.json<SrCandidate>(`${API}/candidates/${enc(candidateId)}`), null, {
        entity: 'candidate',
        externalId: candidateId,
      });
      if (!c) return;
      const candidate = toCandidate(c);
      const byJob = new Map<string, SrAssignment>();
      for (const a of [c.primaryAssignment, ...(c.secondaryAssignments ?? [])]) {
        if (a?.job?.id != null && !byJob.has(String(a.job.id))) byJob.set(String(a.job.id), a);
      }
      // A contact only when some application will land (archived ones are skipped when that option is off).
      if ([...byJob.values()].some((a) => ctx.options.archived || appStatus(a.status) === 'active')) {
        await ctx.load.candidate(candidate);
      }
      for (const a of byJob.values()) await each(ctx, a, () => importApplication(ctx, c, candidate, a, gates));
    }

    // ---------- load: activity ----------

    async function expandMentions(ctx: PhaseContext, text: string): Promise<string> {
      const names = new Map<string, string>();
      for (const [, id] of text.matchAll(/@\[USER:([^\]]+)\]/g)) {
        if (!names.has(id)) names.set(id, (await lookupUser(ctx, id)) ?? 'a teammate');
      }
      return text.replace(/@\[USER:([^\]]+)\]/g, (_m, id: string) => `@${names.get(id)}`).replace(/#\[CANDIDATE:[^\]]+\]/g, 'a candidate');
    }

    async function importMessage(ctx: PhaseContext, candidateId: string, m: SrMessage) {
      const text = m.content?.trim();
      if (!text) return;
      const author = m.authorId ? String(m.authorId) : null;
      const apps = m.context?.applications ?? [];
      const onApp = apps.length === 1 && apps[0].jobId ? appKey(candidateId, String(apps[0].jobId)) : null;
      // Source has no private notes; say so rather than silently widening who can read it.
      const marker =
        m.visibility === 'PRIVATE' ? '(Private in SmartRecruiters) ' : m.visibility === 'DIRECT' ? '(Direct message in SmartRecruiters) ' : '';
      await ctx.load.note({
        externalId: createHash('sha1').update([candidateId, author ?? '', m.createdOn ?? '', text].join('|')).digest('hex'),
        applicationExternalId: onApp && (await ctx.load.has('opportunity', onApp)) ? onApp : null,
        candidateExternalId: candidateId,
        authorExternalUserId: author,
        authorName: await authorName(ctx, author),
        body: marker + (await expandMentions(ctx, text)),
        createdAt: toDate(m.createdOn),
      });
    }

    /** The application of a search result without a job link: find the offer in the candidate's per-application lists. */
    async function offerApplication(ctx: PhaseContext, candidateId: string, offerId: string): Promise<string | null> {
      const c = await soft(ctx, null, () => http.json<SrCandidate>(`${API}/candidates/${enc(candidateId)}`), null);
      for (const a of [c?.primaryAssignment, ...(c?.secondaryAssignments ?? [])]) {
        if (a?.job?.id == null) continue;
        const jobId = String(a.job.id);
        const key = appKey(candidateId, jobId);
        if (!(await ctx.load.has('opportunity', key))) continue;
        const list = await soft(ctx, null, () => http.json<SrList<SrOffer>>(`${API}/candidates/${enc(candidateId)}/jobs/${enc(jobId)}/offers`), null);
        if (items(list).some((o) => String(o.id) === offerId)) return key;
      }
      return null;
    }

    async function toOffer(ctx: PhaseContext, o: SrOffer, app: string, defs: Map<string, SrOfferProperty>): Promise<ImportedOffer> {
      const status = OFFER_STATUS[o.status ?? ''] ?? 'DRAFT';
      const updated = toDate(o.updatedOn);
      const out: ImportedOffer = {
        externalId: String(o.id),
        applicationExternalId: app,
        status,
        createdAt: toDate(o.createdOn),
        // No sent/answered timestamps exist; the last update is when it reached that state.
        sentAt: status === 'SENT' ? updated : null,
        respondedAt: status === 'ACCEPTED' || status === 'DECLINED' ? updated : null,
      };
      const lines = [`SmartRecruiters status: ${o.status ?? 'unknown'}`];
      let salary: { score: number; amount: number; currency: string | null } | null = null;
      let currency: string | null = null;
      for (const [key, raw] of Object.entries(o.properties ?? {})) {
        if (raw == null || String(raw).trim() === '') continue;
        const def = defs.get(key);
        // Without a definition (none readable, or a field since removed), the key alone has to do.
        const type = def?.type ?? null;
        const label = def?.label?.trim() || key;
        const hay = `${key} ${label}`.toLowerCase();
        let value = String(raw).trim();
        if (type === 'USER') value = (await lookupUser(ctx, value)) ?? value;
        lines.push(`${label}: ${value}`);
        const score = !type || SALARY_TYPES.has(type) ? salaryScore(hay) : 0;
        if (score > (salary?.score ?? 0)) {
          const parsed = parseAmount(value);
          if (parsed.amount != null) salary = { score, amount: parsed.amount, currency: parsed.currency };
        }
        if (!currency && (type === 'CURRENCY' || /currency/.test(hay)) && /^[a-z]{3}$/i.test(value)) currency = value.toUpperCase();
        if (!out.startDate && /start/.test(hay) && (type === 'DATE' || (!type && /^\d{4}-\d{2}-\d{2}/.test(value)))) {
          out.startDate = toDate(value);
        }
        if (!out.jobTitle && (!type || type === 'TEXT') && /title/.test(hay)) out.jobTitle = value;
        if (!out.equity && /equity|stock|rsu|shares/.test(hay)) out.equity = value;
      }
      if (salary) out.salaryAmount = salary.amount;
      out.salaryCurrency = salary?.currency ?? currency;
      out.notes = lines.join('\n');
      return out;
    }

    function downloadAttachment(a: SrAttachment): () => Promise<DownloadedFile> {
      return async () => {
        const current = `${API}/candidates/attachments/${enc(String(a.id))}`;
        const listed = a.actions?.download?.url || current;
        try {
          let res: Awaited<ReturnType<HttpClient['bytes']>>;
          try {
            res = await http.bytes(listed);
          } catch (err) {
            // The candidate-scoped download path is deprecated; the current one serves the same attachment id.
            if (listed === current || !(err instanceof ImportHttpError && (err.status === 404 || err.status === 410))) throw err;
            res = await http.bytes(current);
          }
          const declared = res.contentType && !/octet-stream/i.test(res.contentType) ? res.contentType : null;
          return { data: res.data, contentType: declared ?? a.contentType ?? res.contentType, filename: a.name ?? res.filename };
        } catch (err) {
          throw releaseError(err);
        }
      };
    }

    function downloadOfferDocument(offerId: string, documentId: string, name: string | undefined): () => Promise<DownloadedFile> {
      return async () => {
        const wait = lastDocumentAt + DOCUMENT_INTERVAL_MS - Date.now();
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        lastDocumentAt = Date.now();
        try {
          const res = await http.bytes(`${API}/offers/${enc(offerId)}/documents/${enc(documentId)}`);
          return { data: res.data, contentType: res.contentType, filename: name?.trim() || res.filename };
        } catch (err) {
          throw releaseError(err);
        }
      };
    }

    /** DocuSign documents (signed offer letters) of an offer that reached the candidate, as files on its application. */
    async function importOfferDocuments(ctx: PhaseContext, offerId: string, candidateId: string, app: string) {
      const detail = { entity: 'offer', externalId: offerId };
      let res: SrOfferDocuments | null;
      try {
        res = await http.json<SrOfferDocuments>(`${API}/offers/${enc(offerId)}/documents`);
      } catch (err) {
        // 409: the offer was never sent. 422: not a DocuSign offer. Neither has documents.
        if (err instanceof ImportHttpError && (err.status === 409 || err.status === 422)) return;
        res = absorb(ctx, 'Offer documents', err, null, detail);
      }
      if (res?.isCurrentlySyncing) {
        ctx.warn('Offer documents: some were still syncing from DocuSign; run the import again later to pick them up', detail);
      }
      for (const doc of res?.documents ?? []) {
        if (doc?.id == null) continue;
        await each(ctx, doc, () =>
          ctx.load.file({
            externalId: `offer-document:${doc.id}`,
            candidateExternalId: candidateId,
            applicationExternalId: app,
            filename: doc.name?.trim() || `offer-document-${doc.id}`,
            kind: 'other',
            download: downloadOfferDocument(offerId, String(doc.id), doc.name),
          }),
        );
      }
    }

    async function importFiles(ctx: PhaseContext, row: SrCandidateRow) {
      const candidateId = String(row.id);
      if (!(await ctx.load.has('contact', candidateId))) return;
      const found = new Map<string, { file: SrAttachment; app: string | null }>();
      const read = async (url: string, app: string | null) => {
        const detail = app ? { entity: 'application', externalId: app } : { entity: 'candidate', externalId: candidateId };
        for (const file of items(await soft(ctx, 'Attachments', () => http.json<SrList<SrAttachment>>(url), null, detail))) {
          if (file?.id == null) continue;
          const id = String(file.id);
          const seen = found.get(id);
          // Also listed on an application: that application is where it belongs.
          found.set(id, seen ? { file: mergeAttachment(seen.file, file), app: seen.app ?? app } : { file, app });
        }
      };
      // One list failing (a 400, a body that isn't JSON) must not cost the others.
      await each(ctx, { id: candidateId }, () => read(`${API}/candidates/${enc(candidateId)}/attachments`, null));
      // Files added to one application can live only in that application's list.
      for (const jobId of await importedJobs(ctx, row)) {
        const app = appKey(candidateId, jobId);
        await each(ctx, { id: app }, () => read(`${API}/candidates/${enc(candidateId)}/jobs/${enc(jobId)}/attachments`, app));
      }
      for (const [id, { file, app }] of found) {
        if (SKIP_FILE_TYPES.has(file.type ?? '')) continue;
        await each(ctx, file, () =>
          ctx.load.file({
            externalId: id,
            candidateExternalId: candidateId,
            applicationExternalId: app,
            filename: file.name?.trim() || `${(file.type ?? 'attachment').toLowerCase()}-${id}`,
            kind: file.type === 'RESUME' ? 'resume' : 'other',
            download: downloadAttachment(file),
          }),
        );
      }
    }

    // ---------- phases ----------

    const discover: Phase[] = [
      {
        id: 'users',
        label: 'Team members',
        run: (ctx, cursor) =>
          pagedStep(
            ctx,
            cursor,
            async (page) => {
              const pageId = typeof page === 'string' ? page : undefined;
              const res = await optional(
                ctx,
                'Team members',
                () => http.request<SrList<SrUser>>({ url: `${API}/user-api/v201804/users`, query: { limit: PAGE_SIZE, pageId } }),
                null,
              );
              return res ? { items: res.data?.content ?? [], next: nextPage(res, pageId) } : { items: [], next: null };
            },
            async (u) =>
              ctx.catalog.user({
                externalId: String(u.id),
                name: fullName(u.firstName, u.lastName, u.email?.trim() || 'Unknown user'),
                email: u.email?.trim() || null,
              }),
          ),
      },
      {
        id: 'stages',
        label: 'Pipeline stages',
        async run(ctx) {
          const processes = items(
            await optional(ctx, 'Hiring processes', () => http.json<SrList<SrHiringProcess>>(`${API}/configuration/hiring-processes`), null),
          );
          let found = false;
          for (const p of processes) {
            const subs =
              p.subStatuses ??
              (await optional(ctx, 'Hiring processes', () => http.json<SrHiringProcess>(`${API}/configuration/hiring-processes/${enc(p.id)}`), null))
                ?.subStatuses;
            if (!subs) continue;
            emitPipeline(ctx.catalog, subs);
            found = true;
          }
          if (!found) emitPipeline(ctx.catalog, null);
          return null;
        },
      },
      {
        id: 'reasons',
        label: 'Archive reasons',
        async run(ctx) {
          const lists = [
            { prefix: 'rejection', path: 'rejection-reasons', what: 'Rejection reasons', kind: 'rejection' },
            { prefix: 'withdrawal', path: 'withdrawal-reasons', what: 'Withdrawal reasons', kind: 'withdrawn' },
          ] as const;
          for (const list of lists) {
            const res = await optional(ctx, list.what, () => http.json<SrList<SrReason>>(`${API}/configuration/${list.path}`), null);
            for (const r of items(res)) {
              if (r.label?.trim()) ctx.catalog.reason({ externalId: `${list.prefix}:${r.id}`, name: r.label, kind: list.kind });
            }
          }
          for (const r of Object.values(OUTCOME_REASONS)) ctx.catalog.reason(r);
          return null;
        },
      },
    ];

    const load: Phase[] = [
      {
        // Positions (requisitions) are per-job sub-resources, so they load with their job, just before it.
        id: 'postings',
        label: 'Jobs and requisitions',
        run: (ctx, cursor) =>
          pagedStep(
            ctx,
            cursor,
            async (page) => {
              const pageId = typeof page === 'string' ? page : undefined;
              // sort=job_id is required for cursor paging (the default order can skip jobs).
              const res = await http.request<SrList<SrJobRow>>({
                url: `${API}/jobs`,
                query: { limit: PAGE_SIZE, sort: 'job_id', pageId },
              });
              return { items: res.data?.content ?? [], next: nextPage(res, pageId) };
            },
            (row) => importJob(ctx, row),
          ),
      },
      {
        id: 'candidates',
        label: 'Candidates and applications',
        run(ctx, cursor) {
          const gates = { properties: scopeGate(ctx, 'Candidate properties'), screening: scopeGate(ctx, 'Screening answers') };
          return eachCandidate(ctx, cursor, (row) => importCandidate(ctx, row, gates));
        },
      },
      {
        id: 'interviews',
        label: 'Interviews',
        enabled: (o) => o.activity,
        async run(ctx, cursor) {
          const gate = scopeGate(ctx, 'Interviews');
          const now = new Date();
          const next = await eachCandidate(ctx, cursor, async (row) => {
            const candidateId = String(row.id);
            for (const jobId of await importedJobs(ctx, row)) {
              if (gate.isClosed()) return;
              const key = appKey(candidateId, jobId);
              const detail = { entity: 'application', externalId: key };
              // One application's failure must not cost the candidate's others.
              await each(ctx, { id: key }, async () => {
                // The Interviews API is keyed by the application's own id, which only this call returns.
                const app = await soft(
                  ctx,
                  'Applications',
                  () => http.json<SrApplication>(`${API}/candidates/${enc(candidateId)}/jobs/${enc(jobId)}`),
                  null,
                  detail,
                );
                if (!app?.applicationId) return;
                const res = await gate.run(
                  () =>
                    http.json<{ content?: SrInterview[] }>(`${API}/interviews-api/v201904/interviews`, {
                      applicationId: app.applicationId,
                    }),
                  null,
                  detail,
                );
                for (const interview of items(res)) {
                  // One interview holds 1–50 separately scheduled timeslots; each is a Source interview.
                  for (const [i, slot] of (interview.timeslots ?? []).entries()) {
                    const startAt = toDate(slot.startsOn);
                    if (!startAt) continue;
                    const endAt = toDate(slot.endsOn);
                    await each(ctx, slot, () =>
                      ctx.load.interview({
                        externalId: String(slot.id ?? `${interview.id}:${i}`),
                        applicationExternalId: key,
                        title: `${slot.title?.trim() || slot.interviewType?.trim() || 'Interview'}${slot.noShow ? ' (no-show)' : ''}`,
                        startAt,
                        durationMins: endAt ? Math.round((endAt.getTime() - startAt.getTime()) / 60_000) : null,
                        location: cleanList([slot.place, interview.location]).join(' · ') || null,
                        panelistExternalUserIds: cleanList(
                          (slot.interviewers ?? []).filter((p) => p.status !== 'declined').map((p) => String(p.id)),
                        ),
                        // There is no interview status: past means it happened, a no-show means it didn't.
                        state: slot.noShow ? 'canceled' : (endAt ?? startAt) < now ? 'completed' : 'scheduled',
                      }),
                    );
                  }
                }
              });
            }
          });
          return gate.isClosed() ? null : next;
        },
      },
      {
        id: 'feedback',
        label: 'Reviews',
        enabled: (o) => o.activity,
        async run(ctx, cursor) {
          const gate = scopeGate(ctx, 'Reviews');
          const next = await eachCandidate(ctx, cursor, async (row) => {
            const candidateId = String(row.id);
            for (const jobId of await importedJobs(ctx, row)) {
              if (gate.isClosed()) return;
              const key = appKey(candidateId, jobId);
              await each(ctx, { id: key }, async () => {
                const reviews = await gate.run(
                  () => http.json<SrReview[] | SrList<SrReview>>(`${API}/reviews-api/v201910/reviews`, { candidateId, jobId }),
                  null,
                  { entity: 'application', externalId: key },
                );
                for (const r of items(reviews)) {
                  await each(ctx, r, async () => {
                    const raw = r.overallRating;
                    const rating = typeof raw === 'number' ? (RATING[raw] ?? null) : null;
                    const author = r.reviewerId ? String(r.reviewerId) : null;
                    await ctx.load.feedback({
                      externalId: String(r.id),
                      applicationExternalId: key,
                      authorExternalUserId: author,
                      authorName: await authorName(ctx, author),
                      rating,
                      title: raw === 3 ? 'Original rating: 3/5 (neutral)' : null,
                      summary: r.comment?.trim() ?? '',
                      // Keep the vendor's own score; Source's 4-point scale can't hold a 5-star one exactly.
                      answers: raw != null && raw !== 0 ? [{ label: 'SmartRecruiters rating', value: `${raw}/5` }] : [],
                      createdAt: toDate(r.createdOn),
                    });
                  });
                }
              });
            }
          });
          return gate.isClosed() ? null : next;
        },
      },
      {
        id: 'notes',
        label: 'Notes',
        enabled: (o) => o.activity,
        async run(ctx, cursor) {
          const gate = scopeGate(ctx, 'Notes');
          const next = await eachCandidate(ctx, cursor, async (row) => {
            const candidateId = String(row.id);
            if (gate.isClosed() || !(await ctx.load.has('contact', candidateId))) return;
            let pageId: string | undefined;
            // One call returns every message on the candidate (all applications); rarely more than a page.
            for (let pages = 0; pages < 50; pages++) {
              const res = await gate.run(
                () => http.request<SrMessage[]>({ url: `${API}/messages`, query: { candidateId, limit: PAGE_SIZE, pageId } }),
                null,
                { entity: 'candidate', externalId: candidateId },
              );
              if (!res) return;
              for (const m of items(res.data)) await each(ctx, m, () => importMessage(ctx, candidateId, m));
              const more = nextPage(res, pageId);
              if (!more) return;
              pageId = more;
            }
          });
          return gate.isClosed() ? null : next;
        },
      },
      {
        id: 'offers',
        label: 'Offers',
        enabled: (o) => o.offers,
        async run(ctx, cursor) {
          let defs: Map<string, SrOfferProperty> | null = null;
          return pagedStep(
            ctx,
            cursor,
            async (page) => {
              const offset = typeof page === 'number' ? page : 0;
              // One org-wide search instead of a call per application (needs the Extended or Administrator role).
              const res = await optional(
                ctx,
                'Offers',
                () =>
                  http.json<SrList<SrOffer>>(`${API}/offers`, {
                    limit: PAGE_SIZE,
                    offset,
                    createdAfter: ctx.since?.toISOString(),
                  }),
                null,
              );
              const list = res?.content ?? [];
              if (list.length && !defs) {
                const config = await optional(
                  ctx,
                  'Offer fields',
                  () => http.json<SrOfferConfig>(`${API}/configuration/offer-properties`),
                  null,
                );
                defs = new Map((config?.categories ?? []).flatMap((c) => c.properties ?? []).map((p) => [p.key, p]));
              }
              const end = offset + list.length;
              return { items: list, next: list.length && end < (res?.totalFound ?? Infinity) ? end : null };
            },
            async (o) => {
              const offerId = String(o.id);
              const { candidateId, jobId } = offerRefs(o);
              let app = candidateId && jobId ? appKey(candidateId, jobId) : null;
              // Already imported: skip the lookups, but still pick up documents DocuSign had not synced last time.
              if (!(await ctx.load.has('offer', offerId))) {
                if (candidateId && !(await ctx.load.has('contact', candidateId))) return; // candidate not imported
                app ??= candidateId ? await offerApplication(ctx, candidateId, offerId) : null;
                if (!app) {
                  ctx.warn('Offers: an offer whose application could not be found was skipped', { entity: 'offer', externalId: offerId });
                  return;
                }
                await ctx.load.offer(await toOffer(ctx, o, app, defs ?? new Map()));
              }
              if (app && candidateId && ctx.options.files && SENT_OFFER.has(o.status ?? '')) {
                await importOfferDocuments(ctx, offerId, candidateId, app);
              }
            },
          );
        },
      },
      {
        id: 'files',
        label: 'Resumes and attachments',
        enabled: (o) => o.files,
        run: (ctx, cursor) => eachCandidate(ctx, cursor, (row) => importFiles(ctx, row)),
      },
    ];

    return {
      async verify() {
        if (!credentials.clientId?.trim() || !credentials.clientSecret?.trim()) {
          throw new Error('Enter the client ID and client secret from SmartRecruiters (Settings → Apps & Integrations → Credentials).');
        }
        // Prove the credential works now, not a token an earlier slice cached.
        tokenCache.delete(cacheKey);
        const company = await http.json<SrCompany>(`${API}/configuration/company`);
        return { accountName: company?.name?.trim() || company?.identifier?.trim() || 'SmartRecruiters' };
      },
      discover,
      load,
    };
  },
};
