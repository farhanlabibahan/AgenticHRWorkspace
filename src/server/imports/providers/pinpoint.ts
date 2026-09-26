import type { Commitment, OfferStatus, Origin, StageType, WorkplaceType } from '@prisma/client';
import { ImportAuthError, ImportHttpError, type QueryValue } from '@/server/imports/http';
import { nameKey } from '@/server/imports/mapping';
import { each, optional, pagedStep } from '@/server/imports/paging';
import { cleanEmails, cleanList, clip, fullName, htmlToText, toDate } from '@/server/imports/text';
import type {
  Cursor,
  ImportedCandidate,
  ImportedPosting,
  ImportedRequisition,
  ImportOptions,
  JsonValue,
  Phase,
  PhaseContext,
  ProviderModule,
  ReasonKind,
  ReasonRef,
  StageHistoryEntry,
  StageRef,
} from '@/server/imports/types';

/**
 * Pinpoint (pinpointhq.com). JSON:API built on Graphiti, one host per tenant:
 * https://{subdomain}.pinpointhq.com/api/v1 with a static `X-API-KEY` header.
 *
 * Vendor quirks this adapter handles:
 * - Confidential jobs, and the applications and interviews on them, are left
 *   out unless every visibility is listed (`filter[visibility]` /
 *   `filter[job_visibility]`). Jobs also need every status listed.
 * - Relationships only carry ids when sideloaded with `include`. Foreign-key
 *   attributes (job_id, candidate_id, stage_id, commentable_id, application_id)
 *   are used wherever they exist, always through String(): the schema says
 *   integer, the API sends strings.
 * - Graphiti keeps relationships under sparse fieldsets, but that is
 *   unverified for Pinpoint. Where a sparse query relies on a relationship,
 *   each page is checked, and asked again without the sparse fields if the
 *   relationship is missing.
 * - Extra fields (tags, attachments, days_in_current_stage) must be requested
 *   per type (`extra_fields[applications]=…`) or they are absent.
 * - Page-number paging with no `links`: a short page is the last one. Every
 *   list is sorted by id, and ids at or below the previous page's highest are
 *   dropped, so rows that shift between requests aren't handled twice.
 * - Stages are per-job copies with a `basic_type` (applied, review, interview,
 *   offer, hired, rejected). Discovery groups them by name. "Rejected" is not a
 *   pipeline position in Source, only an outcome, so it is never mapped: a
 *   rejected application sits at the furthest stage it reached.
 * - Outcome: a hired or rejected stage decides it, and otherwise hired_at or
 *   rejected_at does. A hire can leave the application in its offer stage
 *   when the company turned off the automatic move to Hired.
 * - There is no reason catalogue. Rejection reasons are application tags with
 *   context "rejection", read from rejected applications. A rejection with no
 *   such tag gets "Rejected (no reason recorded)", and the other tag contexts
 *   on those applications are reported in case a tenant uses its own category.
 * - There is no stage history. Each application gets a synthesized one: the
 *   job's applied stage at created_at, then its current (or furthest) stage at
 *   hired_at, rejected_at, or now minus days_in_current_stage (day precision).
 * - Requisitions link to jobs through requisitions.job_id. jobs.requisition_id
 *   is free text, used only for requisitions that have no job. Headcount and
 *   budget are template-defined details picked out by label. A budget with no
 *   currency of its own takes the linked job's pay currency, or is left out.
 * - Scorecards and offers have no list endpoint. Both come from one second pass
 *   over /applications with sparse fields and includes. Scorecards rate
 *   metrics 1–5 with no overall decision, so the mean maps onto Source's 1–4
 *   scale (≥4.5 strong yes, ≥3.5 yes, ≥2 no, else strong no). The AI sentiment
 *   is the fallback, and a scorecard with neither comes in as a note. Nothing
 *   links a scorecard to an interview.
 * - Attachments are listed on candidates, on applications (CVs, cover letters)
 *   and on offers (offer letters). The same file often appears on several, so
 *   each is identified per candidate by its context and name. URLs are
 *   ActiveStorage paths on Pinpoint hosts that need the key and redirect to
 *   short-lived storage URLs. Only pinpointhq.com and its subdomains are in
 *   auth.hosts, so the key rides the first hop and never the redirect.
 * - A key has Read per data category. An include that needs another category
 *   can 403 the whole request, so rich queries fall back to leaner ones, and
 *   optional data (requisitions, interviews, notes, scorecards, offers)
 *   degrades to a warning.
 * - The rate limit (240 requests per 8 minutes) is per egress IP and shared by
 *   every import on it, hence 2.5 s between requests.
 * - Demo applications, and candidates whose only applications are demos, are
 *   skipped. Blind-screened (`concealed`) application snapshots never build a
 *   contact: the candidate record is sideloaded instead. national_identifier
 *   and date_of_birth are never copied into Source.
 * - Talent-pipeline (JobSeeker) comments reach their person through
 *   /job_seekers. Interviews on job seekers have no application to land on.
 */

const HOST_SUFFIX = '.pinpointhq.com';
const JSONAPI = 'application/vnd.api+json';
const VISIBILITY = 'internal,external,confidential,private_job';
const JOB_STATUSES = 'open,closed,archived,pending_approval,draft,hold,cancelled,filled,preview';
const OPEN_STAGE_TYPES = 'applied,review,interview,offer';
const CANDIDATE_FIELDS = 'first_name,last_name,full_name,email,phone,town,state_province,country,blocked,created_at';
const DAY_MS = 86_400_000;
const INT_MAX = 2_147_483_647;

export type PinpointPageSizes = Record<
  | 'users'
  | 'stages'
  | 'reasons'
  | 'requisitions'
  | 'jobs'
  | 'candidates'
  | 'applications'
  | 'interviews'
  | 'scorecards'
  | 'comments'
  | 'files'
  | 'lookups',
  number
>;

/**
 * Max is 1000. The spec suggests 100–250 for sideload-heavy passes with a
 * 120 s timeout; the engine's is 30 s, so those passes use 100.
 */
const PAGE_SIZES: PinpointPageSizes = {
  users: 500,
  stages: 200,
  reasons: 500,
  requisitions: 500,
  jobs: 100,
  candidates: 500,
  applications: 100,
  interviews: 250,
  scorecards: 100,
  comments: 500,
  files: 200,
  lookups: 1000,
};

// ---------- JSON:API payloads (only the fields we read) ----------

type Query = Record<string, QueryValue>;
type Id = string | number;
type Linkage = { type: string; id: Id };
type Relationship = { data?: Linkage | Linkage[] | null; meta?: { included?: boolean } };
type Resource<A> = { id: Id; type: string; attributes?: A; relationships?: Record<string, Relationship> };
type Doc<A> = { data: Resource<A>[]; included?: Resource<unknown>[] };
type Included = Map<string, Resource<unknown>>;

type Tag = { context?: string | null; name?: string | null };
type Attachment = { context?: string | null; name?: string | null; url?: string | null };

type UserAttrs = { email?: string | null; first_name?: string | null; last_name?: string | null };
type StageAttrs = { name?: string | null; position?: number | null; basic_type?: string | null };
type NameAttrs = { name?: string | null; city?: string | null };
type CompanyAttrs = { name?: string | null };

type JobAttrs = {
  title?: string | null;
  status?: string | null;
  visibility?: string | null;
  created_at?: string | null;
  description?: string | null;
  key_responsibilities?: string | null;
  key_responsibilities_header?: string | null;
  external_key_responsibilities_header?: string | null;
  skills_knowledge_expertise?: string | null;
  skills_knowledge_expertise_header?: string | null;
  external_skills_knowledge_expertise_header?: string | null;
  benefits?: string | null;
  benefits_header?: string | null;
  external_benefits_header?: string | null;
  about_company_theme_section?: string | null;
  about_company_theme_section_header?: string | null;
  compensation?: string | null;
  compensation_minimum?: number | string | null;
  compensation_maximum?: number | string | null;
  compensation_currency?: string | null;
  compensation_frequency?: string | null;
  employment_type?: string | null;
  workplace_type?: string | null;
  remote?: boolean | null;
  custom_town?: string | null;
  custom_county?: string | null;
  custom_country?: string | null;
  requisition_id?: Id | null;
  hiring_user_id?: Id | null;
  recruitment_manager_user_id?: Id | null;
};

type JobPostingAttrs = { description?: string | null; default_for_job?: boolean | null };

type RequisitionAttrs = { name?: string | null; identifier?: string | null; status?: string | null; job_id?: Id | null };

export type RequisitionDetailAttrs = {
  label?: string | null;
  varchar_value?: string | null;
  text_value?: string | null;
  boolean_value?: boolean | null;
  decimal_value?: number | string | null;
  integer_value?: number | string | null;
  single_select_value?: string | null;
  multi_select_value?: string[] | null;
};

