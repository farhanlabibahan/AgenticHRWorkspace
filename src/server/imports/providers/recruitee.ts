import type { Commitment, OfferStatus, Origin, StageType, WorkplaceType } from '@prisma/client';
import { ImportAuthError, ImportHttpError, type AuthConfig, type HttpClient, type QueryValue } from '@/server/imports/http';
import { each, optional, pagedStep, type Page, type PageCursor } from '@/server/imports/paging';
import { cleanEmails, cleanList, clip, fullName, htmlToText, toDate } from '@/server/imports/text';
import type {
  Credentials,
  ImportedApplication,
  ImportedCandidate,
  ImportedFile,
  ImportedPosting,
  ImportedRequisition,
  JsonValue,
  Phase,
  PhaseContext,
  ProviderAdapter,
  ProviderModule,
  StageHistoryEntry,
  StageRef,
} from '@/server/imports/types';

/**
 * Tellent Recruitee (https://api.recruitee.com/c/{company}/…, Bearer personal API token).
 *
 * Vendor quirks this adapter handles:
 * - Tokens can't be scoped: they carry every permission of the user who made
 *   them, write and delete included. We only ever send GETs. The token also
 *   only sees what its user sees, so discovery reads /admin and warns when the
 *   user isn't an admin and lacks the abilities a full import needs.
 * - The company path segment takes the numeric id or the careers subdomain;
 *   verify() accepts either, names the company from /admin, and refuses one
 *   the token's user isn't in (the calls would all go to the wrong place).
 * - "Offer" means job, "placement" means application, "offer letter" is the
 *   offer. Every job has its own copy of its pipeline (stage ids never repeat
 *   across jobs); discovery reads each job's copy so every stage id a placement
 *   can point at is in the catalog, and the review groups them by name.
 * - /offers was rebuilt on 2025-12-01: paginated with `meta`, a basic field
 *   set, extras via include[], pipeline and department name gone. We read each
 *   job's detail and its pipeline from /pipeline_templates/{id}; the old list
 *   (embedded pipeline, no `meta`, `page` ignored) is read as a single page.
 *   Requisition openings are only reliable on /requisitions/{id}.
 * - Candidates are enumerated through /search/new/candidates, the only
 *   endpoint whose placements say disqualified (with when and why) and hired.
 *   It's Elasticsearch-backed and can't page past 10,000 hits, so we sort by
 *   created_at and re-anchor the window on the last creation time before the
 *   cap (a boundary second is re-read, which the loader dedupes). An exact
 *   `total` decides the last page, since a page can come back short.
 * - People and their applications load in one pass. Per search page: one
 *   /candidates?ids= call (search hits lack the applied date) and the activity
 *   feed; per candidate with something new, one /candidates/{id} — the only
 *   source of links, address, CV, cover letter, custom fields, form answers
 *   and who made a hire. Applications create their contact, so someone from
 *   before `since` who applied again after it still arrives with a full
 *   profile; with archived=false, people with nothing active aren't read. A
 *   profile that 404s was deleted or merged after the search listed it, so
 *   that person is skipped. A contact whose CV isn't imported (files off, a
 *   failed download) has its profile re-read on the next run for the link.
 * - Child records (notes, evaluations, events, offer letters, attachments)
 *   point at candidate + job, never at the placement, and Recruitee allows one
 *   placement per candidate per job — so an application's external id is
 *   `${candidateId}:${offerId}` and every child resolves to it without lookups.
 *   A child of a job whose application wasn't imported is dropped rather than
 *   landing on another job's application.
 * - Disqualification isn't a stage: the placement keeps its stage and gets a
 *   reason *name* (matched to /disqualify_reasons by name). Hired is
 *   `hired_at`, never a reason. Talent pools have no job; membership becomes a
 *   "Talent pool: …" tag.
 * - There is no stage-history endpoint. Moves come from the activity feed
 *   (/tracking/activities filtered to the page's candidates, at its documented
 *   default of 20 a page), whose filters and response are undocumented. The
 *   parser is tolerant, and a feed that errors, ignores its candidate filter
 *   or answers in an unknown shape costs the history (one warning; the cursor
 *   stops asking) — never the import. Origin is the
 *   category of the stage the placement entered through (Referred, Sourced,
 *   Applied), which the feed's first move names.
 * - Whether file links expire is undocumented, so the CV and cover letter are
 *   downloaded right after the profile is read, and the profile re-read once
 *   if S3 refuses a link. S3 never gets the token.
 * - Notes, evaluations, offer letters and attachments are per candidate.
 *   Offer letters are plan-gated (Advance/Optimize), so one 403 stops that
 *   phase; for the others a 403 can concern one candidate (a hired one, when
 *   the role can't see hires), so only a run of them stops the phase. Notes
 *   and attachments Recruitee restricts to named users or roles are skipped:
 *   Orqestra shows notes to everyone who can see the application.
 * - Evaluations carry a label (`strong_no`…`strong_yes`) or, on numeric scales,
 *   only a score answer; scores are converted through the company's scale (the
 *   settings endpoint, else the scale the search results describe). Results
 *   don't name their interview: the candidate's events for the same job and
 *   stage do, read only when a new scorecard needs one (one 403 stops that).
 *   Questionnaires are the candidate's answers, so they import as notes.
 * - Offer letters are only draft or sent. The placement answers them: the
 *   latest sent letter on a hire was accepted, on a disqualified placement it
 *   was declined (the candidate withdrew) or withdrawn, and an earlier sent
 *   version was replaced (withdrawn).
 * - Endpoints with defaults that hide data get explicit params:
 *   interview events `status=all`, requisitions both scopes.
 */

const API_HOST = 'api.recruitee.com';
const PAGE_SIZE = 100;
/** Elasticsearch's result window on /search/new/candidates. */
const SEARCH_WINDOW = 10_000;
const OFFER_INDEX_PAGE = 1000;
/** The activity feed's documented default page size; its maximum isn't documented. */
const FEED_LIMIT = 20;
const MAX_FEED_PAGES = 100;
const HISTORY_EVENTS = ['candidate_offer_assign', 'candidate_stage_change', 'candidate_requalify', 'candidate_hired'];
/** Categories of the locked stages a placement enters through. */
const INTAKE = new Set(['referred', 'sourced', 'apply']);
/** 403s in a row on a per-candidate endpoint before its phase stops asking. */
const MAX_DENIED = 5;
/** What a non-admin role needs so the import sees everything (spec §1). */
const FULL_ACCESS_ABILITIES = [
  'view_all_jobs',
  'view_all_requisitions',
  'review_hidden_evaluations',
  'reveal_anonymous_candidates',
  'manage_offer_letters',
  'view_hired_candidates',
  'export_data',
];

// ---------- Vendor payloads (only the fields we read) ----------

type Id = number;
type Meta = { limit?: number | null; page?: number | null; total_count?: number | null } | null;
type Tag = string | { id?: Id; name?: string | null } | null;
/** Who can see a record: `public`, or `protected` to named admins/roles. */
type Visibility = { level?: string | null } | null;

type Reference = {
  id: Id;
  type: string;
  email?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  name?: string | null;
  title?: string | null;
  category?: string | null;
};

type AdminResponse = {
  admin?: {
    id: Id;
    role_admin?: boolean | null;
    role_name?: string | null;
    role_abilities?: string[] | null;
    membership?: { role_admin?: boolean | null } | null;
    all_companies_count?: number | null;
    companies?: { id: Id; name?: string | null; subdomain?: string | null; host?: string | null }[] | null;
  } | null;
};

type Memberships = { meta?: Meta; references?: Reference[]; memberships?: { id: Id; admin_id: Id }[] };

type Stage = { id: Id; name?: string | null; position?: number | null; category?: string | null };
type Pipeline = { id?: Id; stages?: Stage[] | null } | null;
type Salary = { min?: string | number | null; max?: string | number | null; period?: string | null; currency?: string | null } | null;

type Offer = {
  id: Id;
  kind?: string | null;
  status?: string | null;
  title?: string | null;
  department?: string | null;
  department_id?: Id | null;
  recruiter_id?: Id | null;
  pipeline_template_id?: Id | null;
  pipeline_template?: Pipeline;
  description?: string | null;
  description_html?: string | null;
  requirements?: string | null;
  requirements_html?: string | null;
  location?: string | null;
  city?: string | null;
  state_name?: string | null;
  country_code?: string | null;
  remote?: boolean | null;
  hybrid?: boolean | null;
  on_site?: boolean | null;
  employment_type?: string | null;
  salary?: Salary;
  tags?: Tag[] | null;
  requisition_ids?: Id[] | null;
  created_at?: string | null;
  published_at?: string | null;
};
type OfferList = { meta?: Meta; offers?: Offer[] };

type Requisition = {
  id: Id;
  status?: string | null;
  title?: string | null;
  guid?: string | null;
  openings_count?: number | null;
  hires_count?: number | null;
  openings?: { status?: string | null }[] | null;
  archived_at?: string | null;
};

/** A placement as embedded in a search hit. Talent pools come as `offer.kind: talent_pool`. */
type HitPlacement = {
  id: Id;
  offer_id?: Id | null;
  offer?: { id: Id; kind?: string | null; title?: string | null } | null;
  talent_pool_id?: Id | null;
  talent_pool?: { id: Id; title?: string | null } | null;
  stage?: { id: Id; name?: string | null } | null;
  disqualified?: boolean | null;
  disqualified_at?: string | null;
  disqualify_kind?: string | null;
  disqualify_reason?: string | null;
  is_hired?: boolean | null;
  hired_at?: string | null;
  job_starts_at?: string | null;
};
type JobPlacement = HitPlacement & { jobId: Id };

