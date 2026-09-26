import type { Commitment, StageType, WorkplaceType } from '@prisma/client';
import { ImportAuthError, ImportHttpError, type HttpClient } from '@/server/imports/http';
import { isRetryable, listStep, optional, pagedStep, type Page } from '@/server/imports/paging';
import { cleanEmails, cleanList, clip, fullName, htmlToText, toDate } from '@/server/imports/text';
import type {
  Credentials,
  Cursor,
  DownloadedFile,
  ImportedPosting,
  JsonValue,
  Phase,
  PhaseContext,
  ProviderModule,
  ReasonKind,
  ReasonRef,
  StageRef,
} from '@/server/imports/types';

/**
 * BambooHR Hiring (ATS) adapter. API: https://{companyDomain}.bamboohr.com/api/v1,
 * HTTP Basic with the API key as the username and "x" as the password.
 *
 * Quirks it handles:
 * - Keys have no scopes and can write. This adapter only ever sends GETs.
 * - Uses the subdomain host, not api.bamboohr.com/api/gateway.php: the
 *   gateway host is data-center specific for some tenants. A pasted gateway
 *   URL is reduced to its tenant.
 * - Statuses are one org-wide list mixing pipeline stages and "not hired"
 *   outcomes, with no group field. System codes decide which is which. A
 *   custom status is probed twice, in the INACTIVE group and in the others,
 *   because how the status and group filters combine is undocumented; when
 *   the probes can't tell, the name decides. Disabled statuses are listed only
 *   if an application still holds one.
 * - The applications list shows only active rows on Open jobs unless told
 *   otherwise. We walk each status group (NEW, ACTIVE, INACTIVE, HIRED) with
 *   jobStatusGroups=ALL, sorted by created date. The group decides
 *   active/archived/hired, and archived=false skips the last two server-side.
 *   An application leaving a group mid-walk shifts later rows onto an
 *   earlier page, so a final pass over every status catches what that hid.
 *   A last pass asks for applications on Deleted jobs, which ALL may exclude.
 * - Pages are 1-based with no size parameter. Paging stops on
 *   paginationComplete (or, without that flag, a missing nextPageUrl) or an
 *   empty page. We never follow nextPageUrl, whose host is unverified.
 * - There is no candidate endpoint. Each application embeds its own
 *   applicant, and the same person gets a new applicant id per application,
 *   so candidates ride inline and the engine dedupes them by email.
 * - Most fields exist only on the per-application detail call: phone,
 *   links, when and by whom the status last changed, the hiring lead, files
 *   and the comment count. One detail call per new application; ones already
 *   imported are skipped. If the status changed since the list page, the
 *   detail's status wins.
 * - No stage history, interviews, offers or scorecards. History is a single
 *   entry: the current status at status.dateChanged. The 1-5 star rating has
 *   no author or date. It becomes feedback, and a neutral 3 stays a note.
 * - Hiring leads are employees. They are joined to users on employeeId, so
 *   owners carry the same user ids as the catalog.
 * - Job descriptions exist only for Open jobs, on the public careers API,
 *   which is fetched without the key.
 * - Reading comments (GET .../comments) and downloading applicant files
 *   (/api/v1/files/{id}, else the attachment's fileUrl) are undocumented.
 *   Both are fetched before the application is written, so a rate limit
 *   replays the whole application instead of losing its notes or files.
 *   Repeated failures stop further attempts for the rest of the slice, and
 *   a file that can't be downloaded is named in a note.
 */

const MIN_INTERVAL_MS = 250;

const DOMAIN_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** bamboohr.com hosts that are never a tenant. */
const RESERVED = new Set(['api', 'www', 'app', 'documentation', 'marketplace', 'partners']);
const BAD_DOMAIN = 'Enter your BambooHR company subdomain: the "acme" in acme.bamboohr.com';

/**
 * Accepts "acme", "acme.bamboohr.com", a pasted URL, or a legacy gateway URL
 * (api.bamboohr.com/api/gateway.php/acme/v1). Null if invalid, since it's
 * spliced into the host.
 */