type CandidateAttrs = {
  email?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  full_name?: string | null;
  phone?: string | null;
  town?: string | null;
  state_province?: string | null;
  country?: string | null;
  blocked?: boolean | null;
  created_at?: string | null;
  tags?: Tag[] | null;
  attachments?: Attachment[] | null;
};

type ApplicationAttrs = {
  candidate_id?: Id | null;
  job_id?: Id | null;
  stage_id?: Id | null;
  created_at?: string | null;
  hired_at?: string | null;
  rejected_at?: string | null;
  start_on?: string | null;
  is_demo?: boolean | null;
  concealed?: boolean | null;
  internal_candidate?: boolean | null;
  first_name?: string | null;
  last_name?: string | null;
  full_name?: string | null;
  email?: string | null;
  phone?: string | null;
  linkedin_url?: string | null;
  summary?: string | null;
  preferred_pronouns?: string | null;
  channel?: string | null;
  channel_source?: string | null;
  town?: string | null;
  state_province?: string | null;
  country?: string | null;
  country_name?: string | null;
  tags?: Tag[] | null;
  attachments?: Attachment[] | null;
  average_rating?: number | string | null;
  days_in_current_stage?: number | string | null;
};

type JobSeekerAttrs = { candidate_id?: Id | null };

type CustomAttributeAttrs = { field_name?: string | null; value?: string | number | boolean | null; option_label?: string | null };

type CommentAttrs = {
  body_text?: string | null;
  commentable_id?: Id | null;
  commentable_type?: string | null;
  created_at?: string | null;
  private_comment?: boolean | null;
  user_id?: Id | null;
};

type InterviewAttrs = {
  start_at?: string | null;
  end_at?: string | null;
  interviewable_id?: Id | null;
  interviewable_type?: string | null;
  updated_at?: string | null;
  status?: string | null;
  summary?: string | null;
  presence?: string | null;
};

type InterviewPartAttrs = { conferencing_join_url?: string | null; position?: number | null };

type UserScorecardAttrs = {
  completed_at?: string | null;
  name?: string | null;
  sentiment?: string | null;
  summary?: string | null;
};

type ScorecardRatingAttrs = { score?: number | string | null; user_id?: Id | null };
/** Undocumented: whichever label attribute the tenant returns. */
type ScorecardOptionAttrs = { name?: string | null; title?: string | null; label?: string | null };
type ScorecardAnswerAttrs = {
  question_id?: Id | null;
  text_answer?: string | null;
  boolean_answer?: boolean | null;
  user_id?: Id | null;
};
type ScorecardNoteAttrs = { body?: string | null; user_id?: Id | null };
type QuestionAttrs = { title?: string | null };

type OfferAttrs = {
  application_id?: Id | null;
  comment?: string | null;
  created_at?: string | null;
  expires_at?: string | null;
  job_title?: string | null;
  paid_days_off?: string | null;
  result?: string | null;
  result_at?: string | null;
  salary_amount?: number | string | null;
  salary_currency?: string | null;
  salary_period?: string | null;
  sent_at?: string | null;
  start_on?: string | null;
  status?: string | null;
  work_address?: string | null;
  attachments?: Attachment[] | null;
};

// ---------- small helpers ----------

const str = (v: unknown): string | null => (v == null || v === '' ? null : String(v));

