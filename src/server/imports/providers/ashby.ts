import type { Commitment, OfferStatus, Origin, StageType, WorkplaceType } from '@prisma/client';
import { ImportAuthError, ImportHttpError, type HttpClient } from '@/server/imports/http';
import { each, listStep, optional, pagedStep, type Page, type PageCursor } from '@/server/imports/paging';
import { cleanEmails, cleanList, clip, fullName, htmlToText, toDate } from '@/server/imports/text';
import type {
  Cursor,
  DownloadedFile,
  ImportedApplication,
  ImportedCandidate,
  ImportedFeedback,
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
 * Ashby adapter.
 *
 * Ashby's API is RPC-style: every call is `POST https://api.ashbyhq.com/<resource>.<verb>`
 * with a JSON body and HTTP Basic auth (the key is the username, the password
 * is empty). Quirks this file handles:
 *
 * - Errors other than auth come back as HTTP 200 with `success: false`, in
 *   four envelope shapes. They are thrown as AshbyApiError: `*_not_found` → 404,
 *   throttling/outage codes → 503 (retried), anything else → 400 (skipped).
 * - Ashby answers 403 both to a wrong key and to a missing module permission,
 *   and the body that tells them apart never reaches the adapter. verify()
 *   probes another module to decide which it is.
 * - Request schemas are `additionalProperties: false`, so each call sends only
 *   the params its endpoint documents: no `limit`/`cursor` on the unpaginated
 *   lists (archiveReason.list, interviewStage.list).
 * - Cursor pagination: `moreDataAvailable` may be absent, which means false. A
 *   page can come back empty and still promise more (records the key may not
 *   see are dropped after paging), so empty pages are followed, not taken as
 *   the end. There are no sort params; cursors are stable for 14 days. An
 *   expired cursor restarts that list, since ImportRefs make replays harmless.
 * - Pipelines belong to interview plans, not the org. Plan ids come from
 *   interviewPlan.list, job.list and the applications' current stages, because
 *   interviewPlan.list omits legacy plans. The review groups the stages by
 *   name. `Active` stages are typed SCREEN or ONSITE by name, else by position
 *   in their plan. `Archived`-type stages are not pipeline stages: an archived
 *   application keeps its last real stage, and history entries into them are
 *   dropped (interviewStage.info identifies ones discover never saw).
 * - Application status Lead is an active sourced prospect. Hired has no
 *   timestamp of its own: it's the history entry into the current (Hired)
 *   stage, else the application's last update.
 * - Custom fields live on candidates and applications; Orqestra keeps them on
 *   applications, so a candidate's values are copied onto each of its new
 *   applications (candidate.info, only when the org defines candidate fields).
 *   Date fields can arrive as full instants; customField.list says which are
 *   date-only.
 * - Notes belong to the candidate (candidate.listNotes, fanned out per
 *   candidate); stage history comes from application.listHistory, once per
 *   application. Both are skipped for records that were already imported, and
 *   notes for candidates with no application to hold them (with a warning).
 * - Per-record extras (description, pay, candidate details) survive a refusal;
 *   stage history only survives the record being gone, since a re-run can't
 *   repair an application committed without it. A 403 on any of them is a
 *   revoked key and stops the import.
 * - Feedback is decoded with the form snapshot each submission carries. The
 *   default form's `overall_recommendation` is already Orqestra's 1–4 scale;
 *   custom forms map by option label, but only a rating-shaped field counts as
 *   the decision. A submission with no overall field falls back to the mean of
 *   its Score answers, and one with neither becomes a note.
 * - Files: file.info returns a short-lived pre-signed S3 URL, so it is called
 *   inside download(), and once more if S3 rejects the first URL. S3 never
 *   receives the key. Offer letters come from each offer's latest version.
 * - Job descriptions exist only on jobPosting.info (one call per job with a
 *   posting), as opening + body + closing. Pay comes from the posting, else
 *   from job.info's compensation plan. Openings are embedded in job.list and
 *   roll up into one requisition per job.
 */

const HOST = 'api.ashbyhq.com';
const API = `https://${HOST}`;
const JOB_STATUSES = ['Draft', 'Open', 'Closed', 'Archived'];
const JOB_LIST_BODY = {
  limit: 100,
  status: JOB_STATUSES,
  includeUnpublishedJobPostingsIds: true,
  expand: ['openings', 'location'],
};
const CURSOR_EXPIRED = new Set(['next_cursor_expired', 'cursor_invalid', 'invalid_next_cursor']);
const TRANSIENT_CODE = /rate_?limit|throttl|too_many|time_?out|unavailable|internal_(server_)?error/i;
/** Consecutive empty pages one step follows before handing back a cursor. */
const MAX_EMPTY_PAGES = 50;

// ---------- Vendor payloads (only the fields this adapter reads) ----------

type Body = Record<string, JsonValue>;

type Envelope<T> = {
  success?: boolean;
  results?: T | null;
  moreDataAvailable?: boolean | null;
  nextCursor?: string | null;
  errors?: (string | { code?: string | null; message?: string | null } | null)[] | null;
  errorInfo?: { code?: string | null; message?: string | null } | null;
};

type AshbyUser = { id: string; firstName?: string | null; lastName?: string | null; email?: string | null };
type ContactPoint = { value?: string | null };
type FileHandle = { id: string; name?: string | null; handle: string };
type CustomFieldValue = { id?: string | null; title?: string | null; value?: unknown; valueLabel?: string | string[] | null };
type CustomFieldDef = { id: string; objectType?: string | null; isDateOnlyField?: boolean | null };

type AshbyCandidate = {
  id: string;
  name?: string | null;
  createdAt?: string | null;
  primaryEmailAddress?: ContactPoint | null;
  emailAddresses?: ContactPoint[] | null;
  primaryPhoneNumber?: ContactPoint | null;
  phoneNumbers?: ContactPoint[] | null;
  socialLinks?: { url?: string | null }[] | null;
  tags?: { title?: string | null }[] | null;
  position?: string | null;
  company?: string | null;
  location?: { locationSummary?: string | null } | null;
  applicationIds?: string[] | null;
  resumeFileHandle?: FileHandle | null;
  fileHandles?: FileHandle[] | null;
  customFields?: CustomFieldValue[] | null;
};

type AshbyStage = {
  id: string;
  title?: string | null;
  type?: string | null;
  orderInInterviewPlan?: number | null;
  interviewPlanId?: string | null;
};

type AshbyApplication = {
  id: string;
  createdAt?: string | null;
  updatedAt?: string | null;
  status?: string | null;
  customFields?: CustomFieldValue[] | null;
  candidate?: { id: string; name?: string | null; primaryEmailAddress?: ContactPoint | null; primaryPhoneNumber?: ContactPoint | null } | null;
  currentInterviewStage?: AshbyStage | null;
  source?: { title?: string | null; sourceType?: { title?: string | null } | null } | null;
  archiveReason?: { id: string; text?: string | null } | null;
  archivedAt?: string | null;
  job?: { id: string } | null;
  creditedToUser?: { id: string } | null;
  hiringTeam?: { userId: string; role?: string | null }[] | null;
};

type AshbyHistoryEntry = {
  stageId: string;
  title?: string | null;
  enteredStageAt?: string | null;
  stageNumber?: number | null;
  actorId?: string | null;
};

type AshbyOpening = {
  isArchived?: boolean | null;
  openingState?: string | null;
  latestVersion?: { identifier?: string | null; isBackfill?: boolean | null } | null;
};

type CompensationComponent = {
  compensationType?: string | null;
  interval?: string | null;
  currencyCode?: string | null;
  minValue?: number | null;
  maxValue?: number | null;
};

type Compensation = {
  compensationTierSummary?: string | null;
  summaryComponents?: CompensationComponent[] | null;
  compensationTiers?: { tierSummary?: string | null; components?: CompensationComponent[] | null }[] | null;
};

type AshbyJob = {
  id: string;
  title?: string | null;
  confidential?: boolean | null;
  status?: string | null;
  employmentType?: string | null;
  departmentId?: string | null;
  defaultInterviewPlanId?: string | null;
  interviewPlanIds?: string[] | null;
  jobPostingIds?: string[] | null;
  customRequisitionId?: string | null;
  openings?: AshbyOpening[] | null;
  location?: { name?: string | null; externalName?: string | null; workplaceType?: string | null } | null;
  compensation?: Compensation | null;
  createdAt?: string | null;
};

type DescriptionPart = { html?: string | null; plain?: string | null } | null;

type AshbyPosting = {
  title?: string | null;
  descriptionHtml?: string | null;
  descriptionPlain?: string | null;
  descriptionParts?: {
    descriptionOpening?: DescriptionPart;
    descriptionBody?: DescriptionPart;
    descriptionClosing?: DescriptionPart;
  } | null;
  suppressDescriptionOpening?: boolean | null;
  suppressDescriptionClosing?: boolean | null;
  departmentName?: string | null;
  teamName?: string | null;
  locationName?: string | null;
  workplaceType?: string | null;
  employmentType?: string | null;
  compensation?: Compensation | null;
};

type FormField = {
  type?: string | null;
  path: string;
  title?: string | null;
  humanReadablePath?: string | null;
  selectableValues?: { label: string; value: string }[] | null;
};

type AshbyFeedback = {
  id: string;
  applicationId: string;
  interviewId?: string | null;
  interviewEventId?: string | null;
  submittedAt?: string | null;
  submittedByUser?: AshbyUser | null;
  formDefinition?: { sections?: { fields?: { field?: FormField | null }[] | null }[] | null } | null;
  submittedValues?: Record<string, unknown> | null;
};

type AshbyInterviewEvent = {
  id: string;
  interviewId?: string | null;
  interviewerUserIds?: string[] | null;
  interviewers?: { id: string }[] | null;
  startTime?: string | null;
  endTime?: string | null;
  location?: string | null;
  meetingLink?: string | null;
  hasSubmittedFeedback?: boolean | null;
};

type AshbySchedule = { id: string; status?: string | null; applicationId: string; interviewEvents?: AshbyInterviewEvent[] | null };

type AshbyNote = { id: string; createdAt?: string | null; isPrivate?: boolean | null; content?: string | null; author?: AshbyUser | null };

type AshbyOffer = {
  id: string;
  applicationId: string;
  decidedAt?: string | null;
  acceptanceStatus?: string | null;
  offerStatus?: string | null;
  latestVersion?: {
    createdAt?: string | null;
    startDate?: string | null;
    salary?: { value?: number | null; currencyCode?: string | null } | null;
    customFields?: CustomFieldValue[] | null;
    fileHandles?: FileHandle[] | null;
  } | null;
};

// ---------- Transport ----------

/** A `success: false` answer. Only throttling/outage codes are retryable; the rest repeat for the same request. */
class AshbyApiError extends ImportHttpError {
  constructor(
    readonly code: string,
    where: string,
    detail: string,
    status = /not_?found/i.test(code) ? 404 : TRANSIENT_CODE.test(code) ? 503 : 400,
  ) {
    super(status, where, detail);
    this.name = 'AshbyApiError';
    this.message = `${where} → ${detail}`;
  }
}

/** A real key that lacks a module the import can't do without. */
class AshbyPermissionError extends ImportAuthError {
  constructor(where: string, module: string) {
    super(403, where);
    this.name = 'AshbyPermissionError';
    this.message = `This key can't read ${module}. In Ashby, edit the key and tick Read for ${module}.`;
  }
}

function ashbyError(endpoint: string, res: Envelope<unknown> | null): Error {
  const where = `POST ${HOST}/${endpoint}`;
  // Documented parse order: errorInfo.code, then errors[i] as a string, then errors[i].code, then errors[i].message.
  const first = res?.errors?.find((e) => e != null) ?? null;
  const code = res?.errorInfo?.code || (typeof first === 'string' ? first : first?.code) || '';
  const message = res?.errorInfo?.message || (first && typeof first === 'object' ? first.message : '') || '';
  if (code === 'missing_endpoint_permission') return new ImportAuthError(403, where);
  const detail = clip([code, message].filter(Boolean).join(': ') || 'request failed', 200);
  return new AshbyApiError(code || (/not found/i.test(message) ? 'not_found' : 'request_failed'), where, detail);
}

async function call<T>(http: HttpClient, endpoint: string, body: Body): Promise<Envelope<T>> {
  const res = await http.post<Envelope<T> | null>(`${API}/${endpoint}`, body);
  if (res?.success === true) return res;
  throw ashbyError(endpoint, res);
}

/**
 * One page of an Ashby list. Empty pages that still promise more are followed
 * (up to a bound, or until the slice runs late), so a returned empty page with
 * a `next` means "keep going", never the end of the list.
 */
async function fetchPage<T>(
  http: HttpClient,
  endpoint: string,
  body: Body,
  cursor: string | null,
  ctx?: PhaseContext,
): Promise<Page<T>> {
  let at = cursor;
  for (let hop = 0; ; hop++) {
    const res = await call<T[]>(http, endpoint, at ? { ...body, cursor: at } : body);
    const items = Array.isArray(res.results) ? res.results : [];
    let next: string | null = null;
    if (res.moreDataAvailable === true) {
      if (res.nextCursor && res.nextCursor !== at) next = res.nextCursor;
      else ctx?.warn(`${endpoint} said more data was available but sent no new cursor; stopped there`);
    }
    if (items.length || !next || hop + 1 >= MAX_EMPTY_PAGES || ctx?.outOfTime()) return { items, next };
    at = next;
  }
}

/** Every page of a small list: one application's history, one candidate's notes, a lookup table. */
async function fetchAll<T>(http: HttpClient, endpoint: string, body: Body, ctx?: PhaseContext): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 1000; i++) {
    const { items, next }: Page<T> = await fetchPage<T>(http, endpoint, body, cursor, ctx);
    out.push(...items);
    if (typeof next !== 'string' || next === cursor) break;
    cursor = next;
  }
  return out;
}