function companyDomain(raw: string | undefined): string | null {
  let s = (raw ?? '').trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  const gateway = /^api\.bamboohr\.com(?::\d+)?\/api\/gateway\.php\/([^/?#]+)/.exec(s);
  if (gateway) s = gateway[1];
  s = s
    .replace(/[/?#].*$/, '')
    .replace(/:\d+$/, '')
    .replace(/\.bamboohr\.com\.?$/, '');
  return DOMAIN_RE.test(s) && !RESERVED.has(s) ? s : null;
}

// ---------- Vendor payloads (only the fields we read) ----------

type Labeled = { id?: number | string | null; label?: string | null };

type BambooUser = {
  id?: number | string | null;
  employeeId?: number | null;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
};

type BambooStatus = {
  id: string | number;
  code?: string | null;
  name?: string | null;
  translatedName?: string | null;
  enabled?: boolean | null;
};

type BambooAddress = { city?: string | null; state?: string | null; country?: string | null };

type BambooPerson = { id?: number | null; employeeId?: number | null; firstName?: string | null; lastName?: string | null };

type BambooJob = {
  id: number;
  title?: Labeled | null;
  postedDate?: string | null;
  location?: { label?: string | null; address?: BambooAddress | null } | null;
  department?: Labeled | null;
  status?: Labeled | null;
};

type CareersDetail = {
  result?: {
    jobOpening?: {
      description?: string | null;
      employmentStatusLabel?: string | null;
      locationType?: string | number | null;
      compensation?: string | null;
      minimumExperience?: string | null;
    } | null;
  } | null;
};

type Applicant = {
  id?: number | null;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  source?: string | null;
  phoneNumber?: string | null;
  address?: BambooAddress | null;
  linkedinUrl?: string | null;
  twitterUsername?: string | null;
  websiteUrl?: string | null;
  availableStartDate?: string | null;
  education?: { institution?: string | null; level?: Labeled | null } | null;
};

type ApplicationRow = {
  id: number;
  appliedDate?: string | null;
  status?: { id?: number | null; label?: string | null } | null;
  rating?: number | null;
  applicant?: Applicant | null;
  job?: { id?: number | null } | null;
};

type ApplicationsPage = {
  paginationComplete?: boolean | null;
  applications?: ApplicationRow[] | null;
  nextPageUrl?: string | null;
};

type ApplicationDetail = {
  id: number;
  appliedDate?: string | null;
  status?: {
    id?: number | null;
    label?: string | null;
    dateChanged?: string | null;
    changedByUser?: BambooPerson | null;
  } | null;
  rating?: number | null;
  applicant?: Applicant | null;
  job?: { id?: number | null; hiringLead?: BambooPerson | null } | null;
  resumeFileId?: number | null;
  coverLetterFileId?: number | null;
  attachments?: { id?: number | null; name?: string | null; fileUrl?: string | null }[] | null;
  /** Arrays of objects whose shape is undocumented; kept raw. */
  movedTo?: JsonValue;
  movedFrom?: JsonValue;
  referredBy?: string | null;
  desiredSalary?: string | null;
  commentCount?: number | null;
  questionsAndAnswers?: { question?: Labeled | null; answer?: Labeled | null }[] | null;
  applicationReferences?: unknown;
};

/** Undocumented shape (from an open-source SDK), so every field is optional. */
type BambooComment = {
  id?: number | string | null;
  userId?: number | string | null;
  userData?: { firstName?: string | null; lastName?: string | null } | null;
  comment?: string | null;
  dateCreated?: string | null;
};

// ---------- Statuses ----------

/** Candidate-side outcomes are withdrawals, not rejections. */
const REASON_CODES: Record<string, ReasonKind> = {
  NOFIT: 'rejection',
  NOQUAL: 'rejection',
  OVERQUAL: 'rejection',
  DECLINED: 'withdrawn',
  POACHED: 'withdrawn',
};

/** Pipeline order of the system stage statuses. Custom statuses follow, by id. */
const STAGE_CODES = ['NEW', 'REVIEWED', 'SCHEDPHONE', 'PHONED', 'SCHEDINT', 'INTERVIEW', 'ONHOLD', 'REFCHECK', 'OFFER', 'OLSENT', 'OLSIGNED', 'HIRED'];

const STAGE_TYPES: Record<string, StageType> = {
  NEW: 'APPLICANT',
  REVIEWED: 'APPLICANT',
  SCHEDPHONE: 'SCREEN',
  PHONED: 'SCREEN',
  SCHEDINT: 'ONSITE',
  INTERVIEW: 'ONSITE',
  REFCHECK: 'OFFER',
  OFFER: 'OFFER',
  OLSENT: 'OFFER',
  OLSIGNED: 'OFFER',
  HIRED: 'HIRED',
};

/**
 * The MOVED status becomes this reason. The application it moved to is
 * imported on its own, so it is filed as a withdrawal, not a rejection.
 */
const MOVED_REASON = 'Moved to another job';

/** Custom status names that read as a "not hired" outcome, for when the data can't say. */
const NOT_HIRED =
  /\b(not a fit|not qualified|not selected|not hired|not moving forward|no longer (interested|considered|available)|withdr[ae]wn?|declined?|rejected|disqualified|hired elsewhere|accepted another|over ?qualified|under ?qualified|position filled)\b/i;
const WITHDRAWN = /withdr[ae]w|declin|hired elsewhere|accepted another|no longer interested/i;

const statusName = (s: BambooStatus) => s.name?.trim() || s.translatedName?.trim() || `Status ${s.id}`;

/**
 * BambooHR stars → Source's 1 strong no · 2 no · 3 yes · 4 strong yes. Three
 * stars is neutral, not a decision, so it becomes null and the engine keeps
 * it as a note.
 */
const STAR_RATING: Record<number, 1 | 2 | 3 | 4 | null> = { 1: 1, 2: 2, 3: null, 4: 3, 5: 4 };

/** Free-text answers to "Referred by" that mean nobody referred them. */
const NO_REFERRER = /^(n\/?a|none|no|nope|nobody|no ?one|nil|null|not applicable|no referral|-+|\.+|0)$/i;

// ---------- Small mappers ----------

function place(a: BambooAddress | null | undefined, fallback?: string | null): string | null {
  return cleanList([a?.city, a?.state, a?.country]).join(', ') || fallback?.trim() || null;
}

function postingState(status: Labeled | null | undefined): ImportedPosting['state'] {
  const label = (status?.label ?? '').trim().toLowerCase();
  if (label === 'open' || (!label && Number(status?.id) === 1)) return 'open';
  if (label === 'draft' || (!label && Number(status?.id) === 2)) return 'draft';
  return 'closed'; // On Hold, Filled, Canceled, Deleted
}

function commitment(label: string | null | undefined): Commitment | null {
  const l = (label ?? '').toLowerCase();
  if (/intern/.test(l)) return 'INTERNSHIP';
  if (/contract|freelance|temp/.test(l)) return 'CONTRACT';
  if (/part/.test(l)) return 'PART_TIME';
  if (/full/.test(l)) return 'FULL_TIME';
  return null;
}

/** Careers locationType: "0" on-site, "1" remote, "2" hybrid. */
function workplace(value: string | number | null | undefined): WorkplaceType | null {
  return ({ '0': 'ONSITE', '1': 'REMOTE', '2': 'HYBRID' } as Record<string, WorkplaceType>)[String(value ?? '')] ?? null;
}

/** Sources are free text, or a numeric id BambooHR has no endpoint to resolve. */
function sourceLabel(raw: string | null | undefined): string | null {
  const s = raw?.trim();
  if (!s) return null;
  return /^\d+$/.test(s) ? `Unknown source (BambooHR #${s})` : s;
}

function twitterLink(handle: string | null | undefined): string | null {
  const h = handle?.trim().replace(/^@/, '');
  if (!h) return null;
  return /^https?:\/\//i.test(h) ? h : `https://x.com/${h}`;
}

function stars(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  return Math.min(5, Math.max(1, Math.round(value)));
}

/** newSince takes UTC "Y-m-d H:i:s", not ISO 8601. */
function bambooTime(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/** Q&A answers and comments are plain text with CRLF line breaks. */
function plain(text: string | null | undefined): string {
  return (text ?? '').replace(/\r\n?/g, '\n').trim();
}

function commentList(body: unknown): BambooComment[] {
  if (Array.isArray(body)) return body as BambooComment[];
  if (body && typeof body === 'object') {
    for (const key of ['comments', 'data', 'items']) {
      const v = (body as Record<string, unknown>)[key];
      if (Array.isArray(v)) return v as BambooComment[];
    }
  }
  return [];
}

type Attached = { id: string; name: string; label: string; kind: 'resume' | 'other'; url: string | null };

function attachedFiles(d: ApplicationDetail): Attached[] {
  const out: Attached[] = [];
  const add = (f: Attached) => {
    if (!out.some((o) => o.id === f.id)) out.push(f);
  };
  if (d.resumeFileId) add({ id: String(d.resumeFileId), name: `resume-${d.resumeFileId}`, label: 'Resume', kind: 'resume', url: null });
  if (d.coverLetterFileId) {
    add({ id: String(d.coverLetterFileId), name: `cover-letter-${d.coverLetterFileId}`, label: 'Cover letter', kind: 'other', url: null });
  }
  for (const a of d.attachments ?? []) {
    if (!a.id) continue;
    const name = a.name?.trim() || `attachment-${a.id}`;
    add({ id: String(a.id), name, label: `Attachment "${name}"`, kind: 'other', url: a.fileUrl ?? null });
  }
  return out;
}

/** Stops an undocumented endpoint after repeated failures in a row. A success resets it. */
function breaker(limit: number) {
  let failures = 0;
  return {
    get open() {
      return failures >= limit;
    },
    ok() {
      failures = 0;
    },
    fail() {
      failures++;
    },
  };
}

/** A retryable error means "try the slice again". Anything else means "this piece is unavailable". */
function transient(err: unknown): boolean {
  return isRetryable(err) && !(err instanceof ImportAuthError);
}

/**
 * For the undocumented endpoints: a rate limit, a dropped connection or the
 * slice running out of time means "try the slice again". A 5xx that outlasted
 * the client's retries means that endpoint is broken for this item, so one
 * bad file or comment list can't fail the whole import.
 */
function retryLater(err: unknown): boolean {
  return transient(err) && !(err instanceof ImportHttpError && err.status >= 500);
}

const httpStatus = (err: unknown): number | null =>
  err instanceof ImportHttpError || err instanceof ImportAuthError ? err.status : null;

// ---------- The adapter ----------

type Outcome = 'active' | 'archived' | 'hired';

const GROUP_WALKS: { group: string; id: string; label: string; outcome: Outcome }[] = [
  { group: 'NEW', id: 'applications-new', label: 'New applications', outcome: 'active' },
  { group: 'ACTIVE', id: 'applications-active', label: 'Active applications', outcome: 'active' },
  { group: 'INACTIVE', id: 'applications-archived', label: 'Archived applications', outcome: 'archived' },
  { group: 'HIRED', id: 'applications-hired', label: 'Hired applications', outcome: 'hired' },
];

/** Page token for the applications walk. `prev` is the previous page's first id, to catch a server ignoring `page`. */
type WalkPage = { n: number; prev: number | null };

function walkPage(page: JsonValue): WalkPage {
  if (page && typeof page === 'object' && !Array.isArray(page) && typeof page.n === 'number') {
    return { n: page.n, prev: typeof page.prev === 'number' ? page.prev : null };
  }
  return { n: typeof page === 'number' && page >= 1 ? page : 1, prev: null };
}

type WalkFilter = { applicationStatus: string; jobStatusGroups: 'ALL' | 'Deleted'; outcome: Outcome | null };

export const bamboohrProvider: ProviderModule = {
  id: 'bamboohr',
  // No published limit. Guidance is to stay near 5 req/s per tenant, so 4 req/s leaves margin.
  minIntervalMs: MIN_INTERVAL_MS,

  auth(credentials: Credentials) {
    const domain = companyDomain(credentials.companyDomain);
    const key = (credentials.apiKey ?? '').trim();
    if (!domain || !key) return { hosts: [] };
    return {
      hosts: [`${domain}.bamboohr.com`],
      headers: { authorization: `Basic ${Buffer.from(`${key}:x`).toString('base64')}` },
    };
  },

  create(credentials: Credentials, http: HttpClient) {
    const domain = companyDomain(credentials.companyDomain);
    const origin = () => {
      if (!domain) throw new Error(BAD_DOMAIN);
      return `https://${domain}.bamboohr.com`;
    };
    const api = () => `${origin()}/api/v1`;

    // Per-slice state. The engine builds a fresh adapter for every slice.
    let statusCache: Promise<Map<string, BambooStatus>> | null = null;
    let leadCache: Promise<Map<string, string>> | null = null;
    const comments = breaker(5);
    const files = breaker(5);
    let careersOff = false;

    const fetchStatuses = async (h: HttpClient): Promise<BambooStatus[]> => {
      const list = await h.json<BambooStatus[] | null>(`${api()}/applicant_tracking/statuses`);
      return (Array.isArray(list) ? list : []).sort((a, b) => Number(a.id) - Number(b.id));
    };

    const statusIndex = (ctx: PhaseContext) => {
      statusCache ??= fetchStatuses(ctx.http)
        .then((list) => new Map(list.map((s) => [String(s.id), s])))
        .catch((err: unknown) => {
          statusCache = null;
          throw err;
        });
      return statusCache;
    };

    const listUsers = (ctx: PhaseContext): Promise<BambooUser[]> =>
      optional(
        ctx,
        'Teammates could not be listed, so imported activity will be credited to you',
        async () => Object.values((await ctx.http.json<Record<string, BambooUser> | BambooUser[] | null>(`${api()}/meta/users`)) ?? {}),
        [],
      );

    /** Hiring leads are employees. Map employeeId to the user id the catalog knows. */
    const leadIndex = (ctx: PhaseContext) => {
      leadCache ??= listUsers(ctx)
        .then((users) => {
          const map = new Map<string, string>();
          for (const u of users) if (u.id != null && u.employeeId) map.set(String(u.employeeId), String(u.id));
          return map;
        })
        .catch((err: unknown) => {
          leadCache = null;
          throw err;
        });
      return leadCache;
    };

    /**
     * Page 1 of the applications in one status within some status groups:
     * whether any exist, or null when a row in another status shows the two
     * filters weren't ANDed (how they combine is undocumented).
     */
    async function holds(ctx: PhaseContext, statusId: string, groups: string): Promise<boolean | null> {
      const res = await ctx.http.json<ApplicationsPage | null>(`${api()}/applicant_tracking/applications`, {
        applicationStatus: groups,
        applicationStatusId: statusId,
        jobStatusGroups: 'ALL',
        page: 1,
      });
      const rows = res?.applications ?? [];
      return rows.some((a) => String(a.status?.id) !== statusId) ? null : rows.length > 0;
    }

    /** Whether a custom status is a "not hired" outcome, or undefined to leave a hidden, unused one out. */
    async function customIsReason(ctx: PhaseContext, s: BambooStatus): Promise<boolean | undefined> {
      const id = String(s.id);
      const inactive = await holds(ctx, id, 'INACTIVE');
      const active = await holds(ctx, id, 'NEW,ACTIVE,HIRED');
      if (inactive === null || active === null || (inactive && active)) {
        ctx.warn(
          "BambooHR's status filters didn't isolate one status, so custom statuses were sorted into stages and archive reasons by name.",
        );
        return NOT_HIRED.test(statusName(s));
      }
      if (inactive || active) return inactive;
      if (s.enabled === false) return undefined;
      return NOT_HIRED.test(statusName(s));
    }

    /**
     * Active, archived or hired for an application in this status, or null
     * for Deleted, which is skipped. Moved is always archived. Otherwise the
     * group walk that listed it decides; without one, the system code, then
     * how discovery filed a custom status.
     */
    async function classify(ctx: PhaseContext, statusId: string | null, walked: Outcome | null): Promise<Outcome | null> {
      const code = statusId ? ((await statusIndex(ctx)).get(statusId)?.code ?? null) : null;
      if (code === 'DELETED') return null;
      if (code === 'MOVED') return 'archived';
      if (walked) return walked;
      if (code === 'HIRED') return 'hired';
      if (code) return REASON_CODES[code] ? 'archived' : 'active';
      if (statusId && (await ctx.load.has('reason', statusId)) && !(await ctx.load.has('stage', statusId))) return 'archived';
      return 'active';
    }

    async function jobOpening(ctx: PhaseContext, jobId: string) {
      if (careersOff) return null;
      try {
        const res = await optional(
          ctx,
          'An open job is not on the public careers page, so it was imported without a description',
          // The public careers API shares the tenant host with the key-protected API; skipAuth keeps the key off it.
          async () =>
            (
              await ctx.http.request<CareersDetail | null>({
                url: `${origin()}/careers/${encodeURIComponent(jobId)}/detail`,
                skipAuth: true,
              })
            ).data,
          null,
        );
        return res?.result?.jobOpening ?? null;
      } catch (err) {
        if (transient(err)) throw err;
        careersOff = true;
        ctx.warn(`Job descriptions were skipped because the BambooHR careers page could not be read (${(err as Error).message})`);
        return null;
      }
    }

    /** Deleted jobs, if BambooHR will list them. Their applications still point at them. */
    async function deletedJobs(ctx: PhaseContext): Promise<BambooJob[]> {
      try {
        const jobs = await ctx.http.json<BambooJob[] | null>(`${api()}/applicant_tracking/jobs`, {
          statusGroups: 'Deleted',
          sortBy: 'created',
          sortOrder: 'ASC',
        });
        return Array.isArray(jobs) ? jobs : [];
      } catch (err) {
        if (transient(err) || httpStatus(err) === null) throw err;
        ctx.warn(`Deleted jobs could not be listed, so their applications are kept without a job (HTTP ${httpStatus(err)})`);
        return [];
      }
    }

    // A fixed message, with the application id as detail, so thousands of refusals don't crowd out other warnings.
    async function readComments(ctx: PhaseContext, appId: string, d: ApplicationDetail): Promise<BambooComment[]> {
      if (!ctx.options.activity || !(d.commentCount ?? 0) || comments.open) return [];
      try {
        const list = commentList(await ctx.http.json<unknown>(`${api()}/applicant_tracking/applications/${encodeURIComponent(appId)}/comments`));
        comments.ok();
        return list;
      } catch (err) {
        // A 401 here concerns this undocumented endpoint: the key just read the application.
        if (retryLater(err) || httpStatus(err) === null) throw err;
        comments.fail();
        ctx.warn(`Notes on some applications could not be read (HTTP ${httpStatus(err)}). BambooHR does not document reading comments.`, {
          entity: 'application',
          externalId: appId,
        });
        if (comments.open) ctx.warn('Stopped reading BambooHR comments after repeated failures. Remaining notes were skipped.');
        return [];
      }
    }

    /** /api/v1/files/{id} first, then the attachment's own URL. A login page counts as failure. Null when neither works. */
    async function download(ctx: PhaseContext, f: Attached): Promise<DownloadedFile | null> {
      if (files.open) return null;
      const urls = [`${api()}/files/${encodeURIComponent(f.id)}`];
      if (f.url) {
        try {
          const u = new URL(f.url, origin());
          if (u.protocol === 'https:') urls.push(u.toString());
        } catch {
          /* unusable URL */
        }
      }
      let why = '';
      for (const url of urls) {
        try {
          const got = await ctx.http.bytes(url, { headers: { accept: '*/*' } });
          if (!/text\/html/i.test(got.contentType ?? '')) {
            files.ok();
            return got;
          }
          why ||= 'BambooHR sent a web page instead';
        } catch (err) {
          // A 401/403 here concerns this file, not the key, so it must not fail the job.
          if (retryLater(err) || httpStatus(err) === null) throw err;
          why ||= `HTTP ${httpStatus(err)}`;
        }
      }
      files.fail();
      ctx.warn(`Some BambooHR files could not be downloaded (${why})${ctx.options.activity ? ', so a note on the application names each one' : ''}`);
      if (files.open) ctx.warn('Stopped downloading BambooHR files after repeated failures. The API may not serve applicant files for this account.');
      return null;
    }

    async function importApplication(ctx: PhaseContext, row: ApplicationRow, walked: Outcome | null) {
      const id = String(row.id);
      // Re-runs add only what's new. Skipping imported applications saves their detail, comment and file calls.
      if (await ctx.load.has('opportunity', id)) return;

      const rowStatusId = row.status?.id != null ? String(row.status.id) : null;
      let outcome = await classify(ctx, rowStatusId, walked);
      if (!outcome) return ctx.warn('Applications marked Deleted in BambooHR were skipped');
      if (outcome !== 'active' && !ctx.options.archived) return;

      const d = await ctx.http.json<ApplicationDetail>(`${api()}/applicant_tracking/applications/${encodeURIComponent(id)}`);
      const statusId = d.status?.id != null ? String(d.status.id) : rowStatusId;
      if (statusId !== rowStatusId) {
        // Changed since the list page. The detail is newer, and its dateChanged and actor describe its status.
        outcome = await classify(ctx, statusId, null);
        if (!outcome) return ctx.warn('Applications marked Deleted in BambooHR were skipped');
        if (outcome !== 'active' && !ctx.options.archived) return;
      }

      const ap = d.applicant ?? row.applicant;
      if (ap?.id == null) throw new Error('Application has no applicant');
      const candidateId = String(ap.id);
      const createdAt = toDate(d.appliedDate ?? row.appliedDate);
      const changedAt = toDate(d.status?.dateChanged);

      const statuses = await statusIndex(ctx);
      const known = statusId ? statuses.get(statusId) : undefined;
      const current: StageRef | null = statusId
        ? { externalId: statusId, name: known ? statusName(known) : (d.status?.label ?? row.status?.label ?? null) }
        : null;
      const status = outcome;
      const archiveReason: ReasonRef | null =
        status === 'active' ? null : known?.code === 'MOVED' ? { externalId: statusId, name: MOVED_REASON } : current;
      // A "not hired" status is the reason, not a stage. BambooHR keeps no record of the stage before it.
      const stage = status === 'archived' ? null : current;
      const actor = d.status?.changedByUser?.id != null ? String(d.status.changedByUser.id) : null;
      const at = changedAt ?? createdAt;

      const leadEmployee = d.job?.hiringLead?.employeeId;
      const owner = leadEmployee ? ((await leadIndex(ctx)).get(String(leadEmployee)) ?? null) : null;

      const fields: Record<string, string> = {};
      const put = (label: string | null | undefined, value: string | null | undefined) => {
        const v = plain(value);
        if (label?.trim() && v) fields[label.trim()] = clip(v, 4000);
      };
      put('Referred by', d.referredBy);
      put('Desired salary', d.desiredSalary);
      put('Available start date', ap.availableStartDate);
      put('Education', cleanList([ap.education?.level?.label, ap.education?.institution]).join(', '));
      if (typeof d.applicationReferences === 'string') put('References', d.applicationReferences);
      for (const [label, moves] of [['Moved to', d.movedTo], ['Moved from', d.movedFrom]] as const) {
        if (moves != null && !(Array.isArray(moves) && !moves.length)) put(label, JSON.stringify(moves));
      }
      for (const qa of d.questionsAndAnswers ?? []) put(qa.question?.label, qa.answer?.label);
      const referrer = d.referredBy?.trim();

      // Every vendor call happens before anything is written. A step replayed
      // after a rate limit then redoes this application in full, whereas once
      // the opportunity exists, the skip above would drop its notes and files.
      const notes = await readComments(ctx, id, d);
      const fetched: (Attached & { got: DownloadedFile | null })[] = [];
      if (ctx.options.files) for (const f of attachedFiles(d)) fetched.push({ ...f, got: await download(ctx, f) });

      await ctx.load.application({
        externalId: id,
        candidateExternalId: candidateId,
        candidate: {
          externalId: candidateId,
          name: fullName(ap.firstName, ap.lastName),
          emails: cleanEmails([ap.email]),
          phones: cleanList([ap.phoneNumber]),
          links: cleanList([ap.linkedinUrl, ap.websiteUrl, twitterLink(ap.twitterUsername)]),
          location: place(ap.address),
          createdAt,
        },
        postingExternalId: d.job?.id != null ? String(d.job.id) : row.job?.id != null ? String(row.job.id) : null,
        stage,
        status,
        archiveReason,
        archivedAt: status === 'active' ? null : changedAt,
        origin: referrer && !NO_REFERRER.test(referrer) ? 'REFERRED' : 'APPLIED',
        source: sourceLabel(ap.source),
        ownerExternalUserId: owner,
        createdAt,
        history: stage && at ? [{ stage, at, actorExternalUserId: actor }] : [],
        fields,
      });

      if (ctx.options.activity) {
        const s = stars(d.rating ?? row.rating);
        if (s != null) {
          await ctx.load.feedback({
            externalId: `rating-${id}`,
            applicationExternalId: id,
            rating: STAR_RATING[s],
            summary: `Star rating: ${s}/5 (BambooHR does not record who rated or when)`,
            createdAt: at,
          });
        }
        for (const c of notes) {
          const text = plain(c.comment);
          if (c.id == null || !text) continue;
          await ctx.load.note({
            externalId: String(c.id),
            applicationExternalId: id,
            authorExternalUserId: c.userId != null ? String(c.userId) : null,
            authorName: fullName(c.userData?.firstName, c.userData?.lastName, '') || null,
            body: /<[a-z!/][^>]*>/i.test(text) ? htmlToText(text) : text,
            createdAt: toDate(c.dateCreated),
          });
        }
      }

      for (const f of fetched) {
        const got = f.got;
        if (got) {
          await ctx.load.file({
            externalId: f.id,
            candidateExternalId: candidateId,
            applicationExternalId: id,
            filename: f.name,
            kind: f.kind,
            download: async () => got,
          });
        } else {
          await ctx.load.note({
            externalId: `file-note-${f.id}`,
            applicationExternalId: id,
            body: `${f.label} is stored in BambooHR (file ID ${f.id}) but could not be downloaded through its API.`,
            createdAt,
          });
        }
      }
    }

    async function fetchApplications(ctx: PhaseContext, filter: WalkFilter, page: JsonValue): Promise<Page<ApplicationRow>> {
      const at = walkPage(page);
      const res = await ctx.http.json<ApplicationsPage | null>(`${api()}/applicant_tracking/applications`, {
        applicationStatus: filter.applicationStatus,
        jobStatusGroups: filter.jobStatusGroups,
        sortBy: 'created_date',
        sortOrder: 'ASC',
        newSince: ctx.since ? bambooTime(ctx.since) : undefined,
        page: at.n,
      });
      const items = res?.applications ?? [];
      if (items.length && items[0].id === at.prev) {
        ctx.warn('BambooHR returned the same page of applications twice, so one list was cut short');
        return { items: [], next: null };
      }
      // paginationComplete is the observed signal. nextPageUrl only counts when that flag is missing.
      const done = !items.length || (typeof res?.paginationComplete === 'boolean' ? res.paginationComplete : !res?.nextPageUrl);
      return { items, next: done ? null : { n: at.n + 1, prev: items[0].id } };
    }

    const walk = (ctx: PhaseContext, cursor: Cursor | null, filter: WalkFilter) =>
      pagedStep(
        ctx,
        cursor,
        async (page) => {
          if (filter.jobStatusGroups === 'ALL') return fetchApplications(ctx, filter, page);
          // A documented value whose behavior is untested: if BambooHR refuses it, finish without these applications.
          try {
            return await fetchApplications(ctx, filter, page);
          } catch (err) {
            if (transient(err) || httpStatus(err) === null) throw err;
            ctx.warn(`Applications on deleted jobs could not be listed (HTTP ${httpStatus(err)})`);
            return { items: [], next: null };
          }
        },
        (row) => importApplication(ctx, row, filter.outcome),
      );

    /** Every status at once, so an application moving between groups doesn't shift the pages. With archived off, the active groups. */
    const anyStatus = (ctx: PhaseContext, jobStatusGroups: WalkFilter['jobStatusGroups']): WalkFilter =>
      ctx.options.archived
        ? { applicationStatus: 'ALL', jobStatusGroups, outcome: null }
        : { applicationStatus: 'NEW,ACTIVE', jobStatusGroups, outcome: 'active' };

    const discover: Phase[] = [
      {
        id: 'users',
        label: 'Team',
        async run(ctx) {
          const users = await listUsers(ctx);
          for (const u of users) {
            if (u.id == null) continue;
            ctx.catalog.user({
              externalId: String(u.id),
              name: fullName(u.firstName, u.lastName, 'BambooHR user'),
              email: cleanEmails([u.email])[0] ?? null,
            });
          }
          if (users.length && users.every((u) => !u.email)) {
            ctx.warn("BambooHR shares teammates' emails only with admin keys, so imported activity can't be matched to your teammates. Use a key created by a Full Admin.");
          }
          return null;
        },
      },
      {
        id: 'statuses',
        label: 'Statuses',
        async run(ctx, cursor) {
          const statuses = await fetchStatuses(ctx.http);
          return listStep(ctx, cursor, statuses, async (s) => {
            const externalId = String(s.id);
            const code = s.code ?? null;
            if (code === 'DELETED') return;
            // Disabled means hidden from selection. Old applications can still hold one, and those need mapping.
            if (code && s.enabled === false && (await holds(ctx, externalId, 'ALL')) === false) return;
            if (code === 'MOVED') return ctx.catalog.reason({ externalId, name: MOVED_REASON, kind: 'withdrawn' });
            const name = statusName(s);
            const reasonKind = code ? REASON_CODES[code] : undefined;
            if (reasonKind) return ctx.catalog.reason({ externalId, name, kind: reasonKind });
            if (!code) {
              const reason = await customIsReason(ctx, s);
              if (reason === undefined) return;
              if (reason) return ctx.catalog.reason({ externalId, name, kind: WITHDRAWN.test(name) ? 'withdrawn' : 'other' });
            }
            const order = code ? STAGE_CODES.indexOf(code) : -1;
            ctx.catalog.stage({
              externalId,
              name,
              typeHint: code ? (STAGE_TYPES[code] ?? null) : null,
              position: order >= 0 ? order : STAGE_CODES.length + (Number(s.id) || 0),
            });
            if (code === 'HIRED') ctx.catalog.reason({ externalId, name, kind: 'hired' });
          });
        },
      },
    ];

    const load: Phase[] = [
      {
        id: 'postings',
        label: 'Jobs',
        async run(ctx, cursor) {
          const all = await ctx.http.json<BambooJob[] | null>(`${api()}/applicant_tracking/jobs`, {
            statusGroups: 'ALL',
            sortBy: 'created',
            sortOrder: 'ASC',
          });
          const jobs = Array.isArray(all) ? all : [];
          // ALL may leave out Deleted jobs. Appended, so the indexes of the others stay put between steps.
          for (const job of await deletedJobs(ctx)) if (!jobs.some((j) => j.id === job.id)) jobs.push(job);
          return listStep(ctx, cursor, jobs, async (job) => {
            const id = String(job.id);
            if (await ctx.load.has('posting', id)) return;
            const state = postingState(job.status);
            const opening = state === 'open' ? await jobOpening(ctx, id) : null;
            const description = [
              htmlToText(opening?.description),
              opening?.compensation?.trim() ? `Compensation: ${opening.compensation.trim()}` : '',
              opening?.minimumExperience?.trim() ? `Minimum experience: ${opening.minimumExperience.trim()}` : '',
            ]
              .filter(Boolean)
              .join('\n\n');
            await ctx.load.posting({
              externalId: id,
              title: job.title?.label?.trim() || `BambooHR job ${id}`,
              state,
              department: job.department?.label?.trim() || null,
              location: place(job.location?.address, job.location?.label),
              commitment: commitment(opening?.employmentStatusLabel),
              workplaceType: workplace(opening?.locationType),
              description: description || null,
              // Approximate: it's the posted date, and a Draft's changes over time.
              createdAt: toDate(job.postedDate),
            });
          });
        },
      },
      ...GROUP_WALKS.map(
        (w): Phase => ({
          id: w.id,
          label: w.label,
          enabled: w.outcome === 'active' ? undefined : (o) => o.archived,
          run: (ctx, cursor) => walk(ctx, cursor, { applicationStatus: w.group, jobStatusGroups: 'ALL', outcome: w.outcome }),
        }),
      ),
      {
        id: 'applications-sweep',
        label: 'Applications that changed status',
        run: (ctx, cursor) => walk(ctx, cursor, anyStatus(ctx, 'ALL')),
      },
      {
        id: 'applications-deleted-jobs',
        label: 'Applications on deleted jobs',
        run: (ctx, cursor) => walk(ctx, cursor, anyStatus(ctx, 'Deleted')),
      },
    ];

    return {
      async verify() {
        const base = api();
        // Proves the key and its ATS settings access. 401 = bad key, 403 = no ATS access, 404 = wrong subdomain.
        await http.json(`${base}/applicant_tracking/statuses`);
        try {
          const info = await http.json<{ displayName?: string | null; legalName?: string | null } | null>(`${base}/company_information`);
          const name = info?.displayName?.trim() || info?.legalName?.trim();
          if (name) return { accountName: name };
        } catch (err) {
          if (transient(err) || (err instanceof ImportAuthError && err.status === 401)) throw err;
        }
        return { accountName: `${domain}.bamboohr.com` };
      },
      discover,
      load,
    };
  },
};
