import type { Commitment, OfferStatus, Origin, StageType, WorkplaceType } from '@prisma/client';
import {
  describe as describeRequest,
  ImportAuthError,
  ImportHttpError,
  type AuthConfig,
  type HttpClient,
  type QueryValue,
} from '@/server/imports/http';
import { each, optional, pagedStep, type PageCursor } from '@/server/imports/paging';
import { cleanEmails, cleanList, clip, fullName, htmlToText, toDate } from '@/server/imports/text';
import type {
  CatalogReason,
  CatalogStage,
  Cursor,
  DownloadedFile,
  ImportedApplication,
  ImportedCandidate,
  ImportedFeedback,
  ImportedInterview,
  ImportedOffer,
  ImportedPosting,
  ImportedRequisition,
  ImportOptions,
  Phase,
  PhaseContext,
  ProviderModule,
  ReasonKind,
  StageHistoryEntry,
  StageRef,
} from '@/server/imports/types';

/**
 * Lever (Data API v1, https://api.lever.co/v1).
 *
 * Vendor quirks this adapter handles:
 * - Auth is HTTP Basic with the key as the username and an empty password.
 *   Lever answers an invalid key with 403, not 401, and a key that lacks one
 *   endpoint's permission with 403 too. The HTTP client drops the body that
 *   tells them apart, so verify() re-checks a /users 403 against /postings.
 * - Only api.lever.co is documented. EU accounts start there as well (the EU
 *   host 301s to it); every api.*.lever.co host stays authed across redirects.
 * - The core record is the opportunity (one candidacy, 0–1 application); the
 *   person is its `contact`. There is no contact list endpoint, so candidates
 *   and applications come from one pass over /opportunities with
 *   expand=applications&expand=stage.
 * - Lists use an opaque `offset` token and `hasNext`. Some tokens arrive
 *   already percent-encoded, many doc examples omit `hasNext`, and an empty
 *   page mid-list is not proof of the end. How long a token lives is not
 *   documented, so /opportunities is read in created_at windows (both bounds
 *   inclusive) sized to about two pages: a token Lever stops accepting (400)
 *   costs one window, not the whole list. Candidates are read oldest first,
 *   so a contact is created from its earliest candidacy; files newest first,
 *   so a person's latest resume becomes their resume.
 * - Confidential records are excluded unless every list asks for
 *   confidentiality=all AND the key was created with confidential access.
 *   Without it the request fails, so we retry without and warn.
 * - Deactivated users are hidden unless includeDeactivated=true.
 * - Status: archived=null is active; an archive reason of type "hired" is a
 *   hire; any other reason is archived. The archived shape is
 *   {archivedAt, reason}, with flat archivedAt/archiveReason in some docs.
 *   A hire is not a stage in Lever (hired people stay in Offer), so hires move
 *   to a synthetic "Hired" stage at the time they were archived.
 * - Stage history is stageChanges[] (entered stage, who, when). Built-in
 *   stages use slug ids ("applicant-new", "offer") that /stages may list as
 *   UUIDs, so history refs carry a name to fall back on. Moves into stages
 *   Lever no longer lists are dropped rather than guessed.
 * - Notes, scorecards, profile forms, interviews, offers, resumes and files
 *   exist only per opportunity: 7–8 calls per candidacy. Each group is a phase
 *   that re-lists opportunities without expands, and skips opportunities that
 *   were never imported. A 403 on one of them means the key lacks that
 *   permission, so the phase stops fanning out instead of spending a call per
 *   candidate. A 403 on a download skips that kind of download the same way.
 * - The overall scorecard rating is a "score-system" field ("4 - Strong
 *   Hire"), or in some payloads a "score" field with that string, or one
 *   flagged overall=true. The scale is already 1 strong no … 4 strong yes.
 * - Notes are threads; each comment becomes one note so authorship survives.
 *   Profile forms (Lever's candidate custom fields) and referral forms become
 *   notes. Secret notes are skipped. Records with deletedAt are skipped and
 *   counted, because every doc example sets it on live records too.
 * - Resume/file `downloadUrl`s point at the web app (which redirects to a
 *   login page), so downloads use the documented API paths instead, and an
 *   HTML response is treated as a failed download.
 * - headcountTotal can be "unlimited", which Source can't express; those
 *   requisitions get a large opening count so hires never auto-close them.
 * - The API has no account-name endpoint; verify() names the account after
 *   the most common company email domain among its users.
 */

const API = 'https://api.lever.co/v1';
const PAGE_SIZE = 100;
/** Consecutive empty pages we read through before trusting that a list ended. */
const MAX_EMPTY_PAGES = 3;
/** How often one list (or one created_at window) may restart after Lever rejects a saved offset. */
const MAX_RESTARTS = 2;
const MAX_PAGES = 2_000;

const DAY = 86_400_000;
/** Lever launched in 2012; opportunities created earlier were backdated on import and share one window. */
const LEVER_EPOCH = Date.UTC(2012, 0, 1);
const FIRST_SPAN = 30 * DAY;
const MIN_SPAN = DAY;
const MAX_SPAN = 90 * DAY;
/**
 * Pages a created_at window should hold. Small windows rarely need a saved
 * offset at all, and re-reading one costs a page or two; they add few calls,
 * since a window is about as big as the pages it replaces.
 */
const WINDOW_PAGES = 2;

/** Source has no unlimited headcount, and a hire auto-closes a requisition once filled >= openings. */
const UNLIMITED_OPENINGS = 9_999;
/** Deleted records in a row, with no live one, before we say the deletedAt field looks wrong. */
const DELETED_ALARM = 20;

const CONFIDENTIAL_SKIPPED =
  'This Lever key cannot read confidential records, so confidential jobs and candidates were skipped. ' +
  'Lever only grants that access when a key is created: make a new key with "Allow access to confidential data" turned on to include them.';
const REREAD = (path: string) =>
  `Lever stopped accepting a saved position in ${path}, so that part of the list was read again from its start. Nothing was imported twice.`;

// ---------- Vendor payloads (only the fields we read) ----------

type Ts = number | string | null | undefined;
type Ref = string | { id?: string | null } | null | undefined;
type Query = Record<string, QueryValue>;

type Envelope<T> = { data?: T[] | T | null; next?: string | null; hasNext?: boolean | null };
type ListBody<T> = Envelope<T> | T[] | T | null;

type LeverUser = { id: string; name?: string | null; email?: string | null };

type LeverStage = { id: string; text?: string | null };

type LeverDispositionStage = LeverStage & { pipeline?: string | null; rank?: number | null };

type LeverReason = { id: string; text?: string | null; type?: string | null; status?: string | null };

type LeverDisposition = { stages?: LeverDispositionStage[] | null; archiveReasons?: LeverReason[] | null };

type LeverMoney = { min?: number | null; max?: number | null; currency?: string | null; interval?: string | null };

type LeverPosting = {
  id: string;
  text?: string | null;
  state?: string | null;
  createdAt?: Ts;
  confidentiality?: string | null;
  categories?: {
    team?: string | null;
    department?: string | null;
    location?: string | null;
    allLocations?: string[] | null;
    commitment?: string | null;
  } | null;
  content?: {
    description?: string | null;
    descriptionHtml?: string | null;
    lists?: { text?: string | null; content?: string | null }[] | null;
    closing?: string | null;
    closingHtml?: string | null;
  } | null;
  tags?: string[] | null;
  requisitionCodes?: string[] | null;
  salaryRange?: LeverMoney | null;
  salaryDescription?: string | null;
  salaryDescriptionHtml?: string | null;
  workplaceType?: string | null;
  urls?: { list?: string | null } | null;
};

type LeverRequisition = {
  id: string;
  requisitionCode?: string | null;
  name?: string | null;
  status?: string | null;
  backfill?: boolean | null;
  headcountTotal?: number | string | null;
  headcountHired?: number | string | null;
  compensationBand?: LeverMoney | null;
  postings?: string[] | null;
};

type LeverArchived = { archivedAt?: Ts; reason?: Ref } | null;

type LeverPhone = { type?: string | null; value?: string | null } | null;

type LeverFormField = {
  id?: string | null;
  type?: string | null;
  text?: string | null;
  value?: unknown;
  overall?: boolean | null;
  currency?: string | null;
  options?: { text?: string | null }[] | null;
  scores?: { text?: string | null }[] | null;
};

type LeverApplication = {
  id: string;
  createdAt?: Ts;
  type?: string | null;
  posting?: Ref;
  /** The referrer, on referral applications. */
  user?: Ref;
  name?: string | null;
  email?: string | null;
  phone?: LeverPhone;
  company?: string | null;
  links?: string[] | null;
  comments?: string | null;
  customQuestions?: { fields?: LeverFormField[] | null }[] | null;
  requisitionForHire?: { id?: string | null; requisitionCode?: string | null } | null;
};

