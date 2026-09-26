import type { Commitment, OfferStatus, Origin, StageType, WorkplaceType } from '@prisma/client';
import {
  buildUrl,
  ImportAuthError,
  ImportHttpError,
  type AuthConfig,
  type HttpClient,
  type QueryValue,
} from '@/server/imports/http';
import { nameKey } from '@/server/imports/mapping';
import { each, isRetryable, optional, pagedStep, type Page, type PageCursor } from '@/server/imports/paging';
import { cleanEmails, cleanList, clip, fullName, htmlToText, toDate } from '@/server/imports/text';
import type {
  Cursor,
  ImportedApplication,
  ImportedCandidate,
  ImportedOffer,
  ImportedPosting,
  ImportedRequisition,
  JsonValue,
  Phase,
  PhaseContext,
  ProviderModule,
  ReasonRef,
  StageHistoryEntry,
  StageRef,
} from '@/server/imports/types';

/**
 * Workable (SPI v3) adapter.
 *
 * Auth is an account-level token (`Authorization: Bearer …`) sent only to
 * workable.com, www.workable.com and `{subdomain}.workable.com`. Resumes and
 * attachments are pre-signed S3 links (valid ~16 h) and go out bare. Tokens
 * are read-only by scope, expire (30 days to 2 years), and share one budget of
 * 10 requests / 10 s per account, hence the 1.1 s spacing.
 *
 * Quirks handled here (the live API disagrees with the docs in places):
 * - Lists are keyset-paged by ascending hex id; `paging.next` is a ready-made
 *   URL and simply absent on the last page. We follow it verbatim when it
 *   points at a Workable API host, and otherwise rebuild it from `since_id` on
 *   our own base so the token never leaves Workable. A step that stops
 *   mid-page resumes from the next record's id (`since_id` is inclusive), not
 *   an index, so a record deleted between slices can't shift the page. Lists
 *   and candidate details get one retry on 404, which Workable returns
 *   transiently.
 * - A Workable "candidate" is one person in one job, so each record is an
 *   application; the loader merges people across jobs by email. The list
 *   omits tags, links, location, resume_url, answers, withdrew and
 *   disqualified_at, so every candidate costs a detail call, its activity feed
 *   and its Files tab. Candidates already imported (by an earlier run or a
 *   replayed step) skip all of that, except the last one on the page: only a
 *   later candidate proves it wasn't cut off mid-way.
 * - Candidates don't say whether their job is sample data or confidential, or
 *   who recruits for it, so the candidates phase first re-reads /jobs and each
 *   job's hiring team. The job's recruiting admin (else its hiring manager)
 *   owns candidates nobody uploaded. A job that appears later is loaded when
 *   its first candidate arrives.
 * - `candidate.stage` is the stage NAME (not the slug the docs claim); stages
 *   have integer ids and 1-based positions; jobs may have their own pipeline,
 *   so discovery unions /stages with each job's stages.
 * - /disqualification_reasons (and /stages, defensively) may be bare arrays.
 *   Candidates reference reasons by description text, not id, and older
 *   records carry free text; a free-text withdrawal files under "Withdrew" so
 *   it isn't counted as a rejection. Hired is a stage in Workable, so hires
 *   get a synthetic "Hired" reason, and a hire wins over a later
 *   disqualification.
 * - Stage history, comments, emails and ratings all come from the
 *   per-candidate activity feed, fetched once and fanned out in the same
 *   step. A move is an activity with `target_stage`; ratings carry a per-rating
 *   scale (thumbs/stars/numbers) with a 0-based grade. Activities restricted
 *   to some roles (`visibility_roles` without `simple`) are skipped with a
 *   warning, because Source notes have no private setting.
 * - Job state `closed` means internal/unlisted (still hiring); `archived` is
 *   closed. Sample (demo) jobs, their candidates, and GDPR-anonymized
 *   candidates are skipped.
 * - Requisitions (Hiring Plan only) point at jobs, not the other way round, so
 *   they are read in the jobs phase and the job → requisition link rides in
 *   the cursor. What accounts without Hiring Plan get back is undocumented, so
 *   any 4xx there means "no requisitions". Only the latest offer per
 *   candidate is readable.
 * - Events (interviews) are an org-wide list, loaded last so their
 *   applications exist; ratings have no interview link to carry over.
 */

// ---------- Vendor payloads (only the fields we read) ----------

type WListResponse = { paging?: { next?: string | null } | null } & { [key: string]: unknown };

type WAccount = { id?: string | null; name?: string | null; subdomain?: string | null };

type WMember = { id: string | number; name?: string | null; email?: string | null };

type WJobMember = { id: string | number; collaboration_role?: string | null };

type WStage = {
  id?: number | string | null;
  identifier?: string | null;
  slug?: string | null;
  name?: string | null;
  kind?: string | null;
  position?: number | null;
};

type WReason = { id: string | number; description?: string | null; candidate_withdrew?: boolean | null };

type WLocation = {
  location_str?: string | null;
  country?: string | null;
  region?: string | null;
  city?: string | null;
  telecommuting?: boolean | null;
  workplace_type?: string | null;
};

type WJob = {
  id: string;
  title?: string | null;
  shortcode: string;
  state?: string | null;
  sample?: boolean | null;
  confidential?: boolean | null;
  department?: string | null;
  department_hierarchy?: { name?: string | null }[] | null;
  workplace_type?: string | null;
  location?: WLocation | null;
  locations?: { city?: string | null; country_name?: string | null; hidden?: boolean | null }[] | null;
  salary?: { salary_from?: number | null; salary_to?: number | null; salary_currency?: string | null } | null;
  keywords?: string[] | null;
  created_at?: string | null;
  // Detail only
  full_description?: string | null;
  description?: string | null;
  requirements?: string | null;
  benefits?: string | null;
  employment_type?: string | null;
};

type WMoney = {
  amount?: number | null;
  frequency?: string | null;
  currency?: string | null;
  currency_iso?: string | number | null;
  cached_value?: string | null;
};

type WRequisition = {
  id: string | number;
  code?: string | null;
  state?: string | null;
  reason?: string | null;
  job?: { id?: string | number | null; title?: string | null } | null;
  salary_range?: { from?: number | null; to?: number | null; frequency?: string | null; currency?: string | null; currency_iso?: string | number | null } | null;
};

type WStageRef = { id?: number | string | null; name?: string | null; slug?: string | null };

type WPerson = { id?: string | number | null; name?: string | null; type?: string | null };

type WRating = { score?: string | null; scale?: string | null; grade?: number | string | null };

