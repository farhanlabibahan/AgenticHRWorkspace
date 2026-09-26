import type { OfferStatus, Origin, StageType, WorkplaceType, Commitment } from '@prisma/client';
import { buildUrl, ImportAuthError, ImportHttpError, type HttpClient, type QueryValue } from '@/server/imports/http';
import { optional, pagedStep, type Page } from '@/server/imports/paging';
import { cleanEmails, cleanList, clip, fullName, htmlToText, toDate } from '@/server/imports/text';
import type {
  Credentials,
  Cursor,
  DownloadedFile,
  ImportedCandidate,
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
 * Teamtailor (JSON:API, https://docs.teamtailor.com).
 *
 * Vendor quirks this adapter handles:
 * - Auth is `Authorization: Token token=<key>` (not Bearer) plus a mandatory
 *   `X-Api-Version` header — without it every call is a 406. The version is
 *   pinned: "today's date" is accepted but would silently adopt future
 *   breaking payload changes.
 * - The region is the host (EU default, NA, AU). A key on the wrong host gets
 *   the same bare 401 as a bad key, so verify() probes the other regions and
 *   says which one the key belongs to. verify() also reads one candidate: a key
 *   that can read the company may still lack candidates.
 * - Relationships carry no ids unless included, so every list asks for the
 *   includes it links through (notes and movements are the exception: their
 *   foreign keys are integer attributes). Nested and to-many includes (job
 *   recruiter, stage type, custom fields, interview scores and answers,
 *   candidates' applications) are standard JSON:API but undocumented here: a
 *   refusal steps down to the documented includes, and a relationship without
 *   linkage means "not included", never "empty".
 * - Lists page by offset or by cursor depending on the endpoint; we follow
 *   `links.next` verbatim and send `sort=id` so a resumed step re-reads the
 *   same page (jobs and applications don't default to it). A list without
 *   `links` is the last page unless its `meta` counts more pages (notes and
 *   movements have no documented paging style); then we ask for the next
 *   `page[number]`.
 * - Jobs default to published + public feed: we ask for `filter[status]=all`,
 *   make a second pass over the internal feed, and skip templates (which show
 *   up as `human-status: template` with `status: unlisted`).
 * - Stages are defined per job; discovery reports each with its stage-type
 *   category so the review screen can group fifty "Inbox" stages into one.
 * - Rejection keeps the application in its stage: status comes from
 *   `rejected-at`, hired from the current stage's type. There is no owner per
 *   application; the job's recruiter owns it.
 * - Stage history comes from /v1/movements, whose only documented filter is one
 *   application. We ask for a whole page of applications with a comma list and
 *   check the answer, falling back to one call per application. History is
 *   best-effort: a refused movements call never costs the application.
 * - Candidates with no application (talent pool, Connect, sourced without a
 *   job) get a lead opportunity, so their notes, reviews and files have a home.
 *   Active-only imports take everyone else from their active applications.
 * - Resume links are pre-signed S3 URLs valid for 30 s (uploads: 60 s). Resumes
 *   are downloaded while the candidates page that signed them is fresh, and
 *   re-signed through the API when stale or rejected. S3 never gets our key.
 * - Teamtailor "interviews" are interview-kit write-ups, not scheduled events
 *   (the API has no meetings), so they import as feedback. There is no overall
 *   recommendation: the rating is derived from the 1–5 scorecard scores, and
 *   star reviews (notes with a rating) map the same way. Private notes and
 *   draft feedback are visible only to their author and are skipped.
 * - Custom-field values belong to the candidate; they land on each of the
 *   candidate's opportunities, with Select options resolved to their labels.
 * - Offer `details` keys arrive both kebab- and snake-cased, and the salary is
 *   free text; it is parsed only when amount, currency and period are clear,
 *   and always kept verbatim in the notes. Monthly figures are annualized.
 */

const API_VERSION = '20240904';
const PAGE_SIZE = 30;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

const REGIONS: Record<string, { host: string; label: string }> = {
  eu: { host: 'api.teamtailor.com', label: 'Europe' },
  na: { host: 'api.na.teamtailor.com', label: 'North America' },
  au: { host: 'api.au.teamtailor.com', label: 'Asia-Pacific' },
};

/** Documented lifetimes of pre-signed file links; a link's own X-Amz-Expires wins when it has one. */
const RESUME_LINK_MS = 30_000;
const UPLOAD_LINK_MS = 60_000;
/** Re-sign this long before a link would expire (clock skew, slow storage). */
const LINK_MARGIN_MS = 10_000;

/** Where candidates without any application go. */
const LEAD_STAGE = { externalId: 'lead', name: 'Lead (imported)' } satisfies StageRef;
const leadId = (candidateId: string) => `lead:${candidateId}`;

/** Flags a candidate whose processing is restricted (`restricted-at`, undocumented, probably GDPR). */
const RESTRICTED_TAG = 'Teamtailor: processing restricted';
const RESUME_NAME = /(?:^|[^\p{L}])(cv|resume|résumé|curriculum)(?!\p{L})/iu;

const HISTORY = 'Stage history (applications were imported without it)';

// ---------- JSON:API payloads (only the fields we read) ----------

type Linkage = { type: string; id: string | number };
type Relationship = { data?: Linkage | Linkage[] | null };
type Resource<A> = { id: string | number; type: string; attributes?: A; relationships?: Record<string, Relationship> };
type Links = { next?: string | { href?: string | null } | null } | null;
type Meta = { 'page-count'?: number | null } | null;
type Doc<D> = { data?: D | null; included?: Resource<unknown>[]; links?: Links; meta?: Meta };
type Included = Map<string, Resource<unknown>>;

type IdValue = string | number | null;

type CompanyAttrs = { name?: string | null };
type UserAttrs = { name?: string | null; username?: string | null; 'login-email'?: string | null; email?: string | null };
type StageAttrs = { name?: string | null; 'legacy-stage-type-name'?: string | null; 'row-order'?: number | null };
type StageTypeAttrs = { category?: string | null };
type ReasonAttrs = { reason?: string | null; 'rejected-by-company'?: boolean | null };
type NamedAttrs = { name?: string | null };
type LocationAttrs = { name?: string | null; city?: string | null; country?: string | null; address?: string | null };

type JobAttrs = {
  title?: string | null;
  'internal-name'?: string | null;
  pitch?: string | null;
  body?: string | null;
  status?: string | null;
  'human-status'?: string | null;
  internal?: boolean | null;
  tags?: string[] | null;
  'created-at'?: string | null;
  'remote-status'?: string | null;
  'employment-type'?: string | null;
  currency?: string | null;
  'salary-time-unit'?: string | null;
  'min-salary'?: number | string | null;
  'max-salary'?: number | string | null;
};

type RequisitionAttrs = {
  'job-title'?: string | null;
  status?: string | null;
  'number-of-openings'?: number | null;
  'hired-count'?: number | null;
  currency?: string | null;
  'salary-time-unit'?: string | null;
  'min-salary'?: number | string | null;
  'max-salary'?: number | string | null;
  'archived-at'?: string | null;
};

type CandidateAttrs = {
  'first-name'?: string | null;
  'last-name'?: string | null;
  email?: string | null;
  phone?: string | null;
  'linkedin-url'?: string | null;
  pitch?: string | null;
  city?: string | null;
  state?: string | null;
  'administrative-area'?: string | null;
  country?: string | null;
  'display-address'?: string[] | null;
  tags?: string[] | null;
  sourced?: boolean | null;
  referred?: boolean | null;
  internal?: boolean | null;
  'referring-site'?: string | null;
  resume?: string | null;
  'original-resume'?: string | null;
  'restricted-at'?: string | null;
  'created-at'?: string | null;
};

type ApplicationAttrs = {
  'created-at'?: string | null;
  'changed-stage-at'?: string | null;
  'rejected-at'?: string | null;
  'cover-letter'?: string | null;
  'referring-site'?: string | null;
  'referring-url'?: string | null;
  sourced?: boolean | null;
  match?: number | null;
};

type MovementAttrs = { 'created-at'?: string | null; 'from-stage-id'?: IdValue; 'to-stage-id'?: IdValue };

type NoteAttrs = {
  note?: string | null;
  rating?: number | null;
  'candidate-id'?: IdValue;
  'user-id'?: IdValue;
  'job-application-id'?: IdValue;
  'private-note'?: boolean | null;
  'created-at'?: string | null;
};

type InterviewAttrs = { note?: string | null; status?: string | null; 'created-at'?: string | null };
type ScoreAttrs = { score?: number | null };
type QuestionAttrs = { title?: string | null };
type AnswerAttrs = {
  answer?: string | string[] | null;
  text?: string | null;
  boolean?: boolean | null;
  number?: number | null;
  range?: number | null;
  date?: string | null;
};

type OfferAttrs = {
  status?: string | null;
  'approval-status'?: string | null;
  'created-at'?: string | null;
  'sent-at'?: string | null;
  'answered-at'?: string | null;
  response?: string | null;
  details?: Record<string, unknown> | null;
};

type UploadAttrs = { url?: string | null; 'file-name'?: string | null; internal?: boolean | null };
type ReferralAttrs = { comment?: string | null; 'created-at'?: string | null };

type CustomFieldAttrs = { name?: string | null; 'api-name'?: string | null; 'field-type'?: string | null };
type CustomValueAttrs = { value?: string | number | boolean | (string | number)[] | null; 'field-type'?: string | null };
type OptionAttrs = { value?: string | null };

/** One record from a list page, with that page's `included` resources and when it was fetched. */
type Item<A> = { id: string; res: Resource<A>; inc: Included; at: number };

// ---------- JSON:API helpers ----------

function idOf(value: unknown): string | null {
  return value === null || value === undefined || value === '' ? null : String(value);
}

function relId(res: Resource<unknown>, name: string): string | null {
  const data = res.relationships?.[name]?.data;
  return data && !Array.isArray(data) ? idOf(data.id) : null;
}

function relatedIn<A>(inc: Included, res: Resource<unknown>, name: string): Resource<A> | null {
  const data = res.relationships?.[name]?.data;
  if (!data || Array.isArray(data)) return null;
  return (inc.get(`${data.type}:${data.id}`) as Resource<A> | undefined) ?? null;
}

/** A to-many relationship's included records, or null when it has no linkage (it wasn't included). */
function relatedManyIn<A>(inc: Included, res: Resource<unknown>, name: string): Resource<A>[] | null {
  const data = res.relationships?.[name]?.data;
  if (!Array.isArray(data)) return null;
  return data
    .map((d) => inc.get(`${d.type}:${d.id}`) as Resource<A> | undefined)
    .filter((r): r is Resource<A> => !!r);
}

const related = <A>(item: Item<unknown>, name: string) => relatedIn<A>(item.inc, item.res, name);

/** Included to-many records as items of the same page, or null when not included. */
function includedItems<A>(item: Item<unknown>, name: string): Item<A>[] | null {
  return relatedManyIn<A>(item.inc, item.res, name)?.map((res) => ({ id: String(res.id), res, inc: item.inc, at: item.at })) ?? null;
}

/**
 * The next page's URL, used verbatim — it is already percent-encoded and carries
 * the filters, size and cursor. A relative link, or one on another host or over
 * plain http (the docs' own examples use a dev host), is re-rooted on our API
 * host with its path and query untouched.
 */
function nextLink(links: Links | undefined, base: string): string | null {
  const raw = links?.next;
  const href = typeof raw === 'string' ? raw.trim() : raw?.href?.trim();
  if (!href) return null;
  const abs = /^(https?):\/\/([^/?#]+)(.*)$/i.exec(href);
  if (abs) return `${abs[1]}://${abs[2]}`.toLowerCase() === base ? href : `${base}${abs[3] || '/'}`;
  return href.startsWith('/') ? `${base}${href}` : null;
}

/** A list sent without `links` whose `meta` still counts more pages: ask for the next page number. */
function nextByCount(url: string, meta: Meta | undefined, count: number): string | null {
  const pages = Number(meta?.['page-count']);
  if (!count || !Number.isFinite(pages)) return null;
  const u = new URL(url);
  if (u.searchParams.has('page[after]')) return null; // cursor lists always link their next page
  const current = Number(u.searchParams.get('page[number]') ?? '1') || 1;
  if (current >= pages) return null;
  u.searchParams.set('page[number]', String(current + 1));
  return u.href;
}

function statusOf(err: unknown): number | null {
  return err instanceof ImportAuthError || err instanceof ImportHttpError ? err.status : null;
}

/** Status of a refusal an enrichment call can live with; null for bad keys, rate limits, network and yields. */
function refusal(err: unknown): number | null {
  const status = statusOf(err);
  return status === null || status === 0 || status === 401 || status === 429 ? null : status;
}

/** Teamtailor's date filters want second precision. */
function filterDate(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** How long a pre-signed link stays usable after its page was fetched. */
function linkLifetime(url: string, documentedMs: number): number {
  let seconds = NaN;
  try {
    seconds = Number(new URL(url).searchParams.get('X-Amz-Expires'));
  } catch {
    // not a URL; the download will say so
  }
  return (Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : documentedMs) - LINK_MARGIN_MS;
}

// ---------- Mapping ----------

/** Teamtailor 1–5 (scorecard score or review stars) → Source 1–4: 1→1, 2→2, 3–4→3, 5→4. */
export function toRating(score: number | null | undefined): 1 | 2 | 3 | 4 | null {
  if (score == null || !Number.isFinite(score) || score < 1) return null;
  if (score >= 4.5) return 4;
  if (score >= 2.5) return 3;
  if (score >= 1.5) return 2;
  return 1;
}

const CATEGORY_TYPE: Record<string, StageType> = {
  inbox: 'APPLICANT',
  screening: 'SCREEN',
  interview: 'ONSITE',
  offer: 'OFFER',
  hired: 'HIRED',
};

function stageTypeHint(category: string | null | undefined, legacy: string | null | undefined): StageType | null {
  const byCategory = CATEGORY_TYPE[(category ?? '').toLowerCase()];
  if (byCategory) return byCategory;
  const l = (legacy ?? '').toLowerCase();
  return l === 'inbox' ? 'APPLICANT' : l === 'hired' ? 'HIRED' : null;
}

const WORKPLACE: Record<string, WorkplaceType> = { none: 'ONSITE', hybrid: 'HYBRID', fully: 'REMOTE', temporary: 'REMOTE' };

const COMMITMENT: Record<string, Commitment> = {
  fully: 'FULL_TIME',
  part: 'PART_TIME',
  contract: 'CONTRACT',
  temporary: 'CONTRACT',
  internship: 'INTERNSHIP',
  apprenticeship: 'INTERNSHIP',
};

function postingState(a: JobAttrs): ImportedPosting['state'] | null {
  const human = (a['human-status'] ?? '').toLowerCase();
  const status = (a.status ?? '').toLowerCase();
  if (human === 'template' || status === 'temp') return null;
  if (human === 'archived' || human === 'expired' || (!human && status === 'archived')) return 'closed';
  if (human === 'published' || human === 'unlisted' || (!human && (status === 'open' || status === 'unlisted'))) {
    return a.internal ? 'internal' : 'open';
  }
  return 'draft';
}

function requisitionState(a: RequisitionAttrs): ImportedRequisition['state'] {
  const status = (a.status ?? '').toLowerCase();
  return a['archived-at'] || status === 'completed' || status === 'rejected' ? 'closed' : 'open';
}

const PER_YEAR: Record<string, number> = { yearly: 1, monthly: 12 };
const PER_UNIT: Record<string, string> = { hourly: 'per hour', daily: 'per day' };

/** Annual salary from an amount and Teamtailor's time unit; hourly/daily rates don't annualize reliably. */
function annual(amount: unknown, unit: string | null | undefined): number | null {
  const n = typeof amount === 'number' ? amount : typeof amount === 'string' && amount.trim() ? Number(amount) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  const factor = PER_YEAR[(unit || 'yearly').toLowerCase()];
  return factor ? Math.round(n * factor) : null;
}

// ---------- Free-text offer salaries ----------

const ISO_CURRENCIES: ReadonlySet<string> = new Set(
  typeof Intl.supportedValuesOf === 'function'
    ? Intl.supportedValuesOf('currency')
    : ['USD', 'EUR', 'GBP', 'SEK', 'NOK', 'DKK', 'ISK', 'CHF', 'PLN', 'CZK', 'HUF', 'CAD', 'AUD', 'NZD', 'JPY', 'INR', 'SGD', 'HKD', 'ZAR', 'BRL', 'MXN', 'AED'],
);

/** Longest first, so "CA$" is not read as "A$" or "$". "kr" is left out: it is SEK, NOK, DKK or ISK. */
const CURRENCY_SYMBOLS: [string, string][] = [
  ['US$', 'USD'], ['CA$', 'CAD'], ['AU$', 'AUD'], ['NZ$', 'NZD'], ['HK$', 'HKD'],
  ['A$', 'AUD'], ['C$', 'CAD'], ['S$', 'SGD'], ['R$', 'BRL'], ['zł', 'PLN'],
  ['$', 'USD'], ['€', 'EUR'], ['£', 'GBP'], ['¥', 'JPY'], ['₹', 'INR'], ['₺', 'TRY'], ['₪', 'ILS'], ['₩', 'KRW'],
];

/** Indian lakh grouping, then 3-digit groups (space, dot, comma or apostrophe) with optional decimals, then plain numbers. */
const AMOUNT = /\d{1,2}(?:,\d{2})+,\d{3}(?!\d)|\d{1,3}(?:[   .,'’]\d{3})+(?!\d)(?:[.,]\d{1,2}(?!\d))?|\d+(?:[.,]\d+)?/g;

// Period words in the languages Teamtailor customers write offers in (EN, SV, NO, DA, DE, NL, FI).
const HOURLY = /(?<!\p{L})(?:hourly|stündlich|an hour|per (?:hour|hr|time|timme)|pro stunde)(?!\p{L})|\/\s*(?:h|hr|hrs|hour|std|t|tim|timme)(?!\p{L})/u;
const DAILY = /(?<!\p{L})(?:daily|täglich|a day|per (?:day|dag|tag)|pro tag)(?!\p{L})|\/\s*(?:d|day|dag|tag)(?!\p{L})/u;
const WEEKLY = /(?<!\p{L})(?:weekly|wöchentlich|a week|per (?:week|wk|woche|vecka|uke|uge)|pro woche)(?!\p{L})|\/\s*(?:w|wk|week|woche|vecka|uke|uge)(?!\p{L})/u;
const MONTHLY =
  /(?<!\p{L})(?:monthly|monatlich|mtl|a month|per (?:month|mth|mo|monat|maand|mnd|måned|månad|mån|kuukausi)|pro monat|i månaden|p\.?\s?m\.?)(?!\p{L})|\/\s*(?:m|mo|mon|mth|month|monat|mnd|md|mån|måned|månad|kk|maand)(?!\p{L})/u;
const YEARLY =
  /(?<!\p{L})(?:yearly|annual|annually|annum|jährlich|a year|per (?:year|yr|annum|jahr|år|jaar|vuosi)|pro jahr|p\.?\s?a\.?)(?!\p{L})|\/\s*(?:y|yr|year|jahr|år|aar|jaar|a|annum)(?!\p{L})/u;
/** "/ something" or "per something": a period we may not recognize. */
const ANY_PERIOD = /\/\s*\p{L}|(?<!\p{L})(?:per|pro)\s+\p{L}/u;

function amountOf(token: string): number {
  const t = token.replace(/[\s  '’]/g, '');
  // "62,000" / "62.000" are thousands; "62,000.50" / "62.000,50" / "1.5" end in a decimal part.
  const decimal = /[.,](\d{1,2})$/.exec(t);
  const whole = (decimal ? t.slice(0, -decimal[0].length) : t).replace(/[.,]/g, '');
  return Number(decimal ? `${whole}.${decimal[1]}` : whole);
}

/**
 * Best-effort parse of an offer's free-text salary ("50 000 $/mo", "62 000 $ / year",
 * "SEK 45,000 per month", "4.500 € brutto/Monat"). Returns null unless the amount,
 * its currency (an ISO code or an unambiguous symbol, nearest the amount wins) and
 * the period are all clear — the raw text is kept in the offer notes either way.
 * Monthly amounts are annualized; hourly, daily, weekly and unrecognized periods
 * give null rather than a wrong annual figure.
 */
export function parseSalary(text: string | null | undefined): { amount: number; currency: string } | null {
  if (!text) return null;
  const mentions: { at: number; end: number; currency: string }[] = [];
  for (const m of text.matchAll(/(?<![A-Za-z])[A-Z]{3}(?![A-Za-z])/g)) {
    if (ISO_CURRENCIES.has(m[0])) mentions.push({ at: m.index, end: m.index + 3, currency: m[0] });
  }
  const taken: boolean[] = [];
  for (const [symbol, currency] of CURRENCY_SYMBOLS) {
    for (let i = text.indexOf(symbol); i >= 0; i = text.indexOf(symbol, i + symbol.length)) {
      if (taken[i]) continue;
      for (let j = i; j < i + symbol.length; j++) taken[j] = true;
      mentions.push({ at: i, end: i + symbol.length, currency });
    }
  }
  if (!mentions.length) return null;

  let best: { at: number; end: number; token: string; currency: string; gap: number } | null = null;
  for (const n of text.matchAll(AMOUNT)) {
    const at = n.index;
    const end = at + n[0].length;
    for (const c of mentions) {
      const gap = c.at >= end ? c.at - end : at >= c.end ? at - c.end : 0;
      if (!best || gap < best.gap) best = { at, end, token: n[0], currency: c.currency, gap };
    }
  }
  if (!best) return null;

  let amount = amountOf(best.token);
  const scale = /^\s*(k|tsd|mio|mn|m)(?!\p{L})/iu.exec(text.slice(best.end))?.[1].toLowerCase();
  if (scale) amount *= scale === 'k' || scale === 'tsd' ? 1e3 : 1e6;
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const lower = text.toLowerCase();
  if (HOURLY.test(lower) || DAILY.test(lower) || WEEKLY.test(lower)) return null;
  if (MONTHLY.test(lower)) amount *= 12;
  else if (!YEARLY.test(lower) && ANY_PERIOD.test(lower)) return null;
  return { amount: Math.round(amount), currency: best.currency };
}

function offerStatus(a: OfferAttrs): OfferStatus {
  const status = (a.status ?? '').toLowerCase();
  if (status === 'accepted') return 'ACCEPTED';
  if (status === 'declined') return 'DECLINED';
  const approval = (a['approval-status'] ?? '').toLowerCase();
  if (approval === 'rejected') return 'WITHDRAWN'; // turned down internally; never reached the candidate
  if (approval === 'pending') return 'PENDING_APPROVAL';
  return a['sent-at'] ? 'SENT' : 'DRAFT';
}

function origin(app: ApplicationAttrs, c: CandidateAttrs): Origin {
  if (c.referred) return 'REFERRED';
  if (app.sourced || c.sourced) return 'SOURCED';
  if (c.internal) return 'INTERNAL';
  return 'APPLIED';
}

/**
 * The application's own referring site, else "Sourced" when a recruiter added it,
 * else the candidate's referring site — but only for the application they arrived
 * with, not one from years later.
 */
function applicationSource(a: ApplicationAttrs, c: CandidateAttrs): string | null {
  const own = a['referring-site']?.trim();
  if (own) return own;
  if (a.sourced) return 'Sourced';
  const site = c['referring-site']?.trim();
  const applied = toDate(a['created-at']);
  const arrived = toDate(c['created-at']);
  return site && applied && arrived && Math.abs(applied.getTime() - arrived.getTime()) <= DAY_MS ? site : null;
}

function toCandidate(id: string, attrs: CandidateAttrs | undefined): ImportedCandidate {
  const c = attrs ?? {};
  const place = cleanList([c.city, c.state || c['administrative-area'], c.country]).join(', ');
  return {
    externalId: id,
    name: fullName(c['first-name'], c['last-name'], 'Unnamed candidate'),
    emails: cleanEmails([c.email]),
    phones: cleanList([c.phone]),
    links: cleanList([c['linkedin-url']]),
    headline: c.pitch?.trim() || null,
    location: place || cleanList(c['display-address'] ?? []).join(', ') || null,
    tags: cleanList([...(c.tags ?? []), c['restricted-at'] ? RESTRICTED_TAG : null]),
    createdAt: toDate(c['created-at']),
  };
}

function locationName(l: LocationAttrs | undefined): string {
  if (!l) return '';
  const place = l.name?.trim() || l.city?.trim() || l.address?.trim() || '';
  return cleanList([place, place && l.country]).join(', ');
}

function answerText(a: AnswerAttrs | undefined): string {
  if (!a) return '';
  const value = a.answer ?? a.text;
  if (Array.isArray(value)) return cleanList(value.map(String)).join(', ');
  if (typeof value === 'string' && value.trim()) return htmlToText(value);
  if (a.boolean != null) return a.boolean ? 'Yes' : 'No';
  if (a.number != null) return String(a.number);
  if (a.range != null) return String(a.range);
  return a.date?.trim() ?? '';
}

function fileNameFromUrl(url: string, fallback: string): string {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop();
    const name = last ? decodeURIComponent(last) : '';
    return /\.[a-z0-9]{2,5}$/i.test(name) ? name : fallback;
  } catch {
    return fallback;
  }
}

function applicationFields(a: ApplicationAttrs): Record<string, string> {
  const fields: Record<string, string> = {};
  const letter = htmlToText(a['cover-letter']);
  if (letter) fields['Cover letter'] = clip(letter, 10_000);
  if (typeof a.match === 'number') fields['Match score'] = String(a.match);
  if (a['referring-url']?.trim()) fields['Referring URL'] = a['referring-url'].trim();
  return fields;
}

/** Status, dates and stage kind of an application, from its attributes and included stage. */
function applicationState(item: Item<ApplicationAttrs>) {
  const a = item.res.attributes ?? {};
  const stage = related<StageAttrs>(item, 'stage');
  const kind = stage
    ? stageTypeHint(relatedIn<StageTypeAttrs>(item.inc, stage, 'stage-type')?.attributes?.category, stage.attributes?.['legacy-stage-type-name'])
    : null;
  const createdAt = toDate(a['created-at']);
  const changedAt = toDate(a['changed-stage-at']);
  const rejectedAt = toDate(a['rejected-at']);
  const hired = !rejectedAt && kind === 'HIRED';
  const status: 'archived' | 'hired' | 'active' = rejectedAt ? 'archived' : hired ? 'hired' : 'active';
  // Still where it was placed: no movement expected, so an empty history needs no second look.
  const unmoved = kind === 'APPLICANT' || !changedAt || !createdAt || changedAt.getTime() - createdAt.getTime() < MINUTE_MS;
  return { stage, createdAt, changedAt, rejectedAt, hired, status, unmoved };
}

// ---------- Adapter ----------

type Step = (cursor: Cursor | null) => Promise<Cursor | null>;

/** Run several listings one after another inside one phase (e.g. public, then internal jobs). */
async function passes(cursor: Cursor | null, steps: Step[]): Promise<Cursor | null> {
  const at = (cursor as { pass: number; at: Cursor | null } | null) ?? { pass: 0, at: null };
  const step = steps[at.pass];
  if (!step) return null;
  const next = await step(at.at);
  if (next !== null) return { pass: at.pass, at: next };
  return at.pass + 1 < steps.length ? { pass: at.pass + 1, at: null } : null;
}

const NO_PAGE: Page<never> = { items: [], next: null };

// Richest first; each list falls back to the next entry when Teamtailor refuses one.
const CANDIDATE_INCLUDES = ['job-applications,custom-field-values,custom-field-values.custom-field', 'job-applications', null];
const APPLICATION_INCLUDES = [
  'candidate,candidate.custom-field-values,candidate.custom-field-values.custom-field,job,job.user,stage,stage.stage-type,reject-reason',
  'candidate,job,stage,reject-reason',
];
const INTERVIEW_INCLUDES = [
  'candidate,job,user,scorecard-scores,scorecard-scores.scorecard-criterium,answers,answers.question',
  'candidate,job,user',
];

function create(credentials: Credentials, http: HttpClient): ProviderAdapter {
  const region = REGIONS[(credentials.region ?? '').trim().toLowerCase()] ?? REGIONS.eu;
  const base = `https://${region.host}`;
  const api = (path: string) => `${base}/v1${path}`;
  const enc = encodeURIComponent;

  // Per-slice state (the engine builds a fresh adapter for every slice).
  const userNames = new Map<string, string>();
  const appsByCandidate = new Map<string, { id: string; jobId: string | null }[]>();
  const fieldsByCandidate = new Map<string, Record<string, string>>();
  const optionsByField = new Map<string, Map<string, string>>();
  const movesByApp = new Map<string, Item<MovementAttrs>[]>();
  const refused = new Set<string>();
  let movementsUnavailable = false;
  let batchMovements = true;

  async function fetchPage<A>(path: string, query: Record<string, QueryValue>, cursor: JsonValue): Promise<Page<Item<A>>> {
    const url = typeof cursor === 'string' ? cursor : buildUrl(api(path), { ...query, 'page[size]': PAGE_SIZE }).href;
    const doc = await http.json<Doc<Resource<A>[]>>(url);
    const inc: Included = new Map((doc?.included ?? []).map((r) => [`${r.type}:${r.id}`, r] as const));
    const at = Date.now();
    const items = (doc?.data ?? []).map((res) => ({ id: String(res.id), res, inc, at }));
    const next = nextLink(doc?.links, base) ?? (doc?.links ? null : nextByCount(url, doc?.meta, items.length));
    return { items, next };
  }

  /** Every page of a small sub-listing (one parent's movements, scores, answers), read in one go — no sort needed. */
  async function collect<A>(path: string, query: Record<string, QueryValue>, maxPages = 10) {
    const items: Item<A>[] = [];
    let cursor: JsonValue = null;
    for (let i = 0; i < maxPages; i++) {
      const page: Page<Item<A>> = await fetchPage<A>(path, query, cursor);
      items.push(...page.items);
      if (page.next === null || !page.items.length) return { items, complete: true };
      cursor = page.next;
    }
    return { items, complete: false };
  }

  const all = async <A>(path: string, query: Record<string, QueryValue>) => (await collect<A>(path, query)).items;

  /** One page of an org-wide list per step. `optionalWhat` makes a 403/404 a warning instead of a failure. */
  function list<A>(
    ctx: PhaseContext,
    cursor: Cursor | null,
    path: string,
    query: Record<string, QueryValue>,
    handle: (item: Item<A>) => Promise<void>,
    optionalWhat?: string,
  ): Promise<Cursor | null> {
    const fetch = (page: JsonValue) => fetchPage<A>(path, { sort: 'id', ...query }, page);
    return pagedStep(ctx, cursor, (page) => (optionalWhat ? optional(ctx, optionalWhat, () => fetch(page), NO_PAGE) : fetch(page)), handle);
  }

  /**
   * A list page with the richest `include` Teamtailor accepts. A 400 (or a 5xx,
   * which the docs blame on heavy responses) on the first page steps down the
   * list; later pages follow links.next, which carries whichever include worked.
   */
  async function pageIncluding<A>(
    ctx: PhaseContext,
    path: string,
    includes: (string | null)[],
    query: Record<string, QueryValue>,
    page: JsonValue,
    whenRefused?: string,
  ): Promise<Page<Item<A>>> {
    if (page !== null) return fetchPage<A>(path, query, page);
    for (let i = 0; ; i++) {
      try {
        return await fetchPage<A>(path, { sort: 'id', ...query, include: includes[i] ?? undefined }, null);
      } catch (err) {
        const status = statusOf(err);
        if (i + 1 >= includes.length || status === null || (status !== 400 && status < 500)) throw err;
        if (whenRefused) ctx.warn(whenRefused);
      }
    }
  }

  /**
   * A sub-fetch that only enriches a record (scores, answers, custom fields, the
   * candidate's applications). A refusal is a warning and the fallback, never the
   * record: 404 may be about this record alone, any other 4xx is about the route or
   * the key and turns the call off for the rest of the slice, and a 5xx that
   * outlived the client's retries skips just this record.
   */
  async function bestEffort<T>(ctx: PhaseContext, what: string, fn: () => Promise<T>, fallback: T): Promise<T> {
    if (refused.has(what)) return fallback;
    try {
      return await fn();
    } catch (err) {
      const status = refusal(err);
      if (status === null) throw err;
      if (status !== 404 && status < 500) refused.add(what);
      ctx.warn(`${what}: ${(err as Error).message}`);
      return fallback;
    }
  }

  const since = (ctx: PhaseContext): Record<string, QueryValue> =>
    ctx.since ? { 'filter[created-at][from]': filterDate(ctx.since) } : {};

  /** Download a pre-signed file, re-signing it through the API when stale or when S3 says it expired. */
  async function download(url: string, fetchedAt: number, documentedMs: number, resign: () => Promise<string | null>): Promise<DownloadedFile> {
    const fresh = async () => {
      try {
        return await resign();
      } catch (err) {
        if (statusOf(err) === 403 || statusOf(err) === 404) return null;
        throw err;
      }
    };
    const target = Date.now() - fetchedAt > linkLifetime(url, documentedMs) ? ((await fresh()) ?? url) : url;
    try {
      return await http.bytes(target);
    } catch (err) {
      if (!(err instanceof ImportHttpError) || err.status !== 403) throw err;
      const again = await fresh();
      if (!again || again === target) throw err;
      return http.bytes(again);
    }
  }

  async function resumeFile(ctx: PhaseContext, candidateId: string, attrs: CandidateAttrs | undefined, fetchedAt: number) {
    const original = attrs?.['original-resume'];
    const url = original || attrs?.resume;
    if (!url) return;
    await ctx.load.file({
      externalId: `resume:${candidateId}`,
      candidateExternalId: candidateId,
      filename: fileNameFromUrl(url, original ? 'resume' : 'resume.pdf'),
      kind: 'resume',
      download: () =>
        download(url, fetchedAt, RESUME_LINK_MS, async () => {
          const doc = await http.json<Doc<Resource<CandidateAttrs>>>(api(`/candidates/${enc(candidateId)}`));
          const a = doc?.data?.attributes;
          return a?.['original-resume'] || a?.resume || null;
        }),
    });
  }

  /** Name for an author the org has no teammate for, so their notes keep a byline. */
  async function authorName(ctx: PhaseContext, userId: string | null): Promise<string | null> {
    if (!userId || (await ctx.load.has('user', userId))) return null;
    const cached = userNames.get(userId);
    if (cached) return cached;
    let name = 'Former user';
    try {
      const doc = await http.json<Doc<Resource<UserAttrs>>>(api(`/users/${enc(userId)}`));
      name = doc?.data?.attributes?.name?.trim() || name;
    } catch (err) {
      // Deleted users are hard-deleted in Teamtailor; keep the placeholder.
      if (statusOf(err) !== 404 && statusOf(err) !== 403) throw err;
    }
    userNames.set(userId, name);
    return name;
  }

  /**
   * The imported opportunity a candidate-level record belongs to: the application
   * for its job, else the candidate's latest imported application, else their lead.
   * Interviews, reviews, referrals and uploads have no application link of their own.
   */
  async function applicationFor(ctx: PhaseContext, candidateId: string, jobId: string | null): Promise<string | null> {
    const lead = leadId(candidateId);
    // A lead means the candidate had no applications to look up.
    if (!jobId && (await ctx.load.has('opportunity', lead))) return lead;
    let apps = appsByCandidate.get(candidateId);
    if (!apps) {
      const items = await bestEffort(
        ctx,
        'Candidate applications',
        () => all<ApplicationAttrs>(`/candidates/${enc(candidateId)}/job-applications`, { include: 'job' }),
        [],
      );
      apps = items
        .map((i) => ({ id: i.id, jobId: relId(i.res, 'job'), createdAt: toDate(i.res.attributes?.['created-at'])?.getTime() ?? 0 }))
        .sort((x, y) => y.createdAt - x.createdAt);
      appsByCandidate.set(candidateId, apps);
    }
    const forJob = jobId ? apps.find((a) => a.jobId === jobId) : undefined;
    if (forJob) return (await ctx.load.has('opportunity', forJob.id)) ? forJob.id : null;
    for (const a of apps) if (await ctx.load.has('opportunity', a.id)) return a.id;
    return (await ctx.load.has('opportunity', lead)) ? lead : null;
  }

  /** The loader will create this application (so its history and custom fields are worth their calls). */
  async function willCreate(ctx: PhaseContext, item: Item<ApplicationAttrs>): Promise<boolean> {
    const { status, createdAt } = applicationState(item);
    if (!ctx.options.archived && status !== 'active') return false;
    if (ctx.since && createdAt && createdAt < ctx.since) return false;
    return !(await ctx.load.has('opportunity', item.id));
  }

  /**
   * Movements for a page of applications in one listing: jsonapi-resources reads
   * a comma-separated filter as "any of". Teamtailor doesn't document that, so the
   * answer is checked — rows for other applications mean the filter was ignored
   * (per-application calls from then on), and an application that moved but got no
   * rows is asked again on its own (as a filter that kept only the first id would
   * leave it).
   */
  async function prefetchMovements(ctx: PhaseContext, items: Item<ApplicationAttrs>[]) {
    movesByApp.clear();
    if (movementsUnavailable || !batchMovements) return;
    const ids: string[] = [];
    for (const item of items) if (await willCreate(ctx, item)) ids.push(item.id);
    if (ids.length < 2) return;
    let found: { items: Item<MovementAttrs>[]; complete: boolean };
    try {
      found = await collect<MovementAttrs>('/movements', { 'filter[job-application]': ids.join(','), include: 'job-application' }, 40);
    } catch (err) {
      if (refusal(err) === null) throw err;
      batchMovements = false;
      return;
    }
    if (!found.complete) return;
    const grouped = new Map(ids.map((id) => [id, [] as Item<MovementAttrs>[]]));
    for (const m of found.items) {
      const bucket = grouped.get(relId(m.res, 'job-application') ?? '');
      if (!bucket) {
        batchMovements = false;
        return;
      }
      bucket.push(m);
    }
    for (const [id, moves] of grouped) movesByApp.set(id, moves);
  }

  /** One application's movements. Best-effort: history never costs the application. */
  async function movementsFor(ctx: PhaseContext, applicationId: string): Promise<Item<MovementAttrs>[]> {
    if (movementsUnavailable) return [];
    try {
      const moves = await all<MovementAttrs>('/movements', { 'filter[job-application]': applicationId, include: 'job-application' });
      // Keep only this application's moves, in case the filter is ever ignored.
      return moves.filter((m) => (relId(m.res, 'job-application') ?? applicationId) === applicationId);
    } catch (err) {
      const status = refusal(err);
      if (status === null) throw err;
      // The route, the filter or the key: the same answer for every application.
      if (status < 500) movementsUnavailable = true;
      ctx.warn(`${HISTORY}: ${(err as Error).message}`);
      return [];
    }
  }

  async function stageHistory(
    ctx: PhaseContext,
    applicationId: string,
    current: StageRef | null,
    state: ReturnType<typeof applicationState>,
  ): Promise<StageHistoryEntry[]> {
    const { createdAt, changedAt, unmoved } = state;
    let moves = movesByApp.get(applicationId);
    if (!moves || (!moves.length && !unmoved)) moves = await movementsFor(ctx, applicationId);

    const steps = moves
      .map((m) => ({
        from: idOf(m.res.attributes?.['from-stage-id']),
        to: idOf(m.res.attributes?.['to-stage-id']),
        at: toDate(m.res.attributes?.['created-at']),
      }))
      .filter((m): m is { from: string | null; to: string; at: Date } => !!m.to && !!m.at)
      .sort((x, y) => x.at.getTime() - y.at.getTime());

    const entries: StageHistoryEntry[] = [];
    const first = steps[0];
    // The placement into the first stage may not be a movement of its own.
    if (first?.from && createdAt && createdAt <= first.at) entries.push({ stage: { externalId: first.from }, at: createdAt });
    for (const s of steps) entries.push({ stage: { externalId: s.to }, at: s.at });

    if (current?.externalId) {
      const last = entries[entries.length - 1];
      if (!last) {
        const at = changedAt ?? createdAt;
        if (at) entries.push({ stage: current, at });
      } else if (last.stage.externalId !== current.externalId) {
        entries.push({ stage: current, at: changedAt && changedAt > last.at ? changedAt : last.at });
      } else {
        last.stage = current;
      }
    }

    // Moves through stages that were deleted with their job would land on a default stage; drop them.
    const kept: StageHistoryEntry[] = [];
    for (const e of entries) {
      const id = e.stage.externalId;
      if (id && (id === current?.externalId || (await ctx.load.has('stage', id)))) kept.push(e);
    }
    return kept;
  }

  /**
   * The candidate's custom-field values as label → text, for each of their
   * opportunities. They come included with the candidate when Teamtailor honors
   * the include, else from the candidate's own list (one call, cached per slice).
   */
  async function customFields(ctx: PhaseContext, candidateId: string, inc: Included, candidate: Resource<unknown> | null) {
    const cached = fieldsByCandidate.get(candidateId);
    if (cached) return cached;
    const linked = candidate ? relatedManyIn<CustomValueAttrs>(inc, candidate, 'custom-field-values') : null;
    const values = linked
      ? linked.map((res) => ({ res, inc }))
      : await bestEffort(
          ctx,
          'Custom fields',
          () => all<CustomValueAttrs>(`/candidates/${enc(candidateId)}/custom-field-values`, { include: 'custom-field' }),
          [],
        );
    const fields: Record<string, string> = {};
    for (const v of values) {
      const field = relatedIn<CustomFieldAttrs>(v.inc, v.res, 'custom-field');
      const label = field?.attributes?.name?.trim() || field?.attributes?.['api-name']?.trim();
      if (!field || !label) continue;
      const text = await customValueText(ctx, field, v.res.attributes ?? {});
      if (text) fields[clip(label, 200)] = clip(text, 2000);
    }
    fieldsByCandidate.set(candidateId, fields);
    return fields;
  }

  async function customValueText(ctx: PhaseContext, field: Resource<CustomFieldAttrs>, v: CustomValueAttrs): Promise<string> {
    const type = (v['field-type'] || field.attributes?.['field-type'] || '').toLowerCase();
    const raw = v.value;
    if (type.endsWith('select')) {
      // Select and MultiSelect values are option ids.
      const ids = cleanList((Array.isArray(raw) ? raw : [raw]).map((x) => (x == null || x === false ? null : String(x))));
      if (!ids.length) return '';
      const options = await fieldOptions(ctx, String(field.id));
      return cleanList(ids.map((id) => options.get(id))).join(', ');
    }
    if (typeof raw === 'boolean' || type.endsWith('checkbox')) {
      return raw === true || raw === 'true' ? 'Yes' : raw === false || raw === 'false' ? 'No' : '';
    }
    if (Array.isArray(raw)) return cleanList(raw.map(String)).join(', ');
    return raw == null ? '' : String(raw).trim();
  }

  async function fieldOptions(ctx: PhaseContext, fieldId: string): Promise<Map<string, string>> {
    let options = optionsByField.get(fieldId);
    if (!options) {
      const items = await bestEffort(ctx, 'Custom field options', () => all<OptionAttrs>('/custom-field-options', { 'filter[custom-field]': fieldId }), []);
      options = new Map(items.map((o) => [o.id, o.res.attributes?.value?.trim() ?? '']));
      optionsByField.set(fieldId, options);
    }
    return options;
  }

  // ---------- Discover ----------

  const discover: Phase[] = [
    {
      id: 'users',
      label: 'Team members',
      run: (ctx, cursor) =>
        list<UserAttrs>(ctx, cursor, '/users', {}, async ({ id, res }) => {
          const a = res.attributes ?? {};
          const email = cleanEmails([a['login-email'], a.email])[0] ?? null;
          ctx.catalog.user({ externalId: id, name: a.name?.trim() || a.username?.trim() || email || `Teamtailor user ${id}`, email });
        }),
    },
    {
      id: 'stages',
      label: 'Pipeline stages',
      run: (ctx, cursor) => {
        // Not a Teamtailor stage: where candidates without an application go.
        if (cursor === null) ctx.catalog.stage({ ...LEAD_STAGE, typeHint: 'LEAD', position: -1 });
        return list<StageAttrs>(ctx, cursor, '/stages', { include: 'stage-type' }, async (item) => {
          const a = item.res.attributes ?? {};
          const name = a.name?.trim();
          if (!name) return;
          ctx.catalog.stage({
            externalId: item.id,
            name,
            typeHint: stageTypeHint(related<StageTypeAttrs>(item, 'stage-type')?.attributes?.category, a['legacy-stage-type-name']),
            // row-order is a sparse ranking key; it orders stages the same way across jobs.
            position: typeof a['row-order'] === 'number' ? a['row-order'] : null,
          });
        });
      },
    },
    {
      id: 'reasons',
      label: 'Rejection reasons',
      run: (ctx, cursor) =>
        list<ReasonAttrs>(ctx, cursor, '/reject-reasons', {}, async ({ id, res }) => {
          const a = res.attributes ?? {};
          const name = a.reason?.trim();
          if (!name) return;
          // rejected-by-company: false means the candidate withdrew or declined.
          ctx.catalog.reason({ externalId: id, name, kind: a['rejected-by-company'] === false ? 'withdrawn' : 'rejection' });
        }),
    },
  ];

  // ---------- Load ----------

  const JOBS = { 'filter[status]': 'all', include: 'department,locations,requisition' };

  async function loadJob(ctx: PhaseContext, item: Item<JobAttrs>) {
    const a = item.res.attributes ?? {};
    const state = postingState(a);
    if (!state) return; // templates and unsaved temp jobs
    const unit = a['salary-time-unit'];
    const min = annual(a['min-salary'], unit);
    const max = annual(a['max-salary'], unit);
    // Hourly/daily rates can't become an annual range; keep them readable in the description.
    const rate = cleanList([String(a['min-salary'] ?? ''), String(a['max-salary'] ?? '')]).join('–');
    const per = PER_UNIT[(unit ?? '').toLowerCase()];
    const salaryLine = !min && !max && rate && per ? cleanList(['Salary:', rate, a.currency, per]).join(' ') : '';
    await ctx.load.posting({
      externalId: item.id,
      title: a.title?.trim() || a['internal-name']?.trim() || 'Untitled job',
      state,
      department: related<NamedAttrs>(item, 'department')?.attributes?.name ?? null,
      location: cleanList((relatedManyIn<LocationAttrs>(item.inc, item.res, 'locations') ?? []).map((l) => locationName(l.attributes))).join('; ') || null,
      commitment: COMMITMENT[(a['employment-type'] ?? '').toLowerCase()] ?? null,
      workplaceType: WORKPLACE[(a['remote-status'] ?? '').toLowerCase()] ?? null,
      description: [htmlToText(a.pitch), htmlToText(a.body), salaryLine].filter(Boolean).join('\n\n') || null,
      salaryMin: min,
      salaryMax: max,
      salaryCurrency: min || max ? a.currency?.trim() || null : null,
      tags: cleanList(a.tags ?? []),
      requisitionExternalId: relId(item.res, 'requisition'),
      createdAt: toDate(a['created-at']),
    });
  }

  async function loadCandidate(ctx: PhaseContext, item: Item<CandidateAttrs>) {
    // The linkage alone says whether there are any; the included applications aren't read.
    const apps = item.res.relationships?.['job-applications']?.data;
    const lead = Array.isArray(apps) && apps.length === 0;
    if (!Array.isArray(apps)) {
      ctx.warn(
        ctx.options.archived
          ? 'Teamtailor did not say which candidates have applications, so candidates without one were imported without a lead opportunity'
          : 'Teamtailor did not say which candidates have applications, so candidates without one were not imported',
      );
    }
    // Active-only imports take applicants from their active applications, so people
    // whose every application was rejected or hired don't arrive as contacts.
    if (!ctx.options.archived && !lead) return;
    const attrs = item.res.attributes;
    await ctx.load.candidate(toCandidate(item.id, attrs));
    // Resume links expire 30 s after this page was signed, so fetch them first.
    await resumeFile(ctx, item.id, attrs, item.at);
    if (lead) await loadLead(ctx, item);
  }

  /** A candidate with no application gets a lead opportunity, so their notes, reviews and files have a home. */
  async function loadLead(ctx: PhaseContext, item: Item<CandidateAttrs>) {
    const externalId = leadId(item.id);
    const c = item.res.attributes ?? {};
    const createdAt = toDate(c['created-at']);
    const creates = !(ctx.since && createdAt && createdAt < ctx.since) && !(await ctx.load.has('opportunity', externalId));
    await ctx.load.application({
      externalId,
      candidateExternalId: item.id,
      candidate: toCandidate(item.id, c),
      postingExternalId: null,
      stage: LEAD_STAGE,
      status: 'active',
      origin: origin({}, c),
      source: c['referring-site']?.trim() || (c.sourced ? 'Sourced' : null),
      createdAt,
      history: createdAt ? [{ stage: LEAD_STAGE, at: createdAt }] : [],
      fields: creates ? await customFields(ctx, item.id, item.inc, item.res) : {},
    });
  }

  async function loadApplication(ctx: PhaseContext, item: Item<ApplicationAttrs>) {
    const a = item.res.attributes ?? {};
    const candidateId = relId(item.res, 'candidate');
    if (!candidateId) throw new Error(`Application ${item.id} has no candidate`);
    const candidate = related<CandidateAttrs>(item, 'candidate');
    const job = related<JobAttrs>(item, 'job');
    const stageId = relId(item.res, 'stage');
    const reasonId = relId(item.res, 'reject-reason');
    const reason = related<ReasonAttrs>(item, 'reject-reason');
    const state = applicationState(item);
    const { status, createdAt, changedAt, rejectedAt, hired } = state;
    const current: StageRef | null = stageId ? { externalId: stageId, name: state.stage?.attributes?.name ?? null } : null;

    // History and custom fields cost calls; skip them when the loader will skip the record anyway.
    const creates = await willCreate(ctx, item);
    const history = creates ? await stageHistory(ctx, item.id, current, state) : [];
    const custom = creates ? await customFields(ctx, candidateId, item.inc, candidate) : {};

    const c = candidate?.attributes ?? {};
    await ctx.load.application({
      externalId: item.id,
      candidateExternalId: candidateId,
      candidate: candidate ? toCandidate(candidateId, candidate.attributes) : null,
      postingExternalId: relId(item.res, 'job'),
      stage: current,
      status,
      archiveReason: rejectedAt && reasonId ? { externalId: reasonId, name: reason?.attributes?.reason ?? null } : null,
      archivedAt: rejectedAt ?? (hired ? (history[history.length - 1]?.at ?? changedAt) : null),
      origin: origin(a, c),
      source: applicationSource(a, c),
      // No owner per application in Teamtailor: the job's recruiter.
      ownerExternalUserId: job ? relId(job, 'user') : null,
      createdAt,
      history,
      fields: { ...custom, ...applicationFields(a) },
    });
    // The inline candidate carries a freshly signed resume link — covers candidates the
    // candidates phase skipped (created before `since`, applied after it; active-only imports).
    if (candidate) await resumeFile(ctx, candidateId, candidate.attributes, item.at);
  }

  async function loadInterview(ctx: PhaseContext, item: Item<InterviewAttrs>) {
    const a = item.res.attributes ?? {};
    if (a.status && a.status.toLowerCase() !== 'published') return; // drafts are private to their author
    const externalId = `interview:${item.id}`;
    if (await ctx.load.has('feedback', externalId)) return;
    const candidateId = relId(item.res, 'candidate');
    if (!candidateId || !(await ctx.load.has('contact', candidateId))) return;
    const applicationId = await applicationFor(ctx, candidateId, relId(item.res, 'job'));
    if (!applicationId) return;

    const scores =
      includedItems<ScoreAttrs>(item, 'scorecard-scores') ??
      (await bestEffort(ctx, 'Interview scorecards', () => all<ScoreAttrs>(`/interviews/${enc(item.id)}/scorecard-scores`, { include: 'scorecard-criterium' }), []));
    const answers =
      includedItems<AnswerAttrs>(item, 'answers') ??
      (await bestEffort(ctx, 'Interview kit answers', () => all<AnswerAttrs>(`/interviews/${enc(item.id)}/answers`, { include: 'question' }), []));

    const rated = scores
      .map((s) => ({ s, score: s.res.attributes?.score }))
      .filter((x): x is { s: Item<ScoreAttrs>; score: number } => typeof x.score === 'number' && x.score >= 1 && x.score <= 5);
    const mean = rated.length ? rated.reduce((sum, x) => sum + x.score, 0) / rated.length : null;
    const lines = [
      ...rated.map(({ s, score }) => ({
        label: related<NamedAttrs>(s, 'scorecard-criterium')?.attributes?.name?.trim() || 'Scorecard criterion',
        value: `${score}/5`,
      })),
      ...answers
        .map((q) => ({ label: related<QuestionAttrs>(q, 'question')?.attributes?.title?.trim() || 'Interview question', value: answerText(q.res.attributes) }))
        .filter((q) => q.value),
    ];
    const summary = htmlToText(a.note);
    const userId = relId(item.res, 'user');
    await ctx.load.feedback({
      externalId,
      applicationExternalId: applicationId,
      interviewExternalId: null,
      authorExternalUserId: userId,
      authorName: related<UserAttrs>(item, 'user')?.attributes?.name?.trim() || (await authorName(ctx, userId)),
      rating: toRating(mean),
      title: summary || lines.length ? 'Interview feedback' : null,
      summary,
      answers: lines,
      createdAt: toDate(a['created-at']),
    });
  }

  async function loadNote(ctx: PhaseContext, item: Item<NoteAttrs>) {
    const a = item.res.attributes ?? {};
    if (a['private-note']) return; // visible only to its author in Teamtailor
    const text = htmlToText(a.note);
    const stars = typeof a.rating === 'number' && a.rating >= 1 && a.rating <= 5 ? a.rating : null;
    const candidateId = idOf(a['candidate-id']);
    const applicationId = idOf(a['job-application-id']);
    const userId = idOf(a['user-id']);
    const createdAt = toDate(a['created-at']);

    if (stars) {
      // A star review: feedback, rated on the same 1–5 → 1–4 scale. A candidate review
      // (no application) goes where their notes go: latest application, else their lead.
      const externalId = `review:${item.id}`;
      if (await ctx.load.has('feedback', externalId)) return;
      const parent =
        applicationId ?? (candidateId && (await ctx.load.has('contact', candidateId)) ? await applicationFor(ctx, candidateId, null) : null);
      if (parent) {
        await ctx.load.feedback({
          externalId,
          applicationExternalId: parent,
          authorExternalUserId: userId,
          authorName: (await ctx.load.has('opportunity', parent)) ? await authorName(ctx, userId) : null,
          rating: toRating(stars),
          title: `Review (${stars}/5 stars)`,
          summary: text,
          answers: [{ label: 'Stars', value: `${stars}/5` }],
          createdAt,
        });
        return;
      }
    }

    if (await ctx.load.has('note', item.id)) return;
    // The author lookup costs a call; skip it when the loader has nowhere to put the note.
    const parented = applicationId
      ? await ctx.load.has('opportunity', applicationId)
      : !!candidateId && (await ctx.load.has('contact', candidateId));
    await ctx.load.note({
      externalId: item.id,
      applicationExternalId: applicationId,
      candidateExternalId: candidateId,
      authorExternalUserId: userId,
      authorName: parented ? await authorName(ctx, userId) : null,
      body: stars ? [`Review (${stars}/5 stars)`, text].filter(Boolean).join('\n') : text,
      createdAt,
    });
  }

  async function loadReferral(ctx: PhaseContext, item: Item<ReferralAttrs>) {
    const a = item.res.attributes ?? {};
    const candidateId = relId(item.res, 'candidate');
    const externalId = `referral:${item.id}`;
    if (!candidateId || (await ctx.load.has('note', externalId)) || !(await ctx.load.has('contact', candidateId))) return;
    const jobId = relId(item.res, 'job');
    const jobTitle = related<JobAttrs>(item, 'job')?.attributes?.title?.trim();
    const userId = relId(item.res, 'user');
    await ctx.load.note({
      externalId,
      // Without an imported application for the job, the loader uses the candidate's latest.
      applicationExternalId: jobId ? await applicationFor(ctx, candidateId, jobId) : null,
      candidateExternalId: candidateId,
      authorExternalUserId: userId,
      authorName: related<UserAttrs>(item, 'user')?.attributes?.name?.trim() || (await authorName(ctx, userId)),
      body: [jobTitle ? `Referred for ${jobTitle}` : 'Referred', htmlToText(a.comment)].filter(Boolean).join('\n'),
      createdAt: toDate(a['created-at']),
    });
  }

  async function loadOffer(ctx: PhaseContext, item: Item<OfferAttrs>) {
    const a = item.res.attributes ?? {};
    const applicationId = relId(item.res, 'job-application');
    if (!applicationId) throw new Error(`Offer ${item.id} has no application`);
    const details = a.details ?? {};
    const detail = (...keys: string[]) => {
      for (const k of keys) {
        const v = details[k];
        if (typeof v === 'string' && v.trim()) return v.trim();
      }
      return null;
    };
    const salaryText = detail('salary');
    const salary = parseSalary(salaryText);
    const response = htmlToText(a.response);
    const notes = [salaryText && `Salary: ${salaryText}`, response && `Candidate response: ${response}`].filter(Boolean).join('\n');
    await ctx.load.offer({
      externalId: item.id,
      applicationExternalId: applicationId,
      status: offerStatus(a),
      salaryAmount: salary?.amount ?? null,
      salaryCurrency: salary?.currency ?? null,
      startDate: toDate(detail('start-date', 'start_date')),
      sentAt: toDate(a['sent-at']),
      respondedAt: toDate(a['answered-at']),
      createdAt: toDate(a['created-at']),
      notes: notes || null,
    });
  }

  async function loadUpload(ctx: PhaseContext, item: Item<UploadAttrs>) {
    const a = item.res.attributes ?? {};
    const candidateId = relId(item.res, 'candidate');
    const url = a.url;
    if (!candidateId || !url) return;
    const externalId = `upload:${item.id}`;
    const filename = a['file-name']?.trim() || fileNameFromUrl(url, `attachment-${item.id}`);
    const resumeLike = RESUME_NAME.test(filename.replace(/[_-]/g, ' '));
    // The resume a candidate applied with is listed here too, and it already is their resume.
    if (resumeLike && !a.internal && (await ctx.load.has('file', `resume:${candidateId}`))) return;
    const jobId = relId(item.res, 'job');
    const pending = !(await ctx.load.has('file', externalId)) && (await ctx.load.has('contact', candidateId));
    await ctx.load.file({
      externalId,
      candidateExternalId: candidateId,
      // Uploaded for a job: link it from that application. Otherwise the loader uses the latest.
      applicationExternalId: jobId && pending ? await applicationFor(ctx, candidateId, jobId) : null,
      filename,
      // The loader only makes this the resume when the candidate has none yet.
      kind: resumeLike ? 'resume' : 'other',
      download: () =>
        download(url, item.at, UPLOAD_LINK_MS, async () => {
          try {
            const doc = await http.json<Doc<Resource<UploadAttrs>>>(api(`/uploads/${enc(item.id)}`));
            return doc?.data?.attributes?.url ?? null;
          } catch (err) {
            if (statusOf(err) !== 404 && statusOf(err) !== 403) throw err;
            // The single-upload route is undocumented; the candidate's upload list is documented.
            const mine = await all<UploadAttrs>(`/candidates/${enc(candidateId)}/uploads`, {});
            return mine.find((u) => u.id === item.id)?.res.attributes?.url ?? null;
          }
        }),
    });
  }

  const load: Phase[] = [
    {
      id: 'requisitions',
      label: 'Requisitions',
      run: (ctx, cursor) =>
        list<RequisitionAttrs>(
          ctx,
          cursor,
          '/requisitions',
          {},
          async ({ id, res }) => {
            const a = res.attributes ?? {};
            await ctx.load.requisition({
              externalId: id,
              code: `TT-${id}`,
              title: a['job-title']?.trim() || `Requisition ${id}`,
              state: requisitionState(a),
              openings: typeof a['number-of-openings'] === 'number' ? a['number-of-openings'] : null,
              filled: typeof a['hired-count'] === 'number' ? a['hired-count'] : null,
              salaryMin: annual(a['min-salary'], a['salary-time-unit']),
              salaryMax: annual(a['max-salary'], a['salary-time-unit']),
              salaryCurrency: a.currency?.trim() || null,
            });
          },
          'Requisitions',
        ),
    },
    {
      id: 'postings',
      label: 'Jobs',
      run: (ctx, cursor) =>
        passes(cursor, [
          (c) => list<JobAttrs>(ctx, c, '/jobs', JOBS, (item) => loadJob(ctx, item)),
          // status=all may leave out internal-feed jobs; a second pass catches them (dupes are skipped).
          async (c) => {
            try {
              return await list<JobAttrs>(ctx, c, '/jobs', { ...JOBS, 'filter[feed]': 'internal' }, (item) => loadJob(ctx, item), 'Internal jobs');
            } catch (err) {
              if (statusOf(err) !== 400) throw err;
              ctx.warn(`Internal jobs: ${(err as Error).message}`);
              return null;
            }
          },
        ]),
    },
    {
      id: 'candidates',
      label: 'Candidates and resumes',
      run: (ctx, cursor) =>
        pagedStep(
          ctx,
          cursor,
          (page) => pageIncluding<CandidateAttrs>(ctx, '/candidates', CANDIDATE_INCLUDES, since(ctx), page),
          (item) => loadCandidate(ctx, item),
        ),
    },
    {
      id: 'applications',
      label: 'Applications and stage history',
      run: (ctx, cursor) =>
        pagedStep(
          ctx,
          cursor,
          async (page) => {
            const found = await pageIncluding<ApplicationAttrs>(
              ctx,
              '/job-applications',
              APPLICATION_INCLUDES,
              since(ctx),
              page,
              "Teamtailor refused the applications' nested includes, so applications were imported without an owner",
            );
            await prefetchMovements(ctx, found.items);
            return found;
          },
          (item) => loadApplication(ctx, item),
        ),
    },
    {
      id: 'feedback',
      label: 'Interview feedback',
      enabled: (o) => o.activity,
      run: (ctx, cursor) =>
        pagedStep(
          ctx,
          cursor,
          (page) => optional(ctx, 'Interview feedback', () => pageIncluding<InterviewAttrs>(ctx, '/interviews', INTERVIEW_INCLUDES, {}, page), NO_PAGE),
          (item) => loadInterview(ctx, item),
        ),
    },
    {
      id: 'notes',
      label: 'Notes and reviews',
      enabled: (o) => o.activity,
      run: (ctx, cursor) => list<NoteAttrs>(ctx, cursor, '/notes', {}, (item) => loadNote(ctx, item), 'Notes'),
    },
    {
      id: 'referrals',
      label: 'Referrals',
      enabled: (o) => o.activity,
      run: (ctx, cursor) =>
        list<ReferralAttrs>(ctx, cursor, '/referrals', { include: 'candidate,job,user' }, (item) => loadReferral(ctx, item), 'Referrals'),
    },
    {
      id: 'offers',
      label: 'Offers',
      enabled: (o) => o.offers,
      run: (ctx, cursor) =>
        list<OfferAttrs>(ctx, cursor, '/job-offers', { include: 'job-application' }, (item) => loadOffer(ctx, item), 'Offers'),
    },
    {
      id: 'files',
      label: 'Attachments',
      enabled: (o) => o.files,
      run: (ctx, cursor) =>
        list<UploadAttrs>(ctx, cursor, '/uploads', { include: 'candidate,job' }, (item) => loadUpload(ctx, item), 'Attachments'),
    },
  ];

  const SCOPE = 'Create a key with API scope "Admin" and permission "Read".';

  return {
    async verify() {
      if (!credentials.apiKey?.trim()) throw new Error('Enter your Teamtailor API key.');
      let company: Doc<Resource<CompanyAttrs>> | null;
      try {
        company = await http.json<Doc<Resource<CompanyAttrs>>>(api('/company'));
      } catch (err) {
        if (statusOf(err) === 403) throw new Error(`This key cannot read company data. ${SCOPE}`);
        if (statusOf(err) === 401) {
          // A key used on another region's host gets the same bare 401 as a bad key.
          for (const other of Object.values(REGIONS)) {
            if (other.host === region.host) continue;
            try {
              await http.json(`https://${other.host}/v1/company`);
            } catch (probe) {
              if (statusOf(probe) !== null) continue;
              throw probe;
            }
            throw new Error(`This key belongs to Teamtailor's ${other.label} data center. Choose "${other.label}" as the region and try again.`);
          }
        }
        throw err;
      }
      // A key that can read the company may still lack candidates; better to hear it now than mid-import.
      try {
        await http.json(api('/candidates'), { 'page[size]': 1 });
      } catch (err) {
        if (statusOf(err) === 401 || statusOf(err) === 403) throw new Error(`This key cannot read candidates. ${SCOPE}`);
        throw err;
      }
      const id = idOf(company?.data?.id);
      return { accountName: company?.data?.attributes?.name?.trim() || (id ? `Teamtailor company ${id}` : 'Teamtailor') };
    },
    discover,
    load,
  };
}

export const teamtailorProvider: ProviderModule = {
  id: 'teamtailor',
  // Documented limit: 50 requests per 10 s per company, shared with the customer's
  // other integrations. 300 ms ≈ 33 per 10 s.
  minIntervalMs: 300,
  auth(credentials) {
    return {
      hosts: Object.values(REGIONS).map((r) => r.host),
      headers: {
        authorization: `Token token=${credentials.apiKey ?? ''}`,
        'x-api-version': API_VERSION,
        accept: 'application/vnd.api+json',
      },
    };
  },
  create,
};
