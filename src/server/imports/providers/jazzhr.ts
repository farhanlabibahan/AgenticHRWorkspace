import type { Commitment, Origin, WorkplaceType } from '@prisma/client';
import { ImportAuthError, ImportHttpError, type AuthConfig, type HttpClient } from '@/server/imports/http';
import { each, optional, pagedStep, type Page } from '@/server/imports/paging';
import { cleanEmails, cleanList, clip, fullName, htmlToText, toDate } from '@/server/imports/text';
import type {
  Credentials,
  Cursor,
  DownloadedFile,
  ImportedApplication,
  ImportedCandidate,
  ImportedFeedback,
  ImportedNote,
  ImportedPosting,
  ImportedRequisition,
  JsonValue,
  PhaseContext,
  ProviderAdapter,
  ProviderModule,
  StageHistoryEntry,
  StageRef,
} from '@/server/imports/types';

/**
 * JazzHR (formerly The Resumator), through its REST "v1" API at
 * api.resumatorapi.com. Quirks this adapter handles:
 *
 * - The key only works as the `apikey` query parameter (headers are ignored).
 *   It is account-wide, has no scopes and can create records, so the adapter
 *   only ever issues GETs. Plain http is still answered, so a link to the API
 *   host is forced to https before the client adds the key.
 * - Pages and filters are path segments (`/applicants/from_apply_date/d/page/2`),
 *   100 per page with no cursor or total. Org-wide lists end on an empty page.
 *   Exactly one result comes back as a bare object instead of an array, nested
 *   lists can be an object, null or "", an unknown id is a 200 with no `id`,
 *   and a refusal can be a 200 whose body is `{"error": …}`.
 * - Email, source, current step per job, comments, feedback, evaluations,
 *   activity log and resume text exist only on the applicant detail record, so
 *   the candidates phase fetches one detail per applicant and loads the
 *   candidate, its applications and its activity from it in a single pass.
 * - Every applicant needs the workflows, users, job hiring leads and hires.
 *   The candidates phase lists them once, a page per step, and carries a
 *   compact copy in its cursor so later slices never list them again.
 * - Stages are workflow steps (integer ids, compared as strings). "Not Hired"
 *   steps are the rejection reasons and "Hired" steps mark hires; jobs don't say
 *   which workflow they use, so everything is keyed by step id. /hires also
 *   names legacy hire steps that /workflows leaves out.
 * - There is no stage-history endpoint. Moves are read from the activity log
 *   ("… changed the status of … to <step>"), accepting only known step names.
 *   There is no rejection time either: it is the last log line naming the
 *   rejection step, else the last activity. Hire times come from /hires,
 *   per-job apply dates from /applicants2jobs.
 * - `from_apply_date` may filter on the person's first apply date, so with a
 *   start date the org-wide /applicants2jobs is also walked for earlier
 *   candidates who applied again after it.
 * - Every scalar is a string ("0" and "" mean unset). Dates and times are
 *   separate fields in an undocumented zone, read as UTC; date-only values land
 *   at noon UTC so they never shift a day. Ids embed their creation time.
 * - Files, feedback and comments can be private to some users; those are skipped.
 * - No interviews, offers, scorecards, custom fields or requisitions. Resume
 *   files are best-effort (links expire after 60 minutes and the list may be
 *   locked, so any refusal just ends the list); the parsed resume text is kept
 *   as a note.
 */

const HOST = 'api.resumatorapi.com';
const BASE = `https://${HOST}/v1`;
const PAGE_SIZE = 100;
/** Floor for the org-wide file list, which is filtered by upload date. */
const FILES_FROM = '2000-01-01';

// ---------- vendor payloads (every field optional: the API is loosely typed) ----------

type Scalar = string | number | boolean | null | undefined;
type Row = Record<string, unknown>;

type JzUser = { id: string; first_name?: Scalar; last_name?: Scalar; email?: Scalar; type?: Scalar };
type JzStep = { id?: Scalar; name?: Scalar; category?: Scalar; number?: Scalar };
type JzWorkflow = { id: string; steps?: unknown };
type JzJob = {
  id: string;
  title?: Scalar;
  city?: Scalar;
  state?: Scalar;
  zip?: Scalar;
  country_id?: Scalar;
  department?: Scalar;
  description?: Scalar;
  minimum_salary?: Scalar;
  maximum_salary?: Scalar;
  original_open_date?: Scalar;
  type?: Scalar;
  status?: Scalar;
  hiring_lead?: Scalar;
  internal_code?: Scalar;
};
type JzApplicantRow = {
  id: string;
  first_name?: Scalar;
  last_name?: Scalar;
  prospect_phone?: Scalar;
  apply_date?: Scalar;
  job_id?: Scalar;
};
type JzApplicantJob = {
  job_id?: Scalar;
  workflow_step_id?: Scalar;
  applicant_progress?: Scalar;
  hiring_lead_rating?: Scalar;
  average_rating?: Scalar;
};
type JzComment = {
  id?: Scalar;
  author_id?: Scalar;
  author_name?: Scalar;
  text?: Scalar;
  date?: Scalar;
  time?: Scalar;
  security?: Scalar;
  privacy?: Scalar;
};
type JzFeedback = { id?: Scalar; author_id?: Scalar; text?: Scalar; date?: Scalar; time?: Scalar; privacy?: Scalar; is_external?: Scalar };
type JzActivity = { activity?: Scalar; date?: Scalar; time?: Scalar };
type JzMessage = {
  comm_id?: Scalar;
  comm_subject?: Scalar;
  comm_text?: Scalar;
  comm_author_email?: Scalar;
  comm_to?: Scalar;
  comm_datetime_sent?: Scalar;
};
type JzAnswer = { question?: Scalar; answer?: Scalar };
type JzEvaluation = { id?: Scalar; name?: Scalar; category?: Scalar; rating?: Scalar; comment?: Scalar };
type JzCategory = { name?: Scalar; status?: Scalar };
type JzAppJob = { id: string; applicant_id?: Scalar; job_id?: Scalar; workflow_step_id?: Scalar; date?: Scalar };
type JzHire = {
  id: string;
  applicant_id?: Scalar;
  job_id?: Scalar;
  workflow_step_id?: Scalar;
  workflow_step_name?: Scalar;
  hired_date?: Scalar;
  hired_time?: Scalar;
};
type JzFile = { id: string; applicant_id?: Scalar; filename?: Scalar; user_id?: Scalar; file_privacy?: Scalar; file_url?: Scalar };

const YES_NO: Record<string, string> = { '1': 'Yes', '2': 'No' };
const CITIZENSHIP: Record<string, string> = {
  '10': 'U.S. citizen or permanent resident',
  '20': 'Non-citizen allowed to work for any employer',
  '30': 'Non-citizen allowed to work for current employer',
  '40': 'Non-citizen seeking work authorization',
};