function num(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** A whole number that fits Source's integer columns, else null. */
function int(n: number | null | undefined): number | null {
  if (n == null || !Number.isFinite(n)) return null;
  const r = Math.round(n);
  return r >= 0 && r <= INT_MAX ? r : null;
}

const attrs = <A>(r: Resource<A> | undefined): A => (r?.attributes ?? {}) as A;

function indexIncluded(doc: Doc<unknown>): Included {
  return new Map((doc.included ?? []).map((r) => [`${r.type}:${r.id}`, r]));
}

function linked<A>(inc: Included, type: string, id: unknown): Resource<A> | undefined {
  return id == null ? undefined : (inc.get(`${type}:${id}`) as Resource<A> | undefined);
}

function linkages(res: Resource<unknown> | undefined, name: string): Linkage[] {
  const data = res?.relationships?.[name]?.data;
  return data ? (Array.isArray(data) ? data : [data]) : [];
}

const relIds = (res: Resource<unknown> | undefined, name: string) => linkages(res, name).map((l) => String(l.id));

function related<A>(inc: Included, res: Resource<unknown> | undefined, name: string): Resource<A>[] {
  return linkages(res, name)
    .map((l) => inc.get(`${l.type}:${l.id}`) as Resource<A> | undefined)
    .filter((r): r is Resource<A> => !!r);
}

function without(q: Query, key: string): Query {
  const rest = { ...q };
  delete rest[key];
  return rest;
}

const isForbidden = (err: unknown) => err instanceof ImportAuthError && err.status === 403;

const isPinpointHost = (host: string) => host === 'pinpointhq.com' || host.endsWith(HOST_SUFFIX);

/** Response strings for polymorphic types (Application, JobSeeker…) are unverified: compare loosely. */
const typeIs = (value: string | null | undefined, name: string) => (value ?? '').replace(/[_\s]/g, '').toLowerCase() === name;

/** Accepts "acme", "acme.pinpointhq.com", or a pasted admin URL. */
function subdomainOf(raw: string | undefined): string | null {
  let s = (raw ?? '').trim().toLowerCase();
  s = s.replace(/^[a-z]+:\/\//, '').split(/[/?#]/)[0].replace(/:\d+$/, '');
  if (s.endsWith(HOST_SUFFIX)) s = s.slice(0, -HOST_SUFFIX.length);
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(s) ? s : null;
}

/** Graphiti datetime filter value. The http client encodes its "+" as %2B, which Rails needs. */
function sinceParam(since: Date): string {
  return new Date(since.getTime() - 1000).toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

function place(town?: string | null, region?: string | null, country?: string | null): string | null {
  return cleanList([town, region || country]).join(', ') || null;
}

const isRejectionTag = (t: Tag) => (t.context ?? '').trim().toLowerCase() === 'rejection';

function tagNames(tags: Tag[] | null | undefined, keep: (t: Tag) => boolean): string[] {
  return cleanList((tags ?? []).filter(keep).map((t) => t.name));
}

const reasonKey = (name: string) => `rejection:${nameKey(name)}`;

/** For rejections with no rejection tag. Its id can't collide with reasonKey(). */
const NO_REASON = { externalId: 'no-reason', name: 'Rejected (no reason recorded)' } satisfies ReasonRef;

function reasonKind(name: string): ReasonKind {
  return /withdr[ae]w|withdrawn|declined|accepted (another|other)|no longer interested/i.test(name) ? 'withdrawn' : 'rejection';
}

// ---------- vendor → Source mappings ----------

const STAGE_TYPE: Record<string, StageType> = {
  applied: 'APPLICANT',
  review: 'SCREEN',
  interview: 'ONSITE',
  offer: 'OFFER',
  hired: 'HIRED',
};

const basicType = (s: Resource<StageAttrs> | undefined) => (attrs(s).basic_type ?? '').toLowerCase() || null;

function commitment(type: string | null | undefined): Commitment | null {
  if (!type) return null;
  const t = type.toLowerCase();
  if (/part_time|zero_hours|flexible|term_time|bank/.test(t)) return 'PART_TIME';
  if (/contract|freelance|temporary|fixed_term|seasonal|secondment/.test(t)) return 'CONTRACT';
  if (/internship|apprentice|programme/.test(t)) return 'INTERNSHIP';
  return 'FULL_TIME';
}

function workplace(job: JobAttrs): WorkplaceType | null {
  const t = (job.workplace_type ?? '').toLowerCase();
  if (t === 'onsite') return 'ONSITE';
  if (t === 'hybrid') return 'HYBRID';
  if (t === 'remote') return 'REMOTE';
  return job.remote ? 'REMOTE' : null;
}

function postingState(job: JobAttrs): ImportedPosting['state'] {
  const s = (job.status ?? '').toLowerCase();
  if (s === 'open') return job.visibility === 'internal' || job.visibility === 'private_job' ? 'internal' : 'open';
  if (s === 'draft' || s === 'preview' || s === 'pending_approval') return 'draft';
  return 'closed';
}

/** Trix HTML split across sections, each with its own header. */
function jobDescription(job: JobAttrs): string {
  const sections: [string | null | undefined, string | null | undefined][] = [
    [null, job.description],
    [job.external_key_responsibilities_header || job.key_responsibilities_header, job.key_responsibilities],
    [job.external_skills_knowledge_expertise_header || job.skills_knowledge_expertise_header, job.skills_knowledge_expertise],
    [job.external_benefits_header || job.benefits_header, job.benefits],
    [job.about_company_theme_section_header, job.about_company_theme_section],
  ];
  return sections
    .map(([header, body]) => {
      const text = htmlToText(body);
      return text ? [header?.trim(), text].filter(Boolean).join('\n') : '';
    })
    .filter(Boolean)
    .join('\n\n');
}

function requisitionState(status: string | null | undefined): ImportedRequisition['state'] {
  const s = (status ?? '').toLowerCase();
  if (/hold|pause/.test(s)) return 'on_hold';
  if (/clos|fill|cancel|reject|declin|archiv/.test(s)) return 'closed';
  return 'open';
}

/** Every number in free text: "£55,000 - £65,000" → [55000, 65000], "60k" → [60000]. */
function numbersIn(text: string | null | undefined): number[] {
  return [...(text ?? '').matchAll(/(\d[\d,]*(?:\.\d+)?)(\s*k\b)?/gi)]
    .map((m) => Number(m[1].replace(/,/g, '')) * (m[2] ? 1000 : 1))
    .filter(Number.isFinite);
}

/** A requisition detail's numbers: its typed value, else every number written in its text. */
function detailNumbers(d: RequisitionDetailAttrs): number[] {
  const typed = num(d.integer_value) ?? num(d.decimal_value);
  return typed != null ? [typed] : numbersIn(d.varchar_value ?? d.text_value);
}

/** Requisition details are template-defined, so fields are picked out by label. */
function labelled(details: RequisitionDetailAttrs[], label: RegExp, unless?: RegExp): RequisitionDetailAttrs[] {
  return details.filter((d) => label.test(d.label ?? '') && !unless?.test(d.label ?? ''));
}

const firstNumbers = (details: RequisitionDetailAttrs[]) => details.map(detailNumbers).find((ns) => ns.length) ?? [];

const HEADCOUNT = /headcount|openings|number of (hires|positions|roles)/i;
const SALARY = /salary|budget/i;
const CURRENCY_CODE = /\b(GBP|EUR|USD|CAD|AUD|NZD|CHF|SEK|NOK|DKK|PLN|INR|SGD|ZAR|AED|JPY)\b/i;

/** The budget a requisition's own details state, with the currency only if they state it. */
function budget(details: RequisitionDetailAttrs[]) {
  const low = firstNumbers(labelled(details, /(salary|budget).*min|min.*(salary|budget)/i));
  const high = firstNumbers(labelled(details, /(salary|budget).*max|max.*(salary|budget)/i));
  const any = firstNumbers(labelled(details, SALARY, /min|max|currency/i));
  // A single amount ("Budgeted salary") is the ceiling; a range in text gives both ends.
  let min = low[0] ?? (any.length > 1 ? any[0] : null);
  let max = high[high.length - 1] ?? any[any.length - 1] ?? null;
  if (min != null && max != null && min > max) [min, max] = [max, min];
  const text = labelled(details, SALARY)
    .map((d) => `${d.varchar_value ?? ''} ${d.text_value ?? ''}`)
    .join(' ');
  const currency =
    labelled(details, /currency/i)
      .map((d) => (d.single_select_value ?? d.varchar_value ?? '').trim().toUpperCase())
      .find((c) => /^[A-Z]{3}$/.test(c)) ??
    (/£/.test(text) ? 'GBP' : /€/.test(text) ? 'EUR' : (CURRENCY_CODE.exec(text)?.[1].toUpperCase() ?? null));
  return { min, max, currency };
}

/**
 * Requisition budget. Without a currency (from the details, else the linked
 * job's pay currency) the amounts are left out: Source would store them as dollars.
 */
export function pinpointRequisitionSalary(details: RequisitionDetailAttrs[], jobCurrency?: string | null) {
  const b = budget(details);
  const currency = b.currency ?? (jobCurrency?.trim().toUpperCase() || null);
  if (!currency || !/^[A-Z]{3}$/.test(currency)) return { min: null, max: null, currency: null };
  return { min: int(b.min), max: int(b.max), currency };
}

function origin(a: ApplicationAttrs): Origin {
  const c = (a.channel ?? '').toLowerCase();
  if (c === 'employee_referral') return 'REFERRED';
  if (c === 'recruiter') return 'AGENCY';
  if (c === 'internal' || a.internal_candidate) return 'INTERNAL';
  if (c === 'manual' || c === 'chrome_extension' || c === 'invited') return 'SOURCED';
  return 'APPLIED';
}

function source(a: ApplicationAttrs): string | null {
  const free = a.channel_source?.trim();
  if (free) return free;
  const c = (a.channel ?? '').trim().toLowerCase();
  if (!c || c === 'undetermined' || c === 'other') return null;
  const words = c.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A contact from the candidate record, filling gaps from an application's own copy (never a masked one). */
function contactOf(
  id: string,
  c: CandidateAttrs | null,
  app: ApplicationAttrs | null,
  links: (string | null | undefined)[] = [app?.linkedin_url],
): ImportedCandidate {
  return {
    externalId: id,
    name:
      c?.full_name?.trim() ||
      fullName(c?.first_name, c?.last_name, '') ||
      app?.full_name?.trim() ||
      fullName(app?.first_name, app?.last_name),
    emails: cleanEmails([c?.email || app?.email]),
    phones: cleanList([c?.phone || app?.phone]),
    links: cleanList(links),
    location:
      place(c?.town, c?.state_province, c?.country) ??
      (app ? place(app.town, app.state_province, app.country_name ?? app.country) : null),
    tags: c ? cleanList([...tagNames(c.tags, (t) => !isRejectionTag(t)), c.blocked ? 'Blocked' : null]) : [],
    createdAt: toDate(c?.created_at) ?? toDate(app?.created_at),
  };
}

/** Mean 1–5 metric score → 1 strong no · 2 no · 3 yes · 4 strong yes; else the AI sentiment; else no decision. */
export function pinpointRating(scores: number[], sentiment?: string | null): 1 | 2 | 3 | 4 | null {
  const valid = scores.filter((s) => s >= 1 && s <= 5);
  if (valid.length) {
    const mean = valid.reduce((sum, s) => sum + s, 0) / valid.length;
    return mean >= 4.5 ? 4 : mean >= 3.5 ? 3 : mean >= 2 ? 2 : 1;
  }
  // Sentiment strings are unverified. Negative wording is checked first, so "strong_negative" isn't a strong yes.
  const s = (sentiment ?? '').toLowerCase().replace(/[_-]+/g, ' ').trim();
  const strong = /\b(very|strong(ly)?)\b/.test(s);
  if (/negative|^((very|strong(ly)?) )?no$/.test(s)) return strong ? 1 : 2;
  if (/positive|^((very|strong(ly)?) )?yes$|^strong$/.test(s)) return strong ? 4 : 3;
  if (/neutral|mixed/.test(s)) return 2;
  return null;
}

/** Enum strings are undocumented: match `result` first, then `status`. */
export function pinpointOfferStatus(o: Pick<OfferAttrs, 'result' | 'status' | 'sent_at'>): OfferStatus {
  for (const value of [o.result, o.status]) {
    const s = (value ?? '').toLowerCase();
    if (s.includes('accept')) return 'ACCEPTED';
    if (/declin|reject/.test(s)) return 'DECLINED';
    if (/retract|withdr|cancel/.test(s)) return 'WITHDRAWN';
  }
  if (!o.sent_at && /approv|awaiting|pending/.test((o.status ?? '').toLowerCase())) return 'PENDING_APPROVAL';
  return o.sent_at ? 'SENT' : 'DRAFT';
}

const SKIPPED_ATTACHMENTS = /admin_pdf_application|pdf_cover_letter/i;
const RESUME_CONTEXT = /(^|[^a-z])cv([^a-z]|$)|resume|résumé|curriculum/i;

/** The CV by context, else the first document that isn't a cover letter, offer, or form PDF. */
function pickAttachments(list: Attachment[]): { att: Attachment & { url: string }; kind: 'resume' | 'other' }[] {
  const usable = list.filter(
    (a): a is Attachment & { url: string } => !!a.url && !SKIPPED_ATTACHMENTS.test(a.context ?? ''),
  );
  const resume =
    usable.find((a) => RESUME_CONTEXT.test(a.context ?? '')) ??
    usable.find(
      (a) => /\.(pdf|docx?)$/i.test(a.name ?? '') && !/cover|offer|application/i.test(`${a.context ?? ''} ${a.name ?? ''}`),
    );
  return usable.map((att) => ({ att, kind: att === resume ? 'resume' : 'other' }));
}

// ---------- paging ----------

/** `full`: this list drops relationships under sparse fieldsets, so ask without them. */
type Token = { n: number; level: number; last: string | null; full: boolean };

type Fetched<A> = { items: Resource<A>[]; inc: Included; next: Token | null };

/** Checks a page that relies on relationships under a sparse fieldset, and how to ask without it. */
type Probe = { ok: (doc: Doc<unknown>) => boolean; relax: (q: Query) => Query };

const emptyPage = <A>(): Fetched<A> => ({ items: [], inc: new Map(), next: null });

function isObject(v: JsonValue | null | undefined): v is { [key: string]: JsonValue } {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function toToken(page: JsonValue | null): Token {
  const t = isObject(page) ? page : {};
  return {
    n: typeof t.n === 'number' ? t.n : 1,
    level: typeof t.level === 'number' ? t.level : 0,
    last: typeof t.last === 'string' ? t.last : null,
    full: t.full === true,
  };
}

/**
 * Drop ids at or below the previous page's highest: page-number paging over a
 * table that is being written to can shift rows back onto the next page.
 */
function trim<A>(ctx: PhaseContext, what: string, data: Resource<A>[], n: number, last: string | null, size: number) {
  const floor = last == null ? NaN : Number(last);
  const items = Number.isFinite(floor) ? data.filter((r) => !(Number(r.id) <= floor)) : data;
  const ids = data.map((r) => Number(r.id)).filter(Number.isFinite);
  const top = ids.length ? String(Math.max(...ids, Number.isFinite(floor) ? floor : -Infinity)) : last;
  const full = data.length >= size;
  if (full && !items.length) {
    ctx.warn(`${what}: Pinpoint returned page ${n} again; stopped paging to avoid a loop`);
    return { items, top, more: false };
  }
  return { items, top, more: full };
}

function applicationFilters(ctx: PhaseContext): Query {
  return {
    'filter[job_visibility]': VISIBILITY,
    ...(ctx.options.archived ? {} : { 'filter[stage_basic_type]': OPEN_STAGE_TYPES }),
    ...(ctx.since ? { 'filter[created_at][gt]': sinceParam(ctx.since) } : {}),
  };
}

const sinceFilter = (ctx: PhaseContext): Query => (ctx.since ? { 'filter[created_at][gt]': sinceParam(ctx.since) } : {});

type Part = 'scorecards' | 'offers';

/** Richest first. Metric names, question titles and authors can each need another data category. */
const SCORECARD_INCLUDES = [
  [
    'user_scorecards',
    'user_scorecards.user',
    'user_scorecards.scorecard_note',
    'user_scorecards.scorecard_ratings',
    'user_scorecards.scorecard_ratings.scorecard_option',
    'user_scorecards.scorecard_answers',
    'user_scorecards.scorecard_answers.question',
  ],
  ['user_scorecards', 'user_scorecards.user', 'user_scorecards.scorecard_note', 'user_scorecards.scorecard_ratings', 'user_scorecards.scorecard_answers'],
  // The author still comes from the ratings', answers' and note's user_id.
  ['user_scorecards', 'user_scorecards.scorecard_note', 'user_scorecards.scorecard_ratings', 'user_scorecards.scorecard_answers'],
].map((paths) => paths.join(','));

const PART_LABEL: Record<Part, string> = { scorecards: 'Scorecards', offers: 'Offers' };

/** `level` is the scorecards include level the key can read. */
type PassBToken = { n: number; parts: Part[]; full: boolean; last: string | null; level: number };

type PassBPage = {
  items: Resource<ApplicationAttrs>[];
  next: PassBToken | null;
  inc: Included;
  /** Application id → user_scorecard ids (no FK back from the scorecard). */
  scorecards: Map<string, string[]>;
  offers: Map<string, Set<string>>;
};

const isPart = (p: JsonValue): p is Part => p === 'scorecards' || p === 'offers';

function toPassBToken(page: JsonValue | null, options: ImportOptions): PassBToken {
  const t = isObject(page) ? page : {};
  const wanted: Part[] = [...(options.activity ? ['scorecards' as const] : []), ...(options.offers ? ['offers' as const] : [])];
  return {
    n: typeof t.n === 'number' ? t.n : 1,
    parts: Array.isArray(t.parts) ? t.parts.filter(isPart) : wanted,
    full: t.full === true,
    last: typeof t.last === 'string' ? t.last : null,
    level: typeof t.level === 'number' ? Math.min(t.level, SCORECARD_INCLUDES.length - 1) : 0,
  };
}

// ---------- the module ----------

export function createPinpointProvider(pageSizes: Partial<PinpointPageSizes> = {}): ProviderModule {
  const size: PinpointPageSizes = { ...PAGE_SIZES, ...pageSizes };

  return {
    id: 'pinpoint',
    // 240 requests / 8 min per egress IP ≈ one per 2 s, shared by every import on that IP.
    minIntervalMs: 2500,

    auth(credentials) {
      const key = credentials.apiKey?.trim();
      return {
        // The tenant host serves the API and attachment blobs, and older blob
        // links use the apex. Storage redirects leave Pinpoint and go without the key.
        hosts: ['pinpointhq.com', HOST_SUFFIX],
        headers: { ...(key ? { 'X-API-KEY': key } : {}), 'x-vendor-name': 'source-ats' },
      };
    },

    create(credentials, http) {
      const sub = subdomainOf(credentials.subdomain);

      function baseUrl(): string {
        if (!sub) throw new Error('Enter your Pinpoint subdomain: the part before .pinpointhq.com in your Pinpoint address');
        return `https://${sub}${HOST_SUFFIX}`;
      }

      async function get<A>(path: string, query: Query): Promise<Doc<A>> {
        const res = await http.request<Doc<A>>({ url: `${baseUrl()}/api/v1${path}`, query, headers: { accept: JSONAPI } });
        if (!res.data || !Array.isArray(res.data.data)) throw new Error(`Pinpoint returned an unexpected response for ${path}`);
        return res.data;
      }

      /**
       * One page, with the richest query the key can read. `levels` go from
       * richest to leanest; an include that needs another data category may 403
       * the whole request, so fall back and keep the level in the page token.
       */
      async function pageOf<A>(
        ctx: PhaseContext,
        what: string,
        path: string,
        levels: Query[],
        pageSize: number,
        page: JsonValue | null,
        probe?: Probe,
      ): Promise<Fetched<A>> {
        const at = toToken(page);
        let full = at.full;
        let denied: Error | null = null;
        for (let level = Math.min(at.level, levels.length - 1); ; level++) {
          const query = () => ({
            ...(full && probe ? probe.relax(levels[level]) : levels[level]),
            'page[number]': at.n,
            'page[size]': pageSize,
            sort: 'id',
          });
          let doc: Doc<A>;
          try {
            doc = await get<A>(path, query());
            if (probe && !full && !probe.ok(doc)) {
              full = true;
              doc = await get<A>(path, query());
            }
          } catch (err) {
            if (!isForbidden(err) || level >= levels.length - 1) throw err;
            denied ??= err as Error;
            continue;
          }
          if (denied) ctx.warn(`${what}: ${denied.message}. Imported without the related records it can't read.`);
          const { items, top, more } = trim(ctx, what, doc.data, at.n, at.last, pageSize);
          return { items, inc: indexIncluded(doc), next: more ? { n: at.n + 1, level, last: top, full } : null };
        }
      }

      /** Optional endpoints: a 403 or 404 ends the phase with a warning. */
      const optionalPage = <A>(ctx: PhaseContext, what: string, fetch: () => Promise<Fetched<A>>) =>
        optional(ctx, what, fetch, emptyPage<A>());

      /**
       * Values for a few ids from a light, id-sorted walk of a list (no id
       * filter is documented). Stops at the page that passes the highest id.
       */
      async function lookup<A>(path: string, query: Query, ids: Set<string>, pick: (a: A) => string | null) {
        const found = new Map<string, string>();
        const numeric = [...ids].map(Number);
        const top = numeric.every(Number.isFinite) ? Math.max(...numeric) : Infinity;
        for (let n = 1; ids.size; n++) {
          const doc = await get<A>(path, { ...query, 'page[number]': n, 'page[size]': size.lookups, sort: 'id' });
          for (const r of doc.data) {
            const value = ids.has(String(r.id)) ? pick(attrs(r)) : null;
            if (value) found.set(String(r.id), value);
          }
          if (doc.data.length < size.lookups || found.size === ids.size || doc.data.some((r) => Number(r.id) >= top)) break;
        }
        return found;
      }

      // ---------- discovery ----------

      const discover: Phase[] = [
        {
          id: 'users',
          label: 'Team members',
          async run(ctx, cursor) {
            const f = await optionalPage(ctx, 'Team members', () =>
              pageOf<UserAttrs>(ctx, 'Team members', '/users', [{}], size.users, cursor),
            );
            for (const u of f.items) {
              const a = attrs(u);
              ctx.catalog.user({
                externalId: String(u.id),
                name: fullName(a.first_name, a.last_name, a.email ?? `Pinpoint user ${u.id}`),
                email: a.email ?? null,
              });
            }
            return f.next;
          },
        },
        {
          id: 'stages',
          label: 'Job pipelines',
          async run(ctx, cursor) {
            const f = await optionalPage(ctx, 'Job pipelines', () =>
              pageOf<JobAttrs>(
                ctx,
                'Job pipelines',
                '/jobs',
                [
                  {
                    'filter[visibility]': VISIBILITY,
                    'filter[status]': JOB_STATUSES,
                    include: 'stages',
                    'fields[jobs]': 'title',
                    'fields[stages]': 'name,position,basic_type',
                  },
                ],
                size.stages,
                cursor,
              ),
            );
            for (const r of f.inc.values()) {
              if (r.type !== 'stages') continue;
              const s = r as Resource<StageAttrs>;
              const type = basicType(s);
              const name = attrs(s).name?.trim();
              if (!name || type === 'rejected') continue;
              ctx.catalog.stage({
                externalId: String(s.id),
                name,
                typeHint: (type && STAGE_TYPE[type]) || null,
                position: num(attrs(s).position),
              });
            }
            return f.next;
          },
        },
        {
          id: 'reasons',
          label: 'Rejection reasons',
          enabled: (o) => o.archived,
          async run(ctx, cursor) {
            const f = await optionalPage(ctx, 'Rejection reasons', () =>
              pageOf<ApplicationAttrs>(
                ctx,
                'Rejection reasons',
                '/applications',
                [
                  {
                    ...sinceFilter(ctx),
                    'filter[job_visibility]': VISIBILITY,
                    'filter[stage_basic_type]': 'rejected',
                    'fields[applications]': 'stage_id,rejected_at,is_demo',
                    'extra_fields[applications]': 'tags',
                  },
                ],
                size.reasons,
                cursor,
              ),
            );
            const contexts = new Set<string>();
            for (const app of f.items) {
              const a = attrs(app);
              if (a.is_demo) continue;
              const names = tagNames(a.tags, isRejectionTag);
              for (const name of names) ctx.catalog.reason({ externalId: reasonKey(name), name, kind: reasonKind(name) });
              if (names.length) continue;
              ctx.catalog.reason({ ...NO_REASON, kind: 'rejection' });
              for (const t of a.tags ?? []) if (t.context?.trim()) contexts.add(t.context.trim());
            }
            // A tenant may keep rejection reasons in its own tag category; say which ones we saw.
            for (const c of contexts) {
              ctx.warn(
                `Some rejected applications have no rejection-reason tag but do have "${c}" tags. Only tags in Pinpoint's "rejection" category become rejection reasons.`,
              );
            }
            return f.next;
          },
        },
      ];

      // ---------- load ----------

      const detailsOf = (r: Resource<RequisitionAttrs>, inc: Included) =>
        related<RequisitionDetailAttrs>(inc, r, 'requisition_details').map((d) => attrs(d));

      async function loadRequisition(
        ctx: PhaseContext,
        r: Resource<RequisitionAttrs>,
        inc: Included,
        jobCurrency: Map<string, string>,
      ) {
        const a = attrs(r);
        const details = detailsOf(r, inc);
        const identifier = a.identifier?.trim() || null;
        const jobId = str(a.job_id);
        // Postings find their requisition by job. A second requisition for the
        // same job keeps its own key (and a replay of the first is matched by code).
        const byJob = jobId ? `job:${jobId}` : null;
        const salary = pinpointRequisitionSalary(details, jobId ? jobCurrency.get(jobId) : null);
        await ctx.load.requisition({
          externalId: byJob && !(await ctx.load.has('requisition', byJob)) ? byJob : (identifier ?? `id:${r.id}`),
          code: identifier ?? `REQ-${r.id}`,
          title: a.name?.trim() || identifier || `Requisition ${r.id}`,
          state: requisitionState(a.status),
          openings: int(firstNumbers(labelled(details, HEADCOUNT))[0]),
          salaryMin: salary.min,
          salaryMax: salary.max,
          salaryCurrency: salary.currency,
          backfill: details.some(
            (d) =>
              (/backfill|replacement/i.test(d.label ?? '') && d.boolean_value === true) ||
              /backfill|replacement/i.test([d.single_select_value, d.varchar_value, ...(d.multi_select_value ?? [])].join(' ')),
          ),
        });
      }

      async function loadJob(ctx: PhaseContext, job: Resource<JobAttrs>, inc: Included) {
        const a = attrs(job);
        const dept = related<NameAttrs>(inc, job, 'department')[0];
        const loc = related<NameAttrs>(inc, job, 'location')[0];
        const postings = related<JobPostingAttrs>(inc, job, 'job_postings');
        const fallback = postings.find((p) => attrs(p).default_for_job) ?? postings[0];
        // Salaries in Source are annual; keep hourly/daily pay as text instead.
        const annual = !a.compensation_frequency || a.compensation_frequency === 'year';
        const description = [
          jobDescription(a) || htmlToText(attrs(fallback).description),
          !annual && a.compensation ? `Compensation: ${a.compensation}` : '',
        ]
          .filter(Boolean)
          .join('\n\n');
        const byJob = `job:${job.id}`;
        await ctx.load.posting({
          externalId: String(job.id),
          title: a.title?.trim() || `Pinpoint job ${job.id}`,
          state: postingState(a),
          department: attrs(dept).name ?? null,
          location: a.custom_town
            ? cleanList([a.custom_town, a.custom_county, a.custom_country]).join(', ')
            : attrs(loc).name || attrs(loc).city || null,
          commitment: commitment(a.employment_type),
          workplaceType: workplace(a),
          description: description || null,
          salaryMin: annual ? num(a.compensation_minimum) : null,
          salaryMax: annual ? num(a.compensation_maximum) : null,
          salaryCurrency: annual ? (a.compensation_currency ?? null) : null,
          confidential: a.visibility === 'confidential',
          // The job's own requisition_id is free text: only a fallback for requisitions with no job.
          requisitionExternalId: (await ctx.load.has('requisition', byJob)) ? byJob : str(a.requisition_id)?.trim() || null,
          createdAt: toDate(a.created_at),
        });
      }

      async function loadCandidate(ctx: PhaseContext, c: Resource<CandidateAttrs>, apps: ApplicationAttrs[] | undefined) {
        if (apps?.length && apps.every((x) => x.is_demo)) return; // Pinpoint's sample candidates
        // archived=false: a person whose every application is closed brings nothing active.
        if (!ctx.options.archived && apps?.length && apps.every((x) => x.is_demo || x.hired_at || x.rejected_at)) return;
        const links = (apps ?? []).filter((x) => !x.concealed).map((x) => x.linkedin_url);
        await ctx.load.candidate(contactOf(String(c.id), attrs(c), null, links));
      }

      async function loadApplication(ctx: PhaseContext, app: Resource<ApplicationAttrs>, inc: Included) {
        const a = attrs(app);
        if (a.is_demo) return; // Pinpoint's sample data
        const candidateId = str(a.candidate_id);
        if (!candidateId) throw new Error('application has no candidate');

        const job = linked<JobAttrs>(inc, 'jobs', a.job_id);
        const jobAttrs = attrs(job);
        const current = linked<StageAttrs>(inc, 'stages', a.stage_id);
        const furthest = related<StageAttrs>(inc, app, 'furthest_stage')[0];
        const pipeline = related<StageAttrs>(inc, job, 'stages').sort(
          (x, y) => (num(attrs(x).position) ?? 999) - (num(attrs(y).position) ?? 999),
        );
        const entry =
          pipeline.find((s) => basicType(s) === 'applied') ??
          pipeline.find((s) => basicType(s) !== 'rejected' && basicType(s) !== 'hired');

        const kind = basicType(current);
        const status: 'active' | 'archived' | 'hired' =
          kind === 'hired'
            ? 'hired'
            : kind === 'rejected'
              ? 'archived'
              : a.hired_at
                ? 'hired'
                : a.rejected_at
                  ? 'archived'
                  : 'active';

        const refOf = (s: Resource<StageAttrs>): StageRef => ({ externalId: String(s.id), name: attrs(s).name ?? null });
        let stage: StageRef | null;
        if (status === 'archived') {
          const reached = furthest && basicType(furthest) !== 'rejected' ? furthest : entry;
          stage = reached ? refOf(reached) : null;
        } else if (current) {
          stage = refOf(current);
        } else {
          stage = a.stage_id != null ? { externalId: String(a.stage_id) } : null;
        }

        const created = toDate(a.created_at);
        const days = num(a.days_in_current_stage);
        const enteredCurrent = days != null ? new Date(Date.now() - days * DAY_MS) : null;
        const outcomeAt = status === 'archived' ? toDate(a.rejected_at) : status === 'hired' ? toDate(a.hired_at) : null;
        // A hire that left the application in its offer stage entered that stage before the hire.
        const beforeOutcome = status === 'hired' && !!kind && kind !== 'hired';
        const reachedAt = beforeOutcome ? (enteredCurrent ?? outcomeAt) : (outcomeAt ?? enteredCurrent);

        // Pinpoint keeps no moves: applied at created_at, then the stage it sits in.
        let history: StageHistoryEntry[] = entry && created ? [{ stage: refOf(entry), at: created }] : [];
        if (stage && stage.externalId !== history[0]?.stage.externalId) {
          history = reachedAt
            ? [...history, { stage, at: created && reachedAt < created ? created : reachedAt }]
            : []; // can't place the current stage in time
        }

        const reasons = tagNames(a.tags, isRejectionTag);
        const otherTags = cleanList([...tagNames(a.tags, (t) => !isRejectionTag(t)), ...reasons.slice(1)]);
        const fields: Record<string, string> = {};
        for (const ca of related<CustomAttributeAttrs>(inc, app, 'custom_attributes')) {
          const c = attrs(ca);
          const label = c.field_name?.trim();
          const value = str(c.option_label ?? c.value)?.trim();
          if (label && value) fields[label] = clip(value, 2000);
        }
        const extra: Record<string, string | null> = {
          'Pinpoint average rating': str(num(a.average_rating)),
          Summary: a.summary?.trim() ? clip(a.summary.trim(), 4000) : null,
          Pronouns: a.preferred_pronouns?.trim() || null,
          Tags: otherTags.join(', ') || null,
          'Start date': a.start_on ?? null,
        };
        for (const [label, value] of Object.entries(extra)) if (value && !fields[label]) fields[label] = value;

        const person = linked<CandidateAttrs>(inc, 'candidates', candidateId);
        await ctx.load.application({
          externalId: String(app.id),
          candidateExternalId: candidateId,
          // Blind-screened snapshots are masked: only the candidate record may build the contact.
          candidate: person || !a.concealed ? contactOf(candidateId, person ? attrs(person) : null, a.concealed ? null : a) : null,
          postingExternalId: str(a.job_id),
          stage,
          status,
          archiveReason:
            status === 'archived' ? (reasons[0] ? { externalId: reasonKey(reasons[0]), name: reasons[0] } : NO_REASON) : null,
          archivedAt: outcomeAt,
          origin: origin(a),
          source: source(a),
          ownerExternalUserId: str(jobAttrs.recruitment_manager_user_id) ?? str(jobAttrs.hiring_user_id),
          confidential: jobAttrs.visibility === 'confidential',
          createdAt: created,
          history,
          fields,
        });
      }

      async function loadInterview(ctx: PhaseContext, iv: Resource<InterviewAttrs>, inc: Included) {
        const a = attrs(iv);
        const applicationId = str(a.interviewable_id);
        // Talent-pipeline (JobSeeker) interviews have no opportunity to land on.
        if (!typeIs(a.interviewable_type, 'application') || !applicationId) return;
        const startAt = toDate(a.start_at);
        if (!startAt) return;
        const end = toDate(a.end_at);
        const stageName = attrs(related<StageAttrs>(inc, iv, 'stage')[0]).name?.trim();
        const title = stageName || 'Interview';
        const parts = related<InterviewPartAttrs>(inc, iv, 'interview_parts').sort(
          (x, y) => (num(attrs(x).position) ?? 0) - (num(attrs(y).position) ?? 0),
        );
        const status = (a.status ?? '').toLowerCase();
        const presence = (a.presence ?? '').toLowerCase();
        await ctx.load.interview({
          externalId: String(iv.id),
          applicationExternalId: applicationId,
          title,
          startAt,
          durationMins: end ? (end.getTime() - startAt.getTime()) / 60_000 : null,
          location: parts.map((p) => attrs(p).conferencing_join_url?.trim()).find(Boolean) ?? null,
          panelistExternalUserIds: [...new Set(parts.flatMap((p) => relIds(p, 'interviewing_users')))],
          state: /cancel/.test(status)
            ? 'canceled'
            : presence === 'attended' || presence === 'no_show' || /complet/.test(status)
              ? 'completed'
              : null,
        });
        const summary = htmlToText(a.summary);
        if (summary) {
          await ctx.load.note({
            externalId: `interview:${iv.id}`,
            applicationExternalId: applicationId,
            body: `Interview summary (${title})\n${summary}`,
            createdAt: toDate(a.updated_at) ?? startAt,
          });
        }
      }

      async function loadScorecard(ctx: PhaseContext, sc: Resource<UserScorecardAttrs>, applicationId: string, inc: Included) {
        const a = attrs(sc);
        if (!a.completed_at) return; // still being filled in
        const author = attrs(related<UserAttrs>(inc, sc, 'user')[0]);
        const ratings = related<ScorecardRatingAttrs>(inc, sc, 'scorecard_ratings');
        const given = related<ScorecardAnswerAttrs>(inc, sc, 'scorecard_answers');
        const note = related<ScorecardNoteAttrs>(inc, sc, 'scorecard_note')[0];
        const answers: { label: string; value: string }[] = [];
        const scores: number[] = [];
        ratings.forEach((r, i) => {
          const score = num(attrs(r).score);
          if (score == null) return;
          scores.push(score);
          // scorecard_options attributes are undocumented.
          const optionId = relIds(r, 'scorecard_option')[0];
          const option = attrs(related<ScorecardOptionAttrs>(inc, r, 'scorecard_option')[0]);
          answers.push({
            label: option.name || option.title || option.label || (optionId ? `Metric ${optionId}` : `Rating ${i + 1}`),
            value: `${score}/5`,
          });
        });
        for (const ans of given) {
          const x = attrs(ans);
          const question = linked<QuestionAttrs>(inc, 'questions', x.question_id) ?? related<QuestionAttrs>(inc, ans, 'question')[0];
          answers.push({
            label: attrs(question).title?.trim() || 'Answer',
            value: x.text_answer?.trim() || (x.boolean_answer == null ? '' : x.boolean_answer ? 'Yes' : 'No'),
          });
        }
        // Without the user include, the ratings, answers and note still name their author.
        const authorId =
          relIds(sc, 'user')[0] ??
          [...ratings.map(attrs), ...given.map(attrs), attrs(note)].map((x) => str(x.user_id)).find(Boolean) ??
          null;
        await ctx.load.feedback({
          externalId: String(sc.id),
          applicationExternalId: applicationId,
          interviewExternalId: null, // Pinpoint doesn't link scorecards to interviews
          authorExternalUserId: authorId,
          authorName: fullName(author.first_name, author.last_name, author.email ?? '') || null,
          rating: pinpointRating(scores, a.sentiment),
          title: a.name?.trim() || null,
          summary: htmlToText(attrs(note).body) || htmlToText(a.summary),
          answers,
          createdAt: toDate(a.completed_at),
        });
      }

      async function loadOffer(ctx: PhaseContext, offer: Resource<OfferAttrs>, applicationId: string) {
        const o = attrs(offer);
        const amount = num(o.salary_amount);
        const period = o.salary_period?.trim().toLowerCase() || null;
        const annual = !period || period === 'year';
        // Offers expire at 23:59 in the sender's timezone: keep that calendar date, not the UTC one.
        const expires = /^\d{4}-\d{2}-\d{2}/.exec(o.expires_at?.trim() ?? '')?.[0] ?? toDate(o.expires_at)?.toISOString().slice(0, 10);
        const notes = [
          o.comment?.trim(),
          !annual && amount != null ? `Salary: ${amount} ${o.salary_currency ?? ''} per ${period}`.replace(/\s+/g, ' ') : null,
          o.paid_days_off?.trim() ? `Paid time off: ${o.paid_days_off.trim()}` : null,
          o.work_address?.trim() ? `Work address: ${o.work_address.trim()}` : null,
          expires ? `Expires: ${expires}` : null,
        ].filter(Boolean);
        await ctx.load.offer({
          externalId: String(offer.id),
          applicationExternalId: str(o.application_id) ?? applicationId,
          status: pinpointOfferStatus(o),
          jobTitle: o.job_title?.trim() || null,
          salaryAmount: annual ? amount : null,
          salaryCurrency: o.salary_currency ?? null,
          startDate: toDate(o.start_on),
          sentAt: toDate(o.sent_at),
          respondedAt: toDate(o.result_at),
          createdAt: toDate(o.created_at),
          notes: notes.join('\n') || null,
        });
      }

      /**
       * Scorecards and offers are only reachable as sideloads of applications,
       * so one pass fetches both. If the combined request is refused, each part
       * is tried alone (scorecards also with leaner includes), and what the key
       * can read is kept in the token.
       */
      async function scorecardsAndOffersPage(ctx: PhaseContext, page: JsonValue | null): Promise<PassBPage> {
        const t = toPassBToken(page, ctx.options);
        let { parts, full, level } = t;
        const request = (want: Part[], at: number) =>
          get<ApplicationAttrs>('/applications', {
            ...applicationFilters(ctx),
            ...(full ? {} : { 'fields[applications]': 'id,candidate_id' }),
            include: want.map((p) => (p === 'scorecards' ? SCORECARD_INCLUDES[at] : 'offers')).join(','),
            'fields[users]': 'first_name,last_name,email',
            ...(want.includes('offers') && ctx.options.files ? { 'extra_fields[offers]': 'attachments' } : {}),
            'page[number]': t.n,
            'page[size]': size.scorecards,
            sort: 'id',
          });

        /** One part alone, from include level `from` down to its leanest; null (with a warning) if all are refused. */
        const alone = async (part: Part, from: number, denied: Error): Promise<Doc<ApplicationAttrs> | null> => {
          const leanest = part === 'scorecards' ? SCORECARD_INCLUDES.length - 1 : 0;
          for (let at = from; at <= leanest; at++) {
            try {
              const doc = await request([part], at);
              if (part === 'scorecards' && at !== level) {
                ctx.warn(`Scorecards: ${denied.message}. Imported without the related records it can't read.`);
                level = at;
              }
              return doc;
            } catch (err) {
              if (!isForbidden(err)) throw err;
            }
          }
          ctx.warn(`${PART_LABEL[part]}: ${denied.message}`);
          return null;
        };

        const fetchDocs = async (): Promise<{ want: Part[]; doc: Doc<ApplicationAttrs> }[]> => {
          if (!parts.length) return [];
          try {
            return [{ want: parts, doc: await request(parts, level) }];
          } catch (err) {
            if (!isForbidden(err)) throw err;
            const got: { want: Part[]; doc: Doc<ApplicationAttrs> }[] = [];
            for (const part of parts) {
              // A lone part was just refused at this level: start one leaner.
              const from = (part === 'scorecards' ? level : 0) + (parts.length === 1 ? 1 : 0);
              const doc = await alone(part, from, err as Error);
              if (doc) got.push({ want: [part], doc });
            }
            parts = got.flatMap((g) => g.want);
            return got;
          }
        };

        let docs = await fetchDocs();
        const scorecardDoc = () => docs.find((d) => d.want.includes('scorecards'))?.doc;
        // Graphiti keeps relationships under sparse fieldsets; if this tenant doesn't, ask again without them.
        const probe = scorecardDoc();
        if (!full && probe?.data.length && probe.data.every((r) => !r.relationships?.user_scorecards)) {
          full = true;
          docs = await fetchDocs();
        }

        const primary = docs[0]?.doc;
        if (!primary) return { items: [], next: null, inc: new Map(), scorecards: new Map(), offers: new Map() };

        const inc: Included = new Map();
        for (const { doc } of docs) for (const [k, v] of indexIncluded(doc)) inc.set(k, v);
        const scorecards = new Map<string, string[]>();
        for (const app of scorecardDoc()?.data ?? []) scorecards.set(String(app.id), relIds(app, 'user_scorecards'));
        const offers = new Map<string, Set<string>>();
        const addOffer = (appId: string, offerId: string) => offers.set(appId, (offers.get(appId) ?? new Set()).add(offerId));
        for (const app of docs.find((d) => d.want.includes('offers'))?.doc.data ?? []) {
          for (const id of relIds(app, 'offers')) addOffer(String(app.id), id);
        }
        for (const r of inc.values()) {
          const appId = r.type === 'offers' ? str(attrs(r as Resource<OfferAttrs>).application_id) : null;
          if (appId) addOffer(appId, String(r.id));
        }

        const { items, top, more } = trim(ctx, 'Scorecards and offers', primary.data, t.n, t.last, size.scorecards);
        const next: PassBToken | null = more && parts.length ? { n: t.n + 1, parts, full, last: top, level } : null;
        return { items, next, inc, scorecards, offers };
      }

      async function loadFile(
        ctx: PhaseContext,
        candidateId: string,
        att: Attachment & { url: string },
        kind: 'resume' | 'other',
        externalId: string,
        applicationId: string | null,
      ) {
        await ctx.load.file({
          externalId,
          candidateExternalId: candidateId,
          applicationExternalId: applicationId,
          filename: att.name?.trim() || 'attachment',
          kind,
          download: async () => {
            const url = new URL(att.url, baseUrl());
            // Pinpoint refuses plain HTTP, and the key must never travel over it.
            if (url.protocol === 'http:' && isPinpointHost(url.hostname)) url.protocol = 'https:';
            try {
              const got = await http.bytes(url.toString());
              return { data: got.data, contentType: got.contentType, filename: got.filename ?? att.name ?? null };
            } catch (err) {
              // One unreadable attachment must not end the import (ImportAuthError is fatal to the job).
              if (err instanceof ImportAuthError) throw new ImportHttpError(err.status, err.where, 'Pinpoint refused this attachment');
              throw err;
            }
          },
        });
      }

      /** Each attachment once per candidate: the same CV often sits on the candidate, its applications and offers. */
      async function loadAttachments(
        ctx: PhaseContext,
        candidateId: string,
        list: Attachment[],
        applicationId: string | null,
        only?: 'other',
      ) {
        const seen = new Set<string>();
        for (const { att, kind } of pickAttachments(list)) {
          // Blob URLs may be re-signed, so identify files by what they are, not where they are.
          const base = `${candidateId}:${att.context ?? 'file'}:${att.name ?? ''}`;
          let key = base;
          for (let i = 2; seen.has(key); i++) key = `${base}:${i}`;
          seen.add(key);
          await each(ctx, { id: key }, () => loadFile(ctx, candidateId, att, only ?? kind, key, applicationId));
        }
      }

      const candidateFiles = (ctx: PhaseContext, cursor: Cursor | null) =>
        pagedStep(
          ctx,
          cursor,
          (page) =>
            pageOf<CandidateAttrs>(
              ctx,
              'Attachments',
              '/candidates',
              [{ 'fields[candidates]': 'id', 'extra_fields[candidates]': 'attachments' }],
              size.files,
              page,
            ),
          (c) => loadAttachments(ctx, String(c.id), attrs(c).attachments ?? [], null),
        );

      const applicationFiles = (ctx: PhaseContext, cursor: Cursor | null) =>
        pagedStep(
          ctx,
          cursor,
          (page) =>
            pageOf<ApplicationAttrs>(
              ctx,
              'Attachments',
              '/applications',
              [{ ...applicationFilters(ctx), 'fields[applications]': 'candidate_id,is_demo', 'extra_fields[applications]': 'attachments' }],
              size.files,
              page,
            ),
          async (app) => {
            const a = attrs(app);
            const candidateId = str(a.candidate_id);
            if (a.is_demo || !candidateId) return;
            await loadAttachments(ctx, candidateId, a.attachments ?? [], String(app.id));
          },
        );

      const load: Phase[] = [
        {
          id: 'requisitions',
          label: 'Requisitions',
          run(ctx, cursor) {
            let inc: Included = new Map();
            let currencies = new Map<string, string>();
            return pagedStep(
              ctx,
              cursor,
              async (page) => {
                const f = await optionalPage(ctx, 'Requisitions', () =>
                  pageOf<RequisitionAttrs>(ctx, 'Requisitions', '/requisitions', [{ include: 'requisition_details' }, {}], size.requisitions, page),
                );
                inc = f.inc;
                // Budgets that state no currency take their job's pay currency.
                const jobs = new Set<string>();
                for (const r of f.items) {
                  const b = budget(detailsOf(r, inc));
                  const jobId = str(attrs(r).job_id);
                  if (jobId && !b.currency && (b.min != null || b.max != null)) jobs.add(jobId);
                }
                currencies = await lookup<JobAttrs>(
                  '/jobs',
                  { 'filter[visibility]': VISIBILITY, 'filter[status]': JOB_STATUSES, 'fields[jobs]': 'compensation_currency' },
                  jobs,
                  (j) => j.compensation_currency?.trim() || null,
                );
                return f;
              },
              (r) => loadRequisition(ctx, r, inc, currencies),
            );
          },
        },
        {
          id: 'jobs',
          label: 'Jobs',
          run(ctx, cursor) {
            let inc: Included = new Map();
            const filters = { 'filter[visibility]': VISIBILITY, 'filter[status]': JOB_STATUSES };
            return pagedStep(
              ctx,
              cursor,
              async (page) => {
                const f = await pageOf<JobAttrs>(
                  ctx,
                  'Jobs',
                  '/jobs',
                  [
                    {
                      ...filters,
                      include: 'department,location,job_postings',
                      'fields[departments]': 'name',
                      'fields[locations]': 'name,city',
                      'fields[job_postings]': 'description,default_for_job',
                    },
                    filters,
                  ],
                  size.jobs,
                  page,
                );
                inc = f.inc;
                return f;
              },
              (job) => loadJob(ctx, job, inc),
            );
          },
        },
        {
          id: 'candidates',
          label: 'Candidates',
          run(ctx, cursor) {
            let apps = new Map<string, ApplicationAttrs[]>();
            const base = { ...sinceFilter(ctx), 'extra_fields[candidates]': 'tags' };
            return pagedStep(
              ctx,
              cursor,
              async (page) => {
                const f = await pageOf<CandidateAttrs>(
                  ctx,
                  'Candidates',
                  '/candidates',
                  [
                    // LinkedIn URLs live on applications only.
                    {
                      ...base,
                      include: 'applications',
                      'fields[applications]': 'candidate_id,linkedin_url,hired_at,rejected_at,is_demo,concealed',
                    },
                    base,
                  ],
                  size.candidates,
                  page,
                );
                apps = new Map();
                for (const r of f.inc.values()) {
                  if (r.type !== 'applications') continue;
                  const a = attrs(r as Resource<ApplicationAttrs>);
                  const id = str(a.candidate_id);
                  if (id) apps.set(id, [...(apps.get(id) ?? []), a]);
                }
                return f;
              },
              (c) => loadCandidate(ctx, c, apps.get(String(c.id))),
            );
          },
        },
        {
          id: 'applications',
          label: 'Applications',
          run(ctx, cursor) {
            let inc: Included = new Map();
            const base = {
              ...applicationFilters(ctx),
              'extra_fields[applications]': 'tags,average_rating,days_in_current_stage',
            };
            const stages = { 'fields[stages]': 'name,position,basic_type' };
            const job = { ...stages, 'fields[jobs]': 'visibility', 'extra_fields[jobs]': 'hiring_user_id,recruitment_manager_user_id' };
            // The candidate record stands in for masked (blind-screened) snapshots.
            const person = { 'fields[candidates]': CANDIDATE_FIELDS, 'extra_fields[candidates]': 'tags' };
            return pagedStep(
              ctx,
              cursor,
              async (page) => {
                const f = await pageOf<ApplicationAttrs>(
                  ctx,
                  'Applications',
                  '/applications',
                  [
                    { ...base, ...job, ...person, include: 'stage,furthest_stage,job,job.stages,custom_attributes,candidate' },
                    { ...base, ...job, ...person, include: 'stage,furthest_stage,job,job.stages,candidate' },
                    // Stages refused: keep the job's visibility and owner.
                    { ...base, ...job, ...person, include: 'job,candidate' },
                    { ...base, ...stages, include: 'stage,furthest_stage' },
                    base,
                  ],
                  size.applications,
                  page,
                  // The applied stage comes from the job's stages relationship, under fields[jobs].
                  {
                    ok: (doc) => (doc.included ?? []).every((r) => r.type !== 'jobs' || !!r.relationships?.stages),
                    relax: (q) => without(q, 'fields[jobs]'),
                  },
                );
                inc = f.inc;
                return f;
              },
              (app) => loadApplication(ctx, app, inc),
            );
          },
        },
        {
          id: 'interviews',
          label: 'Interviews',
          enabled: (o) => o.activity,
          run(ctx, cursor) {
            let inc: Included = new Map();
            // No filter[interviewable_type]: its values are undocumented, and a wrong one silently empties the list.
            const base = { ...sinceFilter(ctx), 'filter[job_visibility]': VISIBILITY };
            return pagedStep(
              ctx,
              cursor,
              async (page) => {
                const f = await optionalPage(ctx, 'Interviews', () =>
                  pageOf<InterviewAttrs>(
                    ctx,
                    'Interviews',
                    '/interviews',
                    [
                      {
                        ...base,
                        include: 'stage,interview_parts,interview_parts.interviewing_users',
                        'fields[stages]': 'name',
                        'fields[users]': 'email',
                      },
                      base,
                    ],
                    size.interviews,
                    page,
                  ),
                );
                inc = f.inc;
                return f;
              },
              (iv) => loadInterview(ctx, iv, inc),
            );
          },
        },
        {
          id: 'scorecards',
          label: 'Scorecards and offers',
          enabled: (o) => o.activity || o.offers,
          run(ctx, cursor) {
            let b: PassBPage | null = null;
            return pagedStep(
              ctx,
              cursor,
              async (page) => (b = await scorecardsAndOffersPage(ctx, page)),
              async (app) => {
                if (!b) return;
                const { inc } = b;
                const appId = String(app.id);
                for (const id of b.scorecards.get(appId) ?? []) {
                  const sc = linked<UserScorecardAttrs>(inc, 'user_scorecards', id);
                  if (sc) await each(ctx, sc, (s) => loadScorecard(ctx, s, appId, inc));
                }
                const candidateId = str(attrs(app).candidate_id);
                for (const id of b.offers.get(appId) ?? []) {
                  const offer = linked<OfferAttrs>(inc, 'offers', id);
                  if (!offer) continue;
                  await each(ctx, offer, (o) => loadOffer(ctx, o, appId));
                  // Offer letters are only listed on the offer.
                  const o = attrs(offer);
                  if (ctx.options.files && candidateId && o.attachments?.length) {
                    await loadAttachments(ctx, candidateId, o.attachments, str(o.application_id) ?? appId, 'other');
                  }
                }
              },
            );
          },
        },
        {
          id: 'notes',
          label: 'Notes',
          enabled: (o) => o.activity,
          run(ctx, cursor) {
            let inc: Included = new Map();
            let seekers = new Map<string, string>();
            const base = { ...sinceFilter(ctx), 'filter[commentable_type]': 'Application,Candidate,JobSeeker' };
            return pagedStep(
              ctx,
              cursor,
              async (page) => {
                const f = await optionalPage(ctx, 'Notes', () =>
                  pageOf<CommentAttrs>(
                    ctx,
                    'Notes',
                    '/comments',
                    [{ ...base, include: 'user', 'fields[users]': 'first_name,last_name,email' }, base],
                    size.comments,
                    page,
                  ),
                );
                inc = f.inc;
                // Talent-pipeline comments hang off a job seeker; its candidate_id finds the person.
                // `seekers: false` in the token remembers that the key can't read job seekers.
                let refused = isObject(page) && page.seekers === false;
                const wanted = new Set(
                  f.items
                    .map((c) => attrs(c))
                    .filter((a) => typeIs(a.commentable_type, 'jobseeker'))
                    .map((a) => str(a.commentable_id))
                    .filter((id): id is string => !!id),
                );
                seekers = new Map();
                if (wanted.size && !refused) {
                  const got = await optional(
                    ctx,
                    'Talent pipeline notes',
                    () => lookup<JobSeekerAttrs>('/job_seekers', { 'fields[job_seekers]': 'candidate_id' }, wanted, (s) => str(s.candidate_id)),
                    null,
                  );
                  refused = !got;
                  seekers = got ?? new Map();
                }
                return { items: f.items, next: f.next && refused ? { ...f.next, seekers: false } : f.next };
              },
              async (comment) => {
                const a = attrs(comment);
                const parent = str(a.commentable_id);
                const body = a.body_text?.trim();
                if (!parent || !body) return;
                const onApplication = typeIs(a.commentable_type, 'application');
                const candidateId = typeIs(a.commentable_type, 'candidate')
                  ? parent
                  : typeIs(a.commentable_type, 'jobseeker')
                    ? (seekers.get(parent) ?? null)
                    : null;
                if (!onApplication && !candidateId) return;
                // API-created comments belong to the company's system user, which /users may not list.
                const user = attrs(related<UserAttrs>(inc, comment, 'user')[0] ?? linked<UserAttrs>(inc, 'users', a.user_id));
                await ctx.load.note({
                  externalId: String(comment.id),
                  applicationExternalId: onApplication ? parent : null,
                  candidateExternalId: onApplication ? null : candidateId,
                  authorExternalUserId: str(a.user_id),
                  authorName: fullName(user.first_name, user.last_name, user.email ?? '') || null,
                  body: a.private_comment ? `[Private] ${body}` : body,
                  createdAt: toDate(a.created_at),
                });
              },
            );
          },
        },
        {
          id: 'files',
          label: 'Resumes and attachments',
          enabled: (o) => o.files,
          async run(ctx, cursor) {
            // Candidates first, so a person's own CV is the one kept as their resume.
            // Then applications, for cover letters and CVs sent with one application.
            const at = isObject(cursor) ? cursor : {};
            const onApplications = at.part === 'applications';
            const next = await (onApplications ? applicationFiles : candidateFiles)(ctx, at.at ?? null);
            if (next !== null) return { part: onApplications ? 'applications' : 'candidates', at: next };
            return onApplications ? null : { part: 'applications', at: null };
          },
        },
      ];

      return {
        async verify() {
          // No /me or /company endpoint: the company comes sideloaded on a job.
          const doc = await get<JobAttrs>('/jobs', {
            'filter[visibility]': VISIBILITY,
            'filter[status]': JOB_STATUSES,
            include: 'company',
            'fields[jobs]': 'title',
            'fields[companies]': 'name',
            'page[size]': 1,
          });
          const company = (doc.included ?? []).find((r) => r.type === 'companies') as Resource<CompanyAttrs> | undefined;
          return { accountName: attrs(company).name?.trim() || `${sub}${HOST_SUFFIX}` };
        },
        discover,
        load,
      };
    },
  };
}

export const pinpointProvider: ProviderModule = createPinpointProvider();