type WActivity = {
  id: string | number;
  action?: string | null;
  stage_name?: string | null;
  action_stage?: WStageRef | null;
  target_stage?: WStageRef | null;
  created_at?: string | null;
  member?: WPerson | null;
  body?: string | null;
  rating?: WRating | null;
  visibility_roles?: string[] | null;
};

type WAnswerValue = {
  body?: string | number | boolean | null;
  checked?: boolean | null;
  choices?: { body?: string | null }[] | null;
  number?: number | null;
  date?: string | null;
  file_url?: string | null;
};

type WDated = { start_date?: string | null; end_date?: string | null };

/** List item plus the detail-only fields (all optional: the list omits them). */
type WCandidate = {
  id: string | number;
  name?: string | null;
  firstname?: string | null;
  lastname?: string | null;
  headline?: string | null;
  job?: { shortcode?: string | null; title?: string | null } | null;
  stage?: string | null;
  stage_kind?: string | null;
  disqualified?: boolean | null;
  anonymized?: boolean | null;
  disqualification_reason?: string | null;
  hired_at?: string | null;
  moved_to_offer_at?: string | null;
  sourced?: boolean | null;
  profile_url?: string | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  domain?: string | null;
  common_source?: string | null;
  common_source_category?: string | null;
  created_at?: string | null;
  resume_metadata?: { filename?: string | null; filetype?: string | null } | null;
  disqualified_at?: string | null;
  withdrew?: boolean | null;
  cover_letter?: string | null;
  summary?: string | null;
  education_entries?: (WDated & { degree?: string | null; school?: string | null; field_of_study?: string | null })[] | null;
  experience_entries?: (WDated & { title?: string | null; company?: string | null; current?: boolean | null })[] | null;
  skills?: { name?: string | null }[] | null;
  answers?: { question?: { body?: string | null } | null; answer?: WAnswerValue | null }[] | null;
  resume_url?: string | null;
  social_profiles?: { url?: string | null }[] | null;
  tags?: string[] | null;
  location?: WLocation | null;
  uploader_id?: string | number | null;
  originating_candidate_id?: string | number | null;
};

type WEvent = {
  id: string | number;
  title?: string | null;
  type?: string | null;
  starts_at?: string | null;
  ends_at?: string | null;
  cancelled?: boolean | null;
  members?: (WPerson & { status?: string | null })[] | null;
  candidate?: WPerson | null;
  conference?: { url?: string | null } | null;
};

type WDocVar = {
  document_variable?: { name?: string | null; slug?: string | null } | null;
  value?: { body?: JsonValue; data?: WMoney | null } | null;
};

type WOffer = { created_at?: string | null; state?: string | null; document_variables?: WDocVar[] | null };

type WFile = { name?: string | null; preview_url?: string | null; source?: string | null };

// ---------- Constants & small mappers ----------

const ROOT = 'https://workable.com/spi/v3';
const PAGE = 100;
const MAX_TIMELINE_PAGES = 50;
const SUBDOMAIN_HELP = 'Enter your Workable subdomain: the "acme" in acme.workable.com';
const HIRED: ReasonRef = { externalId: 'workable:hired', name: 'Hired' };
/** Not in the catalog: the loader creates it on first use and, going by the name, not as a rejection. */
const WITHDREW: ReasonRef = { name: 'Withdrew' };
const SAMPLE_JOB = "Skipped Workable's sample (demo) jobs";
const SAMPLE_CANDIDATES = "Skipped candidates of Workable's sample (demo) jobs";
const RESTRICTED =
  'Skipped Workable comments, emails and evaluations that only some roles could see (Source notes have no private setting)';
const EMPTY_PAGE = { items: [], next: null };

const STAGE_KIND: Record<string, StageType> = {
  sourced: 'LEAD',
  applied: 'APPLICANT',
  shortlisted: 'SCREEN',
  'phone-screen': 'SCREEN',
  assessment: 'SCREEN',
  interview: 'ONSITE',
  offer: 'OFFER',
  hired: 'HIRED',
};

const JOB_STATE: Record<string, ImportedPosting['state']> = {
  published: 'open',
  draft: 'draft',
  closed: 'internal', // "used internally or confidentially": still hiring, just unlisted
  archived: 'closed',
};

const WORKPLACE: Record<string, WorkplaceType> = { on_site: 'ONSITE', onsite: 'ONSITE', hybrid: 'HYBRID', remote: 'REMOTE' };

/** Headcount that isn't approved yet is on hold, not open. Unknown states stay open. */
const REQUISITION_STATE: Record<string, ImportedRequisition['state']> = {
  processing: 'on_hold',
  draft: 'on_hold',
  pending: 'on_hold',
  on_hold: 'on_hold',
  approved: 'open',
  open: 'open',
  reserved: 'open',
  filled: 'closed',
  rejected: 'closed',
  cancelled: 'closed',
  canceled: 'closed',
  closed: 'closed',
};

/** Offer states beyond accepted/rejected are undocumented; the raw value is kept in the offer notes. */
const OFFER_STATUS: Record<string, OfferStatus> = {
  draft: 'DRAFT',
  approved: 'DRAFT',
  pending: 'PENDING_APPROVAL',
  pending_approval: 'PENDING_APPROVAL',
  awaiting_approval: 'PENDING_APPROVAL',
  sent: 'SENT',
  pending_signature: 'SENT',
  awaiting_signature: 'SENT',
  viewed: 'SENT',
  accepted: 'ACCEPTED',
  signed: 'ACCEPTED',
  rejected: 'DECLINED',
  declined: 'DECLINED',
  withdrawn: 'WITHDRAWN',
  revoked: 'WITHDRAWN',
  rescinded: 'WITHDRAWN',
  cancelled: 'WITHDRAWN',
  canceled: 'WITHDRAWN',
  expired: 'WITHDRAWN',
};

/** Requisition `currency_iso` is documented as the numeric ISO 4217 code. */
const ISO_NUMERIC: Record<string, string> = {
  '036': 'AUD', '124': 'CAD', '156': 'CNY', '203': 'CZK', '208': 'DKK', '344': 'HKD', '348': 'HUF', '356': 'INR',
  '376': 'ILS', '392': 'JPY', '484': 'MXN', '554': 'NZD', '578': 'NOK', '702': 'SGD', '710': 'ZAR', '752': 'SEK',
  '756': 'CHF', '784': 'AED', '826': 'GBP', '840': 'USD', '946': 'RON', '949': 'TRY', '975': 'BGN', '978': 'EUR',
  '985': 'PLN', '986': 'BRL',
};

const THUMBS = ['Thumbs down', 'Thumbs up', 'Definitely'];
const SCORE_BUCKET: Record<string, number> = { negative: 0, positive: 1, definite: 2 };
/** Activities that create the candidate record; their `action_stage` is the first stage. */
const ENTRY_ACTIONS = new Set(['applied', 'uploaded', 'copied', 'referral', 'sourced']);