/** pagedStep over an Ashby list; an expired cursor restarts the list instead of failing the job. */
async function paged<T>(
  ctx: PhaseContext,
  http: HttpClient,
  cursor: Cursor | null,
  endpoint: string,
  body: Body,
  handle: (item: T) => Promise<void>,
): Promise<Cursor | null> {
  const last: { emptyWithNext: string | null } = { emptyWithNext: null };
  try {
    const next = await pagedStep<T>(
      ctx,
      cursor,
      async (page) => {
        const res = await fetchPage<T>(http, endpoint, body, typeof page === 'string' ? page : null, ctx);
        last.emptyWithNext = !res.items.length && typeof res.next === 'string' ? res.next : null;
        return res;
      },
      handle,
    );
    // pagedStep stops at an empty page; one that still has a cursor resumes from it next step.
    return next ?? (last.emptyWithNext ? { page: last.emptyWithNext, index: 0 } : null);
  } catch (err) {
    const resumed = (cursor as PageCursor | null)?.page != null;
    if (resumed && err instanceof AshbyApiError && CURSOR_EXPIRED.has(err.code)) {
      ctx.warn(`Ashby expired the saved position in ${endpoint}; reading it again from the start (imported records are skipped)`);
      return { page: null, index: 0 };
    }
    throw err;
  }
}

// What `soft` may swallow. Anything else (a revoked key, an outage, a yield) still stops the step.
/** Deleted between the list and this call. */
const MISSING: readonly number[] = [404];
/** Supplementary data: a refusal costs the extra, not the record. */
const EXTRA: readonly number[] = [400, 404];
/** An optional lookup table behind a permission the key may not have. */
const LOOKUP: readonly number[] = [400, 403, 404];

/** A per-record extra (history, description, title lookup) whose listed failures shouldn't cost the record. */
async function soft<T>(ctx: PhaseContext, what: string, fn: () => Promise<T>, fallback: T, statuses: readonly number[]): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if ((err instanceof ImportHttpError || err instanceof ImportAuthError) && statuses.includes(err.status)) {
      ctx.warn(`${what}: ${err.message}`);
      return fallback;
    }
    throw err;
  }
}