type LeverContact = {
  id: string;
  name?: string | null;
  headline?: string | null;
  emails?: string[] | null;
  phones?: LeverPhone[] | null;
  location?: { name?: string | null } | string | null;
};

type LeverConsent = { allowed?: boolean | null; expiresAt?: Ts } | null;

type LeverOpportunity = {
  id: string;
  name?: string | null;
  headline?: string | null;
  contact?: string | LeverContact | null;
  emails?: string[] | null;
  phones?: LeverPhone[] | null;
  confidentiality?: string | null;
  location?: string | null;
  links?: string[] | null;
  createdAt?: Ts;
  lastAdvancedAt?: Ts;
  snoozedUntil?: Ts;
  archived?: LeverArchived;
  archivedAt?: Ts;
  archiveReason?: Ref;
  stage?: string | LeverStage | null;
  stageChanges?: { toStageId?: string | null; userId?: string | null; updatedAt?: Ts }[] | null;
  owner?: Ref;
  sourcedBy?: Ref;
  tags?: string[] | null;
  sources?: string[] | null;
  origin?: string | null;
  applications?: (LeverApplication | string)[] | null;
  isAnonymized?: boolean | null;
  urls?: { show?: string | null } | null;
  dataProtection?: { store?: LeverConsent; contact?: LeverConsent } | null;
};

type LeverNote = {
  id: string;
  fields?: { value?: unknown; createdAt?: Ts; user?: Ref; score?: number | null }[] | null;
  user?: Ref;
  secret?: boolean | null;
  createdAt?: Ts;
  deletedAt?: Ts;
};

type LeverFeedback = {
  id: string;
  text?: string | null;
  fields?: LeverFormField[] | null;
  interview?: Ref;
  user?: Ref;
  createdAt?: Ts;
  completedAt?: Ts;
  deletedAt?: Ts;
};

/** A profile form (/forms) or referral form (/referrals): the same form shape. */
type LeverForm = {
  id: string;
  text?: string | null;
  fields?: LeverFormField[] | null;
  user?: Ref;
  referrer?: Ref;
  createdAt?: Ts;
  completedAt?: Ts;
  deletedAt?: Ts;
};

type LeverInterview = {
  id: string;
  subject?: string | null;
  date?: Ts;
  duration?: number | string | null;
  location?: string | null;
  interviewers?: { id?: string | null }[] | null;
  canceledAt?: Ts;
  conferences?: { entryPoints?: { type?: string | null; uri?: string | null }[] | null }[] | null;
};

type LeverOfferDocument = { fileName?: string | null; uploadedAt?: Ts } | null;

type LeverOffer = {
  id: string;
  status?: string | null;
  createdAt?: Ts;
  sentAt?: Ts;
  approvedAt?: Ts;
  fields?: { text?: string | null; identifier?: string | null; value?: string | number | null }[] | null;
  signatures?: Record<string, { signedAt?: Ts } | null> | null;
  sentDocument?: LeverOfferDocument;
  signedDocument?: LeverOfferDocument;
};

type LeverResume = {
  id: string;
  createdAt?: Ts;
  file?: { name?: string | null; ext?: string | null; uploadedAt?: Ts; status?: string | null } | null;
};

type LeverFile = { id: string; name?: string | null; ext?: string | null; status?: string | null };

/** Page state for top-level lists: the offset token plus how it was requested. */
type LeverPage = { offset: string | null; conf: boolean; restarts: number };

type Direction = 'up' | 'down';

/**
 * Where a crawl of /opportunities is. `from`/`to` bound the created_at window
 * being read (inclusive, null = open). The first request is a `probe` of the
 * whole range, kept only when it fits on one page.
 */
type OppCursor = {
  from: number | null;
  to: number | null;
  probe: boolean;
  /** Width of this window, and the starting point for the next one's. */
  span: number;
  offset: string | null;
  /** Items of the current page already handled. */
  index: number;
  /** Pages of this window finished so far. */
  pages: number;
  conf: boolean;
  restarts: number;
};

type DownloadKind = 'offer' | 'resume' | 'file';

type Rating = 1 | 2 | 3 | 4;

// ---------- Small normalizers ----------

function idOf(ref: Ref | LeverStage | LeverContact): string | null {
  if (ref == null) return null;
  if (typeof ref === 'string') return ref || null;
  return ref.id ? String(ref.id) : null;
}

/** Lever timestamps are ms; null, "" and 0 all mean "absent". */
function when(value: Ts | unknown): Date | null {
  if (value === 0 || value === '0') return null;
  return toDate(value);
}

function day(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function headcount(value: number | string | null | undefined): number | null {
  const n = num(value); // "unlimited" → null
  return n != null && n >= 0 ? Math.round(n) : null;
}

function isUnlimited(value: number | string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === 'unlimited';
}

function withScheme(link: string | null | undefined): string | null {
  const l = (link ?? '').trim();
  if (!l) return null;
  return /^[a-z][a-z0-9+.-]*:/i.test(l) ? l : `https://${l}`;
}

function decodeOffset(token: string): string {
  if (!/%[0-9A-Fa-f]{2}/.test(token)) return token;
  try {
    return decodeURIComponent(token);
  } catch {
    return token;
  }
}

function unwrap<T>(body: ListBody<T>, current: string | null): { items: T[]; next: string | null } {
  if (Array.isArray(body)) return { items: body as T[], next: null };
  if (!body || typeof body !== 'object') return { items: [], next: null };
  const env = body as Envelope<T>;
  // The profile-forms list is documented as one bare form, with no envelope.
  if (!('data' in env) && 'id' in env) return { items: [body as T], next: null };
  const items = Array.isArray(env.data) ? env.data : env.data ? [env.data] : [];
  const token = typeof env.next === 'string' && env.next ? env.next : null;
  const more = env.hasNext ?? token !== null;
  return { items, next: more && token && token !== current ? token : null };
}

function confidentialDenied(err: unknown): boolean {
  return (
    (err instanceof ImportAuthError && err.status === 403) ||
    (err instanceof ImportHttpError && (err.status === 400 || err.status === 403))
  );
}

const BUILTIN_STAGES: Record<string, { name: string; type: StageType }> = {
  'lead-new': { name: 'New lead', type: 'LEAD' },
  'lead-reached-out': { name: 'Reached out', type: 'LEAD' },
  'lead-responded': { name: 'Responded', type: 'LEAD' },
  'applicant-new': { name: 'New applicant', type: 'APPLICANT' },
  offer: { name: 'Offer', type: 'OFFER' },
};

/** Synthetic: Lever records a hire as an archive reason, not a stage. */
const HIRED_STAGE = { externalId: 'lever:hired', name: 'Hired' } satisfies StageRef;

const PIPELINE_TYPES: Record<string, StageType> = {
  lead: 'LEAD',
  applicant: 'APPLICANT',
  screen: 'SCREEN',
  onsite: 'ONSITE',
  offer: 'OFFER',
};

const ORIGINS: Record<string, Origin> = {
  agency: 'AGENCY',
  applied: 'APPLIED',
  internal: 'INTERNAL',
  referred: 'REFERRED',
  sourced: 'SOURCED',
  university: 'UNIVERSITY',
};

const OFFER_STATUSES: Record<string, OfferStatus> = {
  draft: 'DRAFT',
  'approval-sent': 'PENDING_APPROVAL',
  // Approved but not sent: Source has no "approved" state, and a draft is what's left to do.
  approved: 'DRAFT',
  sent: 'SENT',
  'sent-manually': 'SENT',
  opened: 'SENT',
  signed: 'ACCEPTED',
  denied: 'DECLINED',
};

/** Pay intervals (an open list in Lever); anything else is shown as Lever sends it. */
const INTERVALS: Record<string, string> = {
  'per-year-salary': 'per year',
  'per-month-salary': 'per month',
  'semi-month-salary': 'twice a month',
  'bi-week-salary': 'every two weeks',
  'per-week-salary': 'per week',
  'per-day-wage': 'per day',
  'per-hour-wage': 'per hour',
  'one-time': 'one time',
};

const FREE_MAIL = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'hotmail.com',
  'outlook.com',
  'live.com',
  'msn.com',
  'icloud.com',
  'me.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
]);

function accountNameFrom(users: LeverUser[]): string {
  const counts = new Map<string, number>();
  for (const email of cleanEmails(users.map((u) => u.email))) {
    const domain = email.split('@')[1];
    if (domain && !FREE_MAIL.has(domain)) counts.set(domain, (counts.get(domain) ?? 0) + 1);
  }
  const best = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  return best ? best[0] : 'Lever account';
}