/** Standard application-form answers kept on each application. EEO and felony answers are deliberately left out. */
const PROFILE_FIELDS = [
  ['referrer', 'Referred by', null],
  ['desired_salary', 'Desired salary', null],
  ['desired_start_date', 'Desired start date', null],
  ['languages', 'Languages', null],
  ['education_level', 'Education level', null],
  ['college', 'College', null],
  ['college_gpa', 'College GPA', null],
  ['citizenship_status', 'Work authorization', CITIZENSHIP],
  ['willing_to_relocate', 'Willing to relocate', YES_NO],
  ['has_driver_license', "Driver's license", YES_NO],
  ['over_18', 'Over 18', YES_NO],
  ['can_work_weekends', 'Can work weekends', YES_NO],
  ['can_work_evenings', 'Can work evenings', YES_NO],
  ['can_work_overtime', 'Can work overtime', YES_NO],
  ['references', 'References', null],
  ['wmyu', 'What makes you unique', null],
] as const;

type JzApplicant = JzApplicantRow & {
  email?: Scalar;
  address?: Scalar;
  location?: Scalar;
  phone?: Scalar;
  linkedin_url?: Scalar;
  website?: Scalar;
  twitter_username?: Scalar;
  recruiter_id?: Scalar;
  source?: Scalar;
  notes?: Scalar;
  resume_body?: Scalar;
  jobs?: unknown;
  comments?: unknown;
  feedback?: unknown;
  activities?: unknown;
  messages?: unknown;
  questionnaire?: unknown;
  evaluation?: unknown;
  categories?: unknown;
} & Partial<Record<(typeof PROFILE_FIELDS)[number][0], Scalar>>;

/** A 200 whose body is `{"error": …}`: JazzHR refusing the request. Retried like an outage on core lists. */
class JazzHrRefusal extends ImportHttpError {
  constructor(
    where: string,
    readonly reason: string,
  ) {
    super(502, where, reason);
  }
}

// ---------- normalizing ----------

function s(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '';
}

function isRow(v: unknown): v is Row {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** An array, a bare object (exactly one result), or anything else (none) → a list. */
function asList<T>(v: unknown): T[] {
  return (Array.isArray(v) ? v.filter(isRow) : isRow(v) ? [v] : []) as unknown as T[];
}

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((i) => !seen.has(i.id) && !!seen.add(i.id));
}

const seg = (...parts: string[]) => parts.map((p) => `/${encodeURIComponent(p)}`).join('');
const day = (d: Date) => d.toISOString().slice(0, 10);

/** "2023-02-20" + "14:03:11" → UTC instant; a date alone → noon UTC. */
function at(date: unknown, time?: unknown): Date | null {
  const d = s(date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d < '1970') return null;
  const t = s(time);
  return toDate(`${d}T${/^\d{2}:\d{2}:\d{2}$/.test(t) ? t : '12:00:00'}Z`);
}

function dateTime(v: unknown): Date | null {
  const [d, t] = s(v).split(/[ T]/);
  return at(d, t);
}

/** Ids are `{prefix}_{YYYYMMDDhhmmss}_{random}`: the record's creation time. */
function idTime(id: string): Date | null {
  const m = /^[a-z]+_(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})_/i.exec(id);
  return m ? at(`${m[1]}-${m[2]}-${m[3]}`, `${m[4]}:${m[5]}:${m[6]}`) : null;
}

/** A date-only apply date, sharpened to the exact time when the id was minted that same day. */
function appliedAt(date: string, precise: Date | null): Date | null {
  const d = at(date);
  if (!d) return precise;
  return precise && day(precise) === date ? precise : d;
}