const enc = encodeURIComponent;
const str = (v: string | number | null | undefined): string | null => (v == null || v === '' ? null : String(v));

/**
 * Accepts "acme", "acme.workable.com", "https://acme.workable.com/backend" or
 * the careers URL "apply.workable.com/acme". Validated before it becomes a
 * hostname, so a crafted value can't redirect the token elsewhere.
 */
export function normalizeSubdomain(raw: string | null | undefined): string | null {
  const [host, ...path] = (raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .split(/[/?#]/)
    .filter(Boolean);
  let sub = host ?? '';
  if (sub === 'apply.workable.com' || sub === 'jobs.workable.com') sub = path[0] ?? '';
  else sub = sub.replace(/\.workable\.com$/, '');
  if (['www', 'apply', 'jobs', 'api'].includes(sub)) return null;
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(sub) ? sub : null;
}

function apiHosts(sub: string | null): string[] {
  return ['workable.com', 'www.workable.com', ...(sub ? [`${sub}.workable.com`] : [])];
}

/** Lenient "is this a per-year amount" check (salary frequency is free-form). */
function perYear(frequency: string | null | undefined): boolean {
  return !frequency || /^(year|yearly|annual|annually|per_year)$/i.test(frequency.trim());
}

function currency(...values: (string | number | null | undefined)[]): string | null {
  for (const v of values) {
    const s = v == null ? '' : String(v).trim();
    if (/^\d{1,3}$/.test(s) && ISO_NUMERIC[s.padStart(3, '0')]) return ISO_NUMERIC[s.padStart(3, '0')];
    if (/^[a-z]{3}$/i.test(s)) return s.toUpperCase();
  }
  return null;
}

function locationText(l: WLocation | null | undefined): string | null {
  if (!l) return null;
  return l.location_str?.trim() || cleanList([l.city, l.region, l.country]).join(', ') || null;
}

/** Every advertised location when a job has several (`locations[]`), else the primary one. */
function jobLocation(j: WJob): string | null {
  const all = cleanList((j.locations ?? []).filter((l) => !l.hidden).map((l) => cleanList([l.city, l.country_name]).join(', ')));
  return all.length > 1 ? all.join('; ') : locationText(j.location);
}

/** Like optional(), but also falls back on errors a retry won't fix (another 4xx, a page that isn't JSON). */
async function soft<T>(ctx: PhaseContext, what: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ImportAuthError ? err.status === 401 : isRetryable(err)) throw err;
    ctx.warn(`${what}: ${err instanceof Error ? err.message : String(err)}`);
    return fallback;
  }
}

function commitment(employmentType: string | null | undefined): Commitment | null {
  const t = (employmentType ?? '').toLowerCase();
  if (/intern/.test(t)) return 'INTERNSHIP';
  if (/part/.test(t)) return 'PART_TIME';
  if (/contract|temporary|\btemp\b|freelance|seasonal/.test(t)) return 'CONTRACT';
  if (/full/.test(t)) return 'FULL_TIME';
  return null;
}

/** Document-variable / answer bodies: strings (sometimes HTML), numbers, or arrays. */
function plain(value: JsonValue | undefined): string | null {
  if (value == null) return null;
  if (Array.isArray(value)) return cleanList(value.map((v) => plain(v))).join(', ') || null;
  if (typeof value === 'object') return null;
  if (typeof value === 'string') return htmlToText(value) || null;
  return String(value);
}

function answerText(a: WAnswerValue | null | undefined): string | null {
  if (!a) return null;
  if (a.body != null && a.body !== '') return plain(a.body);
  if (a.checked != null) return a.checked ? 'Yes' : 'No';
  if (a.choices?.length) return cleanList(a.choices.map((c) => c.body)).join(', ') || null;
  if (a.number != null) return String(a.number);
  if (a.date) return a.date;
  if (a.file_url) return 'File (imported as an attachment)';
  return null;
}

/**
 * Workable ratings → 1 strong no · 2 no · 3 yes · 4 strong yes. The scale is
 * per rating: thumbs (grade 0–2), stars (0–4 = 1★–5★), numbers (0–9 = 1–10).
 * The job feed only has the coarse `score` bucket, which reads as thumbs.
 */
export function workableRating(r: WRating | null | undefined): { value: 1 | 2 | 3 | 4 | null; label: string | null } {
  if (!r) return { value: null, label: null };
  const g = r.grade == null || r.grade === '' ? NaN : Number(r.grade);
  const scale = r.scale?.toLowerCase();
  if (Number.isInteger(g)) {
    if (scale === 'thumbs' && g >= 0 && g <= 2) return { value: ([2, 3, 4] as const)[g], label: THUMBS[g] };
    if (scale === 'stars' && g >= 0 && g <= 4) return { value: ([1, 2, 3, 3, 4] as const)[g], label: `${g + 1} of 5 stars` };
    if (scale === 'numbers' && g >= 0 && g <= 9) {
      return { value: g <= 1 ? 1 : g <= 4 ? 2 : g <= 7 ? 3 : 4, label: `${g + 1}/10` };
    }
  }
  const bucket = r.score ? SCORE_BUCKET[r.score.toLowerCase()] : undefined;
  if (bucket != null) return { value: ([2, 3, 4] as const)[bucket], label: THUMBS[bucket] };
  return { value: null, label: null };
}

/** Last path segment of a (pre-signed) URL, for naming a file that has no name of its own. */
function basename(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
  } catch {
    return '';
  }
}

function stageId(s: WStage | WStageRef | null | undefined): string | null {
  return str(s?.id) ?? s?.slug ?? null;
}

function memberId(p: WPerson | null | undefined): string | null {
  return str(p?.id);
}

/** A hire wins over a later disqualification (spec precedence); `hired_at` alone counts too. */
function statusOf(c: WCandidate): ImportedApplication['status'] {
  if (c.stage_kind === 'hired' || c.hired_at) return 'hired';
  return c.disqualified ? 'archived' : 'active';
}

function originOf(c: WCandidate, timeline: WActivity[]): Origin {
  const source = `${c.common_source ?? ''} ${c.common_source_category ?? ''}`;
  if (timeline.some((a) => a.action === 'referral') || /referr/i.test(source)) return 'REFERRED';
  if (/agenc/i.test(source)) return 'AGENCY';
  return c.sourced ? 'SOURCED' : 'APPLIED';
}

type Dated = { a: WActivity; at: Date };

function chronological(timeline: WActivity[]): Dated[] {
  return timeline
    .map((a) => ({ a, at: toDate(a.created_at) }))
    .filter((x): x is Dated => x.at !== null)
    .sort((x, y) => x.at.getTime() - y.at.getTime());
}