const createdAfter = (ctx: PhaseContext): Body => (ctx.since ? { createdAfter: ctx.since.getTime() } : {});

const uniq = (ids: (string | null | undefined)[]) => [...new Set(ids.filter((id): id is string => !!id).map(String))];

// ---------- Mapping ----------

const STAGE_TYPE: Record<string, StageType> = {
  Lead: 'LEAD',
  PreInterviewScreen: 'APPLICANT',
  Offer: 'OFFER',
  Hired: 'HIRED',
};

const ONSITE_NAME = /on-?site|\bfinal\b|\bpanel\b|\bloop\b|super ?day|in[ -]person|face[ -]to[ -]face/i;
const SCREEN_NAME = /\bscreen|\bphone\b|\bintro\b/i;

/**
 * Type hints for one plan's stages. `Active` stages are interviews, so SCREEN
 * or ONSITE: the name decides when it can, else the plan's first Active stage
 * is the screen and the later ones are onsite.
 */
function stageTypeHints(stages: AshbyStage[]): Map<string, StageType> {
  const hints = new Map<string, StageType>();
  for (const s of stages) {
    const type = STAGE_TYPE[s.type ?? ''];
    if (type) hints.set(String(s.id), type);
  }
  stages
    .filter((s) => s.type === 'Active')
    .sort((a, b) => (a.orderInInterviewPlan ?? 0) - (b.orderInInterviewPlan ?? 0))
    .forEach((s, i) => {
      const title = s.title ?? '';
      hints.set(String(s.id), ONSITE_NAME.test(title) ? 'ONSITE' : SCREEN_NAME.test(title) || i === 0 ? 'SCREEN' : 'ONSITE');
    });
  return hints;
}

// The kind only sets the review's default "counts as rejection". Orqestra counts the
// org's rejections, not withdrawals; Ashby's `Other` (duplicates, filled roles)
// isn't a rejection either, and 'withdrawn' is the non-counting kind it can borrow.
const REASON_KIND: Record<string, ReasonKind> = {
  RejectedByOrg: 'rejection',
  RejectedByCandidate: 'withdrawn',
  Other: 'withdrawn',
};

const JOB_STATE: Record<string, ImportedPosting['state']> = {
  Open: 'open',
  Draft: 'draft',
  Closed: 'closed',
  Archived: 'closed',
};

const COMMITMENT: Record<string, Commitment> = {
  FullTime: 'FULL_TIME',
  PartTime: 'PART_TIME',
  Contract: 'CONTRACT',
  Temporary: 'CONTRACT',
  Intern: 'INTERNSHIP',
};

const WORKPLACE: Record<string, WorkplaceType> = { OnSite: 'ONSITE', Hybrid: 'HYBRID', Remote: 'REMOTE' };

const OFFER_STATUS: Record<string, OfferStatus> = {
  WaitingOnOfferCreation: 'DRAFT',
  WaitingOnApprovalStart: 'DRAFT',
  WaitingOnApprovalDefinition: 'DRAFT',
  WaitingOnOfferApproval: 'PENDING_APPROVAL',
  WaitingOnCandidateResponse: 'SENT',
  CandidateAccepted: 'ACCEPTED',
  CandidateRejected: 'DECLINED',
  OfferCancelled: 'WITHDRAWN',
};

const ACCEPTANCE_STATUS: Record<string, OfferStatus> = {
  Created: 'DRAFT',
  Pending: 'SENT',
  Accepted: 'ACCEPTED',
  Declined: 'DECLINED',
  Cancelled: 'WITHDRAWN',
};

const OPEN_OPENING = new Set(['Draft', 'Approved', 'Open']);

function userName(u: AshbyUser | null | undefined): string | null {
  if (!u) return null;
  return fullName(u.firstName, u.lastName, u.email ?? '') || null;
}

/** Custom-field and form values → one readable line. */
function renderValue(value: unknown, label?: string | string[] | null): string {
  if (Array.isArray(label)) return label.filter(Boolean).join(', ');
  if (typeof label === 'string' && label.trim()) return label.trim();
  if (value == null || value === '') return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.map((v) => renderValue(v)).filter(Boolean).join(', ');
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if ('minValue' in o || 'maxValue' in o) {
      const range = [o.minValue, o.maxValue].filter((v) => v != null).join('–');
      return [range, o.currencyCode, o.interval].filter((v) => v != null && v !== '').join(' ');
    }
    if ('value' in o) return [renderValue(o.value), o.currencyCode].filter((v) => v != null && v !== '').join(' ');
    const place = [o.city, o.region, o.country].filter((v) => typeof v === 'string' && v);
    if (place.length) return place.join(', ');
    return JSON.stringify(value);
  }
  return String(value);
}

const INSTANT = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;
const MIDNIGHT = /^(\d{4}-\d{2}-\d{2})T00:00(:00(\.0+)?)?(Z|[+-]00:?00)$/;

/**
 * One custom-field value as text. Date fields can arrive as full instants: a
 * field customField.list marks date-only keeps its day, and without the
 * definitions a UTC-midnight instant is read as a plain date.
 */
function fieldValue(f: CustomFieldValue, dateOnly?: ReadonlySet<string>): string {
  const text = renderValue(f.value, f.valueLabel);
  if (typeof f.value !== 'string') return text;
  const day = (f.id && dateOnly?.has(String(f.id)) ? INSTANT : MIDNIGHT).exec(text);
  return day ? day[1] : text;
}

function customFields(values: CustomFieldValue[] | null | undefined, dateOnly?: ReadonlySet<string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of values ?? []) {
    const key = f.title?.trim() || f.id;
    const value = fieldValue(f, dateOnly);
    if (key && value) out[key] = clip(value, 2000);
  }
  return out;
}

/** Ashby's editor wraps every list item in a paragraph; unwrap it so a bullet and its text share a line. */
function descriptionText(html: string | null | undefined): string {
  return htmlToText((html ?? '').replace(/(<li\b[^>]*>)\s*<p\b[^>]*>/gi, '$1').replace(/<\/p>\s*(<\/li>)/gi, '$1'));
}

/** The description as the job page shows it: the org's opening, the body, the org's closing. */
function postingDescription(p: AshbyPosting | null): string {
  if (!p) return '';
  const text = (part: DescriptionPart | undefined) => descriptionText(part?.html) || part?.plain?.trim() || '';
  const body = text(p.descriptionParts?.descriptionBody) || descriptionText(p.descriptionHtml) || p.descriptionPlain?.trim() || '';
  return [
    p.suppressDescriptionOpening ? '' : text(p.descriptionParts?.descriptionOpening),
    body,
    p.suppressDescriptionClosing ? '' : text(p.descriptionParts?.descriptionClosing),
  ]
    .filter(Boolean)
    .join('\n\n');
}

function toCandidate(c: AshbyCandidate): ImportedCandidate {
  return {
    externalId: String(c.id),
    name: c.name?.trim() || 'Unknown candidate',
    emails: cleanEmails([c.primaryEmailAddress?.value, ...(c.emailAddresses ?? []).map((e) => e.value)]),
    phones: cleanList([c.primaryPhoneNumber?.value, ...(c.phoneNumbers ?? []).map((p) => p.value)]),
    links: cleanList((c.socialLinks ?? []).map((l) => l.url)),
    headline: [c.position?.trim(), c.company?.trim()].filter(Boolean).join(' at ') || null,
    location: c.location?.locationSummary?.trim() || null,
    tags: cleanList((c.tags ?? []).map((t) => t.title)),
    createdAt: toDate(c.createdAt),
  };
}