function money(v: unknown): number | null {
  const n = Number(s(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** JazzHR stars (0.5–5, 0 = unrated) → 1 strong no · 2 no · 3 yes · 4 strong yes. Three stars is "average", not a yes. */
function starsToRating(stars: number): 1 | 2 | 3 | 4 | null {
  if (!Number.isFinite(stars) || stars <= 0) return null;
  return stars <= 1.5 ? 1 : stars <= 3 ? 2 : stars <= 4 ? 3 : 4;
}

function averageLabel(average: string): string | null {
  const n = Number(average);
  return Number.isFinite(n) && n > 0 ? `${Math.round(Math.min(n, 5) * 100) / 100} of 5` : null;
}

/** "0" (files, feedback) and "1" (notes' `security`) mean everyone; any other value limits an item to some users. */
function isPrivate(...values: unknown[]): boolean {
  return values.some((v) => !['', '0', '1'].includes(s(v)));
}

function commitment(type: string): Commitment | null {
  const t = type.toLowerCase();
  if (t.startsWith('intern')) return 'INTERNSHIP';
  if (t.startsWith('temporary') || t.startsWith('contract')) return 'CONTRACT';
  if (t.startsWith('part time') || t === 'seasonal' || t === 'volunteer') return 'PART_TIME';
  if (t.startsWith('full time')) return 'FULL_TIME';
  return null;
}

/** JazzHR has no workplace field; the title or city is the only signal. */
function workplace(text: string): WorkplaceType | null {
  if (/\bhybrid\b/i.test(text)) return 'HYBRID';
  if (/\bremote\b/i.test(text)) return 'REMOTE';
  return null;
}

function postingState(status: string): ImportedPosting['state'] {
  switch (status.toLowerCase()) {
    case 'open':
      return 'open';
    case 'on hold':
      return 'internal';
    case 'filled':
    case 'closed':
    case 'cancelled':
    case 'canceled':
      return 'closed';
    default:
      return 'draft'; // Drafting, Approved, Needs Approval
  }
}

// ---------- workflows, users ----------

type Step = { id: string; name: string; category: 'active' | 'hired' | 'rejected'; number: number; workflowId: string };
type StepIndex = { byId: Map<string, Step>; byName: Map<string, Step[]>; names: string[]; first: Map<string, Step> };
type UserIndex = {
  byId: Map<string, { name: string; external: boolean }>;
  byName: Map<string, string | null>;
  byEmail: Map<string, string>;
};

function stepsOf(wf: JzWorkflow): Step[] {
  return asList<JzStep>(wf.steps).flatMap((st): Step[] => {
    const id = s(st.id);
    const name = s(st.name);
    if (!id || !name) return [];
    const category = s(st.category).toLowerCase();
    return [
      {
        id,
        name,
        // The REST model says Active | Hired | Not Hired; anything else is treated as Active.
        category: category === 'hired' ? 'hired' : category === 'not hired' ? 'rejected' : 'active',
        number: Number(s(st.number)) || 0,
        workflowId: wf.id,
      },
    ];
  });
}

/** Where candidates enter the workflow ("New"): the lowest positive step number. */
function firstStep(steps: Step[]): Step | undefined {
  return steps.filter((st) => st.category !== 'rejected' && st.number > 0).sort((a, b) => a.number - b.number)[0];
}

function indexSteps(workflows: Step[][]): StepIndex {
  const ix: StepIndex = { byId: new Map(), byName: new Map(), names: [], first: new Map() };
  for (const steps of workflows) {
    const first = firstStep(steps);
    if (first) ix.first.set(first.workflowId, first);
    for (const st of steps) {
      ix.byId.set(st.id, st);
      const key = st.name.toLowerCase();
      ix.byName.set(key, [...(ix.byName.get(key) ?? []), st]);
    }
  }
  ix.names = [...ix.byName.keys()].sort((a, b) => b.length - a.length);
  return ix;
}

/** For step ids nobody lists (legacy accounts): classify by the name JazzHR shows. */
function guessCategory(name: string): Step['category'] {
  if (/not hired|not a fit|reject|declin|withdr|disqualif|elsewhere|not selected|no longer/i.test(name)) return 'rejected';
  return /^hired$/i.test(name) ? 'hired' : 'active';
}

function reasonKind(name: string) {
  return /withdr|declin|elsewhere/i.test(name) ? ('withdrawn' as const) : ('rejection' as const);
}

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
  'protonmail.com',
  'proton.me',
  'ymail.com',
  'comcast.net',
]);

/** No endpoint returns the company name: use the team's dominant work email domain. */
function accountLabel(users: JzUser[]): string {
  const score = new Map<string, number>();
  for (const u of users) {
    const domain = cleanEmails([s(u.email)])[0]?.split('@')[1];
    if (!domain || FREE_MAIL.has(domain)) continue;
    score.set(domain, (score.get(domain) ?? 0) + (/super admin/i.test(s(u.type)) ? 1.5 : 1));
  }
  const best = [...score].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (best) return best;
  const admin = users.find((u) => /super admin/i.test(s(u.type))) ?? users[0];
  return admin ? `JazzHR account of ${fullName(s(admin.first_name), s(admin.last_name), 'an admin')}` : 'JazzHR account';
}

// ---------- reference data, carried in the candidates cursor ----------

/** A workflow step as the cursor keeps it: [id, name, category, number]. */
type RefStep = [string, string, Step['category'], number];
/** A user as the cursor keeps it: [full name, email, 1 when an external recruiter]. */
type RefUser = [string, string, number];

type Refs = {
  /** Workflow id → its steps. */
  workflows: Record<string, RefStep[]>;
  users: Record<string, RefUser>;
  /** Job id → hiring lead user id. */
  leads: Record<string, string>;
  /** `applicant:job` → [hire time in ms or null, hire step id]. */
  hires: Record<string, [number | null, string]>;
  /** Hire step id → name, for legacy steps /workflows may not list. */
  hireSteps: Record<string, string>;
};
type RefList = 'workflows' | 'users' | 'jobs' | 'hires';
const REF_LISTS: RefList[] = ['workflows', 'users', 'jobs', 'hires'];

type WalkCursor = {
  refs: Refs;
  /** The reference list being paged, or null once they're all in. */
  build: { list: RefList; page: JsonValue } | null;
  walk: 'applicants' | 'reapplied';
  /** pagedStep's cursor within the current walk. */
  at: JsonValue;
};

type Hire = { at: Date | null; stepId: string };
type RefIndex = { steps: StepIndex; users: UserIndex; leads: Map<string, string>; hires: Map<string, Hire> };

function withWorkflows(r: Refs, items: JzWorkflow[]): Refs {
  const workflows = { ...r.workflows };
  for (const wf of items) workflows[wf.id] = stepsOf(wf).map((st): RefStep => [st.id, st.name, st.category, st.number]);
  return { ...r, workflows };
}

function withUsers(r: Refs, items: JzUser[]): Refs {
  const users = { ...r.users };
  for (const u of items) {
    const email = cleanEmails([s(u.email)])[0] ?? '';
    users[u.id] = [fullName(s(u.first_name), s(u.last_name), ''), email, /external/i.test(s(u.type)) ? 1 : 0];
  }
  return { ...r, users };
}

function withLeads(r: Refs, items: JzJob[]): Refs {
  const leads = { ...r.leads };
  for (const job of items) if (s(job.hiring_lead)) leads[job.id] = s(job.hiring_lead);
  return { ...r, leads };
}

function withHires(r: Refs, items: JzHire[]): Refs {
  const hires = { ...r.hires };
  const hireSteps = { ...r.hireSteps };
  for (const h of items) {
    const applicant = s(h.applicant_id);
    const job = s(h.job_id);
    if (!applicant || !job) continue;
    const key = `${applicant}:${job}`;
    const when = at(h.hired_date, h.hired_time)?.getTime() ?? null;
    const known = hires[key];
    if (!known || (when !== null && (known[0] === null || when > known[0]))) hires[key] = [when, s(h.workflow_step_id)];
    if (s(h.workflow_step_id) && s(h.workflow_step_name)) hireSteps[s(h.workflow_step_id)] = s(h.workflow_step_name);
  }
  return { ...r, hires, hireSteps };
}

function indexRefs(r: Refs): RefIndex {
  const workflows = Object.entries(r.workflows).map(([workflowId, list]) =>
    list.map(([id, name, category, number]): Step => ({ id, name, category, number, workflowId })),
  );
  const known = new Set(workflows.flat().map((st) => st.id));
  // Legacy accounts: a step only /hires mentions is a hire step.
  const legacy = Object.entries(r.hireSteps)
    .filter(([id]) => !known.has(id))
    .map(([id, name]): Step => ({ id, name, category: 'hired', number: 0, workflowId: '' }));

  const users: UserIndex = { byId: new Map(), byName: new Map(), byEmail: new Map() };
  for (const [id, [name, email, external]] of Object.entries(r.users)) {
    users.byId.set(id, { name, external: external === 1 });
    const key = name.toLowerCase();
    // Two people with one name can't be told apart in the activity log.
    if (key) users.byName.set(key, users.byName.has(key) ? null : id);
    if (email) users.byEmail.set(email, id);
  }

  return {
    steps: indexSteps([...workflows, legacy]),
    users,
    leads: new Map(Object.entries(r.leads)),
    hires: new Map(Object.entries(r.hires).map(([key, [t, stepId]]) => [key, { at: t === null ? null : new Date(t), stepId }])),
  };
}

function originOf(d: JzApplicant, users: UserIndex): Origin {
  if (s(d.referrer)) return 'REFERRED';
  if (users.byId.get(s(d.recruiter_id))?.external) return 'AGENCY';
  const source = s(d.source).toLowerCase();
  if (/referr/.test(source)) return 'REFERRED';
  if (/agency|staffing|headhunt/.test(source)) return 'AGENCY';
  if (/\binternal\b/.test(source)) return 'INTERNAL';
  if (/universit|campus|college|career fair/.test(source)) return 'UNIVERSITY';
  if (/\bsourced\b|added manually|manually added/.test(source)) return 'SOURCED';
  return 'APPLIED';
}

function profileFields(d: JzApplicant): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, label, codes] of PROFILE_FIELDS) {
    const raw = s(d[key]);
    const value = (codes as Record<string, string> | null)?.[raw] ?? raw;
    if (value && value !== '0' && !/^no answer$/i.test(value)) out[label] = clip(value, 2000);
  }
  return out;
}