/**
 * Oldest-first stage history from the candidate feed: the entry activity's
 * stage, then every activity with a `target_stage`. If the feed doesn't end
 * on the current stage (a move it doesn't show, or a `reverted` one, which
 * has no target), the current stage is appended at the best time Workable
 * gives for it, never before the last known move.
 */
function stageHistory(c: WCandidate, timeline: Dated[]): { history: StageHistoryEntry[]; current: StageRef | null } {
  const created = toDate(c.created_at);
  const history: StageHistoryEntry[] = [];
  let lastSlug: string | null = null;
  const push = (s: WStageRef, at: Date, actor: string | null) => {
    history.push({ stage: { externalId: stageId(s), name: s.name?.trim() || null }, at, actorExternalUserId: actor });
    lastSlug = s.slug ?? null;
  };

  const entry = timeline.find((x) => ENTRY_ACTIONS.has(x.a.action ?? '') && x.a.action_stage);
  const firstMove = timeline.find((x) => x.a.target_stage);
  const initial = entry?.a.action_stage ?? firstMove?.a.action_stage ?? null;
  if (initial) {
    const times = [created, entry?.at, firstMove?.at].filter((d): d is Date => !!d).map((d) => d.getTime());
    push(initial, new Date(Math.min(...times)), entry ? memberId(entry.a.member) : null);
  }
  for (const { a, at } of timeline) if (a.target_stage) push(a.target_stage, at, memberId(a.member));

  const name = c.stage?.trim();
  const last = history[history.length - 1];
  const matches = !!last && !!name && (nameKey(last.stage.name ?? '') === nameKey(name) || lastSlug === name);
  if (name && !matches) {
    const reverted = [...timeline].reverse().find((x) => x.a.action === 'reverted')?.at ?? null;
    const entered =
      (c.stage_kind === 'hired' ? toDate(c.hired_at) : c.stage_kind === 'offer' ? toDate(c.moved_to_offer_at) : null) ?? reverted;
    const floor = last?.at ?? created;
    const at = floor && (!entered || entered < floor) ? floor : (entered ?? new Date());
    history.push({ stage: { name }, at, actorExternalUserId: null });
  }
  return { history, current: history[history.length - 1]?.stage ?? null };
}

function profileNote(c: WCandidate): string {
  const sections: string[] = [];
  const span = (d: WDated, current?: boolean | null) => {
    const range = cleanList([d.start_date?.slice(0, 7), current ? 'present' : d.end_date?.slice(0, 7)]).join(' – ');
    return range ? ` (${range})` : '';
  };
  const cover = htmlToText(c.cover_letter);
  if (cover) sections.push(`Cover letter\n${cover}`);
  const summary = htmlToText(c.summary);
  if (summary) sections.push(`Summary\n${summary}`);
  const experience = (c.experience_entries ?? [])
    .map((e) => {
      const what = cleanList([e.title, e.company]).join(', ');
      return what ? `• ${what}${span(e, e.current)}` : '';
    })
    .filter(Boolean);
  if (experience.length) sections.push(`Experience\n${experience.join('\n')}`);
  const education = (c.education_entries ?? [])
    .map((e) => {
      const what = cleanList([e.degree, e.field_of_study, e.school]).join(', ');
      return what ? `• ${what}${span(e)}` : '';
    })
    .filter(Boolean);
  if (education.length) sections.push(`Education\n${education.join('\n')}`);
  const skills = cleanList((c.skills ?? []).map((s) => s.name));
  if (skills.length) sections.push(`Skills: ${skills.join(', ')}`);
  return sections.length ? `Workable profile\n\n${sections.join('\n\n')}` : '';
}

function toPosting(j: WJob, requisitionExternalId: string | null): ImportedPosting {
  const html =
    j.full_description ||
    [j.description, j.requirements && `<h3>Requirements</h3>${j.requirements}`, j.benefits && `<h3>Benefits</h3>${j.benefits}`]
      .filter(Boolean)
      .join('');
  const workplace =
    WORKPLACE[j.workplace_type ?? j.location?.workplace_type ?? ''] ?? (j.location?.telecommuting ? 'REMOTE' : null);
  const hierarchy = j.department_hierarchy ?? [];
  return {
    externalId: j.shortcode,
    title: j.title?.trim() || j.shortcode,
    state: JOB_STATE[j.state ?? ''] ?? 'draft',
    department: j.department?.trim() || hierarchy[hierarchy.length - 1]?.name?.trim() || null,
    location: jobLocation(j) ?? (workplace === 'REMOTE' ? 'Remote' : null),
    commitment: commitment(j.employment_type),
    workplaceType: workplace,
    description: htmlToText(html) || null,
    salaryMin: j.salary?.salary_from ?? null,
    salaryMax: j.salary?.salary_to ?? null,
    salaryCurrency: currency(j.salary?.salary_currency),
    tags: Array.isArray(j.keywords) ? cleanList(j.keywords) : [],
    confidential: !!j.confidential,
    requisitionExternalId,
    createdAt: toDate(j.created_at),
  };
}

function toRequisition(r: WRequisition): ImportedRequisition {
  const state = (r.state ?? '').toLowerCase();
  const range = r.salary_range && perYear(r.salary_range.frequency) ? r.salary_range : null;
  return {
    externalId: String(r.id),
    code: r.code?.trim() || String(r.id),
    title: r.job?.title?.trim() || r.code?.trim() || 'Requisition',
    state: REQUISITION_STATE[state] ?? 'open',
    openings: 1, // a Workable requisition is one hire
    filled: state === 'filled' ? 1 : 0,
    salaryMin: range?.from ?? null,
    salaryMax: range?.to ?? null,
    salaryCurrency: currency(r.salary_range?.currency, r.salary_range?.currency_iso),
    backfill: r.reason === 'replacement' || r.reason === 'backfill',
  };
}