/** The shallow candidate embedded in application.list: name + primary email and phone. */
function inlineCandidate(c: NonNullable<AshbyApplication['candidate']>): ImportedCandidate {
  return {
    externalId: String(c.id),
    name: c.name?.trim() || 'Unknown candidate',
    emails: cleanEmails([c.primaryEmailAddress?.value]),
    phones: cleanList([c.primaryPhoneNumber?.value]),
    links: [],
  };
}

function originOf(a: AshbyApplication): Origin {
  const text = `${a.source?.sourceType?.title ?? ''} ${a.source?.title ?? ''}`.toLowerCase();
  if (/referr/.test(text)) return 'REFERRED';
  if (/agency|recruiting firm|headhunt/.test(text)) return 'AGENCY';
  if (/universit|campus|college|career fair/.test(text)) return 'UNIVERSITY';
  if (/internal|transfer/.test(text)) return 'INTERNAL';
  if (a.status === 'Lead' || /outbound|sourc|prospect/.test(text)) return 'SOURCED';
  return 'APPLIED';
}

function ownerOf(a: AshbyApplication): string | null {
  const team = a.hiringTeam ?? [];
  const recruiter =
    team.find((m) => /^recruiter$/i.test(m.role?.trim() ?? '')) ?? team.find((m) => /recruit/i.test(m.role ?? ''));
  return recruiter?.userId ?? a.creditedToUser?.id ?? null;
}

function toRequisition(job: AshbyJob): ImportedRequisition | null {
  const openings = (job.openings ?? []).filter((o) => !o.isArchived);
  const code = job.customRequisitionId?.trim() || openings.find((o) => o.latestVersion?.identifier)?.latestVersion?.identifier?.trim() || '';
  if (!openings.length && !code) return null;
  const open = openings.length
    ? openings.some((o) => OPEN_OPENING.has(o.openingState ?? ''))
    : job.status === 'Open' || job.status === 'Draft';
  return {
    externalId: String(job.id),
    code,
    title: job.title?.trim() || code,
    state: open ? 'open' : 'closed',
    openings: openings.length || null,
    filled: openings.filter((o) => o.openingState === 'Filled').length,
    backfill: openings.some((o) => !!o.latestVersion?.isBackfill),
  };
}

function annualSalary(comp: Compensation | null | undefined): { min: number | null; max: number | null; currency: string | null } | null {
  const components = [
    ...(comp?.summaryComponents ?? []),
    ...(comp?.compensationTiers ?? []).flatMap((t) => t.components ?? []),
  ];
  const salary = components.find(
    (c) => c.compensationType === 'Salary' && c.interval === '1 YEAR' && (c.minValue != null || c.maxValue != null),
  );
  return salary ? { min: salary.minValue ?? null, max: salary.maxValue ?? null, currency: salary.currencyCode ?? null } : null;
}

function compensationSummary(comp: Compensation | null | undefined): string {
  return comp?.compensationTierSummary?.trim() || cleanList((comp?.compensationTiers ?? []).map((t) => t.tierSummary)).join('; ');
}