// ---------- stage history ----------

type Move = { step: Step; at: Date; actor: string | null };

/**
 * Status changes from the activity log. The wording is unverified, so only a
 * sentence ending in a known step name counts — free text never becomes a stage.
 */
function parseMoves(activities: JzActivity[], steps: StepIndex, current: Step | undefined, users: UserIndex): Move[] {
  const moves: Move[] = [];
  for (const a of activities) {
    const text = s(a.activity).replace(/[\s.]+$/, '');
    const verb = text.search(/\bchanged (?:the )?status\b/i);
    const when = at(a.date, a.time);
    if (verb < 0 || !when) continue;
    const lower = text.toLowerCase();
    const name = steps.names.find((n) => lower.endsWith(` to ${n}`));
    const candidates = name ? (steps.byName.get(name) ?? []) : [];
    // A step name can exist in several workflows; prefer the application's own.
    const step = candidates.find((st) => st.workflowId === current?.workflowId) ?? candidates[0];
    if (step) moves.push({ step, at: when, actor: users.byName.get(text.slice(0, verb).trim().toLowerCase()) ?? null });
  }
  return moves.sort((x, y) => x.at.getTime() - y.at.getTime());
}

/** The last log line that names a step, whatever its wording: the spec's stand-in for a rejection time. */
function mentionedAt(activities: JzActivity[], name: string, notBefore: Date | null): Date | null {
  const pattern = new RegExp(`(?:^|[^\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[^\\p{L}\\p{N}]|$)`, 'iu');
  let latest: Date | null = null;
  for (const a of activities) {
    const when = at(a.date, a.time);
    if (when && (!notBefore || when >= notBefore) && (!latest || when > latest) && pattern.test(s(a.activity))) latest = when;
  }
  return latest;
}

function timeline(o: {
  category: Step['category'];
  current: StageRef | null;
  moves: Move[];
  first: Step | undefined;
  createdAt: Date | null;
  hiredAt: Date | null;
  latestActivity: Date | null;
  /** Best guess at the rejection time when no parsed move lands in the rejection step. */
  rejectedAt: Date | null;
}): { stage: StageRef | null; history: StageHistoryEntry[]; archivedAt: Date | null } {
  const ref = (st: Step): StageRef => ({ externalId: st.id, name: st.name });
  // Moves into a "Not Hired" step are the rejection itself, not a stage.
  const active = o.moves.filter((m) => m.step.category !== 'rejected');
  const history: StageHistoryEntry[] = active.map((m) => ({ stage: ref(m.step), at: m.at, actorExternalUserId: m.actor }));
  let stage = o.current;
  let archivedAt: Date | null = null;

  if (o.category === 'rejected') {
    archivedAt = [...o.moves].reverse().find((m) => m.step.id === o.current?.externalId)?.at ?? o.rejectedAt;
    const lastActive = active[active.length - 1]?.step ?? o.first;
    stage = lastActive ? ref(lastActive) : null;
  } else if (o.current) {
    const last = history[history.length - 1];
    if (last && last.stage.externalId === o.current.externalId) {
      if (o.hiredAt) last.at = o.hiredAt;
    } else {
      const when = o.hiredAt ?? (last ? (o.latestActivity ?? last.at) : o.createdAt);
      if (when) history.push({ stage: o.current, at: when });
    }
    if (o.category === 'hired') archivedAt = o.hiredAt ?? (last?.stage.externalId === o.current.externalId ? last.at : null);
  }

  // Everyone enters a workflow at its first step when they apply.
  const head = history[0];
  if (o.first && o.createdAt && head && (active.length || o.hiredAt) && head.stage.externalId !== o.first.id && o.createdAt <= head.at) {
    history.unshift({ stage: ref(o.first), at: o.createdAt });
  }
  return { stage, history, archivedAt };
}

// ---------- files ----------

const NOT_RESUME = /cover|letter|offer|portfolio|reference|transcript|certif|diploma|licen[cs]e|passport|\bw-?[249]\b|\bi-?9\b|consent|background|agreement|contract|\bnda\b|sign|sample|photo|headshot/i;
const RESUME_NAME = /r[eé]sum[eé]|\bcv\b|curriculum/i;
const RESUME_EXT = /\.(pdf|docx?|odt|rtf|txt)$/i;

/** Named like a resume, or a document the candidate uploaded themselves (no user id). */
function resumeLike(filename: string, uploadedBy: string): boolean {
  if (NOT_RESUME.test(filename)) return false;
  return RESUME_NAME.test(filename) || (!uploadedBy && RESUME_EXT.test(filename));
}

/** Refused rather than failed: 401/403, a 200 `{error}`, or any other 4xx except timeouts and rate limits. */
function isRefusal(err: unknown): err is ImportAuthError | ImportHttpError {
  if (err instanceof ImportAuthError || err instanceof JazzHrRefusal) return true;
  return err instanceof ImportHttpError && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429;
}

/**
 * For lists that are extras (reference data, files, re-applications): the key has
 * already worked on /jobs, so a refusal means the list is locked, not that the key
 * is bad. End it with a warning instead of failing the job. Outages and yields still throw.
 */
async function bestEffort<T>(ctx: PhaseContext, what: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isRefusal(err)) throw err;
    ctx.warn(`${what}: ${err instanceof JazzHrRefusal ? `"${err.reason}"` : `HTTP ${err.status}`}`);
    return fallback;
  }
}

// ---------- the adapter ----------

type PageToken = { n: number; last: string | null };
type Seed = { jobId: string | null; stepId: string; progress: string; stars: number; average: string; applied: string };
type Built = { app: ImportedApplication; stars: number; average: string; lead: string };

const NO_PAGE: Page<never> = { items: [], next: null };

