import type { Commitment, OfferStatus, Origin, WorkplaceType } from '@prisma/client';
import {
  describe as describeRequest,
  ImportAuthError,
  ImportHttpError,
  type AuthConfig,
  type HttpClient,
  type QueryValue,
} from '@/server/imports/http';
import { inferStageType } from '@/server/imports/mapping';
import { optional, pagedStep, type Page } from '@/server/imports/paging';
import { cleanEmails, cleanList, clip, fullName, htmlToText, toDate } from '@/server/imports/text';
import type {
  Credentials,
  Cursor,
  DownloadedFile,
  ImportedApplication,
  ImportedCandidate,
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
 * Merge (Unified ATS API): the long tail. Workday, iCIMS, SAP SuccessFactors,
 * Oracle Taleo, Jobvite, Breezy HR and ~55 more ATSs, read through Merge's
 * normalized Common Models with the customer's own Merge API key and the
 * Linked Account token for their ATS.
 *
 * Vendor quirks handled here:
 * - Region: a key and token only work on the host of the dashboard they came
 *   from (api / api-eu / api-ap .merge.dev), always under /api/ats/v1.
 * - Auth is two headers: `Authorization: Bearer <key>` + `X-Account-Token`.
 * - Every model is an org-wide list paged by cursor ({next, previous,
 *   results}; `next` is a bare token, page_size max 100). There are no sort
 *   params; a cursor pins a position, so a resumed step refetches its page.
 * - `expand` swaps an id for the object under the same key, at no extra
 *   request: applications carry their candidate, stage, job, offers, reject
 *   reason and screening answers (with their questions); jobs carry
 *   departments, offices and postings; notes and scorecards carry their
 *   author, scorecards their interview. Relations are parsed as
 *   `string | object`. Applications repeat their job (HTML description and
 *   all) on every row, so they are paged 50 at a time.
 * - Merge is a synced cache, not a live proxy. Before discovery we warn when
 *   the linked account is idle or a test account (those never resync on
 *   their own), when a model's sync failed or is still on its first run, and
 *   when a Scope turns a model off: Merge then returns it empty, not an error.
 * - `created_at`/`modified_at` and the `created_after` filter are Merge's own
 *   sync times, not the ATS's, so `since` is left to the loader. Applications
 *   have no remote timestamps and often no applied_at (iCIMS,
 *   SmartRecruiters). Those are dated from the later of the candidate's and
 *   the job's creation, the earliest the application can be, so `since`
 *   still drops what is provably older. Applications have no status filter,
 *   so `archived` is also applied by the loader.
 * - Coverage varies by ATS. Anything beyond jobs, candidates and applications
 *   is optional: a 403/404 (or a 400 for a model the ATS lacks) warns and
 *   moves on. For those three, a 400/404 on the first page also means "this
 *   ATS doesn't have it", while 401/403 still fail the import.
 * - Applications have no status and no stage history. Hired = a SIGNED offer
 *   or a hired-type current stage; archived = rejected, a current stage that
 *   records an outcome ("Rejected", "Not Selected", "Hired Elsewhere"), or
 *   still open on a CLOSED/ARCHIVED job. Outcome stages are offered for
 *   mapping as rejection reasons, not as pipeline stages. History is one
 *   synthetic entry: the current stage at applied_at, or at the signed
 *   offer's closed_at for a hire, which reports read as the hire date.
 * - Activities (notes) link only to a candidate; the loader files them on the
 *   candidate's latest application. Scorecards carry only an overall
 *   recommendation; NO_DECISION is kept as a note.
 * - Attachment `file_url`s may be pre-signed, may expire, and often live on
 *   the ATS's own file host (which never sees Merge credentials). Files are
 *   downloaded as each page is listed; a link refused as expired is
 *   refreshed once via GET /attachments/{id}, and after 10 failed downloads
 *   in a row the rest are skipped rather than costing two requests each.
 * - externalIds are Merge ids, because every relation references them
 *   (activities can't expand their candidate, and remote_id is nullable and
 *   not guaranteed unique). Merge issues new ids when the ATS is relinked,
 *   and each linked account (test or production) has its own, so re-run from
 *   the same link.
 */

const HOSTS: Record<string, string> = { us: 'api.merge.dev', eu: 'api-eu.merge.dev', ap: 'api-ap.merge.dev' };
const MERGE_HOSTS = new Set(Object.values(HOSTS));
const PAGE_SIZE = 100;
const APPLICATION_PAGE_SIZE = 50;
const APPLICATION_EXPAND =
  'candidate,current_stage,job,offers,reject_reason,screening_question_answers,screening_question_answers.question';
/** Failed attachment downloads in a row after which the rest are skipped. */
const DOWNLOAD_GIVE_UP = 10;
/** Expired pre-signed links: S3 and Azure answer 403, GCS 400. A 404 is a missing file, not a stale link. */
const REFRESH_ON = new Set([400, 401, 403, 410]);

// ---------- Merge payloads (only the keys read here) ----------

type MergeObject = {
  id: string;
  remote_id?: string | null;
  remote_was_deleted?: boolean | null;
  field_mappings?: {
    organization_defined_targets?: Record<string, unknown> | null;
    linked_account_defined_targets?: Record<string, unknown> | null;
  } | null;
};

/** A relation: the Merge id, or the object itself when `expand` asked for it. */
type Rel<T extends MergeObject = MergeObject> = string | T | null | undefined;

type MergeList<T> = { next?: string | null; previous?: string | null; results?: T[] | null };

type MergeAccountDetails = {
  integration?: string | null;
  category?: string | null;
  end_user_organization_name?: string | null;
  status?: string | null;
  account_type?: string | null;
};

type MergeSyncStatus = { model_name?: string; status?: string; is_initial_sync?: boolean };

type MergeScope = {
  model_name?: string | null;
  model_permissions?: { READ?: { is_enabled?: boolean | null } | null } | null;
  field_permissions?: { disabled_fields?: (string | null)[] | null } | null;
};

type MergeUser = MergeObject & { first_name?: string | null; last_name?: string | null; email?: string | null };

type MergeStage = MergeObject & { name?: string | null; stage_order?: number | null };

type MergeNamed = MergeObject & { name?: string | null };

type MergeOffice = MergeObject & { name?: string | null; location?: string | null };

type MergeJobPosting = MergeObject & { title?: string | null; status?: string | null; content?: string | null; is_internal?: boolean | null };

type MergeJob = MergeObject & {
  name?: string | null;
  description?: string | null;
  code?: string | null;
  status?: string | null;
  type?: string | null;
  job_postings?: Rel<MergeJobPosting>[] | null;
  remote_created_at?: string | null;
  remote_updated_at?: string | null;
  confidential?: boolean | null;
  departments?: Rel<MergeNamed>[] | null;
  offices?: Rel<MergeOffice>[] | null;
  recruiters?: Rel[] | null;
};

type MergeContactValue = { value?: string | null; url_type?: string | null };

type MergeCandidate = MergeObject & {
  first_name?: string | null;
  last_name?: string | null;
  company?: string | null;
  title?: string | null;
  remote_created_at?: string | null;
  is_private?: boolean | null;
  locations?: (string | null)[] | null;
  phone_numbers?: MergeContactValue[] | null;
  email_addresses?: MergeContactValue[] | null;
  urls?: MergeContactValue[] | null;
  tags?: (string | { name?: string | null } | null)[] | null;
  applications?: Rel<MergeObject & { applied_at?: string | null }>[] | null;
};

type MergeOffer = MergeObject & {
  application?: Rel;
  remote_created_at?: string | null;
  closed_at?: string | null;
  sent_at?: string | null;
  start_date?: string | null;
  status?: string | null;
};

type MergeScreeningQuestion = MergeObject & { title?: string | null; description?: string | null };

type MergeScreeningAnswer = MergeObject & { question?: Rel<MergeScreeningQuestion>; answer?: string | null };

type MergeApplication = MergeObject & {
  candidate?: Rel<MergeCandidate>;
  job?: Rel<MergeJob>;
  applied_at?: string | null;
  rejected_at?: string | null;
  offers?: Rel<MergeOffer>[] | null;
  source?: string | null;
  credited_to?: Rel;
  current_stage?: Rel<MergeStage>;
  reject_reason?: Rel<MergeNamed>;
  screening_question_answers?: Rel<MergeScreeningAnswer>[] | null;
};

type MergeActivity = MergeObject & {
  user?: Rel<MergeUser>;
  remote_created_at?: string | null;
  activity_type?: string | null;
  subject?: string | null;
  body?: string | null;
  visibility?: string | null;
  candidate?: Rel;
};

type MergeInterview = MergeObject & {
  application?: Rel;
  job_interview_stage?: Rel<MergeStage>;
  interviewers?: Rel[] | null;
  location?: string | null;
  start_at?: string | null;
  end_at?: string | null;
  status?: string | null;
};

type MergeScorecard = MergeObject & {
  application?: Rel;
  interview?: Rel<MergeInterview>;
  interviewer?: Rel<MergeUser>;
  remote_created_at?: string | null;
  submitted_at?: string | null;
  overall_recommendation?: string | null;
};

type MergeAttachment = MergeObject & {
  file_name?: string | null;
  file_url?: string | null;
  candidate?: Rel;
  attachment_type?: string | null;
};

// ---------- helpers ----------

function relId(rel: Rel<MergeObject>): string | null {
  if (!rel) return null;
  if (typeof rel === 'string') return rel;
  return rel.id ? String(rel.id) : null;
}

function relObj<T extends MergeObject>(rel: Rel<T>): T | null {
  return rel && typeof rel === 'object' ? rel : null;
}

function objects<T extends MergeObject>(rels: Rel<T>[] | null | undefined): T[] {
  return (rels ?? []).map((r) => relObj(r)).filter((r): r is T => !!r);
}

function latest(...dates: (Date | null)[]): Date | null {
  const times = dates.filter((d): d is Date => !!d).map((d) => d.getTime());
  return times.length ? new Date(Math.max(...times)) : null;
}

function regionHost(credentials: Credentials): string {
  const region = (credentials.region || 'us').trim().toLowerCase();
  const host = HOSTS[region === 'apac' ? 'ap' : region];
  if (!host) throw new Error(`Unknown Merge region "${region.slice(0, 20)}". Pick US, EU or APAC.`);
  return host;
}

function apiRoot(credentials: Credentials): string {
  return `https://${regionHost(credentials)}/api/ats/v1`;
}

function personName(user: MergeUser | null): string | null {
  if (!user) return null;
  return fullName(user.first_name, user.last_name, user.email?.trim() ?? '') || null;
}

/** HTML only when it looks like markup; plain-text notes may contain a bare "<". */
function textOf(value: string | null | undefined): string {
  if (!value) return '';
  return /<\/?(p|div|br|span|ul|ol|li|a|b|i|u|strong|em|h[1-6]|table|tr|td|blockquote)\b[^>]*>/i.test(value)
    ? htmlToText(value)
    : value.trim();
}

/** Pro+ Field Mapping values (and the ATS's own id) worth keeping on the opportunity. */
function mappedFields(...objs: (MergeObject | null)[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const obj of objs) {
    const targets = [obj?.field_mappings?.organization_defined_targets, obj?.field_mappings?.linked_account_defined_targets];
    for (const [key, raw] of targets.flatMap((t) => Object.entries(t ?? {}))) {
      const value =
        raw == null
          ? ''
          : typeof raw === 'object'
            ? Array.isArray(raw) && raw.every((v) => typeof v !== 'object')
              ? raw.join(', ')
              : JSON.stringify(raw)
            : String(raw);
      if (value.trim()) out[key] = value.trim().slice(0, 2000);
    }
  }
  return out;
}

/** Merge's start_date is midnight UTC; keep the calendar date, never shift it. */
function dateOnly(value: string | null | undefined): Date | null {
  const day = value ? /^(\d{4}-\d{2}-\d{2})/.exec(value) : null;
  return day ? new Date(`${day[1]}T00:00:00Z`) : toDate(value);
}

/**
 * Stage names that record how an application ended rather than a step in the
 * pipeline. Many ATSs share rejections through Merge only this way, and
 * negated hires ("Not Hired", "Hired Elsewhere") must never count as hires.
 */
const OUTCOME_STAGE =
  /reject|disqualif|declin|withdr[ae]w|\bnot (selected|a fit|qualified|suitable|hired|moving forward|progressed)\b|\b(over|under)[- ]?qualified\b|\b(no|not|do not|don't|never) hire\b|\belsewhere\b|\b(another|other) (req|requisition|job|position|role|candidate)\b/i;

function reasonKind(name: string): ReasonKind {
  if (/withdr[ae]w|declin|not interested|\belsewhere\b|(accepted|took) (another|other)/i.test(name)) return 'withdrawn';
  // Someone else got the job: the company's call, but not about this candidate.
  if (/duplicate|\bfilled\b|on hold|cancell?ed|\b(another|other) (req|requisition|job|position|role|candidate)\b/i.test(name)) return 'other';
  if (/\b(not|no|do not|don't|never) hired?\b/i.test(name)) return 'rejection';
  if (/\bhired\b/i.test(name)) return 'hired';
  return 'rejection';
}

/** Merge has only a free-text `source` on applications. */
function originFrom(source: string | null | undefined): Origin | null {
  const s = source?.trim().toLowerCase();
  if (!s) return null;
  if (/refer/.test(s)) return 'REFERRED';
  if (/agency|staffing|recruitment firm|headhunt/.test(s)) return 'AGENCY';
  if (/internal|employee transfer|mobility/.test(s)) return 'INTERNAL';
  if (/campus|university|college|career fair/.test(s)) return 'UNIVERSITY';
  if (/sourc|linkedin recruiter|outbound|prospect/.test(s)) return 'SOURCED';
  return 'APPLIED';
}

/** Merge has no employment type; only unambiguous title words count. */
function commitmentFrom(title: string): Commitment | null {
  if (/\bintern(ship)?\b|\bco-?op\b/i.test(title)) return 'INTERNSHIP';
  if (/\bpart[- ]time\b/i.test(title)) return 'PART_TIME';
  return null;
}

/** Merge has no workplace type; office names like "Remote - US" are the only signal. */
function workplaceFrom(offices: MergeOffice[]): WorkplaceType | null {
  const labels = offices.map((o) => `${o.name ?? ''} ${o.location ?? ''}`);
  if (labels.some((l) => /hybrid/i.test(l))) return 'HYBRID';
  const remote = labels.filter((l) => /remote|anywhere|virtual/i.test(l)).length;
  if (!remote) return null;
  return remote === labels.length ? 'REMOTE' : 'HYBRID';
}

function postingState(status: string | null, postings: MergeJobPosting[]): ImportedPosting['state'] {
  if (status === 'OPEN') {
    const internalOnly = postings.length > 0 && postings.every((p) => p.is_internal || p.status?.toUpperCase() === 'INTERNAL');
    return internalOnly ? 'internal' : 'open';
  }
  if (status === 'DRAFT' || status === 'PENDING') return 'draft';
  return 'closed'; // CLOSED, ARCHIVED, or unknown
}

const RATINGS: Record<string, { rating: 1 | 2 | 3 | 4; label: string }> = {
  DEFINITELY_NO: { rating: 1, label: 'Definitely no' },
  NO: { rating: 2, label: 'No' },
  YES: { rating: 3, label: 'Yes' },
  STRONG_YES: { rating: 4, label: 'Strong yes' },
};

const OFFER_STATUS: Record<string, OfferStatus> = {
  DRAFT: 'DRAFT',
  'APPROVAL-SENT': 'PENDING_APPROVAL',
  APPROVED: 'DRAFT',
  SENT: 'SENT',
  'SENT-MANUALLY': 'SENT',
  OPENED: 'SENT',
  SIGNED: 'ACCEPTED',
  DENIED: 'DECLINED',
  DEPRECATED: 'WITHDRAWN',
};

/** What the Source status alone would lose. */
const OFFER_NOTES: Record<string, string> = {
  APPROVED: 'Approved in the ATS but not yet sent.',
  OPENED: 'The candidate had opened the offer.',
  'SENT-MANUALLY': 'Sent outside the ATS.',
  DEPRECATED: 'Superseded by a newer offer in the ATS.',
};

/** Merge model names this import reads, how to say them, and the option that turns them on (none: always read). */
const WATCHED_MODELS = new Map<string, { label: string; option?: 'activity' | 'files' }>([
  ['Candidate', { label: 'candidates' }],
  ['Application', { label: 'applications' }],
  ['Job', { label: 'jobs' }],
  ['JobInterviewStage', { label: 'pipeline stages' }],
  ['RejectReason', { label: 'rejection reasons' }],
  ['RemoteUser', { label: 'users' }],
  ['Activity', { label: 'notes', option: 'activity' }],
  ['Scorecard', { label: 'scorecards', option: 'activity' }],
  ['ScheduledInterview', { label: 'interviews', option: 'activity' }],
  // Read even with offers turned off: a signed offer is how a hire shows up.
  ['Offer', { label: 'offers' }],
  ['Attachment', { label: 'attachments', option: 'files' }],
]);

function watchedLabel(ctx: PhaseContext, model: string | null | undefined): string | null {
  const m = model ? WATCHED_MODELS.get(model) : undefined;
  return m && (!m.option || ctx.options[m.option]) ? m.label : null;
}

const SINCE = "the 'added since' date";

function undated(what: string, since: boolean): string {
  return `Some ${what} have no date in this ATS, so they're dated to the import${since ? ` and ${SINCE} couldn't be applied to them` : ''}`;
}

function toCandidate(c: MergeCandidate, fallbackCreatedAt: Date | null = null): ImportedCandidate {
  const emails = cleanEmails((c.email_addresses ?? []).map((e) => e?.value));
  const title = c.title?.trim();
  const company = c.company?.trim();
  const applied = objects(c.applications)
    .map((a) => toDate(a.applied_at)?.getTime())
    .filter((t): t is number => t != null);
  return {
    externalId: String(c.id),
    name: fullName(c.first_name, c.last_name, emails[0] ?? 'Unknown candidate'),
    emails,
    phones: cleanList((c.phone_numbers ?? []).map((p) => p?.value)),
    links: cleanList((c.urls ?? []).filter((u) => u?.url_type !== 'JOB_POSTING').map((u) => u?.value)),
    headline: title && company ? `${title} at ${company}` : title || company || null,
    location: cleanList(c.locations ?? [])[0] ?? null,
    tags: cleanList((c.tags ?? []).map((t) => (typeof t === 'string' ? t : t?.name))),
    // Merge's created_at is when Merge synced the row; fall back to the first application instead.
    createdAt: toDate(c.remote_created_at) ?? (applied.length ? new Date(Math.min(...applied)) : fallbackCreatedAt),
  };
}

/** How an application got its date: applied_at, the earliest it can be, or none at all. */
type ApplicationDating = 'applied' | 'bound' | 'none';

type ApplicationFacts = {
  app: ImportedApplication;
  dating: ApplicationDating;
  /** Archived only because its job is closed. */
  closedJob: boolean;
  /** Owner candidates, most preferred first. */
  owners: string[];
};

function toApplication(a: MergeApplication, candidateId: string): ApplicationFacts {
  const candidate = relObj(a.candidate);
  const job = relObj(a.job);
  const stageId = relId(a.current_stage);
  const stageName = relObj(a.current_stage)?.name?.trim() || null;
  const outcome = !!stageId && !!stageName && OUTCOME_STAGE.test(stageName);
  const reasonId = relId(a.reject_reason);
  const signed = objects(a.offers).find((o) => o.status?.toUpperCase() === 'SIGNED');
  const jobStatus = job?.status?.toUpperCase() ?? null;

  // An application can't predate its candidate or its job: without applied_at,
  // the later of the two is the earliest it can be.
  const appliedAt = toDate(a.applied_at);
  const bound = latest(toDate(candidate?.remote_created_at), toDate(job?.remote_created_at));
  const createdAt = appliedAt ?? bound;

  const outcomeReason: ReasonRef | null = outcome ? { externalId: `stage:${stageId}`, name: stageName } : null;
  let status: ImportedApplication['status'] = 'active';
  let archivedAt: Date | null = null;
  let archiveReason: ReasonRef | null = null;
  let closedJob = false;
  if (signed) {
    status = 'hired';
    archivedAt = toDate(signed.closed_at);
  } else if (a.rejected_at || reasonId) {
    status = 'archived';
    archivedAt = toDate(a.rejected_at);
    archiveReason = reasonId ? { externalId: reasonId, name: relObj(a.reject_reason)?.name ?? null } : outcomeReason;
  } else if (outcome) {
    status = 'archived';
    archiveReason = outcomeReason;
  } else if (stageName && inferStageType(stageName) === 'HIRED') {
    status = 'hired';
  } else if (jobStatus === 'CLOSED' || jobStatus === 'ARCHIVED') {
    // Merge has no application status: an application left open on a closed job is over.
    status = 'archived';
    archivedAt = toDate(job?.remote_updated_at);
    closedJob = true;
  }
  if (archivedAt && createdAt && archivedAt < createdAt) archivedAt = null;

  // An outcome stage is not a pipeline step: the loader parks the application in
  // the first applicant stage. A hire with no usable stage goes to Hired.
  let stage: StageRef | null = stageId && !outcome ? { externalId: stageId, name: stageName } : null;
  if (status === 'hired' && !stage?.name) stage = { name: 'Hired' };
  // No stage history in Merge: one entry for where it sits now. For a hire that
  // is the hire itself, which reports read as the hire date.
  const enteredAt = status === 'hired' && archivedAt ? archivedAt : createdAt;

  const fields = mappedFields(candidate, a);
  if (a.remote_id) fields.remote_id = String(a.remote_id);
  for (const item of a.screening_question_answers ?? []) {
    const answer = relObj(item);
    const question = relObj(answer?.question);
    const label = question?.title?.trim() || question?.description?.trim();
    const text = answer?.answer?.trim();
    if (label && text && !answer?.remote_was_deleted) fields[clip(label, 200)] = clip(text, 4000);
  }

  const owners = cleanList([...(job?.recruiters ?? []).map(relId), relId(a.credited_to)]);

  return {
    app: {
      externalId: String(a.id),
      candidateExternalId: candidateId,
      candidate: candidate && !candidate.remote_was_deleted ? toCandidate(candidate, createdAt) : null,
      postingExternalId: relId(a.job),
      stage,
      status,
      archiveReason: status === 'archived' ? archiveReason : null,
      archivedAt,
      origin: originFrom(a.source),
      source: a.source?.trim() || null,
      ownerExternalUserId: owners[0] ?? null,
      confidential: job?.confidential === true || candidate?.is_private === true,
      createdAt,
      // `{}` resolves to the same fallback stage as a null `stage`.
      history: enteredAt ? [{ stage: stage ?? {}, at: enteredAt }] : [],
      fields,
    },
    dating: appliedAt ? 'applied' : bound ? 'bound' : 'none',
    closedJob,
    owners,
  };
}

function undatedApplications(dating: Exclude<ApplicationDating, 'applied'>, since: boolean): string {
  if (dating === 'none') return undated('applications', since);
  return (
    "Some applications have no application date in this ATS, so they're dated from when the candidate or job was added" +
    (since ? `. ${SINCE[0].toUpperCase()}${SINCE.slice(1)} was checked against that, which can leave out a recent application by an older candidate to an older job` : '')
  );
}

/** The first of these users who is a Source teammate; else the first (the loader leaves an unknown owner empty). */
async function firstTeammate(ctx: PhaseContext, ids: string[]): Promise<string | null> {
  for (const id of ids) if (await ctx.load.has('user', id)) return id;
  return ids[0] ?? null;
}

function fileKind(type: string | null | undefined, filename: string): 'resume' | 'other' {
  const t = type?.toUpperCase();
  if (t === 'RESUME') return 'resume';
  if (!t && /(^|[^a-z])(resume|résumé|cv|curriculum)([^a-z]|$)/i.test(filename)) return 'resume';
  return 'other';
}

/** The client adds Merge credentials to any Merge host whatever the scheme, so those links must be HTTPS. */
function safeLink(url: string): string {
  const target = new URL(url);
  if (MERGE_HOSTS.has(target.host) && target.protocol !== 'https:') {
    throw new ImportHttpError(400, describeRequest('GET', target), 'refusing a Merge link that is not HTTPS');
  }
  return url;
}

async function fetchFile(http: HttpClient, url: string): Promise<DownloadedFile> {
  try {
    return await http.bytes(safeLink(url));
  } catch (err) {
    // A Merge-hosted link that refuses one file is a problem with that file, not with the key.
    if (err instanceof ImportAuthError) throw new ImportHttpError(err.status, err.where);
    throw err;
  }
}

async function downloadAttachment(http: HttpClient, root: string, id: string, url: string): Promise<DownloadedFile> {
  safeLink(url); // refused outright, not worth a refresh
  try {
    return await fetchFile(http, url);
  } catch (err) {
    if (!(err instanceof ImportHttpError) || !REFRESH_ON.has(err.status)) throw err;
    // Pre-signed links expire: ask Merge for the attachment once more for a fresh one.
    let fresh: string | null;
    try {
      fresh = (await http.json<MergeAttachment>(`${root}/attachments/${encodeURIComponent(id)}`))?.file_url?.trim() || null;
    } catch (refreshErr) {
      // A rejected key fails the import; anything else is this file's problem.
      if (refreshErr instanceof ImportAuthError && refreshErr.status === 401) throw refreshErr;
      if (refreshErr instanceof ImportAuthError || refreshErr instanceof ImportHttpError) throw err;
      throw refreshErr;
    }
    if (!fresh || fresh === url) throw err;
    return fetchFile(http, fresh);
  }
}

// ---------- paging ----------

function lister<T extends MergeObject>(
  ctx: PhaseContext,
  url: string,
  params: Record<string, QueryValue> = {},
  pageSize = PAGE_SIZE,
) {
  return async (page: JsonValue): Promise<Page<T>> => {
    // Merge requires every param but cursor/page_size to stay identical across pages.
    const data = await ctx.http.json<MergeList<T>>(url, {
      page_size: pageSize,
      ...params,
      cursor: typeof page === 'string' ? page : undefined,
    });
    return { items: (data?.results ?? []).filter((r) => r && !r.remote_was_deleted), next: data?.next || null };
  };
}

/** A model this ATS may not support, or this token may not be scoped for: warn and skip it. */
function optionalModel<T>(ctx: PhaseContext, what: string, fetchPage: (page: JsonValue) => Promise<Page<T>>) {
  const none: Page<T> = { items: [], next: null };
  return (page: JsonValue) =>
    optional(
      ctx,
      `${what} skipped`,
      async () => {
        try {
          return await fetchPage(page);
        } catch (err) {
          // How Merge answers for a model an integration lacks is undocumented; treat a 400 like a 404.
          if (err instanceof ImportHttpError && (err.status === 400 || err.status === 422)) {
            ctx.warn(`${what} skipped: ${err.message}`);
            return none;
          }
          throw err;
        }
      },
      none,
    );
}

/**
 * Jobs, candidates and applications: 12 of Merge's ATSs have no applications
 * and some no candidates. A 400/404 on the first page means the ATS lacks the
 * model, so the phase is empty rather than failed; 401/403 still fail loudly.
 */
function coreModel<T>(ctx: PhaseContext, label: string, fetchPage: (page: JsonValue) => Promise<Page<T>>) {
  return async (page: JsonValue): Promise<Page<T>> => {
    try {
      return await fetchPage(page);
    } catch (err) {
      if (page === null && err instanceof ImportHttpError && [400, 404, 422].includes(err.status)) {
        ctx.warn(`Merge doesn't provide ${label} for this ATS, so none were imported: ${err.message}`);
        return { items: [], next: null };
      }
      throw err;
    }
  };
}

/** Warn when Merge's copy of the ATS is incomplete, stale, or scoped down; Merge is a synced cache, not a live proxy. */
async function syncPreflight(ctx: PhaseContext, root: string) {
  const details = await optional(
    ctx,
    'Could not read the Merge linked account',
    () => ctx.http.json<MergeAccountDetails>(`${root}/account-details`),
    null,
  );
  const status = details?.status?.trim().toUpperCase();
  if (status === 'IDLE') {
    ctx.warn(
      "Merge marks this linked account as idle, so its copy of your ATS may be out of date. Resync it in the Merge dashboard, then run the import again; re-runs only add what's new.",
    );
  } else if (status === 'RELINK_NEEDED' || status === 'INCOMPLETE') {
    ctx.warn('Merge says this linked account needs to be relinked, so its data may be incomplete. Relink it under Linked Accounts in the Merge dashboard.');
  } else if (status && status !== 'COMPLETE') {
    ctx.warn(`Merge reports this linked account as "${status.slice(0, 40)}", so its data may be incomplete or out of date.`);
  }
  const type = details?.account_type?.trim().toUpperCase();
  if (type && type !== 'PRODUCTION') {
    ctx.warn(
      "This is a Merge test linked account. It doesn't resync on its own, so resync it in the Merge dashboard before importing. Each linked account has its own ids, so importing later from a production linked account would add every record again.",
    );
  }

  const sync = await optional(
    ctx,
    'Could not read Merge sync status',
    () => ctx.http.json<MergeList<MergeSyncStatus>>(`${root}/sync-status`, { page_size: PAGE_SIZE }),
    null,
  );
  for (const s of sync?.results ?? []) {
    const label = watchedLabel(ctx, s.model_name);
    const state = s.status?.toUpperCase();
    if (!label || !state) continue;
    if (state === 'SYNCING' && s.is_initial_sync) {
      ctx.warn(`Merge is still running its first sync of ${label}, so some may be missing. Run the import again once it finishes; re-runs only add what's new.`);
    } else if (state === 'FAILED' || state === 'DISABLED' || state === 'PAUSED') {
      ctx.warn(`Merge's sync of ${label} is ${state.toLowerCase()}, so they may be missing or out of date. Check the linked account in the Merge dashboard.`);
    }
  }

  // A disabled Scope doesn't error: Merge answers with nulls and empty lists.
  const scopes = await optional(
    ctx,
    'Could not read Merge scopes',
    () => ctx.http.json<{ common_models?: MergeScope[] | null }>(`${root}/linked-account-scopes`),
    null,
  );
  for (const m of scopes?.common_models ?? []) {
    const label = watchedLabel(ctx, m?.model_name);
    if (!label) continue;
    if (m.model_permissions?.READ?.is_enabled === false) {
      ctx.warn(`Merge's Scopes turn off reading ${label} for this linked account, so Merge returns them empty. Turn them on under Scopes in the Merge dashboard, then run the import again.`);
      continue;
    }
    const hidden = cleanList(m.field_permissions?.disabled_fields ?? []);
    if (hidden.length) {
      ctx.warn(`Merge's Scopes hide some fields of ${label} for this linked account (${hidden.slice(0, 8).join(', ')}), so those come back empty.`);
    }
  }
}

// ---------- the module ----------

export const mergeProvider: ProviderModule = {
  id: 'merge',
  // Launch plan: 100 requests/min per linked account. ~85/min leaves room for the dashboard and retries.
  minIntervalMs: 700,

  auth(credentials): AuthConfig {
    const headers: Record<string, string> = {};
    const key = credentials.apiKey?.trim().replace(/^bearer\s+/i, '');
    const token = credentials.accountToken?.trim();
    if (key) headers.Authorization = `Bearer ${key}`;
    if (token) headers['X-Account-Token'] = token;
    return { hosts: Object.values(HOSTS), headers };
  },

  create(credentials, http) {
    const root = () => apiRoot(credentials);

    const discover: Phase[] = [
      {
        id: 'users',
        label: 'Team members',
        async run(ctx, cursor) {
          if (cursor === null) await syncPreflight(ctx, root());
          return pagedStep(ctx, cursor, optionalModel(ctx, 'Users', lister<MergeUser>(ctx, `${root()}/users`)), async (u) => {
            ctx.catalog.user({
              externalId: String(u.id),
              name: personName(u) ?? 'Unknown user',
              email: cleanEmails([u.email])[0] ?? null,
            });
          });
        },
      },
      {
        id: 'stages',
        label: 'Pipeline stages',
        run: (ctx, cursor) =>
          pagedStep(
            ctx,
            cursor,
            optionalModel(ctx, 'Pipeline stages', lister<MergeStage>(ctx, `${root()}/job-interview-stages`)),
            async (s) => {
              const name = s.name?.trim();
              if (!name) return;
              // "Rejected" or "Hired Elsewhere" is how an application ended: map it as a reason, not a stage.
              if (OUTCOME_STAGE.test(name)) return ctx.catalog.reason({ externalId: `stage:${s.id}`, name, kind: reasonKind(name) });
              // Merge has no stage type; the engine infers one from the name.
              ctx.catalog.stage({ externalId: String(s.id), name, position: s.stage_order ?? null });
            },
          ),
      },
      {
        id: 'reasons',
        label: 'Rejection reasons',
        run: (ctx, cursor) =>
          pagedStep(
            ctx,
            cursor,
            optionalModel(ctx, 'Rejection reasons', lister<MergeNamed>(ctx, `${root()}/reject-reasons`)),
            async (r) => {
              const name = r.name?.trim();
              if (name) ctx.catalog.reason({ externalId: String(r.id), name, kind: reasonKind(name) });
            },
          ),
      },
    ];

    const load: Phase[] = [
      {
        // A Merge Job is both the requisition and the role; one pass writes both.
        id: 'jobs',
        label: 'Jobs & requisitions',
        run: (ctx, cursor) =>
          pagedStep(
            ctx,
            cursor,
            coreModel(ctx, 'jobs', lister<MergeJob>(ctx, `${root()}/jobs`, { expand: 'departments,job_postings,offices' })),
            async (job) => {
              const id = String(job.id);
              const postings = objects(job.job_postings);
              const offices = objects(job.offices);
              const status = job.status?.toUpperCase() ?? null;
              const title = job.name?.trim() || postings[0]?.title?.trim() || 'Untitled job';
              const code = job.code?.trim() || (job.type === 'REQUISITION' ? job.remote_id?.trim() : null) || null;
              if (code) {
                await ctx.load.requisition({
                  externalId: id,
                  code,
                  title,
                  state: status === 'OPEN' ? 'open' : status === 'DRAFT' || status === 'PENDING' ? 'on_hold' : 'closed',
                });
              }
              const office = offices[0];
              await ctx.load.posting({
                externalId: id,
                title,
                state: postingState(status, postings),
                department: objects(job.departments)[0]?.name?.trim() || null,
                location: office?.location?.trim() || office?.name?.trim() || null,
                commitment: commitmentFrom(title),
                workplaceType: workplaceFrom(offices),
                description: textOf(job.description) || textOf(postings.find((p) => p.content)?.content) || null,
                confidential: job.confidential === true,
                requisitionExternalId: code ? id : null,
                createdAt: toDate(job.remote_created_at),
              });
            },
          ),
      },
      {
        id: 'candidates',
        label: 'Candidates',
        run: (ctx, cursor) =>
          pagedStep(
            ctx,
            cursor,
            // Expanded applications give a creation date when the ATS doesn't share one.
            coreModel(ctx, 'candidates', lister<MergeCandidate>(ctx, `${root()}/candidates`, { expand: 'applications' })),
            async (c) => {
              const candidate = toCandidate(c);
              if (!candidate.createdAt) ctx.warn(undated('candidates', !!ctx.since));
              await ctx.load.candidate(candidate);
            },
          ),
      },
      {
        id: 'applications',
        label: 'Applications',
        run: (ctx, cursor) =>
          pagedStep(
            ctx,
            cursor,
            coreModel(
              ctx,
              'applications',
              lister<MergeApplication>(ctx, `${root()}/applications`, { expand: APPLICATION_EXPAND }, APPLICATION_PAGE_SIZE),
            ),
            async (a) => {
              const candidateId = relId(a.candidate);
              if (!candidateId) return ctx.warn('Skipped applications that Merge does not link to a candidate');
              const { app, dating, closedJob, owners } = toApplication(a, candidateId);
              app.ownerExternalUserId = await firstTeammate(ctx, owners);
              if (dating !== 'applied') ctx.warn(undatedApplications(dating, !!ctx.since));
              // With no date the loader can't apply `since`; don't let it re-create a candidate the candidates phase left out.
              if (dating === 'none' && ctx.since) app.candidate = null;
              if (closedJob) {
                ctx.warn(
                  ctx.options.archived
                    ? 'Archived applications that were still open on a closed or archived job (Merge has no application status)'
                    : 'Skipped applications still open on a closed or archived job: Merge has no application status, so they count as archived',
                );
              }
              await ctx.load.application(app);
            },
          ),
      },
      {
        id: 'interviews',
        label: 'Interviews',
        enabled: (o) => o.activity,
        run: (ctx, cursor) =>
          pagedStep(
            ctx,
            cursor,
            optionalModel(ctx, 'Interviews', lister<MergeInterview>(ctx, `${root()}/interviews`, { expand: 'job_interview_stage' })),
            async (i) => {
              const applicationId = relId(i.application);
              const startAt = toDate(i.start_at);
              if (!applicationId) return;
              if (!startAt) return ctx.warn('Skipped interviews with no start time');
              const endAt = toDate(i.end_at);
              const status = i.status?.toUpperCase();
              await ctx.load.interview({
                externalId: String(i.id),
                applicationExternalId: applicationId,
                title: relObj(i.job_interview_stage)?.name?.trim() || 'Interview',
                startAt,
                durationMins: endAt && endAt > startAt ? Math.round((endAt.getTime() - startAt.getTime()) / 60_000) : null,
                location: i.location?.trim() || null,
                panelistExternalUserIds: cleanList((i.interviewers ?? []).map(relId)),
                // No CANCELED in Merge; unknown status is left to the start time.
                state:
                  status === 'SCHEDULED' ? 'scheduled' : status === 'COMPLETE' || status === 'AWAITING_FEEDBACK' ? 'completed' : null,
              });
            },
          ),
      },
      {
        id: 'feedback',
        label: 'Scorecards',
        enabled: (o) => o.activity,
        run: (ctx, cursor) =>
          pagedStep(
            ctx,
            cursor,
            // The interview is the only date Workday and SuccessFactors scorecards have.
            optionalModel(ctx, 'Scorecards', lister<MergeScorecard>(ctx, `${root()}/scorecards`, { expand: 'interview,interviewer' })),
            async (s) => {
              const applicationId = relId(s.application);
              if (!applicationId) return;
              const decision = RATINGS[s.overall_recommendation?.toUpperCase() ?? ''];
              const interview = relObj(s.interview);
              const createdAt =
                toDate(s.submitted_at) ?? toDate(s.remote_created_at) ?? toDate(interview?.end_at) ?? toDate(interview?.start_at);
              if (!createdAt) ctx.warn(undated('scorecards', false));
              await ctx.load.feedback({
                externalId: String(s.id),
                applicationExternalId: applicationId,
                interviewExternalId: relId(s.interview),
                authorExternalUserId: relId(s.interviewer),
                authorName: personName(relObj(s.interviewer)),
                rating: decision?.rating ?? null,
                // Merge carries no written feedback, only the overall call.
                summary: decision
                  ? `Overall recommendation: ${decision.label}`
                  : 'Scorecard submitted with no overall recommendation',
                createdAt,
              });
            },
          ),
      },
      {
        id: 'notes',
        label: 'Notes',
        enabled: (o) => o.activity,
        run: (ctx, cursor) =>
          pagedStep(
            ctx,
            cursor,
            optionalModel(ctx, 'Notes', lister<MergeActivity>(ctx, `${root()}/activities`, { expand: 'user' })),
            async (n) => {
              const candidateId = relId(n.candidate);
              if (!candidateId) return ctx.warn('Skipped notes that Merge does not link to a candidate');
              const subject = n.subject?.trim();
              const text = textOf(n.body);
              const heading = n.activity_type?.toUpperCase() === 'EMAIL' ? `[Email] ${subject ?? ''}`.trim() : subject;
              const body = [heading, text].filter(Boolean).join('\n\n');
              if (!body) return;
              const visibility = n.visibility?.toUpperCase();
              if (visibility === 'PRIVATE' || visibility === 'ADMIN_ONLY') {
                ctx.warn('Imported notes that were private or admin-only in the ATS; Source shows them to anyone who can see the candidate');
              }
              const createdAt = toDate(n.remote_created_at);
              if (!createdAt) ctx.warn(undated('notes', false));
              await ctx.load.note({
                externalId: String(n.id),
                candidateExternalId: candidateId,
                authorExternalUserId: relId(n.user),
                authorName: personName(relObj(n.user)),
                body,
                createdAt,
              });
            },
          ),
      },
      {
        id: 'offers',
        label: 'Offers',
        enabled: (o) => o.offers,
        run: (ctx, cursor) =>
          pagedStep(ctx, cursor, optionalModel(ctx, 'Offers', lister<MergeOffer>(ctx, `${root()}/offers`)), async (o) => {
            const applicationId = relId(o.application);
            if (!applicationId) return;
            const raw = o.status?.toUpperCase() ?? '';
            const status = OFFER_STATUS[raw] ?? 'DRAFT';
            // Workday and Taleo offers have no remote_created_at, only when they went out and closed.
            const createdAt = toDate(o.remote_created_at) ?? toDate(o.sent_at) ?? toDate(o.closed_at);
            if (!createdAt) ctx.warn(undated('offers', false));
            await ctx.load.offer({
              externalId: String(o.id),
              applicationExternalId: applicationId,
              status,
              // Merge has no offer title or compensation; the loader takes the job title.
              startDate: dateOnly(o.start_date),
              sentAt: toDate(o.sent_at),
              respondedAt: status === 'ACCEPTED' || status === 'DECLINED' ? toDate(o.closed_at) : null,
              createdAt,
              notes: OFFER_NOTES[raw] ?? null,
            });
          }),
      },
      {
        id: 'files',
        label: 'Resumes & attachments',
        enabled: (o) => o.files,
        async run(ctx, cursor) {
          const base = root();
          // Failed downloads in a row ride along in the cursor, so links that never work stop costing requests.
          const state = (cursor ?? {}) as { at?: Cursor | null; failed?: number };
          let failed = typeof state.failed === 'number' ? state.failed : 0;
          const at = await pagedStep(
            ctx,
            state.at ?? null,
            optionalModel(ctx, 'Attachments', lister<MergeAttachment>(ctx, `${base}/attachments`)),
            async (f) => {
              const candidateId = relId(f.candidate);
              if (!candidateId) return;
              const url = f.file_url?.trim();
              if (!url) return ctx.warn('Skipped attachments that this ATS shares with Merge by name only, without a download link');
              if (failed >= DOWNLOAD_GIVE_UP) {
                return ctx.warn(
                  `Skipped the remaining attachments after ${DOWNLOAD_GIVE_UP} downloads in a row failed; this ATS's file links don't seem to download through Merge. Run the import again to retry them.`,
                );
              }
              const filename = f.file_name?.trim() || `attachment-${f.remote_id || f.id}`;
              await ctx.load.file({
                externalId: String(f.id),
                candidateExternalId: candidateId,
                filename,
                kind: fileKind(f.attachment_type, filename),
                download: async () => {
                  try {
                    const file = await downloadAttachment(ctx.http, base, String(f.id), url);
                    failed = 0;
                    return file;
                  } catch (err) {
                    // Too large says nothing about whether this ATS's links work.
                    if (err instanceof ImportHttpError && err.status !== 413) failed++;
                    throw err;
                  }
                },
              });
            },
          );
          return at === null ? null : { at, failed };
        },
      },
    ];

    return {
      async verify() {
        const base = root();
        let details: MergeAccountDetails;
        try {
          details = await http.json<MergeAccountDetails>(`${base}/account-details`);
        } catch (err) {
          if (err instanceof ImportAuthError && err.status === 401) {
            throw new Error(
              'Merge rejected the API key or account token. Check both, and that the region matches your Merge dashboard (app.merge.dev is US, app-eu.merge.dev is EU, app-ap.merge.dev is APAC).',
            );
          }
          if (err instanceof ImportHttpError && (err.status === 400 || err.status === 404)) {
            throw new Error(
              `Merge did not recognize the account token (HTTP ${err.status}). Copy it again from Linked Accounts → your ATS → Overview.`,
            );
          }
          throw err;
        }
        const category = details?.category?.trim().toLowerCase();
        if (category && category !== 'ats') {
          throw new Error(`This account token is for a Merge ${category.toUpperCase()} integration, not an ATS. Use the token of the linked account for your ATS.`);
        }
        const status = details?.status?.toUpperCase();
        if (status === 'RELINK_NEEDED' || status === 'INCOMPLETE') {
          throw new Error('Merge says this linked account needs to be relinked. Relink it under Linked Accounts in the Merge dashboard, then try again.');
        }
        const integration = details?.integration?.trim();
        const org = details?.end_user_organization_name?.trim();
        return {
          accountName: org && integration ? `${org} (${integration} via Merge)` : org || integration || 'Merge linked account',
        };
      },
      discover,
      load,
    };
  },
};