type Hit = {
  id: Id;
  name?: string | null;
  emails?: string[] | null;
  phones?: string[] | null;
  social_links?: string[] | null;
  tags?: Tag[] | null;
  sources?: Tag[] | null;
  source?: string | null;
  created_at?: string | null;
  example?: boolean | null;
  is_anonymous?: boolean | null;
  placements?: HitPlacement[] | null;
};
type RatingScale = { range?: number | null; presentation?: string | null };
type SearchResponse = { total?: number | null; hits?: Hit[] | null; score_buckets?: RatingScale | null };

/**
 * A placement as embedded in /candidates (ids, stage and dates only) and in
 * /candidates/{id} (which adds the hire details).
 */
type Placement = {
  id: Id;
  offer_id?: Id | null;
  stage_id?: Id | null;
  created_at?: string | null;
  updated_at?: string | null;
  hired_at?: string | null;
  hired_by_id?: Id | null;
  hired_in_this_placement?: boolean | null;
  disqualify_reason?: string | null;
  disqualify_kind?: string | null;
  job_starts_at?: string | null;
};
type ListedCandidate = { id: Id; source?: string | null; referrer?: unknown; placements?: Placement[] | null };
type CandidateList = { candidates?: ListedCandidate[] | null; references?: Reference[] | null };

type FieldValue = {
  text?: string | null;
  title?: string | null;
  company?: string | null;
  end_date?: string | null;
  endDate?: string | null;
  flag?: boolean | null;
  value?: string | number | null;
  number?: string | number | null;
  date?: string | null;
};
type ProfileField = { kind?: string | null; name?: string | null; fixed?: boolean | null; values?: FieldValue[] | null; visibility?: Visibility };
/** Application-form answers. The item shape is undocumented (spec §5.17), so every plausible key is optional. */
type OpenAnswer = {
  offer_id?: Id | null;
  question?: string | { title?: string | null; body?: string | null } | null;
  question_title?: string | null;
  title?: string | null;
  content?: string | null;
  contents?: string[] | null;
  answer?: string | null;
  text?: string | null;
};
type Candidate = {
  id: Id;
  name?: string | null;
  title?: string | null;
  emails?: string[] | null;
  phones?: string[] | null;
  links?: string[] | null;
  social_links?: string[] | null;
  tags?: Tag[] | null;
  source?: string | null;
  referrer?: unknown;
  referral_referrers_ids?: Id[] | null;
  sourcing_origin?: unknown;
  cv_url?: string | null;
  cv_original_url?: string | null;
  cover_letter?: string | null;
  cover_letter_file_url?: string | null;
  cover_letter_file_original_url?: string | null;
  fields?: ProfileField[] | null;
  open_question_answers?: OpenAnswer[] | null;
  placements?: Placement[] | null;
  created_at?: string | null;
};
type CandidateDetail = { candidate?: Candidate | null };

/** Undocumented (spec §5.10); read defensively after the candidate_moved webhook's vocabulary. */
type ActivityStage = { id?: Id | null; name?: string | null; category?: string | null };
type Activity = {
  id?: Id | string | null;
  event?: string | null;
  event_type?: string | null;
  created_at?: string | null;
  admin_id?: Id | null;
  admin?: { id?: Id | null } | null;
  candidate_id?: Id | null;
  candidate?: { id?: Id | null } | null;
  offer_id?: Id | null;
  offer?: { id?: Id | null } | null;
  placement_id?: Id | null;
  to_stage?: ActivityStage | null;
  stage?: ActivityStage | null;
  details?: { to_stage?: ActivityStage | null; offer?: { id?: Id | null } | null } | null;
};
type Activities = { activities?: Activity[] | null };
/** A stage move read from the feed. */
type Move = { job: Id | null; stageId: Id | null; name: string | null; category: string | null; at: Date; actor: string | null };

type Note = {
  id: Id;
  text?: string | null;
  body?: string | null;
  body_html?: string | null;
  admin_id?: Id | null;
  guest_id?: Id | null;
  offer_id?: Id | null;
  visibility?: Visibility;
  created_at?: string | null;
  replies?: Note[] | null;
};
type Notes = { notes?: Note[] | null; references?: Reference[] | null };

type Answer = {
  question_title?: string | null;
  question_kind?: string | null;
  content?: string | null;
  contents?: string[] | null;
  note_html?: string | null;
  visible?: boolean | null;
};
type Result = {
  id: Id;
  kind?: string | null;
  admin_id?: Id | null;
  guest_id?: Id | null;
  rating?: string | null;
  offer_id?: Id | null;
  stage_id?: Id | null;
  interview_template_name?: string | null;
  rating_note?: string | null;
  rating_note_html?: string | null;
  pre_note_html?: string | null;
  post_note_html?: string | null;
  interview_result_answers?: Answer[] | null;
  created_at?: string | null;
};
type Results = { interview_results?: Result[] | null; references?: Reference[] | null; hidden_results_preview?: unknown[] | null };

type InterviewEvent = {
  id: Id;
  kind?: string | null;
  custom_name?: string | null;
  candidate_id?: Id | null;
  offer_id?: Id | null;
  stage_id?: Id | null;
  starts_at?: string | null;
  duration?: number | null;
  location?: string | null;
  video_url?: string | null;
  admin_ids?: Id[] | null;
  event_attendees?: { admin_id?: Id | null }[] | null;
};
type Events = { interview_events?: InterviewEvent[] | null; references?: Reference[] | null };

type OfferLetter = {
  id: Id;
  status?: string | null;
  title?: string | null;
  details?: { title?: string | null; description?: string | null }[] | null;
  offer_id?: Id | null;
  sent_at?: string | null;
  published_at?: string | null;
  created_at?: string | null;
  salary?: { enabled?: boolean | null; value?: string | number | null; currency?: string | null; period?: string | null; description?: string | null } | null;
  start_date?: { date?: string | null } | null;
  link_deactivated?: boolean | null;
};

type Attachment = { id: Id; filename?: string | null; file_url?: string | null; offer_id?: Id | null; visibility?: Visibility };
type Attachments = { attachments?: Attachment[] | null; hidden_attachments_exist?: boolean | null };

// ---------- Pure mapping helpers ----------