function toOffer(o: WOffer, c: WCandidate, applicationId: string): ImportedOffer {
  const vars = o.document_variables ?? [];
  const bySlug = (slug: string) => vars.find((v) => v.document_variable?.slug === slug)?.value ?? null;
  const salary = bySlug('salary');
  const money = salary?.data ?? null;
  const amount = typeof money?.amount === 'number' ? money.amount : typeof salary?.body === 'number' ? salary.body : null;
  const yearly = amount != null && perYear(money?.frequency);
  const raw = o.state?.trim() ?? '';

  // Everything the offer form held that Source has no column for stays readable in the notes.
  const used = new Set(['job', 'start_date', ...(yearly ? ['salary'] : [])]);
  const lines = vars
    .filter((v) => !used.has(v.document_variable?.slug ?? ''))
    .map((v) => {
      const label = v.document_variable?.name?.trim() || v.document_variable?.slug || 'Field';
      const text = v.value?.data?.cached_value?.trim() || plain(v.value?.body);
      return text ? `${label}: ${text}` : '';
    })
    .filter(Boolean);
  if (raw) lines.unshift(`Workable offer status: ${raw}`);

  return {
    externalId: `${applicationId}:offer${o.created_at ? `:${o.created_at}` : ''}`,
    applicationExternalId: applicationId,
    status: OFFER_STATUS[raw.toLowerCase()] ?? (c.stage_kind === 'hired' ? 'ACCEPTED' : 'SENT'),
    jobTitle: plain(bySlug('job')?.body) ?? c.job?.title ?? null,
    salaryAmount: yearly ? amount : null,
    salaryCurrency: currency(money?.currency_iso, money?.currency),
    startDate: toDate(plain(bySlug('start_date')?.body)),
    createdAt: toDate(o.created_at),
    notes: lines.join('\n') || null,
  };
}

// ---------- The adapter ----------

type UsersCursor = { recruiters: true };
type StagesCursor = { jobs: Cursor | null };
type JobsCursor = { reqs: boolean; at: Cursor | null; links: Record<string, string> };
/** What candidates don't carry, read from /jobs (and the reasons list) before the first one. */
type CandidatesCursor = {
  sample: string[];
  confidential: string[];
  owners: Record<string, string>;
  reasons: string[];
  scan: Cursor | null;
  ready: boolean;
  at: Cursor | null;
};
type Facts = { sample: Set<string>; confidential: Set<string>; owners: Record<string, string>; reasons: Set<string> };

/** One v3 list. `absent`: first-page errors that mean "this account doesn't have it" (warn, treat as empty). */
type ListSpec = {
  key: string;
  path: string;
  query: Record<string, QueryValue>;
  absent?: { what: string; when: (status: number) => boolean };
};

const JOBS: ListSpec = { key: 'jobs', path: '/jobs', query: { limit: PAGE } };
// status=all: deactivated users wrote much of the history.
const MEMBERS: ListSpec = { key: 'members', path: '/members', query: { limit: PAGE, status: 'all' } };
const REQUISITIONS: ListSpec = {
  key: 'requisitions',
  path: '/requisitions',
  query: { limit: PAGE },
  absent: {
    what: 'Requisitions skipped (they need Workable Hiring Plan and the r_requisitions scope)',
    when: (status) => status >= 400 && status < 500 && status !== 401 && status !== 429,
  },
};
const EVENTS: ListSpec = {
  key: 'events',
  path: '/events',
  query: { limit: PAGE, include_cancelled: true },
  absent: { what: 'Interviews skipped', when: (status) => status === 403 || status === 404 },
};