function createAdapter(credentials: Credentials, http: HttpClient): ProviderAdapter {
  const apiKey = s(credentials.apiKey);

  async function getJson(path: string): Promise<unknown> {
    try {
      return await http.json<unknown>(`${BASE}${path}`);
    } catch (err) {
      // Error details quote the response body; never let one that echoes the key reach a warning.
      if (err instanceof ImportHttpError && apiKey && err.message.includes(apiKey)) {
        throw new ImportHttpError(err.status, err.where, 'response withheld because it contained the API key');
      }
      throw err;
    }
  }

  async function rows<T>(path: string): Promise<T[]> {
    const list = asList<Row>(await getJson(path));
    const failure = list.find((o) => typeof o.error === 'string' && o.id == null);
    if (failure) {
      const where = `GET ${HOST}/v1${path}`;
      const message = String(failure.error);
      if (/api ?key/i.test(message)) throw new ImportAuthError(401, where);
      throw new JazzHrRefusal(where, apiKey && message.includes(apiKey) ? 'response withheld because it contained the API key' : clip(message, 120));
    }
    // An unknown id is a 200 with a near-empty object: no id means no record.
    return list.filter((o) => s(o.id) !== '') as unknown as T[];
  }

  /** One page of an org-wide list; the list ends on an empty page. */
  async function page<T extends { id: string }>(path: string, token: JsonValue): Promise<Page<T>> {
    const cur = (token as PageToken | null) ?? { n: 1, last: null };
    const items = uniqueById(await rows<T>(`${path}/page/${cur.n}`));
    const last = items.length ? s(items[items.length - 1].id) : null;
    // A server that ignored /page/n would serve the same page forever.
    if (last !== null && last === cur.last) return { items: [], next: null };
    return { items, next: items.length ? { n: cur.n + 1, last } : null };
  }

  /** Per-applicant lists end on a short page (an extra empty call per applicant would double the fan-out). */
  async function subList<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    for (let n = 1; n <= 10; n++) {
      const items = await rows<T>(`${path}/page/${n}`);
      out.push(...items);
      if (items.length < PAGE_SIZE) break;
    }
    return out;
  }

  // The runner passes each step the cursor the previous one returned, so within
  // a slice the reference index is built once per cursor object.
  const indexes = new WeakMap<Refs, RefIndex>();
  function refIndex(refs: Refs): RefIndex {
    let ix = indexes.get(refs);
    if (!ix) indexes.set(refs, (ix = indexRefs(refs)));
    return ix;
  }

  /** One page of one reference list per step: bounded, and resumable from the cursor. */
  async function buildStep(ctx: PhaseContext, c: WalkCursor): Promise<WalkCursor> {
    const { list, page: token } = c.build!;
    const read = async <T extends { id: string }>(path: string, what: string, add: (r: Refs, items: T[]) => Refs) => {
      const p = await bestEffort(ctx, what, () => page<T>(path, token), null);
      return { refs: p ? add(c.refs, p.items) : c.refs, next: p?.next ?? null };
    };
    const { refs, next } =
      list === 'workflows'
        ? await read<JzWorkflow>('/workflows', 'JazzHR workflows were unavailable, so stages were matched by name', withWorkflows)
        : list === 'users'
          ? await read<JzUser>('/users', 'JazzHR users were unavailable, so logged moves and emails are not credited to teammates', withUsers)
          : list === 'jobs'
            ? await read<JzJob>('/jobs', 'JazzHR jobs were unavailable, so hiring leads do not own their applications', withLeads)
            : await read<JzHire>('/hires', 'JazzHR hire dates were unavailable, so hires are dated from the activity log', withHires);
    const following = REF_LISTS[REF_LISTS.indexOf(list) + 1];
    return { ...c, refs, build: next !== null ? { list, page: next } : following ? { list: following, page: null } : null };
  }

  let datesBlocked = false;
  async function applicationDates(ctx: PhaseContext, applicantId: string): Promise<JzAppJob[]> {
    if (datesBlocked) return [];
    const found = await optional(
      ctx,
      'JazzHR application dates',
      () => subList<JzAppJob>(`/applicants2jobs${seg('applicant_id', applicantId)}`),
      null,
    );
    if (found === null) datesBlocked = true; // warned once; don't retry for every applicant
    return found ?? [];
  }

  function toCandidate(d: JzApplicant, row: JzApplicantRow): ImportedCandidate {
    const twitter = s(d.twitter_username).replace(/^@/, '');
    return {
      externalId: d.id,
      name: fullName(s(d.first_name) || s(row.first_name), s(d.last_name) || s(row.last_name)),
      emails: cleanEmails([s(d.email)]),
      phones: cleanList([s(d.phone) || s(row.prospect_phone)]),
      links: cleanList([
        s(d.linkedin_url),
        s(d.website),
        twitter && (/^https?:\/\//i.test(twitter) ? twitter : `https://twitter.com/${twitter}`),
      ]),
      location: s(d.location) || s(d.address) || null,
      tags: cleanList(asList<JzCategory>(d.categories).filter((c) => s(c.status) !== '0').map((c) => s(c.name))),
      createdAt: idTime(d.id) ?? at(s(d.apply_date) || s(row.apply_date)),
    };
  }

  async function buildApplications(
    ctx: PhaseContext,
    ix: RefIndex,
    d: JzApplicant,
    row: JzApplicantRow,
    candidate: ImportedCandidate,
  ): Promise<Built[]> {
    const seeds = new Map<string, Seed>();
    for (const j of asList<JzApplicantJob>(d.jobs)) {
      const jobId = s(j.job_id);
      if (!jobId || seeds.has(jobId)) continue;
      seeds.set(jobId, {
        jobId,
        stepId: s(j.workflow_step_id),
        progress: s(j.applicant_progress),
        stars: Number(s(j.hiring_lead_rating)) || 0,
        average: s(j.average_rating),
        applied: '',
      });
    }
    const listedJob = s(row.job_id);
    if (!seeds.size && listedJob) {
      seeds.set(listedJob, { jobId: listedJob, stepId: '', progress: '', stars: 0, average: '', applied: '' });
    }
    if (seeds.size > 1) {
      // The detail has one apply date for the person; the application list has one per job
      // (and catches a job the detail left out).
      for (const r of await applicationDates(ctx, d.id)) {
        const jobId = s(r.job_id);
        if (!jobId) continue;
        const seed = seeds.get(jobId) ?? { jobId, stepId: s(r.workflow_step_id), progress: '', stars: 0, average: '', applied: '' };
        seed.applied = s(r.date);
        seeds.set(jobId, seed);
      }
    }
    // A candidate with no job still needs an application to hold their notes.
    if (!seeds.size) seeds.set('', { jobId: null, stepId: '', progress: '', stars: 0, average: '', applied: '' });

    const activities = asList<JzActivity>(d.activities);
    const latestActivity = activities.reduce<Date | null>((max, a) => {
      const t = at(a.date, a.time);
      return t && (!max || t > max) ? t : max;
    }, null);
    const single = seeds.size === 1;

    const parts = [...seeds.values()].map((seed) => {
      const hire = seed.jobId ? ix.hires.get(`${d.id}:${seed.jobId}`) : undefined;
      let step = ix.steps.byId.get(seed.stepId);
      // The log doesn't say which job a status change was for, so it's only trusted with one job.
      const moves = single ? parseMoves(activities, ix.steps, step, ix.users) : [];
      // No current step at all (the detail's jobs came back empty): the log's last move is where they stand.
      if (!step && !seed.stepId && !seed.progress && !hire && moves.length) step = moves[moves.length - 1].step;
      // A step nobody lists is judged by its name, and hired when /hires has this application.
      const guess = guessCategory(seed.progress);
      const category = step?.category ?? (guess === 'active' && hire ? 'hired' : guess);
      const hireStep = category === 'hired' && hire ? ix.steps.byId.get(hire.stepId) : undefined;
      return {
        seed,
        step: step ?? hireStep,
        moves,
        category,
        stepId: step?.id ?? (seed.stepId || (hire && category === 'hired' ? hire.stepId : '')),
        name: step?.name ?? (seed.progress || hireStep?.name || ''),
        hiredAt: category === 'hired' ? (hire?.at ?? null) : null,
        createdAt: appliedAt(seed.applied || s(d.apply_date) || s(row.apply_date), candidate.createdAt ?? null),
      };
    });
    const sharing = new Map<string, number>();
    for (const p of parts) sharing.set(p.name.toLowerCase(), (sharing.get(p.name.toLowerCase()) ?? 0) + 1);

    const origin = originOf(d, ix.users);
    const profile = profileFields(d);
    return parts.map((p) => {
      const { seed, category, name } = p;
      const externalId = `${d.id}:${seed.jobId ?? 'no-job'}`;
      let rejectedAt: Date | null = null;
      if (category === 'rejected') {
        // A log line naming the rejection step dates it, if no other application sits in a step by that name.
        const named = name && (single || sharing.get(name.toLowerCase()) === 1) ? mentionedAt(activities, name, p.createdAt) : null;
        rejectedAt = named ?? (latestActivity && (!p.createdAt || latestActivity >= p.createdAt) ? latestActivity : null);
      }
      const { stage, history, archivedAt } = timeline({
        category,
        current: p.stepId || name ? { externalId: p.stepId || null, name: name || null } : null,
        moves: p.moves,
        first: p.step ? ix.steps.first.get(p.step.workflowId) : undefined,
        createdAt: p.createdAt,
        hiredAt: p.hiredAt,
        latestActivity,
        rejectedAt,
      });
      const lead = (seed.jobId && ix.leads.get(seed.jobId)) || '';
      const average = averageLabel(seed.average);
      const app: ImportedApplication = {
        externalId,
        candidateExternalId: d.id,
        candidate,
        postingExternalId: seed.jobId,
        stage,
        status: category === 'hired' ? 'hired' : category === 'rejected' ? 'archived' : 'active',
        archiveReason: category === 'rejected' && name ? { externalId: p.stepId || null, name } : null,
        archivedAt,
        origin,
        source: s(d.source) || null,
        ownerExternalUserId: lead || s(d.recruiter_id) || null,
        createdAt: p.createdAt,
        history,
        fields: average ? { ...profile, 'Average rating': average } : profile,
      };
      return { app, stars: seed.stars, average: seed.average, lead };
    });
  }

  /** Candidate-level feedback needs one application: the newest one this import will keep. */
  function targetApplication(ctx: PhaseContext, apps: ImportedApplication[]): string | null {
    const kept = apps.filter(
      (a) => (ctx.options.archived || a.status === 'active') && !(ctx.since && a.createdAt && a.createdAt < ctx.since),
    );
    const newest = (kept.length ? kept : apps).reduce<ImportedApplication | null>(
      (best, a) => (!best || (a.createdAt?.getTime() ?? 0) >= (best.createdAt?.getTime() ?? 0) ? a : best),
      null,
    );
    return newest?.externalId ?? null;
  }

  function skipPrivate(ctx: PhaseContext, externalId: string) {
    ctx.warn('Skipped comments and feedback marked private in JazzHR (visible only to some users there)', {
      entity: 'note',
      externalId,
    });
  }

  async function loadActivity(ctx: PhaseContext, ix: RefIndex, d: JzApplicant, candidate: ImportedCandidate, built: Built[]) {
    const note = (n: ImportedNote) => each(ctx, n, (x) => ctx.load.note(x));
    const feedback = (f: ImportedFeedback) => each(ctx, f, (x) => ctx.load.feedback(x));

    for (const c of asList<JzComment>(d.comments)) {
      const id = s(c.id);
      const body = htmlToText(s(c.text));
      if (!id || !body) continue;
      if (isPrivate(c.security, c.privacy)) {
        skipPrivate(ctx, `comment:${id}`);
        continue;
      }
      await note({
        externalId: `comment:${id}`,
        candidateExternalId: d.id,
        authorExternalUserId: s(c.author_id) || null,
        authorName: s(c.author_name) || null,
        body,
        createdAt: at(c.date, c.time),
      });
    }

    for (const m of asList<JzMessage>(d.messages)) {
      const id = s(m.comm_id);
      const text = htmlToText(s(m.comm_text));
      const subject = s(m.comm_subject) || '(no subject)';
      if (!id || !text) continue;
      const from = s(m.comm_author_email).toLowerCase();
      const to = s(m.comm_to);
      await note({
        externalId: `email:${id}`,
        candidateExternalId: d.id,
        authorExternalUserId: ix.users.byEmail.get(from) ?? null,
        authorName: from || null,
        body: `Email${to ? ` to ${to}` : ''}: ${subject}\n\n${text}`,
        createdAt: dateTime(m.comm_datetime_sent),
      });
    }

    const answers = asList<JzAnswer>(d.questionnaire)
      .map((q) => [s(q.question), htmlToText(s(q.answer))])
      .filter(([q, a]) => q && a);
    if (answers.length) {
      await note({
        externalId: `answers:${d.id}`,
        candidateExternalId: d.id,
        body: ['Application answers', ...answers.map(([q, a]) => `Q: ${q}\nA: ${a}`)].join('\n\n'),
        createdAt: candidate.createdAt,
      });
    }

    const profileNotes = htmlToText(s(d.notes));
    if (profileNotes) {
      await note({ externalId: `profile-notes:${d.id}`, candidateExternalId: d.id, body: `Profile notes\n\n${profileNotes}`, createdAt: candidate.createdAt });
    }

    const target = targetApplication(ctx, built.map((b) => b.app));
    if (target) {
      // Legacy feedback and "Request comment" replies carry no rating: the engine keeps them as notes.
      for (const f of asList<JzFeedback>(d.feedback)) {
        const id = s(f.id);
        const text = htmlToText(s(f.text));
        if (!id || !text) continue;
        if (isPrivate(f.privacy)) {
          skipPrivate(ctx, `feedback:${id}`);
          continue;
        }
        await feedback({
          externalId: `feedback:${id}`,
          applicationExternalId: target,
          authorExternalUserId: s(f.author_id) || null,
          rating: null,
          title: s(f.is_external) === '1' ? 'External feedback' : 'Feedback',
          summary: text,
          createdAt: at(f.date, f.time),
        });
      }

      for (const e of asList<JzEvaluation>(d.evaluation)) {
        const id = s(e.id);
        if (!id) continue;
        const stars = Number(s(e.rating)) || 0;
        if (stars > 5) ctx.warn('Some JazzHR evaluation ratings were above 5 stars and were treated as 5', { entity: 'feedback', externalId: id });
        await feedback({
          externalId: `evaluation:${id}`,
          applicationExternalId: target,
          rating: starsToRating(Math.min(stars, 5)),
          title: s(e.name) || 'Evaluation',
          summary: htmlToText(s(e.comment)),
          answers: [
            { label: 'Category', value: s(e.category) },
            { label: 'Stars', value: stars > 0 ? `${Math.min(stars, 5)}/5` : '' },
          ],
          createdAt: idTime(id),
        });
      }
    }

    // The hiring lead's star rating on each job — the only per-application verdict the API has.
    for (const { app, stars, average, lead } of built) {
      const rating = starsToRating(Math.min(stars, 5));
      if (!rating) continue;
      await feedback({
        externalId: `stars:${app.externalId}`,
        applicationExternalId: app.externalId,
        authorExternalUserId: lead || null,
        authorName: ix.users.byId.get(lead)?.name || 'Hiring lead',
        rating,
        title: 'Hiring lead star rating',
        summary: `${stars} of 5 stars in JazzHR`,
        answers: [
          { label: 'Stars', value: `${stars}/5` },
          { label: 'Average rating', value: Number(average) > 0 ? average : '' },
        ],
      });
    }
  }

  let resumeTextWarned = false;
  async function importApplicant(ctx: PhaseContext, ix: RefIndex, row: JzApplicantRow) {
    // Email, source, jobs and everything else live only on the detail record.
    const [d] = await rows<JzApplicant>(`/applicants${seg(row.id)}`);
    if (!d) {
      ctx.warn('Skipped candidates JazzHR listed but no longer returns (deleted during the import?)', {
        entity: 'candidate',
        externalId: row.id,
      });
      return;
    }
    const candidate = toCandidate(d, row);
    const built = await buildApplications(ctx, ix, d, row, candidate);
    // Without archived data, someone whose every application is closed brings nothing.
    if (!ctx.options.archived && built.every((b) => b.app.status !== 'active')) return;

    await ctx.load.candidate(candidate);
    for (const { app } of built) await each(ctx, app, (a) => ctx.load.application(a));
    if (ctx.options.activity) await loadActivity(ctx, ix, d, candidate, built);

    const resumeText = s(d.resume_body).replace(/\r\n?/g, '\n');
    if (!ctx.options.files || !resumeText) return;
    if (!ctx.options.activity) {
      // The text can only travel as a note, and notes are off.
      if (!resumeTextWarned) ctx.warn('The resume text JazzHR parsed was not kept because notes are turned off for this import');
      resumeTextWarned = true;
      return;
    }
    // Resume files may be unreachable; JazzHR's parsed text is kept so the resume isn't lost.
    await each(ctx, d, () =>
      ctx.load.note({
        externalId: `resume-text:${d.id}`,
        candidateExternalId: d.id,
        body: `Resume (text from JazzHR)\n\n${resumeText}`,
        createdAt: candidate.createdAt,
      }),
    );
  }

  const reapplied = new Set<string>();
  /** An application after `since` from someone whose own apply date is earlier, so the filtered list skipped them. */
  async function importReapplied(ctx: PhaseContext, ix: RefIndex, r: JzAppJob) {
    const applicantId = s(r.applicant_id);
    const jobId = s(r.job_id);
    const applied = at(r.date);
    if (!ctx.since || !applicantId || !jobId || !applied || applied < ctx.since || reapplied.has(applicantId)) return;
    if (await ctx.load.has('opportunity', `${applicantId}:${jobId}`)) return;
    const category = ix.steps.byId.get(s(r.workflow_step_id))?.category;
    if (!ctx.options.archived && category && category !== 'active') return; // would be skipped anyway: save the detail call
    reapplied.add(applicantId);
    await importApplicant(ctx, ix, { id: applicantId, job_id: jobId, apply_date: s(r.date) });
  }

  async function candidatesStep(ctx: PhaseContext, cursor: Cursor | null): Promise<Cursor | null> {
    const c: WalkCursor =
      isRow(cursor) && isRow(cursor.refs)
        ? (cursor as unknown as WalkCursor)
        : { refs: { workflows: {}, users: {}, leads: {}, hires: {}, hireSteps: {} }, build: { list: REF_LISTS[0], page: null }, walk: 'applicants', at: null };
    if (c.build) return buildStep(ctx, c);
    const ix = refIndex(c.refs);

    if (c.walk === 'applicants') {
      const next = await pagedStep(
        ctx,
        c.at,
        (p) => page<JzApplicantRow>(ctx.since ? `/applicants${seg('from_apply_date', day(ctx.since))}` : '/applicants', p),
        (row) => importApplicant(ctx, ix, row),
      );
      if (next !== null) return { ...c, at: next };
      return ctx.since ? { ...c, walk: 'reapplied', at: null } : null;
    }

    // No date filter exists on /applicants2jobs, so the whole list is read and filtered here.
    const next = await pagedStep(
      ctx,
      c.at,
      (p) =>
        bestEffort(
          ctx,
          'Earlier candidates who applied again after the start date were skipped because JazzHR refused its application list',
          () => page<JzAppJob>('/applicants2jobs', p),
          NO_PAGE,
        ),
      (r) => importReapplied(ctx, ix, r),
    );
    return next === null ? null : { ...c, at: next };
  }

  async function fetchFile(url: string): Promise<DownloadedFile> {
    const target = new URL(url, `${BASE}/`);
    // JazzHR still answers plain http, and the client adds the key for this host.
    if (target.hostname === HOST) target.protocol = 'https:';
    try {
      return await http.bytes(target.toString());
    } catch (err) {
      // A refused download must not read as a rejected API key, which would end the import.
      if (err instanceof ImportAuthError) throw new ImportHttpError(err.status, err.where, 'download refused');
      throw err;
    }
  }

  async function downloadFile(id: string, url: string): Promise<DownloadedFile> {
    try {
      return await fetchFile(url);
    } catch (err) {
      if (!(err instanceof ImportHttpError) || ![400, 401, 403, 404, 410].includes(err.status)) throw err;
      // Links expire after an hour: ask JazzHR for a fresh one and try once more.
      let fresh = '';
      try {
        fresh = s((await rows<JzFile>(`/files${seg(id)}`))[0]?.file_url);
      } catch {
        throw err;
      }
      if (!fresh || fresh === url) throw err;
      return fetchFile(fresh);
    }
  }

  async function importFile(ctx: PhaseContext, f: JzFile) {
    const applicantId = s(f.applicant_id);
    if (!applicantId || !(await ctx.load.has('contact', applicantId))) return;
    if (isPrivate(f.file_privacy)) {
      ctx.warn('Skipped files marked private in JazzHR (admins only, or only the uploader)', { entity: 'file', externalId: f.id });
      return;
    }
    const url = s(f.file_url);
    if (!url) {
      ctx.warn('Skipped JazzHR files that came without a download link', { entity: 'file', externalId: f.id });
      return;
    }
    const filename = s(f.filename) || `jazzhr-file-${f.id}`;
    await ctx.load.file({
      externalId: f.id,
      candidateExternalId: applicantId,
      filename,
      kind: resumeLike(filename, s(f.user_id)) ? 'resume' : 'other',
      download: () => downloadFile(f.id, url),
    });
  }

  function toRequisition(job: JzJob, code: string): ImportedRequisition {
    const state = postingState(s(job.status));
    // No currency field, and the engine assumes USD: keep amounts only where they are dollars.
    const usd = /^united states/i.test(s(job.country_id));
    return {
      externalId: code,
      code,
      title: s(job.title) || code,
      state: state === 'closed' ? 'closed' : s(job.status).toLowerCase() === 'on hold' ? 'on_hold' : 'open',
      salaryMin: usd ? money(job.minimum_salary) : null,
      salaryMax: usd ? money(job.maximum_salary) : null,
      salaryCurrency: usd ? 'USD' : null,
    };
  }

  function toPosting(job: JzJob, requisition: string | null): ImportedPosting {
    const title = s(job.title) || 'Untitled job';
    const country = s(job.country_id);
    const salaryMin = money(job.minimum_salary);
    const salaryMax = money(job.maximum_salary);
    return {
      externalId: job.id,
      title,
      state: postingState(s(job.status)),
      department: s(job.department) || null,
      location: [s(job.city), [s(job.state), s(job.zip)].filter(Boolean).join(' '), country].filter(Boolean).join(', ') || null,
      commitment: commitment(s(job.type)),
      workplaceType: workplace(`${title} ${s(job.city)}`),
      description: htmlToText(s(job.description)) || null,
      salaryMin,
      salaryMax,
      // No currency field; only a US job's salary can be read as dollars with confidence.
      salaryCurrency: (salaryMin ?? salaryMax) != null && /^united states/i.test(country) ? 'USD' : null,
      requisitionExternalId: requisition,
      createdAt: idTime(job.id) ?? at(job.original_open_date),
    };
  }

  return {
    async verify() {
      if (!apiKey) throw new Error('Paste the API key from JazzHR → Settings → Integrations');
      return { accountName: accountLabel(await rows<JzUser>('/users/page/1')) };
    },

    discover: [
      {
        id: 'users',
        label: 'Team',
        run: (ctx, cursor) =>
          pagedStep(ctx, cursor, (p) => page<JzUser>('/users', p), async (u) => {
            const email = cleanEmails([s(u.email)])[0] ?? null;
            ctx.catalog.user({ externalId: u.id, name: fullName(s(u.first_name), s(u.last_name), email ?? 'JazzHR user'), email });
          }),
      },
      {
        id: 'stages',
        label: 'Workflows',
        run: (ctx, cursor) =>
          pagedStep(
            ctx,
            cursor,
            (p) => optional(ctx, 'JazzHR workflows (stages will come from the candidates instead)', () => page<JzWorkflow>('/workflows', p), NO_PAGE),
            async (wf) => {
              const list = stepsOf(wf);
              const first = firstStep(list);
              for (const st of list) {
                if (st.category === 'rejected') {
                  ctx.catalog.reason({ externalId: st.id, name: st.name, kind: reasonKind(st.name) });
                } else {
                  ctx.catalog.stage({
                    externalId: st.id,
                    name: st.name,
                    typeHint: st.category === 'hired' ? 'HIRED' : st === first ? 'APPLICANT' : null,
                    position: st.number > 0 ? st.number : null,
                  });
                }
              }
            },
          ),
      },
    ],

    load: [
      {
        id: 'jobs',
        label: 'Jobs',
        run: (ctx, cursor) =>
          pagedStep(ctx, cursor, (p) => page<JzJob>('/jobs', p), async (job) => {
            // The free-text internal job code is the closest thing JazzHR has to a requisition.
            const code = s(job.internal_code);
            if (code) await each(ctx, job, (j) => ctx.load.requisition(toRequisition(j, code)));
            await ctx.load.posting(toPosting(job, code || null));
          }),
      },
      {
        id: 'candidates',
        label: 'Candidates, applications and activity',
        run: candidatesStep,
      },
      {
        id: 'files',
        label: 'Resumes and attachments',
        enabled: (o) => o.files,
        run: (ctx, cursor) =>
          pagedStep(
            ctx,
            cursor,
            // One org-wide list instead of a call per applicant. Links expire after an
            // hour, so each page is downloaded as soon as it's listed.
            async (p) => {
              const listed = await bestEffort(
                ctx,
                'Resume files were skipped because JazzHR refused the file list',
                () => page<JzFile>(`/files${seg('from_creation_date', ctx.since ? day(ctx.since) : FILES_FROM)}`, p),
                null,
              );
              if (!listed) return NO_PAGE;
              // An empty list is how a locked file API can look, too.
              if (p === null && !listed.items.length && !ctx.since) {
                ctx.warn('JazzHR listed no files, so resumes are limited to the text JazzHR parsed');
              }
              return listed;
            },
            (f) => importFile(ctx, f),
          ),
      },
    ],
  };
}

export const jazzhrProvider: ProviderModule = {
  id: 'jazzhr',
  // Documented limit: 240 calls/min, possibly shared per egress IP. ~170/min leaves margin.
  minIntervalMs: 350,
  auth(credentials): AuthConfig {
    return {
      hosts: [HOST],
      query: { apikey: s(credentials.apiKey) },
      // JazzHR sits behind Cloudflare; identify ourselves rather than send a bare runtime UA.
      headers: { 'user-agent': 'SourceATS-Importer/1.0' },
    };
  },
  create: createAdapter,
};