/** "49498", "acme", "acme.recruitee.com" or an app URL with `company=49498` → the path segment. */
function companyKey(raw: string | undefined): string {
  const s = (raw ?? '').trim();
  const fromUrl = /[?&]company=(\d+)/.exec(s);
  if (fromUrl) return fromUrl[1];
  return s.replace(/^https?:\/\//i, '').replace(/[/?#].*$/, '').replace(/\.recruitee\.com$/i, '');
}

const appKey = (candidateId: Id, offerId: Id) => `${candidateId}:${offerId}`;

function names(list: Tag[] | null | undefined): string[] {
  return cleanList((list ?? []).map((t) => (typeof t === 'string' ? t : (t?.name ?? null))));
}

function refIndex(refs: Reference[] | null | undefined): Map<string, Reference> {
  return new Map((refs ?? []).map((r) => [`${r.type}:${r.id}`, r]));
}

function personName(ref: Reference | undefined): string | null {
  if (!ref) return null;
  return fullName(ref.first_name, ref.last_name, ref.name?.trim() || ref.email?.trim() || '') || null;
}

const idString = (id: Id | null | undefined) => (id == null ? null : String(id));

const restricted = (v: Visibility | undefined) => !!v?.level && v.level !== 'public';

/** Payload file links are absolute S3 URLs in production; relative ones (test fixtures) are unusable. */
function absoluteUrl(url: string | null | undefined): string | null {
  return url && /^https?:\/\//i.test(url.trim()) ? url.trim() : null;
}

function extension(url: string): string | null {
  const m = /\.([a-z0-9]{2,5})$/i.exec(new URL(url).pathname);
  return m ? m[1].toLowerCase() : null;
}

function basename(url: string): string {
  const last = new URL(url).pathname.split('/').pop() ?? '';
  try {
    return decodeURIComponent(last) || 'file';
  } catch {
    return last || 'file';
  }
}

/** Date part of an ISO timestamp, as UTC midnight (offer-letter start dates are timestamps). */
function dateOnly(value: string | null | undefined): Date | null {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(value ?? '');
  return m ? toDate(`${m[1]}T00:00:00Z`) : null;
}

function amount(value: string | number | null | undefined): number | null {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/[\s,]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** Orqestra salaries are annual: yearly passes through, monthly is ×12, anything else stays in the text. */
function annual(value: number | null, period: string | null | undefined): number | null {
  if (value == null) return null;
  if (!period || period === 'year') return value;
  return period === 'month' ? value * 12 : null;
}

const STAGE_TYPE: Record<string, StageType> = {
  referred: 'APPLICANT',
  sourced: 'LEAD',
  apply: 'APPLICANT',
  phone_screen: 'SCREEN',
  interview: 'ONSITE',
  evaluation: 'ONSITE',
  offer: 'OFFER',
  hire: 'HIRED',
};

function reasonKind(name: string): 'rejection' | 'withdrawn' | 'other' {
  if (/withdr[ae]w|hired elsewhere|accepted (an)?other|declined|not interested|no[- ]show/i.test(name)) return 'withdrawn';
  return /^other$/i.test(name.trim()) ? 'other' : 'rejection';
}

const POSTING_STATE: Record<string, ImportedPosting['state']> = {
  published: 'open',
  internal: 'internal',
  draft: 'draft',
  closed: 'closed',
  archived: 'closed',
};

function commitmentOf(type: string | null | undefined): Commitment | null {
  const t = (type ?? '').toLowerCase();
  if (/intern|apprentice/.test(t)) return 'INTERNSHIP';
  if (/part/.test(t)) return 'PART_TIME';
  if (/contract|freelance|temporar|seasonal/.test(t)) return 'CONTRACT';
  if (/full/.test(t)) return 'FULL_TIME';
  return null;
}

function workplaceOf(o: Offer): WorkplaceType | null {
  if (o.hybrid) return 'HYBRID';
  if (o.remote) return 'REMOTE';
  if (o.on_site) return 'ONSITE';
  return null;
}

const SOURCE_LABEL: Record<string, string> = {
  career_site: 'Careers site',
  email: 'Email',
  manual: 'Added manually',
  import: 'Imported',
};

const RATING_LABEL: Record<string, string> = {
  strong_no: 'Strong no',
  no: 'No',
  neutral: 'Not sure',
  yes: 'Yes',
  strong_yes: 'Strong yes',
};

/** Recruitee's recommendation label → 1 strong no · 2 no · 3 yes · 4 strong yes. "Not sure" isn't a yes. */
export function ratingFromLabel(label: string | null | undefined): 1 | 2 | 3 | 4 | null {
  switch ((label ?? '').trim()) {
    case 'strong_no':
      return 1;
    case 'no':
    case 'neutral':
      return 2;
    case 'yes':
      return 3;
    case 'strong_yes':
      return 4;
    default:
      return null;
  }
}

/**
 * An overall *score* → 1–4. Thumbs scales store scores 1–5 that stand for
 * labels (thumbs_4 skips 2), so they decode through the label map; numeric
 * scales go through Recruitee's own percentage (score / range) bucketed at
 * the thumbs anchors 0 / 50 / 75 / 100 %.
 */
export function ratingFromScore(score: number, scale: RatingScale | null): 1 | 2 | 3 | 4 | null {
  if (!Number.isFinite(score) || !scale) return null;
  if (scale.presentation === 'thumbs_4') return ratingFromLabel({ 1: 'no', 3: 'neutral', 4: 'yes', 5: 'strong_yes' }[score]);
  if (scale.presentation === 'thumbs_5') {
    return ratingFromLabel({ 1: 'strong_no', 2: 'no', 3: 'neutral', 4: 'yes', 5: 'strong_yes' }[score]);
  }
  if (!scale.range || scale.range <= 0) return null;
  const pct = (score / scale.range) * 100;
  return pct < 25 ? 1 : pct < 62.5 ? 2 : pct < 87.5 ? 3 : 4;
}

const EVENT_KIND: Record<string, string> = { meeting: 'Meeting', call: 'Phone call', video: 'Video call', onsite: 'On-site interview' };
const RESULT_KIND: Record<string, string> = { rating: 'Quick evaluation', template_form: 'Evaluation', questionnaire: 'Questionnaire' };

function jobPlacements(hit: Hit): JobPlacement[] {
  return (hit.placements ?? []).flatMap((p) => {
    const jobId = p.offer?.id ?? p.offer_id;
    const pool = p.offer?.kind === 'talent_pool' || p.talent_pool != null || p.talent_pool_id != null;
    return jobId != null && !pool ? [{ ...p, jobId }] : [];
  });
}

/** Talent pools have no Source equivalent; membership becomes a tag (spec §5.19). */
function talentPoolTags(hit: Hit): string[] {
  const pools = (hit.placements ?? []).map((p) => (p.offer?.kind === 'talent_pool' ? p.offer?.title : p.talent_pool?.title));
  return cleanList(pools).map((title) => `Talent pool: ${title}`);
}

/** A placement's facts from the list (applied date) and the profile (hire details), whichever has them. */
function placementFacts(p: JobPlacement, listed: ListedCandidate | null, profile: Candidate | null): Placement | null {
  const find = (list: Placement[] | null | undefined) => list?.find((x) => x.id === p.id) ?? list?.find((x) => x.offer_id === p.jobId) ?? null;
  const a = find(listed?.placements);
  const b = find(profile?.placements);
  if (!a && !b) return null;
  return {
    id: p.id,
    offer_id: p.jobId,
    stage_id: a?.stage_id ?? b?.stage_id,
    created_at: a?.created_at ?? b?.created_at,
    updated_at: a?.updated_at ?? b?.updated_at,
    hired_at: a?.hired_at ?? b?.hired_at,
    hired_by_id: a?.hired_by_id ?? b?.hired_by_id,
    hired_in_this_placement: a?.hired_in_this_placement ?? b?.hired_in_this_placement,
    disqualify_reason: a?.disqualify_reason ?? b?.disqualify_reason,
    disqualify_kind: a?.disqualify_kind ?? b?.disqualify_kind,
    job_starts_at: a?.job_starts_at ?? b?.job_starts_at,
  };
}

function placementStatus(p: HitPlacement, facts: Placement | null, category: string | null): ImportedApplication['status'] {
  if (p.disqualified || p.disqualified_at || p.disqualify_reason || facts?.disqualify_reason) return 'archived';
  if (p.hired_at || p.is_hired || facts?.hired_at || facts?.hired_in_this_placement || category === 'hire') return 'hired';
  return 'active';
}

function hasValue(v: unknown): boolean {
  return v != null && v !== '' && !(Array.isArray(v) && v.length === 0);
}

/** The stage a placement entered through names its origin; otherwise what the candidate record says. */
function originOf(intake: string | null, hit: Hit, listed: ListedCandidate | null, profile: Candidate | null): Origin | null {
  if (intake === 'referred') return 'REFERRED';
  if (intake === 'sourced') return 'SOURCED';
  if (intake === 'apply') return 'APPLIED';
  if (hasValue(listed?.referrer) || hasValue(profile?.referrer) || hasValue(profile?.referral_referrers_ids)) return 'REFERRED';
  if (hasValue(profile?.sourcing_origin)) return 'SOURCED';
  const source = hit.source ?? listed?.source ?? profile?.source;
  if (source === 'career_site' || source === 'email') return 'APPLIED';
  if (source === 'manual') return 'SOURCED';
  return null;
}

function sourceOf(hit: Hit, listed: ListedCandidate | null): string | null {
  const tags = names(hit.sources);
  if (tags.length) return tags.join(', ');
  const source = hit.source ?? listed?.source;
  return source ? (SOURCE_LABEL[source] ?? source) : null;
}

function sameStage(a: StageRef, b: StageRef): boolean {
  if (a.externalId && b.externalId) return a.externalId === b.externalId;
  return !!a.name && !!b.name && a.name.trim().toLowerCase() === b.name.trim().toLowerCase();
}

function inlineCandidate(hit: Hit): ImportedCandidate {
  return {
    externalId: String(hit.id),
    name: hit.name?.trim() || 'Unknown candidate',
    emails: cleanEmails(hit.emails ?? []),
    phones: cleanList(hit.phones ?? []),
    links: cleanList(hit.social_links ?? []),
    tags: cleanList([...names(hit.tags), ...talentPoolTags(hit)]),
    createdAt: toDate(hit.created_at),
  };
}

function toCandidate(hit: Hit, c: Candidate | null): ImportedCandidate {
  if (!c) return inlineCandidate(hit);
  const field = (kind: string) => c.fields?.find((f) => f.kind === kind)?.values ?? [];
  const current = field('experience').find((v) => !(v.end_date ?? v.endDate));
  const title = c.title?.trim() || current?.title?.trim() || null;
  const employer = current?.company?.trim();
  return {
    externalId: String(c.id),
    name: c.name?.trim() || hit.name?.trim() || 'Unknown candidate',
    emails: cleanEmails(c.emails ?? hit.emails ?? []),
    phones: cleanList(c.phones ?? hit.phones ?? []),
    links: cleanList([...(c.links ?? []), ...(c.social_links ?? hit.social_links ?? [])]),
    headline: title && employer ? `${title} at ${employer}` : title,
    location: field('address')[0]?.text?.trim() || null,
    tags: cleanList([...names(c.tags), ...names(hit.tags), ...talentPoolTags(hit)]),
    createdAt: toDate(c.created_at ?? hit.created_at),
  };
}

function fieldValue(v: FieldValue): string | null {
  if (typeof v.flag === 'boolean') return v.flag ? 'Yes' : 'No';
  const raw = v.text ?? v.value ?? v.number ?? v.date;
  return raw == null ? null : String(raw);
}

/**
 * Profile data with no Source field of its own, kept on each new
 * application: the typed cover letter, custom profile fields anyone may see,
 * and the application-form answers (all of them, or this job's when an
 * answer names its job).
 */
function profileFields(c: Candidate | null, jobId: Id): Record<string, string> {
  const out: Record<string, string> = {};
  if (!c) return out;
  const cover = htmlToText(c.cover_letter);
  if (cover) out['Cover letter'] = clip(cover, 4000);
  for (const f of c.fields ?? []) {
    const name = f.name?.trim();
    if (f.fixed || !name || restricted(f.visibility)) continue;
    const value = cleanList((f.values ?? []).map(fieldValue)).join(', ');
    if (value) out[clip(name, 200)] = clip(value, 2000);
  }
  for (const a of c.open_question_answers ?? []) {
    if (a.offer_id != null && a.offer_id !== jobId) continue;
    const question = typeof a.question === 'string' ? a.question : (a.question?.title ?? a.question?.body);
    const label = htmlToText(a.question_title ?? question ?? a.title);
    const value = htmlToText(a.content ?? a.answer ?? a.text) || cleanList(a.contents ?? []).join(', ');
    if (label && value) out[clip(label, 200)] = clip(value, 2000);
  }
  return out;
}

/** Threaded notes → a flat list; replies inherit the job, and the restriction, of the note they answer. */
function flattenNotes(
  notes: Note[],
  job: Id | null = null,
  reply = false,
  hidden = false,
): { note: Note; job: Id | null; reply: boolean; hidden: boolean }[] {
  return notes.flatMap((n) => {
    const own = n.offer_id ?? job;
    const secret = hidden || restricted(n.visibility);
    return [{ note: n, job: own, reply, hidden: secret }, ...flattenNotes(n.replies ?? [], own, true, secret)];
  });
}

/** A form's overall recommendation when it's a question rather than `rating` (numeric scales). */
function overallAnswer(r: Result): Answer | undefined {
  return (r.interview_result_answers ?? []).find((a) => a.question_kind === 'overall_rating' && a.content?.trim());
}

function answerText(a: Answer): string {
  const value = a.content?.trim() || (a.contents ?? []).filter(Boolean).join(', ');
  return [value, htmlToText(a.note_html)].filter(Boolean).join(' — ');
}

/** The event an evaluation was written for: same job and stage, by the same reviewer if possible, latest one before it. */
function interviewFor(r: Result, events: InterviewEvent[]): string | null {
  if (r.offer_id == null || r.stage_id == null) return null;
  const same = events.filter((e) => e.offer_id === r.offer_id && e.stage_id === r.stage_id && toDate(e.starts_at));
  const mine = same.filter((e) => r.admin_id != null && (e.admin_ids ?? []).includes(r.admin_id));
  const pool = mine.length ? mine : same;
  if (!pool.length) return null;
  const at = toDate(r.created_at)?.getTime() ?? Number.POSITIVE_INFINITY;
  const time = (e: InterviewEvent) => toDate(e.starts_at)!.getTime();
  const before = pool.filter((e) => time(e) <= at).sort((a, b) => time(b) - time(a));
  const after = pool.filter((e) => time(e) > at).sort((a, b) => time(a) - time(b));
  return String((before[0] ?? after[0]).id);
}

/** A feed entry as a stage move, or null when it isn't one we can read. */
function toMove(a: Activity, offerOfPlacement: Map<Id, Id>): Move | null {
  const event = a.event ?? a.event_type;
  if (event && !HISTORY_EVENTS.includes(event) && event !== 'candidate_moved') return null;
  const to = a.details?.to_stage ?? a.to_stage ?? a.stage;
  const at = toDate(a.created_at);
  if (!to || (to.id == null && !to.name?.trim()) || !at) return null;
  const job = a.offer_id ?? a.offer?.id ?? a.details?.offer?.id ?? (a.placement_id != null ? offerOfPlacement.get(a.placement_id) : null);
  return {
    job: job ?? null,
    stageId: to.id ?? null,
    name: to.name?.trim() || null,
    category: to.category ?? null,
    at,
    actor: idString(a.admin_id ?? a.admin?.id),
  };
}

/**
 * Recruitee letters are only draft or sent, so the placement answers them:
 * the latest sent letter on a hire was accepted; on a disqualified placement
 * it was declined when the candidate withdrew, otherwise withdrawn; an
 * earlier sent version was replaced by a later one.
 */
function letterOutcome(
  l: OfferLetter,
  letters: OfferLetter[],
  p: JobPlacement | undefined,
): { status: OfferStatus; respondedAt: Date | null; replaced: boolean } {
  if (l.status === 'draft') return { status: 'DRAFT', respondedAt: null, replaced: false };
  const sent = (x: OfferLetter) => toDate(x.sent_at ?? x.published_at ?? x.created_at)?.getTime() ?? 0;
  const latest = letters
    .filter((x) => x.offer_id === l.offer_id && x.status !== 'draft')
    .reduce((a, b) => (sent(b) > sent(a) || (sent(b) === sent(a) && b.id > a.id) ? b : a), l);
  if (latest.id !== l.id) return { status: 'WITHDRAWN', respondedAt: null, replaced: true };
  const status = p ? placementStatus(p, null, null) : 'active';
  if (status === 'hired') return { status: 'ACCEPTED', respondedAt: toDate(p?.hired_at), replaced: false };
  if (status === 'archived') {
    const reason = p?.disqualify_reason?.trim();
    const declined = !!reason && reasonKind(reason) === 'withdrawn';
    return { status: declined ? 'DECLINED' : 'WITHDRAWN', respondedAt: toDate(p?.disqualified_at), replaced: false };
  }
  return { status: 'SENT', respondedAt: null, replaced: false };
}

// ---------- Adapter ----------

type SearchToken = { from: number | null; page: number };
/** The people phase's page token: a search token, flagged once the activity feed proved unusable. */
type PeopleToken = SearchToken & { history?: boolean };
type OfferInfo = { title: string | null; recruiterId: Id | null };
/** A per-candidate endpoint the token may not be allowed to read. */
type Gate = { denied: number; blocked: boolean; limit: number };
/** A search hit with what its page read for it. `fresh`: placements this step will newly import. */
type Person = { id: Id; hit: Hit; listed: ListedCandidate | null; stages: Map<Id, Reference>; moves: Move[]; fresh: Set<Id> };

function morePages(meta: Meta | undefined, page: number, limit: number, count: number): boolean {
  // No `meta` is the pre-Dec-2025 /offers, which ignored `page` and returned everything at once.
  if (!meta || count < limit) return false;
  return meta.total_count == null || page * limit < meta.total_count;
}

const gate = (limit: number): Gate => ({ denied: 0, blocked: false, limit });

function createAdapter(credentials: Credentials, http: HttpClient, pageSize: number, searchWindow: number): ProviderAdapter {
  const company = companyKey(credentials.companyId);
  const base = `https://${API_HOST}/c/${encodeURIComponent(company)}`;
  const get = <T>(path: string, query?: Record<string, QueryValue>) => http.json<T>(`${base}${path}`, query);

  // Per-slice caches: an adapter is built once per slice, so these are re-read at most once per slice.
  let offerIndexP: Promise<Map<Id, OfferInfo>> | null = null;
  let departmentsP: Promise<Map<Id, string>> | null = null;
  let scaleP: Promise<RatingScale | null> | null = null;
  let searchScale: RatingScale | null = null;
  const pipelinesRead = new Set<Id>();
  const warned = new Set<string>();
  const gates = {
    notes: gate(MAX_DENIED),
    results: gate(MAX_DENIED),
    letters: gate(1),
    attachments: gate(MAX_DENIED),
    /** The per-candidate events read that links evaluations to interviews. */
    events: gate(1),
  };

  function warnOnce(ctx: PhaseContext, key: string, message: string) {
    if (warned.has(key)) return;
    warned.add(key);
    ctx.warn(message);
  }

  function offerIndex(): Promise<Map<Id, OfferInfo>> {
    offerIndexP ??= (async () => {
      const index = new Map<Id, OfferInfo>();
      for (let page = 1; ; page++) {
        const res = await get<OfferList>('/offers', { limit: OFFER_INDEX_PAGE, page });
        const offers = res.offers ?? [];
        for (const o of offers) index.set(o.id, { title: o.title ?? null, recruiterId: o.recruiter_id ?? null });
        if (!morePages(res.meta, page, OFFER_INDEX_PAGE, offers.length)) return index;
      }
    })().catch((err: unknown) => {
      offerIndexP = null;
      throw err;
    });
    return offerIndexP;
  }

  function departments(ctx: PhaseContext): Promise<Map<Id, string>> {
    departmentsP ??= optional(
      ctx,
      'Departments',
      async () => {
        const res = await get<{ departments?: { id: Id; name?: string | null }[] | null }>('/departments');
        return new Map((res.departments ?? []).flatMap((d) => (d.name?.trim() ? [[d.id, d.name.trim()] as const] : [])));
      },
      new Map<Id, string>(),
    );
    return departmentsP;
  }

  /** The company's scale; non-admin tokens often can't read settings, and the search results describe the same scale. */
  function ratingScale(ctx: PhaseContext): Promise<RatingScale | null> {
    scaleP ??= (async () => {
      try {
        const res = await get<{ default_rating_scale?: RatingScale | null }>('/candidates/settings/rating_scale');
        return res.default_rating_scale ?? searchScale;
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status !== 403 && status !== 404) throw err;
        if (!searchScale) ctx.warn(`Evaluation rating scale: ${(err as Error).message}`);
        return searchScale;
      }
    })().catch((err: unknown) => {
      scaleP = null;
      throw err;
    });
    return scaleP;
  }

  /**
   * A per-candidate sub-resource. A 404 skips that candidate (merged or
   * deleted since it was listed). A 403 can be about one candidate, so the
   * phase stops only after `gate.limit` refusals in a row.
   */
  async function subresource<T>(ctx: PhaseContext, g: Gate, what: string, candidateId: Id, fn: () => Promise<T>): Promise<T | null> {
    const detail = { externalId: String(candidateId) };
    try {
      const res = await fn();
      g.denied = 0;
      return res;
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status !== 403 && status !== 404) throw err;
      // One message per endpoint, not per candidate: the id rides in the detail.
      const message = `${what}: ${(err as Error).message.replace(/\/candidates\/\d+/, '/candidates/{id}')}`;
      if (status === 404) {
        ctx.warn(message, detail);
      } else if (++g.denied < g.limit) {
        ctx.warn(message, detail);
      } else {
        g.blocked = true;
        ctx.warn(`${message} — skipped for the remaining candidates`, detail);
      }
      return null;
    }
  }

  /**
   * The full profile. A 403 (a role that can't open this candidate) leaves
   * the search hit's fields to stand in; a 404 means the candidate was
   * deleted or merged after the search listed it, and must not be recreated.
   */
  async function readProfile(ctx: PhaseContext, candidateId: Id): Promise<Candidate | null | 'gone'> {
    try {
      return (await get<CandidateDetail>(`/candidates/${candidateId}`)).candidate ?? null;
    } catch (err) {
      const status = (err as { status?: number }).status;
      const detail = { externalId: String(candidateId) };
      if (status === 404) {
        ctx.warn('Skipped candidates deleted or merged in Recruitee after the import listed them', detail);
        return 'gone';
      }
      if (status !== 403) throw err;
      ctx.warn(`Candidate profile: ${(err as Error).message.replace(/\/candidates\/\d+/, '/candidates/{id}')}`, detail);
      return null;
    }
  }

  // ---------- Paged sources ----------

  async function offersPage(page: JsonValue, withRequisitions: boolean): Promise<Page<Offer>> {
    const p = typeof page === 'number' ? page : 1;
    const res = await get<OfferList>('/offers', {
      limit: pageSize,
      page: p,
      'include[]': withRequisitions ? ['requisition_ids'] : undefined,
    });
    const offers = res.offers ?? [];
    return { items: offers, next: morePages(res.meta, p, pageSize, offers.length) ? p + 1 : null };
  }

  /**
   * One page of candidates, oldest first. Page numbers run until the search
   * window would overflow; then the window restarts at the last hit's
   * creation second (so that second is read twice — harmless, it's deduped).
   */
  async function searchPage(ctx: PhaseContext, token: JsonValue): Promise<Page<Hit>> {
    const t = (token as SearchToken | null) ?? { from: null, page: 1 };
    const filters: { field: string; gte: number }[] = [];
    // updated_at, not created_at: an older candidate who applied again after `since` must still come through.
    if (ctx.since) filters.push({ field: 'updated_at', gte: Math.floor(ctx.since.getTime() / 1000) });
    if (t.from != null) filters.push({ field: 'created_at', gte: t.from });
    const res = await get<SearchResponse>('/search/new/candidates', {
      limit: pageSize,
      page: t.page,
      sort_by: 'created_at_asc',
      filters_json: filters.length ? JSON.stringify(filters) : undefined,
    });
    const buckets = res.score_buckets;
    if (!searchScale && (buckets?.presentation || buckets?.range)) searchScale = { presentation: buckets.presentation ?? null, range: buckets.range ?? null };
    const hits = res.hits ?? [];
    // Elasticsearch may cap `total` at the window size, so only a smaller total is exact. An exact one
    // decides the last page (a page can come back short); without one, a short page is the last.
    const total = typeof res.total === 'number' && res.total < searchWindow ? res.total : null;
    if (!hits.length || (total != null ? t.page * pageSize >= total : hits.length < pageSize)) return { items: hits, next: null };
    if ((t.page + 1) * pageSize <= searchWindow) return { items: hits, next: { from: t.from, page: t.page + 1 } };
    const last = toDate(hits[hits.length - 1].created_at);
    const from = last ? Math.floor(last.getTime() / 1000) : null;
    if (from == null || (t.from != null && from <= t.from)) {
      ctx.warn(`More than ${searchWindow} candidates share one creation time; the rest of them could not be listed`);
      return { items: hits, next: null };
    }
    return { items: hits, next: { from, page: 1 } };
  }

  /** Placements of this candidate that were imported as applications (child records attach to these). */
  async function importedApps(ctx: PhaseContext, hit: Hit): Promise<Set<string>> {
    const keys = new Set<string>();
    if (hit.example) return keys;
    for (const p of jobPlacements(hit)) {
      const key = appKey(hit.id, p.jobId);
      if (await ctx.load.has('opportunity', key)) keys.add(key);
    }
    return keys;
  }

  /** A search page with a per-candidate pass, for phases that fan out per candidate. */
  function perCandidate(g: Gate | null, handle: (ctx: PhaseContext, hit: Hit, apps: Set<string>) => Promise<void>) {
    return async (ctx: PhaseContext, cursor: JsonValue | null) => {
      const next = await pagedStep(ctx, cursor, (p) => searchPage(ctx, p), async (hit) => {
        if (g?.blocked) return;
        const apps = await importedApps(ctx, hit);
        if (apps.size) await handle(ctx, hit, apps);
      });
      return g?.blocked ? null : next;
    };
  }

  // ---------- Stage history ----------

  /**
   * Stage moves for these candidates, by candidate, from the activity feed.
   * Its parameters and response are undocumented, so anything but bad
   * credentials, the rate limit or the slice's time budget means "no
   * history": one warning, and null tells the caller to stop asking.
   */
  async function feed(ctx: PhaseContext, people: Hit[]): Promise<Map<Id, Move[]> | null> {
    const wanted = new Set(people.map((h) => h.id));
    const placements = people.flatMap((h) => (h.placements ?? []).map((p) => ({ p, h })));
    const candidateOfPlacement = new Map(placements.map(({ p, h }) => [p.id, h.id] as const));
    const offerOfPlacement = new Map(placements.flatMap(({ p }) => (p.offer?.id ?? p.offer_id) != null ? [[p.id, (p.offer?.id ?? p.offer_id)!] as const] : []));
    const limit = Math.min(pageSize, FEED_LIMIT);
    const moves = new Map<Id, Move[]>();
    const seen = new Set<string>();
    /** Stage-move entries (by their event name, or with none) that didn't parse. */
    let unreadable = 0;
    const skip = (why: string) => {
      ctx.warn(`Stage history: ${why}, so applications keep only their current stage and dates`);
      return null;
    };
    try {
      for (let page = 1; ; page++) {
        const res = await get<Activities | Activity[] | null>('/tracking/activities', {
          'candidates[]': [...wanted],
          'events[]': HISTORY_EVENTS,
          limit,
          page,
        });
        const batch = Array.isArray(res) ? res : Array.isArray(res?.activities) ? res.activities : null;
        if (!batch) return skip('the activity feed answered in an unrecognized format');
        let fresh = 0;
        let attributed = 0;
        for (const a of batch) {
          const key = a.id != null ? String(a.id) : JSON.stringify(a);
          if (seen.has(key)) continue;
          seen.add(key);
          fresh++;
          const named = a.candidate_id ?? a.candidate?.id ?? null;
          // A feed that ignores the filter is the company's whole history, newest first: useless and costly.
          const foreign = named != null ? !wanted.has(named) : a.placement_id != null && !candidateOfPlacement.has(a.placement_id);
          if (foreign) return skip('the activity feed ignored its candidate filter');
          const who = named ?? (a.placement_id != null ? candidateOfPlacement.get(a.placement_id) : undefined);
          if (who == null) continue;
          attributed++;
          const move = toMove(a, offerOfPlacement);
          const event = a.event ?? a.event_type;
          if (move) moves.set(who, [...(moves.get(who) ?? []), move]);
          else if (!event || HISTORY_EVENTS.includes(event)) unreadable++;
        }
        // Entries that name no candidate or placement can't be told apart from anyone else's.
        if (fresh && !attributed) return skip("the activity feed's entries weren't in a recognized format");
        // A short page is the last; a page with nothing new means the feed ignores `page`.
        if (batch.length < limit || !fresh) break;
        if (page >= MAX_FEED_PAGES) {
          warnOnce(ctx, 'history-cap', 'Stage history was cut short for candidates with very long activity feeds');
          break;
        }
      }
    } catch (err) {
      // Bad credentials, the rate limit and the slice's time budget are the run's business; anything else costs only the history.
      const unusable = (err instanceof ImportHttpError && err.status !== 429) || (err instanceof ImportAuthError && err.status === 403);
      if (!unusable) throw err;
      return skip(err.message);
    }
    if (unreadable && !moves.size) return skip("the activity feed's entries weren't in a recognized format");
    return moves;
  }

  /** The placement's moves oldest first, and the category of the stage it entered through. */
  function historyFor(
    moves: Move[],
    p: JobPlacement,
    current: StageRef | null,
    stages: Map<Id, Reference>,
    facts: Placement | null,
    hiredAt: Date | null,
  ): { history?: StageHistoryEntry[]; intake: string | null } {
    const mine = moves.filter((m) => m.job === p.jobId).sort((a, b) => a.at.getTime() - b.at.getTime());
    const first = mine[0];
    const firstCategory = first ? (first.category ?? (first.stageId != null ? (stages.get(first.stageId)?.category ?? null) : null)) : null;
    const intake = firstCategory && INTAKE.has(firstCategory) ? firstCategory : null;
    const hiredBy = idString(facts?.hired_by_id);
    const entries: StageHistoryEntry[] = mine.map((m) => ({
      stage: { externalId: idString(m.stageId), name: m.name },
      at: m.at,
      actorExternalUserId: m.actor,
    }));
    if (!entries.length) {
      // Without the feed, the one move we know for sure is the hire.
      return { history: current && hiredAt ? [{ stage: current, at: hiredAt, actorExternalUserId: hiredBy }] : undefined, intake };
    }
    const last = entries[entries.length - 1];
    if (current && !sameStage(last.stage, current)) {
      // The feed missed the latest move; the placement's own timestamps bound it.
      const known = [hiredAt, toDate(facts?.updated_at)].filter((d): d is Date => !!d && d > last.at);
      entries.push({ stage: current, at: known[0] ?? last.at, actorExternalUserId: hiredAt ? hiredBy : null });
    }
    return { history: entries, intake };
  }

  // ---------- People: contacts and their applications ----------

  const stageIdOf = (p: HitPlacement, facts: Placement | null) => p.stage?.id ?? facts?.stage_id ?? null;
  const categoryOf = (stages: Map<Id, Reference>, id: Id | null) => (id != null ? (stages.get(id)?.category ?? null) : null);

  /** Placements this step will newly import as applications — what's worth a profile read and the feed. */
  async function freshPlacements(ctx: PhaseContext, hit: Hit, listed: ListedCandidate | null, stages: Map<Id, Reference>): Promise<Set<Id>> {
    const out = new Set<Id>();
    for (const p of jobPlacements(hit)) {
      const facts = placementFacts(p, listed, null);
      if (!ctx.options.archived && placementStatus(p, facts, categoryOf(stages, stageIdOf(p, facts))) !== 'active') continue;
      const created = toDate(facts?.created_at) ?? toDate(hit.created_at);
      if (ctx.since && created && created < ctx.since) continue;
      if (!(await ctx.load.has('opportunity', appKey(hit.id, p.jobId)))) out.add(p.id);
    }
    return out;
  }

  /**
   * A search page for the people phase. Only the hits from `from` on are
   * still to do (a resumed step), so only they get the page's extra calls:
   * /candidates?ids= for applied dates and stage categories, and the feed.
   */
  async function peoplePage(ctx: PhaseContext, token: JsonValue, from: number): Promise<Page<Person>> {
    const t = token as PeopleToken | null;
    const page = await searchPage(ctx, t);
    let historyOn = t?.history !== false;
    const todo = page.items.slice(from).filter((h) => !h.example && jobPlacements(h).length);
    const listed = new Map<Id, ListedCandidate>();
    const stages = new Map<Id, Reference>();
    const fresh = new Map<Id, Set<Id>>();
    let moves = new Map<Id, Move[]>();
    if (todo.length) {
      const ids = todo.map((h) => h.id);
      const res = await get<CandidateList>('/candidates', { ids: ids.join(','), limit: ids.length, offset: 0 });
      for (const c of res.candidates ?? []) listed.set(c.id, c);
      for (const r of res.references ?? []) if (r.type === 'Stage') stages.set(r.id, r);
      for (const h of todo) fresh.set(h.id, await freshPlacements(ctx, h, listed.get(h.id) ?? null, stages));
      const needHistory = todo.filter((h) => fresh.get(h.id)!.size);
      if (historyOn && needHistory.length) {
        const got = await feed(ctx, needHistory);
        if (!got) historyOn = false;
        else {
          moves = got;
          const moved = needHistory.some((h) =>
            jobPlacements(h).some((p) => {
              const category = categoryOf(stages, p.stage?.id ?? null);
              return fresh.get(h.id)!.has(p.id) && !!category && !INTAKE.has(category);
            }),
          );
          if (!got.size && moved) {
            warnOnce(ctx, 'history-empty', 'Stage history: the activity feed had no stage moves for some candidates who moved stages; their applications keep only their current stage and dates');
          }
        }
      }
    }
    const next = page.next != null && !historyOn ? { ...(page.next as SearchToken), history: false } : page.next;
    return {
      items: page.items.map((hit) => ({
        id: hit.id,
        hit,
        listed: listed.get(hit.id) ?? null,
        stages,
        moves: moves.get(hit.id) ?? [],
        fresh: fresh.get(hit.id) ?? new Set<Id>(),
      })),
      next,
    };
  }

  async function toApplication(item: Person, p: JobPlacement, profile: Candidate | null, person: ImportedCandidate): Promise<ImportedApplication> {
    const { hit, listed } = item;
    const facts = placementFacts(p, listed, profile);
    const stageId = stageIdOf(p, facts);
    const stageRef: StageRef | null =
      stageId != null ? { externalId: String(stageId), name: p.stage?.name ?? item.stages.get(stageId)?.name ?? null } : null;
    const category = categoryOf(item.stages, stageId);
    const status = placementStatus(p, facts, category);
    const hiredAt = toDate(p.hired_at ?? facts?.hired_at);
    const reason = (p.disqualify_reason ?? facts?.disqualify_reason)?.trim() || null;
    const { history, intake } = historyFor(item.moves, p, stageRef, item.stages, facts, status === 'hired' ? hiredAt : null);

    const fields: Record<string, string> = { 'Recruitee placement ID': String(p.id) };
    if (status === 'archived' && (p.disqualify_kind ?? facts?.disqualify_kind) === 'system') {
      fields['Disqualified by'] = 'Recruitee automation';
    }
    const starts = dateOnly(p.job_starts_at ?? facts?.job_starts_at);
    if (status === 'hired' && starts) fields['Start date'] = starts.toISOString().slice(0, 10);
    for (const [label, value] of Object.entries(profileFields(profile, p.jobId))) fields[label] ??= value;

    const owner = (await offerIndex()).get(p.jobId)?.recruiterId;
    return {
      externalId: appKey(hit.id, p.jobId),
      candidateExternalId: String(hit.id),
      candidate: person,
      postingExternalId: String(p.jobId),
      stage: stageRef,
      status,
      archiveReason: status === 'archived' && reason ? { name: reason } : null,
      // Only search hits say when; the placement's last update is the spec's approximation. A hire's time is its entry into Hired.
      archivedAt: status === 'archived' ? (toDate(p.disqualified_at) ?? toDate(facts?.updated_at)) : status === 'hired' ? hiredAt : null,
      // A placement still in its intake stage names it directly.
      origin: originOf(intake ?? (category && INTAKE.has(category) ? category : null), hit, listed, profile),
      source: sourceOf(hit, listed),
      ownerExternalUserId: idString(owner),
      createdAt: toDate(facts?.created_at) ?? toDate(hit.created_at),
      history,
      fields,
    };
  }

  /** The profile's CV or cover-letter file: the original upload first; the link is re-read once if S3 refuses it. */
  function profileFile(c: Candidate, which: 'cv' | 'cover'): ImportedFile | null {
    const pick = (x: Candidate | null | undefined) =>
      which === 'cv'
        ? (absoluteUrl(x?.cv_original_url) ?? absoluteUrl(x?.cv_url))
        : (absoluteUrl(x?.cover_letter_file_original_url) ?? absoluteUrl(x?.cover_letter_file_url));
    const url = pick(c);
    if (!url) return null;
    const who = (c.name?.trim() || `Candidate ${c.id}`).replace(/[/\\]/g, ' ');
    return {
      externalId: which === 'cv' ? `cv-${c.id}` : `cover-letter-${c.id}`,
      candidateExternalId: String(c.id),
      filename: `${who} ${which === 'cv' ? 'CV' : 'cover letter'}.${extension(url) ?? 'pdf'}`,
      kind: which === 'cv' ? 'resume' : 'other',
      download: async () => {
        try {
          return await http.bytes(url);
        } catch (err) {
          // If the links turn out to be signed and short-lived, the profile hands out a fresh one.
          if (!(err instanceof ImportHttpError) || (err.status !== 403 && err.status !== 400)) throw err;
          const fresh = await get<CandidateDetail>(`/candidates/${c.id}`).catch((e: unknown) => {
            if (e instanceof ImportAuthError || (e instanceof ImportHttpError && e.status !== 429)) return null;
            throw e;
          });
          const again = pick(fresh?.candidate);
          if (!again || again === url) throw err;
          return http.bytes(again);
        }
      },
    };
  }

  async function loadPerson(ctx: PhaseContext, item: Person) {
    const { hit } = item;
    if (hit.example) return; // Recruitee's sample data
    const places = jobPlacements(hit);
    if (!ctx.options.archived && places.length) {
      // archived=false: someone whose every application is closed brings nothing active.
      const active = places.some((p) => {
        const facts = placementFacts(p, item.listed, null);
        return placementStatus(p, facts, categoryOf(item.stages, stageIdOf(p, facts))) === 'active';
      });
      if (!active) return;
    }
    const id = String(hit.id);
    const known = await ctx.load.has('contact', id);
    const created = toDate(hit.created_at);
    // Only in talent pools: a contact without applications. Everyone else arrives with a new application.
    const standalone = !places.length && !known && !(ctx.since && created && created < ctx.since);
    const fresh = item.fresh.size > 0;
    // The contact may be from a run without files, or its CV download failed: the link is only on the profile.
    const wantCv = ctx.options.files && (known || standalone || fresh) && !(await ctx.load.has('file', `cv-${hit.id}`));
    let profile: Candidate | null = null;
    if (standalone || fresh || wantCv) {
      const read = await readProfile(ctx, hit.id);
      if (read === 'gone') return;
      profile = read;
    }
    const person = toCandidate(hit, profile);
    if (hit.is_anonymous && !known && (standalone || fresh)) {
      warnOnce(ctx, 'anonymous', 'Some candidates are anonymized in Recruitee and came across with only the details the token user can see');
    }
    if (standalone) await ctx.load.candidate(person);
    // Every placement goes to the loader, which skips what exists, is closed (archived=false) or predates `since`.
    for (const p of places) await each(ctx, p, async (x) => ctx.load.application(await toApplication(item, x, profile, person)));
    if (profile && ctx.options.files) {
      // File links only come with the profile; fetch them while they're fresh.
      for (const file of [profileFile(profile, 'cv'), profileFile(profile, 'cover')]) if (file) await ctx.load.file(file);
    }
  }

  // ---------- Record mapping that needs the API ----------

  async function toPosting(ctx: PhaseContext, o: Offer): Promise<ImportedPosting> {
    const department =
      o.department?.trim() || (o.department_id != null ? ((await departments(ctx)).get(o.department_id) ?? null) : null);
    const salary = o.salary ?? null;
    const min = annual(amount(salary?.min), salary?.period);
    const max = annual(amount(salary?.max), salary?.period);
    // Hourly/daily/weekly pay (and anything unparseable) has no annual figure; keep it readable instead.
    const salaryText =
      salary && (salary.min != null || salary.max != null) && ((min == null && max == null) || (!!salary.period && salary.period !== 'year'))
        ? cleanList([
            'Salary:',
            [salary.min, salary.max].filter((v) => v != null).join('–'),
            salary.currency,
            salary.period ? `per ${salary.period}` : null,
          ]).join(' ')
        : null;
    const requirements = htmlToText(o.requirements || o.requirements_html);
    return {
      externalId: String(o.id),
      title: o.title?.trim() || `Job ${o.id}`,
      state: POSTING_STATE[o.status ?? ''] ?? 'draft',
      department,
      location: o.location?.trim() || cleanList([o.city, o.state_name, o.country_code]).join(', ') || null,
      commitment: commitmentOf(o.employment_type),
      workplaceType: workplaceOf(o),
      description:
        [htmlToText(o.description || o.description_html), requirements ? `Requirements\n${requirements}` : '', salaryText ?? '']
          .filter(Boolean)
          .join('\n\n') || null,
      salaryMin: min,
      salaryMax: max,
      salaryCurrency: min != null || max != null ? (salary?.currency ?? null) : null,
      tags: names(o.tags),
      requisitionExternalId: idString(o.requisition_ids?.[0]),
      createdAt: toDate(o.created_at ?? o.published_at),
    };
  }

  /** `detail` is /requisitions/{id}, the only place openings are reliably filled in. */
  function toRequisition(r: Requisition, detail: Requisition | null, archivedScope: boolean): ImportedRequisition {
    const d = detail ?? r;
    const status = (d.status ?? r.status ?? '').toLowerCase();
    const openings = d.openings_count ?? r.openings_count ?? null;
    const list = d.openings?.length ? d.openings : r.openings?.length ? r.openings : null;
    const filled = list ? list.filter((o) => o.status === 'filled').length : (d.hires_count ?? r.hires_count ?? null);
    const full = openings != null && openings > 0 && filled != null && filled >= openings;
    const closed = archivedScope || !!(d.archived_at ?? r.archived_at) || status === 'rejected' || (status === 'approved' && full);
    return {
      externalId: String(r.id),
      code: (d.guid ?? r.guid)?.trim() || `REQ-${r.id}`,
      title: (d.title ?? r.title)?.trim() || `Requisition ${r.id}`,
      state: closed ? 'closed' : status === 'approved' ? 'open' : 'on_hold',
      openings,
      filled,
    };
  }

  async function loadResult(ctx: PhaseContext, r: Result, hit: Hit, apps: Set<string>, refs: Map<string, Reference>, events: InterviewEvent[]) {
    if (r.offer_id == null) return;
    const key = appKey(hit.id, r.offer_id);
    if (!apps.has(key)) return;
    const questionnaire = r.kind === 'questionnaire';
    const author = r.admin_id != null ? refs.get(`Admin:${r.admin_id}`) : r.guest_id != null ? refs.get(`Guest:${r.guest_id}`) : undefined;
    const answers = r.interview_result_answers ?? [];

    let rating = questionnaire ? null : ratingFromLabel(r.rating);
    let overall = r.rating ? (RATING_LABEL[r.rating] ?? r.rating) : null;
    const scored = overallAnswer(r);
    if (!questionnaire && rating == null && scored?.content) {
      const content = scored.content.trim();
      const score = Number(content);
      const scale = ratingFromLabel(content) == null && Number.isFinite(score) ? await ratingScale(ctx) : null;
      rating = ratingFromLabel(content) ?? ratingFromScore(score, scale);
      overall ??= RATING_LABEL[content] ?? (scale?.range ? `${content} of ${scale.range}` : content);
    }

    const stage = r.stage_id != null ? refs.get(`Stage:${r.stage_id}`)?.name : null;
    await ctx.load.feedback({
      externalId: String(r.id),
      applicationExternalId: key,
      interviewExternalId: questionnaire ? null : interviewFor(r, events),
      authorExternalUserId: idString(r.admin_id),
      authorName: personName(author),
      rating,
      title: [r.interview_template_name?.trim() || RESULT_KIND[r.kind ?? ''] || 'Evaluation', stage].filter(Boolean).join(' · '),
      summary: [
        overall ? `Overall: ${overall}` : '',
        htmlToText(r.rating_note_html) || r.rating_note?.trim() || '',
        htmlToText(r.pre_note_html),
        htmlToText(r.post_note_html),
      ]
        .filter(Boolean)
        .join('\n\n'),
      answers: answers
        .filter((a) => a.visible !== false && a.question_kind !== 'overall_rating')
        .map((a) => ({ label: a.question_title?.trim() || 'Question', value: answerText(a) }))
        .filter((a) => a.value),
      createdAt: toDate(r.created_at),
    });
  }

  async function loadLetter(ctx: PhaseContext, l: OfferLetter, letters: OfferLetter[], hit: Hit, apps: Set<string>) {
    if (l.offer_id == null) return;
    const key = appKey(hit.id, l.offer_id);
    if (!apps.has(key)) return;
    const placement = jobPlacements(hit).find((p) => p.jobId === l.offer_id);
    const outcome = letterOutcome(l, letters, placement);
    const details = (l.details ?? []).filter((d) => d.description?.trim());
    const position = details.find((d) => /^(position|job title)$/i.test(d.title?.trim() ?? ''))?.description?.trim();
    const salary = l.salary && l.salary.enabled !== false ? l.salary : null;
    const value = amount(salary?.value);
    await ctx.load.offer({
      externalId: String(l.id),
      applicationExternalId: key,
      status: outcome.status,
      jobTitle: position || placement?.offer?.title?.trim() || null,
      salaryAmount: annual(value, salary?.period),
      salaryCurrency: salary?.currency ?? null,
      startDate: dateOnly(l.start_date?.date),
      sentAt: toDate(l.sent_at),
      respondedAt: outcome.respondedAt,
      createdAt: toDate(l.created_at),
      notes:
        [
          l.title?.trim(),
          ...details.filter((d) => d.description?.trim() !== position).map((d) => `${d.title?.trim() || 'Detail'}: ${d.description!.trim()}`),
          salary && value != null
            ? cleanList([
                'Salary:',
                String(value),
                salary.currency,
                salary.period ? `per ${salary.period}` : null,
                salary.description ? `(${salary.description.trim()})` : null,
              ]).join(' ')
            : '',
          outcome.replaced ? 'Replaced by a later offer letter.' : '',
          l.link_deactivated ? 'The offer link was deactivated.' : '',
        ]
          .filter(Boolean)
          .join('\n') || null,
    });
  }

  // ---------- Phases ----------

  const discover: Phase[] = [
    {
      id: 'users',
      label: 'Team members',
      async run(ctx, cursor) {
        if (cursor === null) {
          // The token acts as its user: say up front when that user can't see everything.
          const me = (await optional(ctx, 'Token access check', () => get<AdminResponse>('/admin'), null))?.admin;
          if (me && !me.role_admin && !me.membership?.role_admin) {
            const have = new Set(me.role_abilities ?? []);
            const missing = FULL_ACCESS_ABILITIES.filter((a) => !have.has(a));
            if (missing.length) {
              ctx.warn(
                `The API token belongs to a ${me.role_name?.trim() || 'non-admin'} user without ${missing.join(', ')}, so the import will miss what that role can't see. Create the token as an Admin for a complete import.`,
              );
            }
          }
        }
        return pagedStep(
          ctx,
          cursor,
          async (page) => {
            const p = typeof page === 'number' ? page : 1;
            const res = await optional(
              ctx,
              'Team members',
              () => get<Memberships>('/memberships', { limit: pageSize, page: p, sort_by: 'email', sort_order: 'asc' }),
              null,
            );
            const admins = refIndex(res?.references);
            const items = (res?.memberships ?? []).map((m) => ({ id: m.id, adminId: m.admin_id, admin: admins.get(`Admin:${m.admin_id}`) }));
            return { items, next: res && morePages(res.meta, p, pageSize, items.length) ? p + 1 : null };
          },
          async (m) => {
            if (!m.admin) return;
            ctx.catalog.user({
              externalId: String(m.adminId),
              name: personName(m.admin) ?? `User ${m.adminId}`,
              email: m.admin.email?.trim() || null,
            });
          },
        );
      },
    },
    {
      id: 'stages',
      label: 'Job pipelines',
      run: (ctx, cursor) =>
        pagedStep(
          ctx,
          cursor,
          (page) => offersPage(page, false),
          async (o) => {
            if (o.kind === 'talent_pool') return;
            // Pre-Dec-2025 list items embedded the pipeline; now it's one call per job's own copy.
            let stages = o.pipeline_template?.stages ?? null;
            if (!stages && o.pipeline_template_id != null) {
              if (pipelinesRead.has(o.pipeline_template_id)) return;
              pipelinesRead.add(o.pipeline_template_id);
              const res = await optional(
                ctx,
                'Job pipeline',
                () => get<{ pipeline_template?: Pipeline }>(`/pipeline_templates/${o.pipeline_template_id}`),
                null,
              );
              stages = res?.pipeline_template?.stages ?? null;
            }
            if (!stages) {
              const res = await optional(ctx, 'Job pipeline', () => get<{ offer?: Offer | null }>(`/offers/${o.id}`), null);
              stages = res?.offer?.pipeline_template?.stages ?? null;
            }
            for (const s of stages ?? []) {
              const name = s.name?.trim();
              if (!name) continue;
              ctx.catalog.stage({ externalId: String(s.id), name, typeHint: STAGE_TYPE[s.category ?? ''] ?? null, position: s.position ?? null });
            }
          },
        ),
    },
    {
      id: 'reasons',
      label: 'Disqualify reasons',
      async run(ctx) {
        const res = await optional(
          ctx,
          'Disqualify reasons',
          () => get<{ disqualify_reasons?: { id: Id; name?: string | null }[] | null }>('/disqualify_reasons'),
          null,
        );
        for (const r of res?.disqualify_reasons ?? []) {
          const name = r.name?.trim();
          if (name) ctx.catalog.reason({ externalId: String(r.id), name, kind: reasonKind(name) });
        }
        return null;
      },
    },
  ];

  const load: Phase[] = [
    {
      id: 'requisitions',
      label: 'Requisitions',
      run: (ctx, cursor) =>
        pagedStep(
          ctx,
          cursor,
          async () => {
            // Unpaginated, and the default scope hides archived ones: read both in one page.
            const active = await optional(ctx, 'Requisitions', () => get<{ requisitions?: Requisition[] | null }>('/requisitions', { scope: 'active' }), null);
            if (!active) return { items: [], next: null };
            const archived = await optional(ctx, 'Archived requisitions', () => get<{ requisitions?: Requisition[] | null }>('/requisitions', { scope: 'archived' }), null);
            const byId = new Map<Id, Requisition & { archivedScope: boolean }>();
            for (const r of active.requisitions ?? []) byId.set(r.id, { ...r, archivedScope: false });
            for (const r of archived?.requisitions ?? []) byId.set(r.id, { ...r, archivedScope: true });
            return { items: [...byId.values()], next: null };
          },
          async (r) => {
            const detail = (await ctx.load.has('requisition', String(r.id)))
              ? null
              : ((await optional(ctx, 'Requisition details', () => get<{ requisition?: Requisition | null }>(`/requisitions/${r.id}`), null))
                  ?.requisition ?? null);
            await ctx.load.requisition(toRequisition(r, detail, r.archivedScope));
          },
        ),
    },
    {
      id: 'postings',
      label: 'Jobs',
      run: (ctx, cursor) =>
        pagedStep(
          ctx,
          cursor,
          (page) => offersPage(page, true),
          async (o) => {
            if (o.kind === 'talent_pool' || (await ctx.load.has('posting', String(o.id)))) return;
            // The rebuilt list is a basic field set; the detail has the description, department and location.
            const detail = (await optional(ctx, 'Job details', () => get<{ offer?: Offer | null }>(`/offers/${o.id}`), null))?.offer;
            const offer: Offer = { ...o, ...(detail ?? {}), requisition_ids: detail?.requisition_ids ?? o.requisition_ids };
            if (offer.kind === 'talent_pool') return;
            await ctx.load.posting(await toPosting(ctx, offer));
          },
        ),
    },
    {
      id: 'candidates',
      label: 'Candidates and applications',
      run: (ctx, cursor) => {
        const from = (cursor as PageCursor | null)?.index ?? 0;
        return pagedStep(ctx, cursor, (p) => peoplePage(ctx, p, from), (item) => loadPerson(ctx, item));
      },
    },
    {
      id: 'interviews',
      label: 'Interviews',
      enabled: (o) => o.activity,
      run: (ctx, cursor) =>
        pagedStep(
          ctx,
          cursor,
          async (page) => {
            const p = typeof page === 'number' ? page : 1;
            // status defaults to "upcoming", which would drop every past interview.
            const res = await optional(
              ctx,
              'Interviews',
              () => get<Events>('/interview/events', { scope: 'all', status: 'all', limit: pageSize, page: p }),
              null,
            );
            const refs = refIndex(res?.references);
            const items = (res?.interview_events ?? []).map((e) => ({ id: e.id, event: e, refs }));
            return { items, next: items.length < pageSize ? null : p + 1 };
          },
          async ({ event: e, refs }) => {
            const startAt = toDate(e.starts_at);
            if (e.candidate_id == null || e.offer_id == null || !startAt) return;
            const job = (await offerIndex()).get(e.offer_id)?.title ?? refs.get(`Offer:${e.offer_id}`)?.title;
            const kind = EVENT_KIND[e.kind ?? ''] ?? 'Interview';
            await ctx.load.interview({
              externalId: String(e.id),
              applicationExternalId: appKey(e.candidate_id, e.offer_id),
              title: e.custom_name?.trim() || (job ? `${kind} for ${job}` : kind),
              startAt,
              durationMins: e.duration ?? null,
              location: e.location?.trim() || e.video_url?.trim() || null,
              panelistExternalUserIds: cleanList([...(e.admin_ids ?? []), ...(e.event_attendees ?? []).map((a) => a.admin_id)].map(idString)),
            });
          },
        ),
    },
    {
      id: 'feedback',
      label: 'Evaluations',
      enabled: (o) => o.activity,
      run: perCandidate(gates.results, async (ctx, hit, apps) => {
        const res = await subresource(ctx, gates.results, 'Evaluations', hit.id, () =>
          get<Results>('/interview/results', { candidate_id: hit.id, scope: 'all', kind: 'all' }),
        );
        if (res?.hidden_results_preview?.length) {
          warnOnce(ctx, 'hidden-results', "Some evaluations are hidden from the token's user (fair evaluations); give it the review_hidden_evaluations ability to import them");
        }
        // Only what this run will add: on a re-run that is usually nothing, and nothing more is read.
        const results: Result[] = [];
        for (const r of res?.interview_results ?? []) {
          if (r.offer_id != null && apps.has(appKey(hit.id, r.offer_id)) && !(await ctx.load.has('feedback', String(r.id)))) results.push(r);
        }
        if (!results.length) return;
        const refs = refIndex(res?.references);
        // Results don't name their interview; the candidate's events for the same job and stage do.
        // Only scorecards link to one (a result with no overall decision imports as a note).
        const linkable =
          !gates.events.blocked &&
          results.some((r) => r.kind !== 'questionnaire' && r.stage_id != null && (!!r.rating?.trim() || !!overallAnswer(r)));
        const events = linkable
          ? ((
              await subresource(ctx, gates.events, 'Linking evaluations to interviews', hit.id, () =>
                get<Events>('/interview/events', { candidate_id: hit.id, scope: 'all', status: 'all' }),
              )
            )?.interview_events ?? [])
          : [];
        for (const r of results) await each(ctx, r, (x) => loadResult(ctx, x, hit, apps, refs, events));
      }),
    },
    {
      id: 'notes',
      label: 'Notes',
      enabled: (o) => o.activity,
      run: perCandidate(gates.notes, async (ctx, hit, apps) => {
        const res = await subresource(ctx, gates.notes, 'Notes', hit.id, () => get<Notes>(`/candidates/${hit.id}/notes`));
        const refs = refIndex(res?.references);
        for (const { note: n, job, reply, hidden } of flattenNotes(res?.notes ?? [])) {
          await each(ctx, n, async () => {
            if (hidden) {
              warnOnce(ctx, 'restricted-notes', 'Skipped notes Recruitee restricts to certain users or roles: in Orqestra, everyone who can see an application can read its notes');
              return;
            }
            // A note on a job whose application wasn't imported stays out rather than landing on another job.
            const key = job != null ? appKey(hit.id, job) : null;
            if (key && !apps.has(key)) return;
            const author = n.admin_id != null ? refs.get(`Admin:${n.admin_id}`) : n.guest_id != null ? refs.get(`Guest:${n.guest_id}`) : undefined;
            const body = n.text?.trim() || htmlToText(n.body_html || n.body);
            await ctx.load.note({
              externalId: String(n.id),
              applicationExternalId: key,
              candidateExternalId: String(hit.id),
              authorExternalUserId: idString(n.admin_id),
              authorName: personName(author),
              body: body && reply ? `Reply: ${body}` : body,
              createdAt: toDate(n.created_at),
            });
          });
        }
      }),
    },
    {
      id: 'offers',
      label: 'Offer letters',
      enabled: (o) => o.offers,
      run: perCandidate(gates.letters, async (ctx, hit, apps) => {
        // The response wrapper isn't documented (the example is empty); accept a bare array too.
        const res = await subresource(ctx, gates.letters, 'Offer letters', hit.id, () =>
          get<{ offer_letters?: OfferLetter[] | null } | OfferLetter[]>(`/offer_letters/candidates/${hit.id}/offer_letters`),
        );
        const letters = Array.isArray(res) ? res : (res?.offer_letters ?? []);
        for (const l of letters) await each(ctx, l, (x) => loadLetter(ctx, x, letters, hit, apps));
      }),
    },
    {
      id: 'files',
      label: 'Attachments',
      enabled: (o) => o.files,
      run: perCandidate(gates.attachments, async (ctx, hit, apps) => {
        const res = await subresource(ctx, gates.attachments, 'Attachments', hit.id, () => get<Attachments>(`/candidates/${hit.id}/attachments`));
        if (res?.hidden_attachments_exist) {
          warnOnce(ctx, 'hidden-attachments', "Some attachments are hidden from the token's user and were not imported");
        }
        for (const a of res?.attachments ?? []) {
          await each(ctx, a, async () => {
            if (restricted(a.visibility)) {
              warnOnce(ctx, 'restricted-attachments', 'Skipped attachments Recruitee restricts to certain users or roles: in Orqestra, everyone who can see an application can open its files');
              return;
            }
            const url = absoluteUrl(a.file_url);
            const key = a.offer_id != null ? appKey(hit.id, a.offer_id) : null;
            if (!url || (key && !apps.has(key))) return;
            await ctx.load.file({
              externalId: String(a.id),
              candidateExternalId: String(hit.id),
              applicationExternalId: key,
              filename: clip(a.filename?.trim() || basename(url), 200),
              kind: 'other',
              download: () => http.bytes(url),
            });
          });
        }
      }),
    },
  ];

  return {
    async verify() {
      if (!company || !credentials.apiToken?.trim()) throw new Error('Enter your Recruitee company ID and personal API token.');
      if (!/^[a-z0-9][a-z0-9-]*$/i.test(company)) {
        throw new Error('The company ID is the number on the Personal API tokens page (e.g. 49498), or your careers-site subdomain.');
      }
      const me = (await get<AdminResponse>('/admin')).admin;
      const companies = me?.companies ?? [];
      const key = company.toLowerCase();
      const match = companies.find(
        (c) => String(c.id) === company || c.subdomain?.toLowerCase() === key || c.host?.toLowerCase() === `${key}.recruitee.com`,
      );
      if (match) return { accountName: match.name?.trim() || `Recruitee company ${match.id}` };
      // Every call would go to a company the token's user isn't in. Only a complete list can say so.
      if (companies.length && companies.length >= (me?.all_companies_count ?? 0)) {
        const theirs = companies.slice(0, 5).map((c) => `${c.name?.trim() || 'Company'} (${c.id})`).join(', ');
        throw new Error(
          `This token's user isn't in Recruitee company ${company}. It can reach ${theirs}. Check the company ID, or create the token in the company you're importing.`,
        );
      }
      return { accountName: `Recruitee company ${company}` };
    },
    discover,
    load,
  };
}

/** Page sizes are tunable so tests can exercise paging and the search re-anchoring with a few records. */
export function createRecruiteeProvider(tuning: { pageSize?: number; searchWindow?: number } = {}): ProviderModule {
  const pageSize = tuning.pageSize ?? PAGE_SIZE;
  const searchWindow = tuning.searchWindow ?? SEARCH_WINDOW;
  return {
    id: 'recruitee',
    // 1,000 requests / 60 s per token, enforced since 2025-10-15; stay near 60% of it.
    minIntervalMs: 100,
    auth(credentials): AuthConfig {
      const token = (credentials.apiToken ?? '').trim();
      const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
      return { hosts: [API_HOST], headers };
    },
    create: (credentials, http) => createAdapter(credentials, http, pageSize, searchWindow),
  };
}

export const recruiteeProvider: ProviderModule = createRecruiteeProvider();