function toPosting(
  job: AshbyJob,
  posting: AshbyPosting | null,
  departments: Map<string, string>,
  compensation: Compensation | null = posting?.compensation ?? null,
): ImportedPosting {
  const salary = annualSalary(compensation);
  const summary = compensationSummary(compensation);
  const description = [
    postingDescription(posting),
    // Hourly or other non-annual pay can't fill the salary range; keep it readable instead.
    !salary && summary ? `Compensation: ${summary}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  return {
    externalId: String(job.id),
    title: job.title?.trim() || posting?.title?.trim() || 'Untitled job',
    state: JOB_STATE[job.status ?? ''] ?? 'closed',
    department: (job.departmentId && departments.get(job.departmentId)) || posting?.teamName || posting?.departmentName || null,
    location: posting?.locationName || job.location?.externalName || job.location?.name || null,
    commitment: COMMITMENT[posting?.employmentType || job.employmentType || ''] ?? null,
    workplaceType: WORKPLACE[posting?.workplaceType || job.location?.workplaceType || ''] ?? null,
    description: description || null,
    salaryMin: salary?.min ?? null,
    salaryMax: salary?.max ?? null,
    salaryCurrency: salary?.currency ?? null,
    confidential: !!job.confidential,
    requisitionExternalId: toRequisition(job) ? String(job.id) : null,
    createdAt: toDate(job.createdAt),
  };
}

// ---------- Feedback decoding ----------

type Rating = ImportedFeedback['rating'];

function formFields(f: AshbyFeedback): FormField[] {
  return (f.formDefinition?.sections ?? [])
    .flatMap((s) => s.fields ?? [])
    .map((x) => x.field)
    .filter((x): x is FormField => !!x?.path);
}

function scoreOf(raw: unknown): number | null {
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string' && /^\d+(\.\d+)?$/.test(raw.trim())) return Number(raw);
  if (raw && typeof raw === 'object' && typeof (raw as { score?: unknown }).score === 'number') {
    return (raw as { score: number }).score;
  }
  return null;
}

const toRating = (n: number | null): Rating =>
  n == null || !Number.isFinite(n) ? null : (Math.min(4, Math.max(1, Math.round(n))) as Rating);

const isDefaultScale = (f: FormField) =>
  (f.selectableValues ?? []).map((o) => o.value).sort().join(',') === '1,2,3,4';

const NEUTRAL = /not sure|unsure|maybe|neutral|mixed|undecided|on the fence|no (strong )?opinion|no decision|no recommendation|abstain|\bn\/?a\b|not applicable|needs? more/;

/** "Strong No Hire" → 1, "no_hire" → 2, "Hire" → 3, "4 - Strong Yes" → 4; neutral answers → null. */
function labelRating(label: string): Rating {
  const s = label.toLowerCase().replace(/[_-]+/g, ' ');
  // Before the negative test: "No strong opinion" is not a "strong no".
  if (NEUTRAL.test(s)) return null;
  const strong = /\bstrong(ly)?\b|\bdefinitely\b/.test(s);
  if (/\bno\b|\bnot\b|reject|declin/.test(s)) return strong ? 1 : 2;
  if (/\byes\b|\bhire\b|advance|proceed/.test(s)) return strong ? 4 : 3;
  return null;
}

/** A field that can hold a rating: a score, a number, or a select whose options decode. Never free text. */
function canRate(f: FormField): boolean {
  if (f.type === 'Score' || f.type === 'Number') return true;
  if (f.type !== 'ValueSelect') return false;
  const options = f.selectableValues ?? [];
  return (
    options.some((o) => labelRating(o.label) != null) ||
    (options.length > 1 && options.every((o) => o.value.trim() !== '' && Number.isFinite(Number(o.value))))
  );
}

/** A select that reads as a hiring decision, not any yes/no question ("Willing to relocate?"). */
function isHireScale(f: FormField): boolean {
  if (f.type !== 'ValueSelect') return false;
  if (isDefaultScale(f)) return true;
  const options = f.selectableValues ?? [];
  const levels = new Set(options.map((o) => labelRating(o.label)).filter((r) => r != null));
  return levels.size >= 2 && (levels.size >= 3 || options.some((o) => /hire|advance|proceed|recommend/i.test(o.label)));
}

function overallField(fields: FormField[]): FormField | undefined {
  return (
    fields.find((f) => f.path === 'overall_recommendation') ??
    fields.find((f) => canRate(f) && /overall|recommend|decision|\bhire\b/i.test(`${f.title ?? ''} ${f.humanReadablePath ?? ''}`)) ??
    fields.find(isHireScale)
  );
}

function decodeRating(overall: FormField | undefined, fields: FormField[], values: Record<string, unknown>): Rating {
  if (!overall) {
    // No overall question: average the 1–4 Score answers, or leave it undecided.
    const scores = fields
      .filter((f) => f.type === 'Score')
      .map((f) => scoreOf(values[f.path]))
      .filter((n): n is number => n != null);
    return scores.length ? toRating(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
  }
  const raw = values[overall.path];
  if (raw == null || raw === '') return null;
  if (overall.type === 'Score' || (typeof raw === 'object' && raw !== null)) return toRating(scoreOf(raw));
  const value = String(raw);
  const options = overall.selectableValues ?? [];
  if (isDefaultScale(overall) || !options.length) {
    const n = Number(value);
    if (Number.isInteger(n) && n >= 1 && n <= 4) return n as Rating;
  }
  const byLabel = labelRating(options.find((o) => o.value === value)?.label ?? value);
  if (byLabel != null) return byLabel;
  // A numeric scale of another size (e.g. 1–5): stretch it onto 1–4.
  const nums = options.map((o) => Number(o.value));
  const v = Number(value);
  if (nums.length > 1 && nums.every(Number.isFinite) && Number.isFinite(v)) {
    const min = Math.min(...nums);
    const max = Math.max(...nums);
    if (max > min) return toRating(1 + ((v - min) * 3) / (max - min));
  }
  return null;
}

function renderAnswer(field: FormField, raw: unknown): string {
  if (raw == null || raw === '') return '';
  const labelOf = (v: unknown) => field.selectableValues?.find((o) => o.value === String(v))?.label ?? renderValue(v);
  switch (field.type) {
    case 'Score': {
      const score = scoreOf(raw);
      const comment = renderValue((raw as { comments?: unknown })?.comments);
      return [score != null ? `${score}/4` : '', comment].filter(Boolean).join(' — ');
    }
    case 'ValueSelect':
      return labelOf(raw);
    case 'MultiValueSelect':
      return Array.isArray(raw) ? raw.map(labelOf).join(', ') : labelOf(raw);
    default:
      return renderValue(raw);
  }
}

// ---------- The module ----------

/** Cheap reads in other modules: if any works, a 403 elsewhere is a missing permission, not a wrong key. */
const KEY_PROBES: [string, Body][] = [
  ['apiKey.info', {}],
  ['job.list', { limit: 1 }],
  ['user.list', { limit: 1 }],
  ['interviewPlan.list', { limit: 1 }],
  ['archiveReason.list', {}],
];

export const ashbyProvider: ProviderModule = {
  id: 'ashby',
  // Ashby allows 1,000 requests/min per key (possibly per org, shared with other
  // integrations). 100ms spacing = 600/min, 60% of it.
  minIntervalMs: 100,

  auth(credentials) {
    const key = (credentials.apiKey ?? '').trim();
    return {
      hosts: [HOST],
      headers: { authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` },
    };
  },

  create(_credentials, http) {
    // Per-adapter (per-slice) lookups, fetched only when a step first needs them.
    let departments: Promise<Map<string, string>> | null = null;
    let interviewTitles: Promise<Map<string, string>> | null = null;
    let fieldDefs: Promise<{ dateOnly: Set<string>; onCandidates: boolean } | null> | null = null;
    let internalBoards: Promise<string[]> | null = null;
    const fullCandidates = new Map<string, Promise<AshbyCandidate | null>>();
    // Archived-type stage ids seen so far; history entries into them are not stage moves.
    const archivedStages = new Set<string>();
    const stageTypes = new Map<string, Promise<string | null>>();
    let stageInfoDenied = false;

    const departmentNames = (ctx: PhaseContext) =>
      (departments ??= soft(
        ctx,
        'Department names',
        async () =>
          new Map(
            (await fetchAll<{ id: string; name?: string | null }>(http, 'department.list', { includeArchived: true, limit: 100 }, ctx))
              .filter((d) => d.name?.trim())
              .map((d) => [String(d.id), d.name!.trim()]),
          ),
        new Map<string, string>(),
        LOOKUP,
      ));

    const interviewTitle = async (ctx: PhaseContext, interviewId: string | null | undefined) => {
      if (!interviewId) return null;
      interviewTitles ??= soft(
        ctx,
        'Interview names',
        async () =>
          new Map(
            (
              await fetchAll<{ id: string; title?: string | null }>(
                http,
                'interview.list',
                { includeArchived: true, includeNonSharedInterviews: true, limit: 100 },
                ctx,
              )
            ).map((i) => [String(i.id), i.title?.trim() ?? '']),
          ),
        new Map<string, string>(),
        LOOKUP,
      );
      return (await interviewTitles).get(interviewId) || null;
    };

    /** Which custom fields are date-only, and whether candidates have any. Null when the key can't read definitions. */
    const customFieldDefs = (ctx: PhaseContext) =>
      (fieldDefs ??= fetchAll<CustomFieldDef>(http, 'customField.list', { includeArchived: true, limit: 100 }, ctx).then(
        (defs) => ({
          dateOnly: new Set(defs.filter((d) => d.isDateOnlyField).map((d) => String(d.id))),
          onCandidates: defs.some((d) => /^candidate$/i.test(d.objectType?.trim() ?? '')),
        }),
        (err: unknown) => {
          if (err instanceof ImportAuthError || (err instanceof AshbyApiError && err.status < 500)) {
            ctx.warn(`Candidate custom fields were not imported (grant Hiring Process read): ${err.message}`);
            return null;
          }
          fieldDefs = null;
          throw err;
        },
      ));

    const candidateInfo = (ctx: PhaseContext, candidateId: string) => {
      let found = fullCandidates.get(candidateId);
      if (!found) {
        found = soft(
          ctx,
          'Candidate details',
          () => call<AshbyCandidate>(http, 'candidate.info', { id: candidateId }).then((r) => r.results ?? null),
          null,
          EXTRA,
        );
        fullCandidates.set(candidateId, found);
      }
      return found;
    };

    /** Discover catalogued every non-Archived stage it reached; anything else is asked about once per slice. */
    async function isArchivedStage(ctx: PhaseContext, stageId: string, current: AshbyStage | null): Promise<boolean> {
      if (archivedStages.has(stageId)) return true;
      if (current && String(current.id) === stageId) return false;
      if (stageInfoDenied || (await ctx.load.has('stage', stageId))) return false;
      let type = stageTypes.get(stageId);
      if (!type) {
        type = call<AshbyStage>(http, 'interviewStage.info', { interviewStageId: stageId }).then(
          (r) => r.results?.type ?? null,
          (err: unknown) => {
            // Interviews read is optional (discover already said so): the entry keeps its name.
            if (err instanceof ImportAuthError) stageInfoDenied = true;
            else if (!(err instanceof AshbyApiError && err.status < 500)) throw err;
            return null;
          },
        );
        stageTypes.set(stageId, type);
      }
      if ((await type) !== 'Archived') return false;
      archivedStages.add(stageId);
      return true;
    }

    /** jobPosting.info reads an external board by default; a posting that only lives on an internal board needs its id. */
    async function postingInfo(jobPostingId: string): Promise<AshbyPosting | null> {
      const info = (jobBoardId?: string) =>
        call<AshbyPosting>(http, 'jobPosting.info', {
          jobPostingId,
          includeUnpublishedJobPostings: true,
          ...(jobBoardId ? { jobBoardId } : {}),
        }).then((r) => r.results ?? null);
      try {
        return await info();
      } catch (err) {
        if (!(err instanceof AshbyApiError) || err.status >= 500) throw err;
        internalBoards ??= call<{ id: string; isInternal?: boolean | null }[]>(http, 'jobBoard.list', {}).then(
          (r) => (r.results ?? []).filter((b) => b.isInternal).map((b) => String(b.id)),
          (boardErr: unknown) => {
            if (boardErr instanceof AshbyApiError && boardErr.status < 500) return [];
            // An outage or a yield: let the step fail and retry, and ask again next time.
            internalBoards = null;
            throw boardErr;
          },
        );
        for (const board of await internalBoards) {
          try {
            return await info(board);
          } catch (retryErr) {
            if (!(retryErr instanceof AshbyApiError) || retryErr.status >= 500) throw retryErr;
          }
        }
        throw err;
      }
    }

    /** A display name for "Connected to …": the brand, else the external job board, else the key's own title. */
    async function accountName(): Promise<string | null> {
      const lookups: [string, (r: Envelope<unknown>) => string | null | undefined][] = [
        ['brand.list', (r) => (r.results as { name?: string | null }[] | null)?.[0]?.name],
        ['jobBoard.list', (r) => {
          const boards = (r.results as { title?: string | null; isInternal?: boolean | null }[] | null) ?? [];
          return (boards.find((b) => !b.isInternal) ?? boards[0])?.title;
        }],
        ['apiKey.info', (r) => (r.results as { title?: string | null } | null)?.title],
      ];
      for (const [endpoint, pick] of lookups) {
        try {
          const name = pick(await call(http, endpoint, endpoint === 'brand.list' ? { limit: 1 } : {}))?.trim();
          if (name) return name;
        } catch (err) {
          // Each lookup needs its own permission (Organization, Jobs, API Keys); none is required.
          if (!(err instanceof AshbyApiError) && !(err instanceof ImportAuthError && err.status === 403)) throw err;
        }
      }
      return null;
    }

    /**
     * A module the import needs. Ashby answers 403 both to a wrong key and to a
     * key missing this module; a key that can read another module is real.
     */
    async function requireModule(endpoint: string, module: string) {
      try {
        await call(http, endpoint, { limit: 1 });
      } catch (err) {
        if (!(err instanceof ImportAuthError && err.status === 403)) throw err;
        for (const [probe, body] of KEY_PROBES) {
          if (probe === endpoint) continue;
          try {
            await call(http, probe, body);
          } catch (probeErr) {
            if (probeErr instanceof ImportAuthError && probeErr.status === 403) continue;
            if (!(probeErr instanceof AshbyApiError)) throw probeErr;
          }
          throw new AshbyPermissionError(err.where, module);
        }
        throw new ImportAuthError(401, err.where);
      }
    }

    async function downloadFile(h: FileHandle): Promise<DownloadedFile> {
      const signedUrl = async () => {
        try {
          const res = await call<{ url?: string | null }>(http, 'file.info', { fileHandle: h.handle });
          if (!res.results?.url) throw new AshbyApiError('no_url', `POST ${HOST}/file.info`, 'no download URL returned');
          return res.results.url;
        } catch (err) {
          // A file the key can't open is one skipped file, not a failed import.
          if (err instanceof ImportAuthError) throw new ImportHttpError(403, err.where, 'file access denied');
          throw err;
        }
      };
      const url = await signedUrl();
      let file;
      try {
        file = await http.bytes(url);
      } catch (err) {
        // S3 answers 403 once a signed link has expired: sign a fresh one and try once more.
        if (!(err instanceof ImportHttpError && err.status === 403)) throw err;
        file = await http.bytes(await signedUrl());
      }
      return { data: file.data, contentType: file.contentType, filename: h.name || file.filename };
    }

    // ----- discover -----

    type StagesCursor =
      | { step: 'plans' | 'jobs' | 'applications'; page: string | null; planIds: string[] }
      | { step: 'stages'; index: number; planIds: string[] };

    /** Collect plan ids from one page, then move on to the next page or the next source. */
    function advance(
      at: Extract<StagesCursor, { page: string | null }>,
      then: 'jobs' | 'applications' | 'stages',
      next: JsonValue,
      ids: (string | null | undefined)[],
    ): StagesCursor {
      const planIds = uniq([...at.planIds, ...ids]);
      if (typeof next === 'string') return { step: at.step, page: next, planIds };
      return then === 'stages' ? { step: 'stages', index: 0, planIds } : { step: then, page: null, planIds };
    }

    async function discoverStages(ctx: PhaseContext, cursor: Cursor | null): Promise<Cursor | null> {
      const at = (cursor as StagesCursor | null) ?? { step: 'plans', page: null, planIds: [] };
      if (at.step === 'stages') {
        const next = await listStep(ctx, at.index, at.planIds, async (planId) => {
          const res = await optional(
            ctx,
            'An interview plan could not be read',
            () => call<AshbyStage[]>(http, 'interviewStage.list', { interviewPlanId: planId }),
            null,
          );
          const stages = res?.results ?? [];
          const hints = stageTypeHints(stages);
          for (const s of stages) {
            if (s.type === 'Archived' || !s.title?.trim()) continue;
            ctx.catalog.stage({
              externalId: String(s.id),
              name: s.title,
              typeHint: hints.get(String(s.id)) ?? null,
              position: s.orderInInterviewPlan ?? null,
            });
          }
        });
        return next === null ? null : { step: 'stages', index: next as number, planIds: at.planIds };
      }
      // Plan ids come from three places: interviewPlan.list hides legacy plans, which jobs and applications still name.
      if (at.step === 'plans') {
        const res = await optional(
          ctx,
          'Interview plans were not read, so stages will be matched by name as applications load (grant Interviews read)',
          () => fetchPage<{ id: string }>(http, 'interviewPlan.list', { includeArchived: true, limit: 100 }, at.page, ctx),
          null,
        );
        if (!res) return null;
        return advance(at, 'jobs', res.next, res.items.map((p) => p.id));
      }
      if (at.step === 'jobs') {
        const res = await fetchPage<AshbyJob>(http, 'job.list', { limit: 100, status: JOB_STATUSES }, at.page, ctx);
        return advance(at, 'applications', res.next, res.items.flatMap((j) => [j.defaultInterviewPlanId, ...(j.interviewPlanIds ?? [])]));
      }
      const res = await fetchPage<AshbyApplication>(http, 'application.list', { limit: 100, ...createdAfter(ctx) }, at.page, ctx);
      return advance(at, 'stages', res.next, res.items.map((a) => a.currentInterviewStage?.interviewPlanId));
    }

    const discover: Phase[] = [
      {
        id: 'users',
        label: 'Team',
        run: (ctx, cursor) =>
          optional(
            ctx,
            'Teammates could not be listed, so notes and scorecards keep their authors as text (grant Organization read)',
            () =>
              paged<AshbyUser>(ctx, http, cursor, 'user.list', { includeDeactivated: true, limit: 100 }, async (u) =>
                ctx.catalog.user({ externalId: String(u.id), name: userName(u) || 'Ashby user', email: u.email ?? null }),
              ),
            null,
          ),
      },
      { id: 'stages', label: 'Interview plans', run: discoverStages },
      {
        id: 'reasons',
        label: 'Archive reasons',
        async run(ctx) {
          const res = await optional(
            ctx,
            'Archive reasons were not listed; they will be created by name from the applications (grant Hiring Process read)',
            () =>
              call<{ id: string; text?: string | null; reasonType?: string | null }[]>(http, 'archiveReason.list', {
                includeArchived: true,
              }),
            null,
          );
          for (const r of res?.results ?? []) {
            if (!r.text?.trim()) continue;
            ctx.catalog.reason({ externalId: String(r.id), name: r.text, kind: REASON_KIND[r.reasonType ?? ''] ?? 'other' });
          }
          return null;
        },
      },
    ];

    // ----- load -----

    async function loadApplication(ctx: PhaseContext, a: AshbyApplication, confidential: Set<string>) {
      const id = String(a.id);
      const current = a.currentInterviewStage ?? null;
      if (current?.type === 'Archived') archivedStages.add(String(current.id));
      const status: ImportedApplication['status'] = a.status === 'Hired' ? 'hired' : a.status === 'Archived' ? 'archived' : 'active';
      const candidateId = a.candidate?.id ? String(a.candidate.id) : '';
      const record: ImportedApplication = {
        externalId: id,
        candidateExternalId: candidateId,
        candidate: a.candidate ? inlineCandidate(a.candidate) : null,
        postingExternalId: a.job?.id ? String(a.job.id) : null,
        stage: current && current.type !== 'Archived' ? { externalId: String(current.id), name: current.title ?? null } : null,
        status,
        archiveReason: a.archiveReason ? { externalId: String(a.archiveReason.id), name: a.archiveReason.text ?? null } : null,
        archivedAt: status === 'archived' ? toDate(a.archivedAt) : null,
        origin: originOf(a),
        source: a.source?.title?.trim() || null,
        ownerExternalUserId: ownerOf(a),
        confidential: !!a.job?.id && confidential.has(String(a.job.id)),
        createdAt: toDate(a.createdAt),
      };
      if (await ctx.load.has('opportunity', id)) return ctx.load.application(record);

      const defs = await customFieldDefs(ctx);
      record.fields = customFields(a.customFields, defs?.dateOnly);
      // Orqestra keeps custom fields on applications, so the candidate's ride along (the application's win a clash).
      // With a `since` cutoff, candidate.list skipped older candidates; one who applied again after it
      // gets the full record instead of the shallow inline copy.
      const wantFields = !!defs?.onCandidates;
      const wantRecord = !!ctx.since && !!candidateId && !(await ctx.load.has('contact', candidateId));
      if (candidateId && (wantFields || wantRecord)) {
        const full = await candidateInfo(ctx, candidateId);
        if (full) {
          record.candidate = toCandidate(full);
          if (wantFields) record.fields = { ...customFields(full.customFields, defs?.dateOnly), ...record.fields };
        }
      }

      const entries = await soft(
        ctx,
        'Stage history',
        () => fetchAll<AshbyHistoryEntry>(http, 'application.listHistory', { applicationId: id, limit: 100 }, ctx),
        [],
        MISSING,
      );
      const moves: { h: AshbyHistoryEntry; at: Date }[] = [];
      for (const h of entries) {
        const at = toDate(h.enteredStageAt);
        if (!h.stageId || !at || /^archived$/i.test(h.title?.trim() ?? '')) continue;
        if (await isArchivedStage(ctx, String(h.stageId), current)) continue;
        moves.push({ h, at });
      }
      moves.sort((x, y) => (x.h.stageNumber ?? 0) - (y.h.stageNumber ?? 0) || x.at.getTime() - y.at.getTime());
      const history: StageHistoryEntry[] = moves.map(({ h, at }) => ({
        stage: { externalId: String(h.stageId), name: h.title ?? null } satisfies StageRef,
        at,
        actorExternalUserId: h.actorId ?? null,
      }));
      record.history = history;
      // Archived applications stay in the last stage they actually reached.
      if (!record.stage && history.length) record.stage = history[history.length - 1].stage;
      if (status === 'hired') {
        const hired = current ? moves.find(({ h }) => String(h.stageId) === String(current.id))?.at : undefined;
        record.archivedAt = hired ?? toDate(a.updatedAt);
      }
      await ctx.load.application(record);
    }

    async function confidentialJobIds(ctx: PhaseContext): Promise<string[]> {
      const jobs = await fetchAll<AshbyJob>(http, 'job.list', { limit: 100, status: JOB_STATUSES }, ctx);
      return jobs.filter((j) => j.confidential).map((j) => String(j.id));
    }

    type ApplicationsCursor = { pass: number; page: Cursor | null; confidential: string[] };

    async function loadInterviewEvent(ctx: PhaseContext, s: AshbySchedule, e: AshbyInterviewEvent) {
      const startAt = toDate(e.startTime);
      if (!startAt) return;
      const id = String(e.id);
      const end = toDate(e.endTime);
      const done =
        s.status === 'Complete' || s.status === 'WaitingOnFeedback' || !!e.hasSubmittedFeedback || (end ?? startAt) < new Date();
      const title = (await ctx.load.has('interview', id)) ? null : await interviewTitle(ctx, e.interviewId);
      await ctx.load.interview({
        externalId: id,
        applicationExternalId: String(s.applicationId),
        title: title || 'Interview',
        startAt,
        durationMins: end ? Math.round((end.getTime() - startAt.getTime()) / 60_000) : null,
        location: e.meetingLink || e.location || null,
        panelistExternalUserIds: uniq(e.interviewerUserIds?.length ? e.interviewerUserIds : (e.interviewers ?? []).map((i) => i.id)),
        state: s.status === 'Cancelled' ? 'canceled' : done ? 'completed' : 'scheduled',
      });
    }

    async function loadFeedback(ctx: PhaseContext, f: AshbyFeedback) {
      const id = String(f.id);
      const fields = formFields(f);
      const values = f.submittedValues ?? {};
      const overall = overallField(fields);
      const rating = decodeRating(overall, fields, values);
      const text = (types: string[]) =>
        fields.find((fl) => fl !== overall && types.includes(fl.type ?? '') && renderAnswer(fl, values[fl.path]));
      const summaryField = text(['LongText', 'RichText']) ?? text(['String']);
      const answers = fields
        // Keep the overall answer when it isn't the default 1–4 scale, so the original wording survives.
        .filter((fl) => fl !== summaryField && (fl !== overall || rating == null || !isDefaultScale(fl)))
        .map((fl) => ({ label: fl.title?.trim() || fl.humanReadablePath?.trim() || fl.path, value: renderAnswer(fl, values[fl.path]) }))
        .filter((x) => x.value);
      const title = (await ctx.load.has('feedback', id)) ? null : await interviewTitle(ctx, f.interviewId);
      await ctx.load.feedback({
        externalId: id,
        applicationExternalId: String(f.applicationId),
        interviewExternalId: f.interviewEventId ? String(f.interviewEventId) : null,
        authorExternalUserId: f.submittedByUser?.id ? String(f.submittedByUser.id) : null,
        authorName: userName(f.submittedByUser),
        rating,
        title,
        summary: summaryField ? renderAnswer(summaryField, values[summaryField.path]) : '',
        answers,
        createdAt: toDate(f.submittedAt),
      });
    }

    type FeedbackCursor = { perApplication: boolean; page: Cursor | null };

    function toOffer(o: AshbyOffer): ImportedOffer {
      const v = o.latestVersion;
      const extras = (v?.customFields ?? [])
        .map((f) => ({ title: f.title?.trim() || '', value: fieldValue(f) }))
        .filter((f) => f.title && f.value);
      // "Relocation option" is not equity: match the word, then the named instruments.
      const equity =
        extras.find((f) => /\bequity\b/i.test(f.title)) ?? extras.find((f) => /\brsus?\b|\bstock options?\b|\bstock grants?\b/i.test(f.title));
      return {
        externalId: String(o.id),
        applicationExternalId: String(o.applicationId),
        status: OFFER_STATUS[o.offerStatus ?? ''] ?? ACCEPTANCE_STATUS[o.acceptanceStatus ?? ''] ?? 'DRAFT',
        // Ashby offers carry no job title; the engine uses the posting's.
        jobTitle: null,
        salaryAmount: v?.salary?.value ?? null,
        salaryCurrency: v?.salary?.currencyCode ?? null,
        equity: equity ? (/^equity$/i.test(equity.title) ? equity.value : `${equity.title}: ${equity.value}`) : null,
        startDate: toDate(v?.startDate),
        sentAt: null,
        respondedAt: toDate(o.decidedAt),
        createdAt: toDate(v?.createdAt),
        notes: extras.filter((f) => f !== equity).map((f) => `${f.title}: ${f.value}`).join('\n') || null,
      };
    }

    /** Offer letters are files on the candidate, and an offer names only its application. */
    async function loadOfferLetters(ctx: PhaseContext, o: AshbyOffer) {
      const applicationId = String(o.applicationId);
      const handles: FileHandle[] = [];
      for (const h of o.latestVersion?.fileHandles ?? []) {
        if (h?.handle && !(await ctx.load.has('file', String(h.id)))) handles.push(h);
      }
      if (!handles.length || !(await ctx.load.has('opportunity', applicationId))) return;
      const app = await soft(
        ctx,
        'Offer letter',
        () => call<AshbyApplication>(http, 'application.info', { applicationId }).then((r) => r.results ?? null),
        null,
        EXTRA,
      );
      const candidateId = app?.candidate?.id;
      if (!candidateId) return;
      for (const h of handles) {
        await each(ctx, h, (x) =>
          ctx.load.file({
            externalId: String(x.id),
            candidateExternalId: String(candidateId),
            applicationExternalId: applicationId,
            filename: x.name?.trim() || 'Offer letter',
            kind: 'other',
            download: () => downloadFile(x),
          }),
        );
      }
    }

    /** Walk every candidate, but only fan out for those this import (or an earlier one) created. */
    const forImportedCandidates =
      (fan: (ctx: PhaseContext, c: AshbyCandidate, candidateId: string) => Promise<void>): Phase['run'] =>
      (ctx, cursor) =>
        paged<AshbyCandidate>(ctx, http, cursor, 'candidate.list', { limit: 100 }, async (c) => {
          const candidateId = String(c.id);
          if (await ctx.load.has('contact', candidateId)) await fan(ctx, c, candidateId);
        });

    const load: Phase[] = [
      {
        id: 'requisitions',
        label: 'Openings',
        run: (ctx, cursor) =>
          paged<AshbyJob>(ctx, http, cursor, 'job.list', JOB_LIST_BODY, async (job) => {
            const req = toRequisition(job);
            if (req) await ctx.load.requisition(req);
          }),
      },
      {
        id: 'postings',
        label: 'Jobs',
        run: (ctx, cursor) =>
          paged<AshbyJob>(ctx, http, cursor, 'job.list', JOB_LIST_BODY, async (job) => {
            const id = String(job.id);
            if (await ctx.load.has('posting', id)) return ctx.load.posting(toPosting(job, null, new Map()));
            const postingId = job.jobPostingIds?.[0];
            const posting = postingId ? await soft(ctx, 'Job description', () => postingInfo(postingId), null, EXTRA) : null;
            let compensation = posting?.compensation ?? null;
            if (!annualSalary(compensation)) {
              // No posting, or one that doesn't show its pay: the job's own compensation plan may.
              const full = await soft(
                ctx,
                'Job compensation',
                () => call<AshbyJob>(http, 'job.info', { id, expand: ['compensation'] }).then((r) => r.results ?? null),
                null,
                EXTRA,
              );
              if (full?.compensation && (annualSalary(full.compensation) || !compensationSummary(compensation))) {
                compensation = full.compensation;
              }
            }
            await ctx.load.posting(toPosting(job, posting, await departmentNames(ctx), compensation));
          }),
      },
      {
        id: 'candidates',
        label: 'Candidates',
        run: (ctx, cursor) =>
          paged<AshbyCandidate>(ctx, http, cursor, 'candidate.list', { limit: 100, ...createdAfter(ctx) }, (c) =>
            ctx.load.candidate(toCandidate(c)),
          ),
      },
      {
        id: 'applications',
        label: 'Applications',
        async run(ctx, cursor) {
          const at = (cursor as ApplicationsCursor | null) ?? { pass: 0, page: null, confidential: await confidentialJobIds(ctx) };
          // Without archived applications, ask Ashby for the active ones only (its filter takes one status).
          const statuses = ctx.options.archived ? [null] : ['Active', 'Lead'];
          const status = statuses[at.pass];
          const confidential = new Set(at.confidential);
          const body: Body = { limit: 100, ...(status ? { status } : {}), ...createdAfter(ctx) };
          const next = await paged<AshbyApplication>(ctx, http, at.page, 'application.list', body, (a) =>
            loadApplication(ctx, a, confidential),
          );
          if (next !== null) return { ...at, page: next };
          return at.pass + 1 < statuses.length ? { pass: at.pass + 1, page: null, confidential: at.confidential } : null;
        },
      },
      {
        id: 'interviews',
        label: 'Interviews',
        enabled: (o) => o.activity,
        run: (ctx, cursor) =>
          optional(
            ctx,
            'Interviews were skipped (grant Interviews read)',
            () =>
              paged<AshbySchedule>(ctx, http, cursor, 'interviewSchedule.list', { limit: 100, ...createdAfter(ctx) }, async (s) => {
                for (const e of s.interviewEvents ?? []) await each(ctx, e, (ev) => loadInterviewEvent(ctx, s, ev));
              }),
            null,
          ),
      },
      {
        id: 'feedback',
        label: 'Scorecards',
        enabled: (o) => o.activity,
        async run(ctx, cursor) {
          const at = (cursor as FeedbackCursor | null) ?? { perApplication: false, page: null };
          if (!at.perApplication) {
            try {
              const next = await paged<AshbyFeedback>(ctx, http, at.page, 'applicationFeedback.list', { limit: 100, ...createdAfter(ctx) }, (f) =>
                loadFeedback(ctx, f),
              );
              return next === null ? null : { perApplication: false, page: next };
            } catch (err) {
              if (!(err instanceof AshbyApiError) || err.status >= 500 || at.page !== null) throw err;
              ctx.warn(`Ashby refused the org-wide scorecard list (${err.code}); reading scorecards per application instead`);
              return { perApplication: true, page: null };
            }
          }
          const next = await paged<AshbyApplication>(ctx, http, at.page, 'application.list', { limit: 100, ...createdAfter(ctx) }, async (a) => {
            if (!(await ctx.load.has('opportunity', String(a.id)))) return;
            const list = await fetchAll<AshbyFeedback>(http, 'applicationFeedback.list', { applicationId: String(a.id), limit: 100 }, ctx);
            for (const f of list) await each(ctx, f, (x) => loadFeedback(ctx, x));
          });
          return next === null ? null : { perApplication: true, page: next };
        },
      },
      {
        id: 'notes',
        label: 'Notes',
        enabled: (o) => o.activity,
        run: forImportedCandidates(async (ctx, c, candidateId) => {
          if (Array.isArray(c.applicationIds) && !c.applicationIds.length) {
            // Orqestra keeps notes on applications; a CRM-only prospect has none to hold them.
            ctx.warn("Notes weren't imported for candidates with no applications", { entity: 'note' });
            return;
          }
          const notes = await fetchAll<AshbyNote>(http, 'candidate.listNotes', { candidateId, limit: 100 }, ctx);
          for (const n of notes) {
            await each(ctx, n, (x) =>
              ctx.load.note({
                externalId: String(x.id),
                candidateExternalId: candidateId,
                authorExternalUserId: x.author?.id ? String(x.author.id) : null,
                authorName: userName(x.author),
                // Orqestra notes have no private flag; keep Ashby's so nobody mistakes it for a shared note.
                body: `${x.isPrivate ? '[Private] ' : ''}${x.content?.trim() ?? ''}`,
                createdAt: toDate(x.createdAt),
              }),
            );
          }
        }),
      },
      {
        id: 'offers',
        label: 'Offers',
        enabled: (o) => o.offers,
        run: (ctx, cursor) =>
          optional(
            ctx,
            'Offers were skipped (grant Offers read)',
            () =>
              paged<AshbyOffer>(ctx, http, cursor, 'offer.list', { limit: 100, ...createdAfter(ctx) }, async (o) => {
                await ctx.load.offer(toOffer(o));
                if (ctx.options.files) await loadOfferLetters(ctx, o);
              }),
            null,
          ),
      },
      {
        id: 'files',
        label: 'Resumes',
        enabled: (o) => o.files,
        run: forImportedCandidates(async (ctx, c, candidateId) => {
          const resumeId = c.resumeFileHandle?.id ? String(c.resumeFileHandle.id) : null;
          const handles = [...(c.resumeFileHandle ? [c.resumeFileHandle] : []), ...(c.fileHandles ?? [])].filter(
            (h, i, all) => h?.handle && all.findIndex((x) => x.id === h.id) === i,
          );
          for (const h of handles) {
            await each(ctx, h, (x) =>
              ctx.load.file({
                externalId: String(x.id),
                candidateExternalId: candidateId,
                filename: x.name?.trim() || 'file',
                kind: String(x.id) === resumeId ? 'resume' : 'other',
                download: () => downloadFile(x),
              }),
            );
          }
        }),
      },
    ];

    return {
      async verify() {
        // The two permissions the import can't do without.
        await requireModule('candidate.list', 'Candidates');
        await requireModule('job.list', 'Jobs');
        return { accountName: (await accountName()) || 'Ashby' };
      },
      discover,
      load,
    };
  },
};