/** "https://jobs.lever.co/brickly-labs" → "Brickly Labs": the job-site slug, the only name the API has. */
function accountNameFromSite(postings: LeverPosting[]): string {
  const list = postings.map((p) => p.urls?.list).find(Boolean);
  const slug = list ? /jobs\.(?:eu\.)?lever\.co\/([^/?#]+)/i.exec(list)?.[1] : null;
  const words = (slug ?? '').split(/[-_]+/).filter(Boolean);
  return words.length ? words.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ') : 'Lever account';
}

function reasonKind(reason: LeverReason): ReasonKind {
  if (reason.type === 'hired') return 'hired';
  const name = (reason.text ?? '').toLowerCase();
  if (/withdr[ae]w|declin|accepted (another|other)|went elsewhere|hired elsewhere|not interested|unresponsive|ghost|no.?show|counter.?offer/.test(name))
    return 'withdrawn';
  // No-fault, company-side reasons don't count as rejections in Source's defaults
  // (Timing, Position filled). ReasonKind has no neutral kind, and 'withdrawn' is
  // the only non-hired kind that isn't counted, so they use it.
  if (/timing|duplicate|(position|role|job|req\w*) (filled|closed|cancel)|hiring freeze|on hold|budget/.test(name)) return 'withdrawn';
  return 'rejection';
}

function catalogReason(reason: LeverReason): CatalogReason {
  return { externalId: String(reason.id), name: reason.text?.trim() || String(reason.id), kind: reasonKind(reason) };
}

function catalogStage(stage: LeverDispositionStage, position: number | null): CatalogStage {
  const id = String(stage.id);
  const typeHint = (stage.pipeline && PIPELINE_TYPES[stage.pipeline]) || BUILTIN_STAGES[id]?.type || null;
  return { externalId: id, name: stage.text?.trim() || BUILTIN_STAGES[id]?.name || id, typeHint, position };
}

function commitmentOf(value: string | null | undefined): Commitment | null {
  const s = (value ?? '').toLowerCase();
  if (/intern/.test(s)) return 'INTERNSHIP';
  if (/part/.test(s)) return 'PART_TIME';
  if (/contract|temp|freelance|consult|fixed.?term/.test(s)) return 'CONTRACT';
  if (/full|permanent|regular/.test(s)) return 'FULL_TIME';
  return null;
}

function workplaceOf(value: string | null | undefined): WorkplaceType | null {
  const s = (value ?? '').toLowerCase().replace(/[^a-z]/g, '');
  if (s === 'onsite') return 'ONSITE';
  if (s === 'remote') return 'REMOTE';
  if (s === 'hybrid') return 'HYBRID';
  return null;
}

function isAnnual(interval: string | null | undefined): boolean {
  return !interval || interval === 'per-year-salary';
}

/** Salary only when it's annual (or unstated): Source's salary fields are yearly. */
function annualSalary(band: LeverMoney | null | undefined) {
  if (!band || !isAnnual(band.interval)) return {};
  return { salaryMin: num(band.min), salaryMax: num(band.max), salaryCurrency: band.currency?.trim() || null };
}

/** "Pay: 22–28 USD per hour", for pay Source's yearly salary fields can't hold. */
function payLine(min: unknown, max: unknown, currency: string | null | undefined, interval: string | null | undefined): string | null {
  const amounts = cleanList([num(min), num(max)].map((n) => (n == null ? null : String(n))));
  if (!amounts.length) return null;
  const every = interval ? (INTERVALS[interval] ?? interval) : null;
  return `Pay: ${[amounts.join('–'), currency?.trim(), every].filter(Boolean).join(' ')}`;
}

function thumbs(score: number): string {
  return ['N/A', '1 - Strong no', '2 - No', '3 - Yes', '4 - Strong yes'][score] ?? String(score);
}

function asRating(n: number): Rating | null {
  return n === 1 || n === 2 || n === 3 || n === 4 ? n : null;
}

/** The form's overall recommendation, in the order Lever's payloads disagree about it. */
function overallField(fields: LeverFormField[]): LeverFormField | undefined {
  return (
    fields.find((f) => f.type === 'score-system') ??
    fields.find((f) => f.overall === true) ??
    fields.find((f) => f.type === 'score' && typeof f.value === 'string' && /^\s*[1-4]\s*-/.test(f.value))
  );
}

function parseRating(field: LeverFormField): Rating | null {
  const v = field.value;
  if (v == null || v === '') return null;
  if (typeof v === 'number') return asRating(v);
  const text = String(v);
  const digit = /^\s*([1-4])\b/.exec(text);
  if (digit) return asRating(Number(digit[1]));
  const t = text.toLowerCase();
  if (/strong\s*(no|not)/.test(t)) return 1;
  if (/strong\s*(hire|yes)/.test(t)) return 4;
  if (/\bno\b|no hire/.test(t)) return 2;
  if (/hire|yes/.test(t)) return 3;
  // Custom labels: default option lists run best → worst.
  const options = field.options ?? [];
  const i = options.findIndex((o) => o.text === text);
  return i >= 0 && options.length === 4 ? asRating(4 - i) : null;
}

function scalar(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value && typeof value === 'object' && 'name' in value) return scalar((value as { name?: unknown }).name);
  return '';
}

function formatAnswer(field: LeverFormField): string {
  const v = field.value;
  if (v == null || v === '') return '';
  switch (field.type) {
    case 'score':
      return typeof v === 'number' ? thumbs(v) : scalar(v);
    case 'scorecard': {
      if (!Array.isArray(v)) return '';
      const labels = field.scores ?? [];
      return v
        .map((entry: unknown, i) => {
          if (!entry || typeof entry !== 'object') return '';
          const { score, comment } = entry as { score?: unknown; comment?: unknown };
          const n = num(score);
          if (n == null && !scalar(comment)) return '';
          const label = labels[i]?.text?.trim() || `Skill ${i + 1}`;
          return [`${label}: ${n != null ? thumbs(n) : '—'}`, scalar(comment)].filter(Boolean).join(', ');
        })
        .filter(Boolean)
        .join('; ');
    }
    case 'yes-no':
      return v === 'yes' ? 'Yes' : v === 'no' ? 'No' : scalar(v);
    case 'date': {
      const d = when(v);
      return d ? day(d) : '';
    }
    case 'currency':
      return [scalar(v), field.currency].filter(Boolean).join(' ');
  }
  if (Array.isArray(v)) return v.map(scalar).filter(Boolean).join(', ');
  return scalar(v);
}

/** A form as note text: its title, then one "Question: answer" line per answered field. */
function formBody(title: string | null | undefined, fields: LeverFormField[] | null | undefined): string {
  const lines = (fields ?? [])
    .filter((f) => f.type !== 'file-upload')
    .map((f) => {
      const value = formatAnswer(f);
      return value ? `${f.text?.trim() || 'Question'}: ${value}` : '';
    })
    .filter(Boolean);
  return lines.length ? [title?.trim(), ...lines].filter(Boolean).join('\n') : '';
}

function fileName(name: string | null | undefined, ext: string | null | undefined, fallback: string): string {
  const base = name?.trim() || fallback;
  const e = (ext ?? '').trim().replace(/^\./, '');
  return e && !base.toLowerCase().endsWith(`.${e.toLowerCase()}`) ? `${base}.${e}` : base;
}

function firstApplication(opp: LeverOpportunity): LeverApplication | null {
  const app = (opp.applications ?? [])[0];
  return app && typeof app === 'object' ? app : null;
}

function archivedOf(opp: LeverOpportunity): { at: Date | null; reason: string | null } | null {
  const a = opp.archived ?? { archivedAt: opp.archivedAt, reason: opp.archiveReason };
  const at = when(a.archivedAt);
  const reason = idOf(a.reason);
  return at || reason ? { at, reason } : null;
}

function contactOf(opp: LeverOpportunity): LeverContact | null {
  return opp.contact && typeof opp.contact === 'object' ? opp.contact : null;
}

function contactIdOf(opp: LeverOpportunity): string {
  return idOf(opp.contact) ?? opp.id;
}

function consent(c: LeverConsent | undefined): string | null {
  if (!c || c.allowed == null) return null;
  if (!c.allowed) return 'No';
  const until = when(c.expiresAt);
  return until ? `Yes, until ${day(until)}` : 'Yes';
}

/** Lever's GDPR flag says this candidate's data may not be kept (declined, or the consent ran out). */
function storageNotAllowed(opp: LeverOpportunity, now: number): boolean {
  const store = opp.dataProtection?.store;
  if (!store) return false;
  const expires = when(store.expiresAt);
  return store.allowed === false || (!!expires && expires.getTime() < now);
}

// ---------- created_at windows over /opportunities ----------

/** Every window after the probe lies in [lo, LEVER_EPOCH - 1] (the backdated tail) or [mainStart, ∞). */
function mainStart(lo: number | null): number {
  return Math.max(lo ?? LEVER_EPOCH, LEVER_EPOCH);
}

function hasTail(lo: number | null): boolean {
  return lo === null || lo < LEVER_EPOCH;
}

function freshWindow(w: OppCursor, from: number | null, to: number | null, span: number): OppCursor {
  return { ...w, from, to, probe: false, span, offset: null, index: 0, pages: 0, restarts: 0 };
}

/** Oldest-first window from `from`; the one that reaches today stays open, so nothing created mid-import is missed. */
function upWindow(w: OppCursor, from: number, span: number, now: number): OppCursor {
  const to = from + span - 1;
  return freshWindow(w, from, to >= now ? null : to, span);
}

function firstWindow(w: OppCursor, lo: number | null, dir: Direction, now: number): OppCursor {
  const start = mainStart(lo);
  if (dir === 'up') return hasTail(lo) ? freshWindow(w, lo, LEVER_EPOCH - 1, w.span) : upWindow(w, start, w.span, now);
  return freshWindow(w, Math.max(start, now - w.span + 1), null, w.span);
}

/** The window after `w` (whose `pages` counts every page it had), or null when the range is covered. */
function nextWindow(w: OppCursor, lo: number | null, dir: Direction, now: number): OppCursor | null {
  if (w.probe) return null;
  // Sparse windows double; dense ones resize toward WINDOW_PAGES.
  const span = Math.min(
    MAX_SPAN,
    w.pages <= 1 ? w.span * 2 : Math.max(MIN_SPAN, Math.round((w.span * WINDOW_PAGES) / w.pages)),
  );
  const start = mainStart(lo);
  const isTail = w.to !== null && w.to < start;
  if (dir === 'up') {
    if (isTail) return upWindow(w, start, span, now);
    return w.to === null ? null : upWindow(w, w.to + 1, span, now);
  }
  if (isTail) return null;
  if (w.from !== null && w.from > start) return freshWindow(w, Math.max(start, w.from - span), w.from - 1, span);
  return hasTail(lo) ? freshWindow(w, lo, LEVER_EPOCH - 1, span) : null;
}

function byCreated(items: LeverOpportunity[], dir: Direction): LeverOpportunity[] {
  const t = (o: LeverOpportunity) => when(o.createdAt)?.getTime() ?? 0;
  return [...items].sort((a, b) => (dir === 'up' ? t(a) - t(b) : t(b) - t(a)) || String(a.id).localeCompare(String(b.id)));
}

// ---------- Record mapping ----------

function toCandidate(opp: LeverOpportunity): ImportedCandidate {
  const contact = contactOf(opp);
  const app = firstApplication(opp);
  const emails = cleanEmails([...(opp.emails ?? []), ...(contact?.emails ?? []), app?.email]);
  const name = [opp.name, contact?.name, app?.name].map((n) => n?.trim()).find(Boolean) ?? emails[0]?.split('@')[0];
  const location = contact?.location;
  return {
    externalId: contactIdOf(opp),
    name: fullName(name, null, 'Unnamed candidate'),
    emails,
    phones: cleanList([...(opp.phones ?? []), ...(contact?.phones ?? []), app?.phone].map((p) => p?.value)),
    links: cleanList([...(opp.links ?? []), ...(app?.links ?? [])].map(withScheme)),
    headline: opp.headline?.trim() || contact?.headline?.trim() || null,
    location: opp.location?.trim() || (typeof location === 'string' ? location : location?.name)?.trim() || null,
    tags: cleanList(opp.tags ?? []),
    createdAt: when(opp.createdAt),
  };
}

type ApplicationContext = {
  reasons: Map<string, LeverReason>;
  /** User id → name, for referrer and sourcer. */
  names: Map<string, string>;
  /** Stage ids a history entry may point at: cataloged, built in, or current. */
  knownStages: Set<string>;
};

function toApplication(opp: LeverOpportunity, candidate: ImportedCandidate, x: ApplicationContext): ImportedApplication {
  const app = firstApplication(opp);
  const archived = archivedOf(opp);
  const reason = archived?.reason ? x.reasons.get(archived.reason) : undefined;
  const status: ImportedApplication['status'] = !archived
    ? 'active'
    : reason
      ? reason.type === 'hired'
        ? 'hired'
        : 'archived'
      : app?.requisitionForHire // reason list unreadable: a hire against a requisition is still a hire
        ? 'hired'
        : 'archived';

  const stageId = idOf(opp.stage);
  const stageName = opp.stage && typeof opp.stage === 'object' ? opp.stage.text?.trim() || null : null;
  const stageRef = (id: string): StageRef => ({
    externalId: id,
    name: id === stageId && stageName ? stageName : (BUILTIN_STAGES[id]?.name ?? null),
  });
  const stage = stageId ? stageRef(stageId) : null;
  const createdAt = when(app?.createdAt) ?? when(opp.createdAt);

  // A move into a stage Lever no longer lists has no name to map by; the loader
  // would file it under the first stage, inventing a step backwards.
  const history: StageHistoryEntry[] = (opp.stageChanges ?? [])
    .map((c) => ({ id: c.toStageId, at: when(c.updatedAt), by: c.userId }))
    .filter((c): c is { id: string; at: Date; by: string | null | undefined } => !!c.id && !!c.at && x.knownStages.has(c.id))
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .map((c) => ({ stage: stageRef(c.id), at: c.at, actorExternalUserId: c.by ?? null }));
  const last = history[history.length - 1];
  if (stage && last?.stage.externalId !== stageId) {
    const entered = when(opp.lastAdvancedAt) ?? last?.at ?? createdAt;
    if (entered) history.push({ stage, at: last && entered < last.at ? last.at : entered, actorExternalUserId: null });
  }
  if (status === 'hired') {
    // Hired people stay in Offer in Lever; Source hires into a HIRED stage, and that move is the hire date.
    const prior = history[history.length - 1];
    const hiredAt = archived?.at ?? prior?.at ?? createdAt;
    if (hiredAt) history.push({ stage: HIRED_STAGE, at: prior && hiredAt < prior.at ? prior.at : hiredAt, actorExternalUserId: null });
  }

  const sources = cleanList(opp.sources ?? []);
  const tags = cleanList(opp.tags ?? []);
  const referrer = app?.type === 'referral' ? idOf(app.user) : null;
  const sourcer = idOf(opp.sourcedBy);
  const snoozed = when(opp.snoozedUntil);
  const fields: Record<string, string> = {};
  if (sources.length > 1) fields['Lever sources'] = sources.join(', ');
  // Tags are per candidacy in Lever; the contact only gets the first one's.
  if (tags.length) fields['Lever tags'] = tags.join(', ');
  if (referrer && x.names.get(referrer)) fields['Referred by'] = x.names.get(referrer)!;
  if (sourcer && x.names.get(sourcer)) fields['Sourced by'] = x.names.get(sourcer)!;
  if (snoozed) fields['Snoozed until'] = day(snoozed);
  const store = consent(opp.dataProtection?.store);
  const contactable = consent(opp.dataProtection?.contact);
  if (store) fields['Consent to store data'] = store;
  if (contactable) fields['Consent to contact'] = contactable;
  if (app?.company?.trim()) fields['Current company'] = app.company.trim();
  if (app?.comments?.trim()) fields['Cover letter'] = clip(app.comments.trim(), 4000);
  if (app?.requisitionForHire?.requisitionCode) fields['Hired against requisition'] = app.requisitionForHire.requisitionCode;
  for (const form of app?.customQuestions ?? [])
    for (const f of form.fields ?? []) {
      const value = formatAnswer(f);
      if (value && f.text?.trim() && f.type !== 'file-upload') fields[clip(f.text.trim(), 200)] = clip(value, 2000);
    }
  if (opp.urls?.show) fields['Lever profile'] = opp.urls.show;

  return {
    externalId: opp.id,
    candidateExternalId: candidate.externalId,
    candidate,
    postingExternalId: idOf(app?.posting),
    stage: status === 'hired' ? HIRED_STAGE : stage,
    status,
    archiveReason: archived?.reason ? { externalId: archived.reason, name: reason?.text ?? null } : null,
    archivedAt: archived?.at ?? null,
    origin: ORIGINS[(opp.origin ?? '').toLowerCase()] ?? (app?.type === 'referral' ? 'REFERRED' : null),
    source: sources[0] ?? null,
    ownerExternalUserId: idOf(opp.owner),
    confidential: opp.confidentiality === 'confidential',
    createdAt,
    history,
    fields,
  };
}

function toPosting(p: LeverPosting, requisitionId: string | null): ImportedPosting {
  const c = p.content ?? {};
  const band = p.salaryRange;
  const description = [
    htmlToText(c.descriptionHtml) || (c.description ?? '').replace(/\\n/g, '\n').trim(),
    ...(c.lists ?? []).map((l) => [l.text?.trim(), htmlToText(`<ul>${l.content ?? ''}</ul>`)].filter(Boolean).join('\n')),
    htmlToText(c.closingHtml) || c.closing?.trim(),
    htmlToText(p.salaryDescriptionHtml) || p.salaryDescription?.trim(),
    // Hourly or monthly pay has no place in Source's yearly salary fields; keep it readable.
    band && !isAnnual(band.interval) ? payLine(band.min, band.max, band.currency, band.interval) : null,
  ]
    .filter(Boolean)
    .join('\n\n');
  const state = (p.state ?? '').toLowerCase();
  const categories = p.categories ?? {};
  return {
    externalId: p.id,
    title: p.text?.trim() || 'Untitled Lever job',
    state: state === 'published' ? 'open' : state === 'internal' ? 'internal' : state === 'closed' ? 'closed' : 'draft',
    department: categories.department?.trim() || null,
    location: cleanList([categories.location, ...(categories.allLocations ?? [])]).join(' · ') || null,
    commitment: commitmentOf(categories.commitment),
    workplaceType: workplaceOf(p.workplaceType),
    description: description || null,
    ...annualSalary(band),
    // Source has no teams; the team is kept as a tag.
    tags: cleanList([...(p.tags ?? []), categories.team]),
    confidential: p.confidentiality === 'confidential',
    requisitionExternalId: requisitionId,
    createdAt: when(p.createdAt),
  };
}

function toRequisition(r: LeverRequisition): ImportedRequisition {
  const code = r.requisitionCode?.trim() || String(r.id);
  const filled = headcount(r.headcountHired);
  return {
    externalId: String(r.id),
    code,
    title: r.name?.trim() || code,
    state: r.status === 'open' ? 'open' : r.status === 'closed' ? 'closed' : 'on_hold', // onHold, draft
    openings: isUnlimited(r.headcountTotal) ? Math.max(UNLIMITED_OPENINGS, (filled ?? 0) + 1) : headcount(r.headcountTotal),
    filled,
    ...annualSalary(r.compensationBand),
    backfill: !!r.backfill,
  };
}

function toInterview(i: LeverInterview, opportunityId: string, now: number): ImportedInterview | null {
  const startAt = when(i.date);
  if (!startAt) return null;
  const duration = num(i.duration);
  const video = (i.conferences ?? [])
    .flatMap((c) => c?.entryPoints ?? [])
    .find((e) => e?.type === 'video' && e.uri)?.uri;
  const endsAt = startAt.getTime() + (duration && duration > 0 ? duration : 60) * 60_000;
  return {
    externalId: String(i.id),
    applicationExternalId: opportunityId,
    title: i.subject?.trim() || 'Interview',
    startAt,
    durationMins: duration && duration > 0 ? duration : null,
    location: cleanList([i.location, video]).join(' · ') || null,
    panelistExternalUserIds: cleanList((i.interviewers ?? []).map((p) => p?.id)),
    state: when(i.canceledAt) ? 'canceled' : endsAt < now ? 'completed' : 'scheduled',
  };
}

function toFeedback(form: LeverFeedback, opportunityId: string, names: Map<string, string>): ImportedFeedback {
  const fields = form.fields ?? [];
  const overall = overallField(fields);
  const summary = fields.find(
    (f) => f !== overall && (f.type === 'textarea' || f.type === 'text') && /note|comment|summary|feedback|thought/i.test(f.text ?? ''),
  );
  const author = idOf(form.user);
  return {
    externalId: String(form.id),
    applicationExternalId: opportunityId,
    interviewExternalId: idOf(form.interview),
    authorExternalUserId: author,
    authorName: author ? (names.get(author) ?? null) : null,
    rating: overall ? parseRating(overall) : null,
    title: form.text?.trim() || null,
    summary: summary ? formatAnswer(summary) : '',
    answers: fields
      .filter((f) => f !== overall && f !== summary)
      .map((f) => ({ label: f.text?.trim() || 'Question', value: formatAnswer(f) }))
      .filter((a) => a.value),
    createdAt: when(form.completedAt) ?? when(form.createdAt),
  };
}

/** `declinedAt`: when the candidacy was archived as a declined offer. Lever records no decline time otherwise. */
function toOffer(o: LeverOffer, opportunityId: string, declinedAt: Date | null): ImportedOffer {
  const fields = o.fields ?? [];
  const field = (id: string) => fields.find((f) => f.identifier === id)?.value ?? null;
  const status = OFFER_STATUSES[(o.status ?? '').toLowerCase()] ?? 'DRAFT';
  const equity = fields.find((f) => /equity/i.test(`${f.identifier ?? ''} ${f.text ?? ''}`));
  const currency = scalar(field('compensation_currency')) || null;
  const interval = scalar(field('salary_interval')) || null;
  // Stored as Lever returns it; the docs don't say whether it's major or minor units.
  const amount = num(field('salary_amount'));
  const annual = isAnnual(interval);
  const pay = annual ? null : payLine(amount, null, currency, interval);
  const extras = fields
    .filter((f) => f !== equity && ((annual && f.identifier === 'salary_interval') || f.identifier?.startsWith('custom_')))
    .map((f) => `${f.text?.trim() || f.identifier}: ${scalar(f.value)}`)
    .filter((line) => !line.endsWith(': '));
  const notes = [pay, ...extras].filter(Boolean);
  const sentAt =
    when(o.sentAt) ??
    (['SENT', 'ACCEPTED', 'DECLINED'].includes(status) ? when(o.sentDocument?.uploadedAt) : null);
  return {
    externalId: String(o.id),
    applicationExternalId: opportunityId,
    status,
    jobTitle: scalar(field('job_title')) || null,
    // Source shows an offer's salary as yearly.
    salaryAmount: annual ? amount : null,
    salaryCurrency: currency,
    equity: equity ? scalar(equity.value) || null : null,
    startDate: when(field('anticipated_start_date')),
    sentAt,
    respondedAt: status === 'ACCEPTED' ? when(o.signatures?.candidate?.signedAt) : status === 'DECLINED' ? declinedAt : null,
    createdAt: when(o.createdAt),
    notes: notes.length ? notes.join('\n') : null,
  };
}

function noteBody(comment: { value?: unknown; score?: number | null }): string {
  const text = scalar(comment.value);
  const score = comment.score != null ? asRating(comment.score) : null;
  return [text, score ? `Rating: ${thumbs(score)}` : ''].filter(Boolean).join('\n\n');
}

// ---------- The module ----------

export const leverProvider: ProviderModule = {
  id: 'lever',
  // Every phase hands the loader the full record, imported before or not.
  updatesOnReimport: true,
  // Lever allows 10 req/s steady per key (burst 20) and still throttles below that at times.
  minIntervalMs: 125,

  auth(credentials): AuthConfig {
    const key = (credentials.apiKey ?? '').trim();
    return {
      hosts: ['api.lever.co', 'api.eu.lever.co', 'api.sandbox.lever.co'],
      headers: key ? { authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` } : {},
    };
  },

  create(_credentials, http: HttpClient) {
    // Per-adapter (per-slice) memory. Everything here can be re-derived.
    let confidential: boolean | null = null;
    let warnedConfidential = false;
    const denied = new Set<string>();
    const deniedDownloads = new Set<DownloadKind>();
    const deletedSeen = new Map<string, { deleted: number; live: number }>();
    let dispositionMemo: LeverDisposition | null | undefined;
    let reasonsMemo: Map<string, LeverReason> | undefined;
    let namesMemo: Map<string, string> | undefined;
    let requisitionsMemo: { byPosting: Map<string, string>; byCode: Map<string, string> } | undefined;

    async function fetchList<T>(
      ctx: PhaseContext | null,
      path: string,
      query: Query,
      offset: string | null,
    ): Promise<{ items: T[]; next: string | null }> {
      let at = offset;
      for (let empty = 1; ; empty++) {
        const body = await http.json<ListBody<T>>(`${API}${path}`, {
          ...query,
          limit: PAGE_SIZE,
          offset: at === null ? undefined : decodeOffset(at),
        });
        const page = unwrap(body, at);
        if (page.items.length || !page.next) return page;
        if (empty >= MAX_EMPTY_PAGES) {
          ctx?.warn(`Lever returned ${MAX_EMPTY_PAGES} empty pages in a row for ${path}; stopped reading that list there`);
          return page;
        }
        at = page.next;
      }
    }

    /** One page of a top-level list, asking for confidential records when the list supports it. */
    async function listPage<T>(
      ctx: PhaseContext | null,
      path: string,
      query: Query,
      at: LeverPage | null,
      withConfidential: boolean,
    ): Promise<{ items: T[]; next: LeverPage | null; conf: boolean }> {
      const offset = at?.offset ?? null;
      let conf = withConfidential && (at ? at.conf : confidential !== false);
      let page: { items: T[]; next: string | null };
      try {
        page = await fetchList<T>(ctx, path, conf ? { ...query, confidentiality: 'all' } : query, offset);
      } catch (err) {
        if (!conf || offset !== null || !confidentialDenied(err)) throw err;
        // Only conclude "no confidential access" if the plain request works.
        page = await fetchList<T>(ctx, path, query, null);
        conf = false;
        confidential = false;
        if (!warnedConfidential && ctx) {
          warnedConfidential = true;
          ctx.warn(CONFIDENTIAL_SKIPPED);
        }
      }
      return { items: page.items, next: page.next ? { offset: page.next, conf, restarts: at?.restarts ?? 0 } : null, conf };
    }

    async function readAll<T>(ctx: PhaseContext | null, path: string, query: Query = {}, withConfidential = false) {
      const out: T[] = [];
      let at: LeverPage | null = null;
      for (let i = 0; i < MAX_PAGES; i++) {
        const page: { items: T[]; next: LeverPage | null } = await listPage<T>(ctx, path, query, at, withConfidential);
        out.push(...page.items);
        if (!page.next) break;
        at = page.next;
      }
      return out;
    }

    /** pagedStep over a small top-level list, restarting it if Lever stops accepting a saved offset. */
    async function listRun<T>(
      ctx: PhaseContext,
      cursor: Cursor | null,
      path: string,
      query: Query,
      withConfidential: boolean,
      handle: (item: T) => Promise<void>,
    ): Promise<Cursor | null> {
      try {
        return await pagedStep<T>(
          ctx,
          cursor,
          (page) => listPage<T>(ctx, path, query, page as LeverPage | null, withConfidential),
          handle,
        );
      } catch (err) {
        const at = ((cursor as PageCursor | null)?.page ?? null) as LeverPage | null;
        if (at?.offset && err instanceof ImportHttpError && err.status === 400 && (at.restarts ?? 0) < MAX_RESTARTS) {
          ctx.warn(REREAD(path));
          const restart: LeverPage = { offset: null, conf: at.conf, restarts: (at.restarts ?? 0) + 1 };
          return { page: restart, index: 0 };
        }
        throw err;
      }
    }

    async function oppPage(ctx: PhaseContext, query: Query, w: OppCursor) {
      const bounded = { ...query, created_at_start: w.from ?? undefined, created_at_end: w.to ?? undefined };
      const res = await listPage<LeverOpportunity>(ctx, '/opportunities', bounded, { offset: w.offset, conf: w.conf, restarts: 0 }, true);
      return { items: res.items, next: res.next?.offset ?? null, conf: res.conf };
    }

    /**
     * One step (about a page) over /opportunities in created_at windows. The
     * first request probes the whole range: an account that fits on one page
     * costs one call. Otherwise the range is walked in windows, oldest first
     * ('up') or newest first ('down'), and a rejected offset re-reads only the
     * current window.
     */
    async function oppRun(
      ctx: PhaseContext,
      cursor: Cursor | null,
      query: Query,
      dir: Direction,
      handle: (opp: LeverOpportunity) => Promise<void>,
    ): Promise<Cursor | null> {
      const lo = ctx.since ? ctx.since.getTime() : null;
      const now = Date.now();
      const saved = cursor as OppCursor | null;
      // A cursor from before windowing (a job mid-flight across a deploy) restarts the list; refs keep that idempotent.
      let w: OppCursor = saved && typeof saved.span === 'number' ? saved : {
        from: lo,
        to: null,
        probe: true,
        span: FIRST_SPAN,
        offset: null,
        index: 0,
        pages: 0,
        conf: confidential !== false,
        restarts: 0,
      };
      let page: { items: LeverOpportunity[]; next: string | null; conf: boolean };
      try {
        page = await oppPage(ctx, query, w);
      } catch (err) {
        if (w.offset !== null && err instanceof ImportHttpError && err.status === 400 && w.restarts < MAX_RESTARTS) {
          ctx.warn(REREAD('/opportunities'));
          return { ...w, offset: null, index: 0, pages: 0, restarts: w.restarts + 1 };
        }
        throw err;
      }
      w = { ...w, conf: page.conf };
      if (w.probe && page.next) {
        w = firstWindow(w, lo, dir, now);
        page = await oppPage(ctx, query, w);
        w = { ...w, conf: page.conf };
      }
      const items = byCreated(page.items, dir);
      for (let i = w.index; i < items.length; i++) {
        // Always make progress: at least one item per step even if already late.
        if (i > w.index && ctx.outOfTime()) return { ...w, index: i };
        await each(ctx, items[i], handle);
      }
      if (page.next && items.length) return { ...w, offset: page.next, index: 0, pages: w.pages + 1 };
      return nextWindow({ ...w, pages: w.pages + 1 }, lo, dir, now);
    }

    async function disposition(ctx: PhaseContext): Promise<LeverDisposition | null> {
      if (dispositionMemo === undefined) {
        const body = await optional(
          ctx,
          'Stage order (disposition stages)',
          () => http.json<{ data?: LeverDisposition | null }>(`${API}/disposition_stages`),
          null,
        );
        dispositionMemo = body?.data ?? null;
      }
      return dispositionMemo;
    }

    async function reasonIndex(ctx: PhaseContext): Promise<Map<string, LeverReason>> {
      if (!reasonsMemo) {
        const listed = await optional(ctx, 'Archive reasons', () => readAll<LeverReason>(ctx, '/archive_reasons'), null);
        const list = listed ?? (await disposition(ctx))?.archiveReasons ?? [];
        reasonsMemo = new Map(list.map((r) => [String(r.id), r]));
      }
      return reasonsMemo;
    }

    /** User id → name, for "[Lever · Name]" bylines when the author isn't a Source teammate. */
    async function userNames(ctx: PhaseContext): Promise<Map<string, string>> {
      if (!namesMemo) {
        const users = await optional(
          ctx,
          'Team members',
          () => readAll<LeverUser>(ctx, '/users', { includeDeactivated: true }),
          [],
        );
        namesMemo = new Map(users.filter((u) => u.name?.trim()).map((u) => [String(u.id), u.name!.trim()]));
      }
      return namesMemo;
    }

    async function requisitionFor(ctx: PhaseContext, p: LeverPosting): Promise<string | null> {
      const codes = cleanList(p.requisitionCodes ?? []);
      if (!codes.length) return null;
      if (!requisitionsMemo) {
        const list = await optional(ctx, 'Requisitions', () => readAll<LeverRequisition>(ctx, '/requisitions', {}, true), []);
        requisitionsMemo = { byPosting: new Map(), byCode: new Map() };
        for (const r of list) {
          for (const postingId of r.postings ?? []) requisitionsMemo.byPosting.set(postingId, String(r.id));
          if (r.requisitionCode) requisitionsMemo.byCode.set(r.requisitionCode, String(r.id));
        }
      }
      return requisitionsMemo.byPosting.get(p.id) ?? codes.map((c) => requisitionsMemo!.byCode.get(c)).find(Boolean) ?? null;
    }

    /** History entries may only point at stages the review mapped (or built-ins, or the current stage). */
    async function knownStages(ctx: PhaseContext, opp: LeverOpportunity): Promise<Set<string>> {
      const known = new Set<string>();
      const current = idOf(opp.stage);
      for (const c of opp.stageChanges ?? []) {
        const id = c.toStageId;
        if (!id || known.has(id)) continue;
        if (id === current || BUILTIN_STAGES[id] || (await ctx.load.has('stage', id))) known.add(id);
      }
      return known;
    }

    /**
     * A per-opportunity sub-resource. A 403 means the key lacks that permission: stop asking.
     * A 404 means that one opportunity's list is gone (deleted mid-import): nothing to read.
     */
    async function child<T>(ctx: PhaseContext, opp: LeverOpportunity, sub: string, label: string): Promise<T[]> {
      if (denied.has(sub)) return [];
      try {
        return await readAll<T>(ctx, `/opportunities/${encodeURIComponent(opp.id)}/${sub}`);
      } catch (err) {
        if (err instanceof ImportHttpError && err.status === 404) {
          ctx.warn(`${label}: Lever could not find them for some candidates (HTTP 404), so those were skipped`);
          return [];
        }
        if (!(err instanceof ImportAuthError) || err.status !== 403) throw err;
        denied.add(sub);
        ctx.warn(
          `${label} were skipped: this Lever key has no permission to read them. Create a key with the "Select all read" preset to include them.`,
        );
        return [];
      }
    }

    /**
     * Records Lever marks deleted are skipped and counted. Every doc example
     * sets deletedAt on live records too, so a run of nothing but deleted ones
     * gets a louder warning.
     */
    function skipDeleted(ctx: PhaseContext, label: string, deletedAt: Ts): boolean {
      const seen = deletedSeen.get(label) ?? { deleted: 0, live: 0 };
      deletedSeen.set(label, seen);
      if (!when(deletedAt)) {
        seen.live++;
        return false;
      }
      seen.deleted++;
      ctx.warn(`Skipped Lever ${label} marked as deleted`);
      if (!seen.live && seen.deleted === DELETED_ALARM) {
        ctx.warn(
          `The first ${DELETED_ALARM} Lever ${label} read were all marked as deleted, so none of them were imported. ` +
            `If you can see these ${label} in Lever, contact Source support before relying on this import.`,
        );
      }
      return true;
    }

    const DOWNLOADS: Record<DownloadKind, { label: string; sub: string | null }> = {
      offer: { label: 'Offer letters', sub: null },
      resume: { label: 'Resumes', sub: 'resumes' },
      file: { label: 'Attachments', sub: 'files' },
    };

    async function download(ctx: PhaseContext, kind: DownloadKind, url: string, filename: string): Promise<DownloadedFile> {
      let res: Awaited<ReturnType<HttpClient['bytes']>>;
      try {
        res = await http.bytes(url);
      } catch (err) {
        if (!(err instanceof ImportAuthError) || err.status !== 403) throw err;
        // A key that can list files but not download them. The loader skips a
        // failed download with a warning; an auth error would fail the whole job.
        if (!deniedDownloads.has(kind)) {
          deniedDownloads.add(kind);
          const { label, sub } = DOWNLOADS[kind];
          if (sub) denied.add(sub); // nothing left to fetch the list for
          ctx.warn(
            `${label} were not downloaded: this Lever key has no permission to download them. Create a key with the "Select all read" preset to include them.`,
          );
        }
        throw new ImportHttpError(403, err.where, 'this Lever key cannot download it');
      }
      const type = (res.contentType ?? '').split(';')[0].trim().toLowerCase();
      if (type === 'text/html') {
        throw new ImportHttpError(415, describeRequest('GET', new URL(url)), 'Lever sent a web page instead of the file');
      }
      return { data: res.data, contentType: res.contentType, filename: res.filename ?? filename };
    }

    function opportunityQuery(ctx: PhaseContext, expand: boolean): Query {
      return {
        ...(expand ? { expand: ['applications', 'stage'] } : {}),
        // A re-import also reads archived ones: someone imported while active may be archived now.
        ...(ctx.options.archived || ctx.resync ? {} : { archived: 'false' }),
      };
    }

    /** A phase that walks opportunities and fetches one or more sub-resources for each imported one. */
    function fanOut(
      id: string,
      label: string,
      enabled: (o: ImportOptions) => boolean,
      subs: string[],
      dir: Direction,
      handle: (ctx: PhaseContext, opp: LeverOpportunity) => Promise<void>,
    ): Phase {
      const allDenied = () => subs.every((s) => denied.has(s));
      return {
        id,
        label,
        enabled,
        async run(ctx, cursor) {
          if (allDenied()) return null;
          const next = await oppRun(ctx, cursor, opportunityQuery(ctx, false), dir, async (opp) => {
            if (allDenied() || !(await ctx.load.has('opportunity', opp.id))) return;
            await handle(ctx, opp);
          });
          return allDenied() ? null : next;
        },
      };
    }

    /** A profile or referral form, as a note by whoever filled it in. */
    async function formNote(ctx: PhaseContext, opp: LeverOpportunity, key: string, form: LeverForm, names: Map<string, string>) {
      const author = idOf(form.user) ?? idOf(form.referrer);
      await ctx.load.note({
        externalId: `${key}:${form.id}`,
        applicationExternalId: opp.id,
        authorExternalUserId: author,
        authorName: author ? (names.get(author) ?? null) : null,
        body: formBody(form.text, form.fields),
        createdAt: when(form.completedAt) ?? when(form.createdAt),
      });
    }

    const discover: Phase[] = [
      {
        id: 'users',
        label: 'Team members',
        run: (ctx, cursor) =>
          optional(
            ctx,
            'Team members',
            () =>
              listRun<LeverUser>(ctx, cursor, '/users', { includeDeactivated: true }, false, async (u) => {
                ctx.catalog.user({
                  externalId: String(u.id),
                  name: u.name?.trim() || u.email?.trim() || 'Lever user',
                  email: u.email?.trim() || null,
                });
              }),
            null,
          ),
      },
      {
        id: 'stages',
        label: 'Pipeline stages',
        async run(ctx, cursor) {
          // /disposition_stages has the pipeline order and type; older keys get 403 and we fall back to /stages order.
          const ordered = (await disposition(ctx))?.stages ?? [];
          const rankById = new Map(ordered.map((s) => [String(s.id), s]));
          const rankByName = new Map(ordered.map((s) => [(s.text ?? '').trim().toLowerCase(), s]));
          if (!cursor) {
            for (const s of ordered) ctx.catalog.stage(catalogStage(s, num(s.rank)));
            ctx.catalog.stage({ ...HIRED_STAGE, typeHint: 'HIRED', position: null });
          }
          return optional(
            ctx,
            'Pipeline stages',
            () =>
              pagedStep<LeverDispositionStage & { position: number }>(
                ctx,
                cursor,
                async (page) => {
                  const res = await listPage<LeverStage>(ctx, '/stages', {}, page as LeverPage | null, false);
                  return {
                    items: res.items.map((s, i) => {
                      const known = rankById.get(String(s.id)) ?? rankByName.get((s.text ?? '').trim().toLowerCase());
                      return { ...s, pipeline: known?.pipeline ?? null, position: num(known?.rank) ?? i };
                    }),
                    next: res.next,
                  };
                },
                async (s) => ctx.catalog.stage(catalogStage(s, s.position)),
              ),
            null,
          );
        },
      },
      {
        id: 'reasons',
        label: 'Archive reasons',
        async run(ctx, cursor) {
          const DENIED = '__denied__';
          const next = await optional<Cursor | null>(
            ctx,
            'Archive reasons',
            () =>
              listRun<LeverReason>(ctx, cursor, '/archive_reasons', {}, false, async (r) => {
                ctx.catalog.reason(catalogReason(r));
              }),
            DENIED,
          );
          if (next !== DENIED) return next;
          for (const r of (await disposition(ctx))?.archiveReasons ?? []) ctx.catalog.reason(catalogReason(r));
          return null;
        },
      },
    ];

    const load: Phase[] = [
      {
        id: 'requisitions',
        label: 'Requisitions',
        // Keys made before Lever added requisitions to "all permissions" get 403 here.
        run: (ctx, cursor) =>
          optional(
            ctx,
            'Requisitions',
            () =>
              listRun<LeverRequisition>(ctx, cursor, '/requisitions', {}, true, async (r) => {
                if (isUnlimited(r.headcountTotal)) {
                  ctx.warn(
                    `Lever requisitions with unlimited headcount were imported with ${UNLIMITED_OPENINGS.toLocaleString('en-US')} openings, because Source has no unlimited setting`,
                  );
                }
                await ctx.load.requisition(toRequisition(r));
              }),
            null,
          ),
      },
      {
        id: 'postings',
        label: 'Jobs',
        async run(ctx, cursor) {
          // Pass 1 lists every state. Pass 2 catches published jobs that only
          // appear on the internal job site, which Lever can leave out.
          const at = (cursor as { pass: number; at: Cursor | null } | null) ?? { pass: 0, at: null };
          const query: Query = at.pass === 0 ? {} : { state: 'published', distributionChannel: ['public', 'internal'] };
          const next = await listRun<LeverPosting>(ctx, at.at, '/postings', query, true, async (listed) => {
            // Both passes can list a job: read it once per run (a re-import reads it again to update it).
            if (await ctx.load.handled('posting', listed.id)) return;
            let p = listed;
            if (!p.content) {
              const detail = await optional(
                ctx,
                'Job descriptions',
                () => http.json<{ data?: LeverPosting | null }>(`${API}/postings/${encodeURIComponent(p.id)}`),
                null,
              );
              if (detail?.data) p = { ...p, ...detail.data };
            }
            await ctx.load.posting(toPosting(p, await requisitionFor(ctx, p)));
          });
          if (next !== null) return { pass: at.pass, at: next };
          return at.pass === 0 ? { pass: 1, at: null } : null;
        },
      },
      {
        id: 'candidates',
        label: 'Candidates and applications',
        // Oldest first: a contact is created from its earliest candidacy.
        run: (ctx, cursor) =>
          oppRun(ctx, cursor, opportunityQuery(ctx, true), 'up', async (opp) => {
            if (opp.isAnonymized) {
              ctx.warn('Skipped candidates that were anonymized in Lever');
              return;
            }
            // archived=false is also sent to Lever; this keeps an archived-only person from becoming a contact.
            // A re-import still updates the ones it imported while they were active.
            if (!ctx.options.archived && archivedOf(opp) && !(ctx.resync && (await ctx.load.has('opportunity', opp.id)))) return;
            const candidate = toCandidate(opp);
            await ctx.load.candidate(candidate);
            const app = firstApplication(opp);
            const names = (app?.type === 'referral' && idOf(app.user)) || idOf(opp.sourcedBy) ? await userNames(ctx) : new Map<string, string>();
            if (storageNotAllowed(opp, Date.now())) {
              ctx.warn(
                'Imported Lever candidates whose consent to store their data was declined or has expired (GDPR). Their consent is kept on the application; review them.',
              );
            }
            await ctx.load.application(
              toApplication(opp, candidate, {
                reasons: await reasonIndex(ctx),
                names,
                knownStages: await knownStages(ctx, opp),
              }),
            );
          }),
      },
      fanOut('interviews', 'Interviews', (o) => o.activity, ['interviews'], 'up', async (ctx, opp) => {
        const now = Date.now();
        for (const i of await child<LeverInterview>(ctx, opp, 'interviews', 'Interviews')) {
          await each(ctx, i, async (item) => {
            const record = toInterview(item, opp.id, now);
            if (record) await ctx.load.interview(record);
          });
        }
      }),
      fanOut('feedback', 'Scorecards', (o) => o.activity, ['feedback'], 'up', async (ctx, opp) => {
        const forms = await child<LeverFeedback>(ctx, opp, 'feedback', 'Scorecards');
        if (!forms.length) return;
        const names = await userNames(ctx);
        for (const form of forms) {
          await each(ctx, form, async (f) => {
            if (skipDeleted(ctx, 'scorecards', f.deletedAt)) return;
            await ctx.load.feedback(toFeedback(f, opp.id, names));
          });
        }
      }),
      // Notes, profile forms (Lever's candidate custom fields) and referral forms all land as notes.
      fanOut('notes', 'Notes', (o) => o.activity, ['notes', 'forms', 'referrals'], 'up', async (ctx, opp) => {
        const notes = await child<LeverNote>(ctx, opp, 'notes', 'Notes');
        const forms = await child<LeverForm>(ctx, opp, 'forms', 'Profile forms');
        // Referral forms only exist on referrals; asking for everyone would cost a call per candidate.
        const referrals = opp.origin === 'referred' ? await child<LeverForm>(ctx, opp, 'referrals', 'Referral forms') : [];
        if (!notes.length && !forms.length && !referrals.length) return;
        const names = await userNames(ctx);
        for (const note of notes) {
          await each(ctx, note, async (n) => {
            if (skipDeleted(ctx, 'notes', n.deletedAt)) return;
            if (n.secret) {
              ctx.warn('Skipped secret Lever notes: Source notes are visible to everyone who can see the application');
              return;
            }
            // A Lever note is a thread; each comment keeps its own author.
            const comments = n.fields ?? [];
            for (let i = 0; i < comments.length; i++) {
              const c = comments[i];
              const author = idOf(c.user) ?? idOf(n.user);
              await ctx.load.note({
                externalId: `${n.id}:${when(c.createdAt)?.getTime() ?? `i${i}`}`,
                applicationExternalId: opp.id,
                authorExternalUserId: author,
                authorName: author ? (names.get(author) ?? null) : null,
                body: noteBody(c),
                createdAt: when(c.createdAt) ?? when(n.createdAt),
              });
            }
          });
        }
        for (const form of forms) {
          await each(ctx, form, async (f) => {
            if (skipDeleted(ctx, 'profile forms', f.deletedAt)) return;
            await formNote(ctx, opp, 'form', f, names);
          });
        }
        for (const referral of referrals) await each(ctx, referral, (r) => formNote(ctx, opp, 'referral', r, names));
      }),
      fanOut('offers', 'Offers', (o) => o.offers, ['offers'], 'up', async (ctx, opp) => {
        const offers = await child<LeverOffer>(ctx, opp, 'offers', 'Offers');
        if (!offers.length) return;
        // Lever has no decline time; archiving the candidacy as a declined offer is the closest record of it.
        const archived = archivedOf(opp);
        const reason = archived?.reason ? (await reasonIndex(ctx)).get(archived.reason) : undefined;
        const declinedAt = reason && reason.type !== 'hired' && /declin/i.test(reason.text ?? '') ? (archived?.at ?? null) : null;
        for (const offer of offers) {
          await each(ctx, offer, async (o) => {
            await ctx.load.offer(toOffer(o, opp.id, declinedAt));
            // The signed letter if there is one, else the one that was sent. The loader skips it when files are off.
            const doc = o.signedDocument ? 'signed' : o.sentDocument ? 'sent' : null;
            if (!doc || deniedDownloads.has('offer')) return;
            const filename = fileName((o.signedDocument ?? o.sentDocument)?.fileName, null, `offer-letter-${doc}.pdf`);
            await ctx.load.file({
              externalId: `offer:${o.id}:${doc}`,
              candidateExternalId: contactIdOf(opp),
              applicationExternalId: opp.id,
              filename,
              kind: 'other',
              download: () =>
                download(
                  ctx,
                  'offer',
                  `${API}/opportunities/${encodeURIComponent(opp.id)}/offers/${encodeURIComponent(o.id)}/download?status=${doc}`,
                  filename,
                ),
            });
          });
        }
      }),
      // Newest candidacy first, so a person's latest resume becomes their resume and older ones attachments.
      fanOut('files', 'Resumes and files', (o) => o.files, ['resumes', 'files'], 'down', async (ctx, opp) => {
        const base = `${API}/opportunities/${encodeURIComponent(opp.id)}`;
        const resumes = (await child<LeverResume>(ctx, opp, 'resumes', 'Resumes'))
          .filter((r) => r.file && r.file.status !== 'error') // parsed-profile resumes have no file; "error" answers 422
          .sort((a, b) => (when(b.file?.uploadedAt ?? b.createdAt)?.getTime() ?? 0) - (when(a.file?.uploadedAt ?? a.createdAt)?.getTime() ?? 0));
        for (const resume of resumes) {
          await each(ctx, resume, async (r) => {
            if (deniedDownloads.has('resume')) return;
            const filename = fileName(r.file?.name, r.file?.ext, 'resume');
            await ctx.load.file({
              externalId: `resume:${r.id}`,
              candidateExternalId: contactIdOf(opp),
              applicationExternalId: opp.id,
              filename,
              kind: 'resume',
              download: () => download(ctx, 'resume', `${base}/resumes/${encodeURIComponent(r.id)}/download`, filename),
            });
          });
        }
        for (const file of await child<LeverFile>(ctx, opp, 'files', 'Attachments')) {
          await each(ctx, file, async (f) => {
            if (f.status === 'error' || deniedDownloads.has('file')) return;
            const filename = fileName(f.name, f.ext, 'attachment');
            await ctx.load.file({
              externalId: `file:${f.id}`,
              candidateExternalId: contactIdOf(opp),
              applicationExternalId: opp.id,
              filename,
              kind: 'other',
              download: () => download(ctx, 'file', `${base}/files/${encodeURIComponent(f.id)}/download`, filename),
            });
          });
        }
      }),
    ];

    return {
      async verify() {
        try {
          const { items } = await fetchList<LeverUser>(null, '/users', {}, null);
          return { accountName: accountNameFrom(items) };
        } catch (err) {
          if (!(err instanceof ImportAuthError) || err.status !== 403) throw err;
          // Lever answers an invalid key with 403, and a key without users:read
          // with 403 too. A key that can read jobs is valid: the import skips
          // team members with a warning. Otherwise report rejected credentials.
          const postings = await http
            .json<ListBody<LeverPosting>>(`${API}/postings`, { limit: 1 })
            .catch((e: unknown) => {
              if (e instanceof ImportAuthError && e.status === 403) return undefined;
              throw e;
            });
          if (postings === undefined) throw new ImportAuthError(401, err.where);
          return { accountName: accountNameFromSite(unwrap(postings, null).items) };
        }
      },
      discover,
      load,
    };
  },
};