function create(credentials: Record<string, string>, http: HttpClient) {
  const sub = normalizeSubdomain(credentials.subdomain);
  const hosts = apiHosts(sub);
  const api = (): string => {
    if (!sub) throw new Error(SUBDOMAIN_HELP);
    return `https://${sub}.workable.com/spi/v3`;
  };

  /** Resume a list from its `paging.next`, keeping our filters and never leaving Workable. */
  function nextPage(next: string | null | undefined, path: string, query: Record<string, QueryValue>): string | null {
    if (!next) return null;
    let url: URL;
    try {
      url = new URL(next);
    } catch {
      return null;
    }
    if (url.protocol !== 'https:' || !hosts.includes(url.host)) {
      const since = url.searchParams.get('since_id');
      if (!since) return null;
      url = buildUrl(`${api()}${path}`, { ...query, since_id: since });
    }
    for (const [k, v] of Object.entries(query)) {
      if (v != null && !Array.isArray(v) && !url.searchParams.has(k)) url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  /** GET with one retry on 404: Workable returns the odd transient one (Nango retries them too). */
  async function getJson<T>(url: string): Promise<T> {
    try {
      return await http.json<T>(url);
    } catch (err) {
      if (!(err instanceof ImportHttpError) || err.status !== 404) throw err;
      return http.json<T>(url);
    }
  }

  /** One page of a v3 list. `page` is the previous page's next URL; null is the first page. */
  async function listPage<T>(key: string, path: string, query: Record<string, QueryValue>, page: JsonValue): Promise<Page<T>> {
    const url = typeof page === 'string' ? page : buildUrl(`${api()}${path}`, query).toString();
    const data = await getJson<WListResponse | T[] | null>(url);
    if (Array.isArray(data)) return { items: data, next: null };
    const items = data?.[key];
    return { items: Array.isArray(items) ? (items as T[]) : [], next: nextPage(data?.paging?.next, path, query) };
  }

  /** Plain arrays in the live API; tolerate the `{key: [...]}` wrapper the docs show. */
  async function bareList<T>(url: string, key: string): Promise<T[]> {
    const data = await getJson<T[] | Record<string, T[] | undefined> | null>(url);
    if (Array.isArray(data)) return data;
    return data?.[key] ?? [];
  }

  /**
   * pagedStep over a v3 list. A step that stops mid-page resumes from the next record's id
   * (`since_id` is inclusive) rather than an index into a page that may have lost a record
   * since. `handle` also gets the rest of the page.
   */
  async function walk<T extends { id: string | number }>(
    ctx: PhaseContext,
    cursor: Cursor | null,
    list: ListSpec,
    handle: (item: T, rest: T[]) => Promise<void>,
  ): Promise<Cursor | null> {
    let items: T[] = [];
    const fetchPage = async (page: JsonValue): Promise<Page<T>> => {
      try {
        const p = await listPage<T>(list.key, list.path, list.query, page);
        items = p.items;
        return p;
      } catch (err) {
        const status = (err as { status?: unknown }).status;
        // Only the first page can show the feature is missing; a later failure mustn't truncate the list.
        if (page !== null || !list.absent || typeof status !== 'number' || !list.absent.when(status)) throw err;
        ctx.warn(`${list.absent.what}: ${err instanceof Error ? err.message : String(err)}`);
        return EMPTY_PAGE;
      }
    };
    const next = (await pagedStep<T>(ctx, cursor, fetchPage, (item) =>
      handle(item, items.slice(items.indexOf(item) + 1)),
    )) as PageCursor | null;
    const resume = next && next.index > 0 ? items[next.index] : undefined;
    if (!resume) return next;
    return { page: buildUrl(`${api()}${list.path}`, { ...list.query, since_id: String(resume.id) }).toString(), index: 0 };
  }

  function catalogStages(ctx: PhaseContext, stages: WStage[]) {
    for (const s of stages) {
      const externalId = stageId(s);
      const name = s.name?.trim();
      if (!externalId || !name) continue;
      ctx.catalog.stage({ externalId, name, typeHint: STAGE_KIND[s.kind ?? ''] ?? null, position: s.position ?? null });
    }
  }

  async function timelineOf(ctx: PhaseContext, id: string): Promise<WActivity[] | null> {
    return optional(
      ctx,
      'Candidate timeline unavailable',
      async () => {
        const all: WActivity[] = [];
        let page: JsonValue = null;
        for (let n = 0; n < MAX_TIMELINE_PAGES; n++) {
          const p: Page<WActivity> = await listPage<WActivity>('activities', `/candidates/${enc(id)}/activities`, { limit: PAGE }, page);
          all.push(...p.items);
          if (!p.next || !p.items.length) return all;
          page = p.next;
        }
        ctx.warn('Some candidate timelines were longer than 5,000 events; only the first 5,000 were read', {
          entity: 'candidate',
          externalId: id,
        });
        return all;
      },
      null,
    );
  }

  async function importJob(ctx: PhaseContext, job: WJob, links: Record<string, string>) {
    if (job.sample) return ctx.warn(SAMPLE_JOB, { entity: 'posting', externalId: job.shortcode });
    if (await ctx.load.has('posting', job.shortcode)) return; // an earlier run's: skip the detail call
    // The detail is the only place with employment_type and the descriptions; the list alone still makes a posting.
    const detail = await soft(ctx, 'Job details unavailable', () => http.json<WJob | null>(`${api()}/jobs/${enc(job.shortcode)}`), null);
    await ctx.load.posting(toPosting({ ...job, ...(detail ?? {}) }, links[job.id] ?? null));
  }

  /** Before the first candidate: which jobs are sample data or confidential, and who recruits for each. */
  async function scanJobs(ctx: PhaseContext, c: CandidatesCursor): Promise<CandidatesCursor> {
    const sample = new Set(c.sample);
    const confidential = new Set(c.confidential);
    const owners = { ...c.owners };
    const scan = await walk<WJob>(ctx, c.scan, JOBS, async (job) => {
      if (!job.shortcode) return;
      if (job.sample) {
        sample.add(job.shortcode);
        return;
      }
      if (job.confidential) confidential.add(job.shortcode);
      const team = await optional(
        ctx,
        'Job hiring team unavailable',
        () => bareList<WJobMember>(`${api()}/jobs/${enc(job.shortcode)}/members`, 'members'),
        [],
      );
      const owner =
        team.find((m) => m.collaboration_role === 'recruiting_admin') ?? team.find((m) => m.collaboration_role === 'hiring_manager');
      if (owner) owners[job.shortcode] = String(owner.id);
    });
    return { ...c, sample: [...sample], confidential: [...confidential], owners, scan, ready: scan === null };
  }

  const lateJobs = new Map<string, WJob | null>();

  /**
   * A candidate's job that has no posting yet (created after the jobs phase, or its import
   * failed) is loaded when its first candidate arrives, once per slice.
   */
  async function lateJob(ctx: PhaseContext, shortcode: string): Promise<WJob | null> {
    if (lateJobs.has(shortcode)) return lateJobs.get(shortcode) ?? null;
    let job: WJob | null = null;
    if (!(await ctx.load.has('posting', shortcode))) {
      job = await soft(ctx, 'Job details unavailable', () => http.json<WJob | null>(`${api()}/jobs/${enc(shortcode)}`), null);
      const posting = job?.shortcode && !job.sample ? toPosting(job, null) : null;
      if (posting) await each(ctx, { id: shortcode }, () => ctx.load.posting(posting));
    }
    lateJobs.set(shortcode, job);
    return job;
  }

  /** Why a listed candidate is skipped before any call: a warning, '' to skip quietly, or null to import it. */
  function skipOf(ctx: PhaseContext, c: WCandidate, facts: Facts): string | null {
    if (c.anonymized) return 'Skipped candidates that Workable has anonymized';
    // Sample jobs carry `sample`; their candidates don't.
    if (c.job?.shortcode && facts.sample.has(c.job.shortcode)) return SAMPLE_CANDIDATES;
    if (!ctx.options.archived && statusOf(c) !== 'active') return '';
    const createdAt = toDate(c.created_at);
    return ctx.since && createdAt && createdAt < ctx.since ? '' : null;
  }

  async function importCandidate(ctx: PhaseContext, item: WCandidate, rest: WCandidate[], facts: Facts) {
    const id = String(item.id);
    const skip = skipOf(ctx, item, facts);
    if (skip !== null) {
      if (skip) ctx.warn(skip, { entity: 'candidate', externalId: id });
      return;
    }
    if (await ctx.load.has('opportunity', id)) {
      // Imported by an earlier run or a replayed step, so skip its detail, feed, offer and files.
      // It may have been cut off mid-way, though: only a later imported candidate proves it wasn't.
      const later = rest.find((x) => skipOf(ctx, x, facts) === null);
      if (later && (await ctx.load.has('opportunity', String(later.id)))) return;
    }
    const status = statusOf(item);
    const createdAt = toDate(item.created_at);
    const shortcode = item.job?.shortcode ?? null;
    const late = shortcode ? await lateJob(ctx, shortcode) : null;
    if (late?.sample) return ctx.warn(SAMPLE_CANDIDATES, { entity: 'candidate', externalId: id });

    const detail = await getJson<{ candidate?: WCandidate } | null>(`${api()}/candidates/${enc(id)}`);
    const c: WCandidate = { ...item, ...(detail?.candidate ?? {}) };
    const timeline = await timelineOf(ctx, id);
    const acts = chronological(timeline ?? []);

    const emails = cleanEmails([c.email]);
    const originating = str(c.originating_candidate_id);
    // Records copied to another job are the same person; without an email to merge on, follow the copy link.
    const personId =
      !emails.length && originating && (await ctx.load.has('contact', originating)) ? originating : id;
    const person: ImportedCandidate = {
      externalId: personId,
      name: c.name?.trim() || fullName(c.firstname, c.lastname),
      emails,
      phones: cleanList([c.phone]),
      links: cleanList((c.social_profiles ?? []).map((p) => p.url)),
      headline: c.headline?.trim() || null,
      location: locationText(c.location) ?? (c.address?.trim() || null),
      tags: cleanList(c.tags ?? []),
      createdAt,
    };

    const { history, current } = stageHistory(c, acts);
    const disqualification = [...acts].reverse().find((x) => x.a.action === 'disqualified' || x.a.action === 'disqualification');
    const reasonText = c.disqualification_reason?.trim() || disqualification?.a.body?.trim() || null;
    let archiveReason: ReasonRef | null = null;
    let archivedAt: Date | null = null;
    if (status === 'hired') {
      archiveReason = HIRED;
      archivedAt = toDate(c.hired_at);
    } else if (status === 'archived') {
      // A reason missing from /disqualification_reasons is created on the fly and counted as a
      // rejection, so a free-text withdrawal files under "Withdrew" instead.
      const listed = !!reasonText && facts.reasons.has(nameKey(reasonText));
      archiveReason = c.withdrew && !listed ? WITHDREW : reasonText ? { name: reasonText } : null;
      archivedAt = toDate(c.disqualified_at) ?? disqualification?.at ?? null;
    }

    const fields: Record<string, string> = {};
    for (const qa of c.answers ?? []) {
      const question = htmlToText(qa.question?.body);
      const answer = answerText(qa.answer);
      if (question && answer) fields[clip(question, 200)] = clip(answer, 2000);
    }
    if (c.profile_url) fields['Workable profile URL'] = c.profile_url;
    // Reason text the archive reason doesn't show: a hire disqualified afterwards, or a free-text withdrawal.
    if (c.disqualified && reasonText && archiveReason?.name !== reasonText) {
      fields['Workable disqualification reason'] = clip(reasonText, 2000);
    }

    await ctx.load.application({
      externalId: id,
      candidateExternalId: personId,
      candidate: person,
      postingExternalId: shortcode,
      stage: current ?? (c.stage ? { name: c.stage } : null),
      status,
      archiveReason,
      archivedAt,
      origin: originOf(c, timeline ?? []),
      source: [c.common_source, c.domain].map((s) => s?.trim()).find((s) => s && !/^unknown$/i.test(s)) ?? null,
      // No owner field in Workable: whoever uploaded the candidate, else the job's recruiter.
      ownerExternalUserId: str(c.uploader_id) ?? (shortcode ? (facts.owners[shortcode] ?? null) : null),
      // Confidential Workable jobs are visible only to their hiring team.
      confidential: !!shortcode && (facts.confidential.has(shortcode) || !!late?.confidential),
      createdAt,
      history,
      fields,
    });

    if (ctx.options.activity) {
      for (const { a, at } of acts) await each(ctx, a, () => importActivity(ctx, id, a, at));
      const profile = profileNote(c);
      if (profile) {
        await each(ctx, { id }, () =>
          ctx.load.note({ externalId: `${id}:profile`, applicationExternalId: id, body: profile, createdAt }),
        );
      }
    }

    const offerStage = status === 'hired' || !!c.moved_to_offer_at || c.stage_kind === 'offer';
    if (ctx.options.offers && offerStage) {
      await each(ctx, { id }, async () => {
        const offer = await optional(ctx, 'Offer unavailable', () => http.json<WOffer | null>(`${api()}/candidates/${enc(id)}/offer`), null);
        // No offer → 200 with only the candidate stub.
        if (offer && (offer.created_at || offer.state || offer.document_variables?.length)) {
          await ctx.load.offer(toOffer(offer, c, id));
        }
      });
    }

    if (ctx.options.files) await importFiles(ctx, c, id, personId);
  }

  async function importActivity(ctx: PhaseContext, applicationId: string, a: WActivity, at: Date) {
    if (a.action !== 'comment' && a.action !== 'message' && a.action !== 'rating') return;
    const roles = a.visibility_roles ?? [];
    // Without `simple` (standard members) it was for admins or the hiring team; imported, everyone would see it.
    if (roles.length && !roles.includes('simple')) return ctx.warn(RESTRICTED, { entity: 'note', externalId: String(a.id) });
    const author = { authorExternalUserId: memberId(a.member), authorName: a.member?.name?.trim() || null };
    if (a.action === 'rating') {
      const r = workableRating(a.rating);
      const stage = a.action_stage?.name?.trim() || a.stage_name?.trim();
      await ctx.load.feedback({
        externalId: String(a.id),
        applicationExternalId: applicationId,
        ...author,
        rating: r.value,
        title: stage ? `${stage} evaluation` : 'Evaluation',
        summary: a.body?.trim() ?? '',
        answers: r.label ? [{ label: 'Workable rating', value: r.label }] : [],
        createdAt: at,
      });
      return;
    }
    // Comments are plain text with @mentions; emails are HTML.
    const text = a.action === 'message' ? htmlToText(a.body) : (a.body ?? '').trim();
    if (!text) return;
    const body = a.action === 'message' ? `Email\n${text}` : text;
    await ctx.load.note({ externalId: String(a.id), applicationExternalId: applicationId, ...author, body, createdAt: at });
  }

  async function importFiles(ctx: PhaseContext, c: WCandidate, id: string, personId: string) {
    const file = (externalId: string, url: string, filename: string, kind: 'resume' | 'other') =>
      each(ctx, { id: externalId }, () =>
        ctx.load.file({
          externalId,
          candidateExternalId: personId,
          applicationExternalId: id,
          filename,
          kind,
          // Pre-signed and fresh from this step's detail/list call; never stored.
          download: async () => {
            const got = await http.bytes(url);
            return { data: got.data, contentType: got.contentType, filename: got.filename ?? filename };
          },
        }),
      );

    if (c.resume_url) {
      const meta = c.resume_metadata;
      await file(`${id}:resume`, c.resume_url, meta?.filename?.trim() || `resume.${meta?.filetype || 'pdf'}`, 'resume');
    }
    for (const qa of c.answers ?? []) {
      const url = qa.answer?.file_url;
      if (!url) continue;
      const question = htmlToText(qa.question?.body) || 'Application answer';
      const base = basename(url);
      await file(`${id}:answer:${clip(question, 150)}`, url, /\.\w{2,5}$/.test(base) ? base : clip(question, 100), 'other');
    }
    // The Files tab: timeline and comment attachments, and offer documents (never the resume).
    // Which activities leave attachments isn't documented, so every candidate's tab is read.
    const listed = await optional(
      ctx,
      'Candidate files unavailable',
      () => http.json<{ files?: WFile[] } | null>(`${api()}/candidates/${enc(id)}/files`),
      null,
    );
    const seen = new Map<string, number>();
    for (const f of listed?.files ?? []) {
      if (!f.preview_url) continue;
      const name = clip(f.name?.trim() || 'attachment', 150);
      const key = `${id}:file:${(f.source ?? 'file').toLowerCase()}:${name}`;
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      await file(n > 1 ? `${key}#${n}` : key, f.preview_url, name, 'other');
    }
  }

  const discover: Phase[] = [
    {
      id: 'users',
      label: 'Team members',
      async run(ctx, cursor) {
        const add = (m: WMember) =>
          ctx.catalog.user({ externalId: String(m.id), name: m.name?.trim() || m.email || 'Workable user', email: m.email ?? null });
        if ((cursor as UsersCursor | null)?.recruiters) {
          const recruiters = await optional(ctx, 'External recruiters unavailable', () => bareList<WMember>(`${api()}/recruiters`, 'recruiters'), []);
          recruiters.forEach(add);
          return null;
        }
        const next = await walk<WMember>(ctx, cursor, MEMBERS, async (m) => add(m));
        return next ?? { recruiters: true };
      },
    },
    {
      id: 'stages',
      label: 'Pipeline stages',
      async run(ctx, cursor) {
        if (cursor == null) {
          catalogStages(ctx, await bareList<WStage>(`${api()}/stages`, 'stages'));
          return { jobs: null };
        }
        // Jobs can customize their pipeline; union every job's stages (same ids when shared).
        const next = await walk<WJob>(ctx, (cursor as StagesCursor).jobs, JOBS, async (job) => {
          if (job.sample || !job.shortcode) return;
          const stages = await optional(
            ctx,
            'Job pipeline unavailable',
            () => bareList<WStage>(`${api()}/jobs/${enc(job.shortcode)}/stages`, 'stages'),
            [],
          );
          catalogStages(ctx, stages);
        });
        return next ? { jobs: next } : null;
      },
    },
    {
      id: 'reasons',
      label: 'Disqualification reasons',
      async run(ctx) {
        for (const r of await bareList<WReason>(`${api()}/disqualification_reasons`, 'disqualification_reasons')) {
          const name = r.description?.trim();
          if (name) ctx.catalog.reason({ externalId: String(r.id), name, kind: r.candidate_withdrew ? 'withdrawn' : 'rejection' });
        }
        ctx.catalog.reason({ externalId: HIRED.externalId!, name: HIRED.name!, kind: 'hired' });
        return null;
      },
    },
  ];

  const load: Phase[] = [
    {
      // Requisitions reference their job (not the reverse), so both are read here and the
      // job → requisition link travels in the cursor from the first half to the second.
      id: 'postings',
      label: 'Requisitions and jobs',
      async run(ctx, cursor) {
        const c = (cursor as JobsCursor | null) ?? { reqs: true, at: null, links: {} };
        const links = { ...c.links };
        if (c.reqs) {
          const at = await walk<WRequisition>(ctx, c.at, REQUISITIONS, async (r) => {
            await ctx.load.requisition(toRequisition(r));
            const jobId = str(r.job?.id);
            const dead = ['rejected', 'cancelled', 'canceled'].includes((r.state ?? '').toLowerCase());
            if (jobId && (!links[jobId] || !dead)) links[jobId] = String(r.id);
          });
          return at ? { reqs: true, at, links } : { reqs: false, at: null, links };
        }
        const at = await walk<WJob>(ctx, c.at, JOBS, (job) => importJob(ctx, job, links));
        return at ? { reqs: false, at, links } : null;
      },
    },
    {
      // One Workable candidate = one application. Its detail and timeline are fetched once and
      // yield the contact, application + history, notes, scorecards, offer and files together.
      id: 'candidates',
      label: 'Candidates, applications and activity',
      async run(ctx, cursor) {
        let c = cursor as CandidatesCursor | null;
        if (!c) {
          const reasons = await optional(
            ctx,
            'Disqualification reasons unavailable',
            () => bareList<WReason>(`${api()}/disqualification_reasons`, 'disqualification_reasons'),
            [],
          );
          const listed = cleanList(reasons.map((r) => (r.description?.trim() ? nameKey(r.description) : null)));
          c = { sample: [], confidential: [], owners: {}, reasons: listed, scan: null, ready: false, at: null };
        }
        if (!c.ready) return scanJobs(ctx, c);
        const facts: Facts = {
          sample: new Set(c.sample),
          confidential: new Set(c.confidential),
          owners: c.owners,
          reasons: new Set(c.reasons),
        };
        const since = ctx.since ? Math.floor(ctx.since.getTime() / 1000) : undefined;
        const at = await walk<WCandidate>(
          ctx,
          c.at,
          { key: 'candidates', path: '/candidates', query: { limit: PAGE, created_after: since } },
          (item, rest) => importCandidate(ctx, item, rest, facts),
        );
        return at ? { ...c, at } : null;
      },
    },
    {
      id: 'interviews',
      label: 'Interviews',
      enabled: (o) => o.activity,
      run: (ctx, cursor) =>
        walk<WEvent>(ctx, cursor, EVENTS, async (e) => {
          const applicationId = str(e.candidate?.id);
          const startAt = toDate(e.starts_at);
          if (!applicationId || !startAt) return; // meetings without a candidate
          const endAt = toDate(e.ends_at);
          await ctx.load.interview({
            externalId: String(e.id),
            applicationExternalId: applicationId,
            title: e.title?.trim() || (e.type === 'CallEvent' ? 'Call' : 'Interview'),
            startAt,
            durationMins: endAt ? Math.round((endAt.getTime() - startAt.getTime()) / 60_000) : null,
            location: e.conference?.url ?? null,
            panelistExternalUserIds: cleanList(
              (e.members ?? []).filter((m) => m.status !== 'declined').map((m) => memberId(m)),
            ),
            state: e.cancelled ? 'canceled' : endAt && endAt.getTime() < Date.now() ? 'completed' : 'scheduled',
          });
        }),
    },
  ];

  return {
    async verify() {
      if (!sub) throw new Error(SUBDOMAIN_HELP);
      const data = await http.json<{ accounts?: WAccount[] } | null>(`${ROOT}/accounts`);
      const accounts = data?.accounts ?? [];
      const account = accounts.find((a) => a.subdomain?.toLowerCase() === sub);
      if (!account) {
        const others = cleanList(accounts.map((a) => (a.subdomain ? `${a.subdomain}.workable.com` : null)));
        throw new Error(
          others.length
            ? `This token is for ${others.join(', ')}, not ${sub}.workable.com. Check the subdomain.`
            : `This token can't open ${sub}.workable.com. Check the subdomain and the token.`,
        );
      }
      // Candidates need a separate scope (r_candidates); fail now rather than after the review.
      await http.json(`${api()}/candidates`, { limit: 1 });
      return { accountName: account.name?.trim() || `${sub}.workable.com` };
    },
    discover,
    load,
  };
}

export const workableProvider: ProviderModule = {
  id: 'workable',
  // 10 requests per 10 s per account, shared with the customer's other integrations.
  minIntervalMs: 1100,
  auth(credentials): AuthConfig {
    const token = (credentials.apiToken ?? '').trim().replace(/^bearer\s+/i, '');
    return {
      hosts: apiHosts(normalizeSubdomain(credentials.subdomain)),
      headers: token ? { authorization: `Bearer ${token}` } : {},
    };
  },
  create,
};
