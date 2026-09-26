import type { Prisma } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { db, json, mockFetch, runImportForTest, verifyForTest, type RouteHandler } from '@/server/imports/__tests__/harness';
import { hasDb, publicDns } from '@/server/imports/__tests__/harness';
import { sealCredentials } from '@/server/imports/crypto';
import { createHttpClient, ImportAuthError } from '@/server/imports/http';
import { confirmImportMapping, getImportJob } from '@/server/imports/jobs';
import { registerProviderForTests } from '@/server/imports/providers';
import { bamboohrProvider } from '@/server/imports/providers/bamboohr';
import { runSlice } from '@/server/imports/runner';
import { DEFAULT_IMPORT_OPTIONS } from '@/server/imports/types';

vi.mock('@/lib/session', () => ({ isAdmin: () => true }));

/**
 * BambooHR adapter against a mock tenant built from the spec's recorded
 * payloads (field names, int vs. string ids, +00:00 timestamps, the
 * paginationComplete envelope, users keyed by id string).
 */

const HOST = 'acme.bamboohr.com';
const API = `${HOST}/api/v1`;
const S3 = 'bamboohr-applicant-files.s3.amazonaws.com';
const KEY = 'bhr_test_4f9a1c7e2b8d6f3a0c5e9b1d';
const BASIC = `Basic ${Buffer.from(`${KEY}:x`).toString('base64')}`;
const credentials = { companyDomain: 'acme', apiKey: KEY };

// ---------- the mock tenant ----------

const users = {
  '2370': { id: 2370, employeeId: 61, firstName: 'Dwight', lastName: 'Goodman', email: 'dwight@efficientoffice.com', status: 'enabled', lastLogin: '2025-10-20T22:14:17+00:00' },
  '2382': { id: 2382, employeeId: 11, firstName: 'Daniel', lastName: 'Vance', email: 'dvance@efficientoffice.com', status: 'enabled', lastLogin: '2025-11-15T21:30:40+00:00' },
  // Same address as the harness org's admin, so her activity is attributed to that teammate.
  '2388': { id: 2388, employeeId: 5, firstName: 'Ashley', lastName: 'Adams', email: 'admin@example.test', status: 'enabled', lastLogin: '2026-09-21T15:02:11+00:00' },
  '2999': { id: 2999, employeeId: 0, firstName: 'Recruiting', lastName: 'Agency', email: 'recruiting@agency.example', status: 'disabled' },
};

type Status = { code: string | null; description: string | null; enabled: boolean; id: string; manageable: boolean; name: string; translatedName: string };

const status = (id: number, code: string | null, name: string, enabled = true): Status => ({
  code,
  description: null,
  enabled,
  id: String(id),
  manageable: code === null,
  name,
  translatedName: name,
});

const statuses: Status[] = [
  status(1, 'NEW', 'New'),
  status(2, 'REVIEWED', 'Reviewed'),
  status(3, 'SCHEDPHONE', 'Schedule Phone Screen'),
  status(4, 'PHONED', 'Phone Screened'),
  status(5, 'SCHEDINT', 'Schedule Interview'),
  status(6, 'INTERVIEW', 'Interviewed'),
  status(7, 'ONHOLD', 'Put on Hold'),
  status(8, 'REFCHECK', 'Checking References'),
  status(9, 'OFFER', 'Made an Offer', false), // disabled, but application 64 still holds it
  status(10, 'NOFIT', 'Not a Fit'),
  status(11, 'DECLINED', 'Declined Offer'),
  status(12, 'NOQUAL', 'Not Qualified'),
  status(13, 'OVERQUAL', 'Over Qualified'),
  status(14, 'POACHED', 'Hired Elsewhere'),
  status(15, 'HIRED', 'Hired'),
  status(16, 'OLSENT', 'Offer Sent'),
  status(17, 'OLSIGNED', 'Offer Signed'),
  status(18, 'DELETED', 'Deleted', false),
  status(19, 'MOVED', 'Moved', false), // application 61 holds it
  { ...status(20, null, 'Technical Assessment'), description: 'Take-home exercise' },
  status(21, null, 'Withdrew'), // custom, and in the INACTIVE group
  status(22, null, 'No Longer Interested'), // custom, unused: its name says it's an outcome
  status(23, null, 'Culture Interview'), // custom, unused: a stage
  status(24, null, 'Old Screening', false), // custom, disabled and unused: left out
];

const address = (name: string, city: string, line1 = '335 South 560 West') => ({
  name,
  description: null,
  addressLine1: line1,
  addressLine2: null,
  city,
  state: 'Utah',
  zipcode: '84042',
  country: 'United States',
  phoneNumber: null,
});

const lead = (employeeId: number, firstName: string, lastName: string, jobTitle: string | null = null) => ({
  employeeId,
  firstName,
  lastName,
  avatar: 'https://resources.bamboohr.com/images/photo_person_160x160.png',
  jobTitle: { id: jobTitle ? 18276 : null, label: jobTitle },
});

const jobs = [
  {
    id: 14,
    title: { id: null, label: 'Customer Success Advocate' },
    postedDate: '2025-12-18T21:25:15+00:00',
    location: { id: 18235, label: 'Lindon, Utah', address: address('Salt Lake City, Utah', 'Lindon') },
    department: { id: 18253, label: 'Customer Success' },
    status: { id: 4, label: 'Filled' },
    hiringLead: lead(8, 'Victor', 'Nango'),
    newApplicantsCount: 0,
    activeApplicantsCount: 5,
    totalApplicantsCount: 7,
    postingUrl: 'https://acme.bamboohr.com/jobs/view.php?id=14',
  },
  {
    id: 15,
    title: { id: null, label: 'IT Security Engineer' },
    postedDate: '2025-12-20T15:00:00+00:00',
    location: { id: 18235, label: 'Lindon, Utah', address: address('Salt Lake City, Utah', 'Lindon') },
    department: { id: 18262, label: 'IT' },
    status: { id: 1, label: 'Open' },
    hiringLead: lead(5, 'Ashley', 'Adams'),
    newApplicantsCount: 1,
    activeApplicantsCount: 2,
    totalApplicantsCount: 3,
    postingUrl: 'https://acme.bamboohr.com/jobs/view.php?id=15',
  },
  {
    id: 22,
    title: { id: null, label: 'Financial Analyst' },
    postedDate: '2026-04-22T20:21:18+00:00',
    location: { id: 18352, label: 'Salt Lake City, Utah', address: address('Remote Worker', 'Salt Lake City', ' ') },
    department: { id: 18259, label: 'Finance' },
    status: { id: 1, label: 'Open' },
    hiringLead: lead(83, 'Preston', 'Wilder'),
    newApplicantsCount: 3,
    activeApplicantsCount: 3,
    totalApplicantsCount: 3,
    postingUrl: 'https://acme.bamboohr.com/jobs/view.php?id=22',
  },
  {
    id: 18,
    title: { id: null, label: 'Videographer' },
    postedDate: '2026-06-02T06:33:34+00:00',
    location: null,
    department: { id: 18256, label: 'Marketing' },
    status: { id: 2, label: 'Draft' },
    hiringLead: null,
    newApplicantsCount: null,
    activeApplicantsCount: null,
    totalApplicantsCount: 0,
    postingUrl: 'https://acme.bamboohr.com/jobs/view.php?id=18',
  },
  {
    // Illustrative: the Deleted status id is unverified. Listed only with statusGroups=Deleted here.
    id: 25,
    title: { id: null, label: 'Warehouse Associate' },
    postedDate: '2025-09-15T16:00:00+00:00',
    location: null,
    department: { id: 18264, label: 'Product' },
    status: { id: 6, label: 'Deleted' },
    hiringLead: null,
    newApplicantsCount: 0,
    activeApplicantsCount: 0,
    totalApplicantsCount: 1,
    postingUrl: 'https://acme.bamboohr.com/jobs/view.php?id=25',
  },
];

const jobDeleted = (jobId: number) => jobs.find((j) => j.id === jobId)?.status.label === 'Deleted';

const careers22 = {
  meta: {},
  result: {
    jobOpening: {
      jobOpeningShareUrl: 'https://acme.bamboohr.com/careers/22',
      jobOpeningName: 'Financial Analyst',
      jobOpeningStatus: 'Open',
      jobCategoryId: null,
      departmentId: '18259',
      departmentLabel: 'Finance',
      employmentStatusLabel: 'Full-Time',
      employmentType: null,
      location: { city: 'Salt Lake City', state: 'Utah', postalCode: '84042', addressCountry: 'United States' },
      atsLocation: { country: null, countryId: null, state: null, city: null },
      description:
        '<p><span style="font-weight: bold;">MAIN DUTIES &amp; RESPONSIBILITIES:</span></p>\n<p><br></p>\n<ul>\n<li>Own the monthly close.</li>\n</ul>',
      compensation: '$70,000 - $85,000 a year',
      datePosted: '2026-04-22',
      minimumExperience: 'Mid-level',
      locationType: '2',
      seekPromoted: false,
      aiProcessingDisclosureEnabled: false,
    },
    formFields: {
      firstName: { isRequired: true, value: '', label: 'First Name' },
      lastName: { isRequired: true, value: '', label: 'Last Name' },
      email: { isRequired: true, value: '', label: 'Email' },
      resumeFileId: { isRequired: false, value: '', label: 'Resume' },
      customQuestions: [],
    },
  },
};

type Person = { id: number; firstName: string; lastName: string; email: string | null; source: string | null };

/** What each fixture spells out; app() fills in the rest of the detail shape. */
type DetailInput = {
  id: number;
  appliedDate: string;
  status: { id: number; label: string; dateChanged: string; changedByUser: ReturnType<typeof changer> | null };
  rating: number | null;
  applicant: Person & { [field: string]: unknown };
  job: number;
  resumeFileId?: number | null;
  coverLetterFileId?: number | null;
  movedTo?: unknown[] | null;
  movedFrom?: unknown[] | null;
  referredBy?: string | null;
  desiredSalary?: string | null;
  commentCount?: number;
  emailCount?: number;
  attachmentCount?: number | null;
  eventCount?: number;
  questionsAndAnswers?: unknown[];
  attachments?: { id: number; name: string; fileUrl: string }[] | null;
};

type Group = 'NEW' | 'ACTIVE' | 'INACTIVE' | 'HIRED';

type App = {
  group: Group;
  detail: Omit<DetailInput, 'job'> & { job: ReturnType<typeof jobRef> } & { [field: string]: unknown };
};

const changer = (id: number, firstName: string, lastName: string) => ({
  id,
  firstName,
  lastName,
  avatar: 'https://resources.bamboohr.com/images/photo_person_160x160.png',
  jobTitle: { id: 18236, label: 'HR Administrator' },
});

const jobRef = (id: number) => {
  const job = jobs.find((j) => j.id === id)!;
  return { id, title: job.title, hiringLead: job.hiringLead ? { ...job.hiringLead, jobTitle: { id: 18276, label: 'Account Executive' } } : null };
};

/** The minimal detail shape recorded from a live 2026 tenant: most fields null. */
function app(group: Group, d: DetailInput): App {
  return {
    group,
    detail: {
      resumeFileId: null,
      coverLetterFileId: null,
      movedTo: null,
      movedFrom: null,
      alsoConsideredForCount: 0,
      duplicateApplicationCount: 0,
      referredBy: null,
      desiredSalary: null,
      commentCount: 0,
      emailCount: 0,
      attachmentCount: null,
      eventCount: 0,
      questionsAndAnswers: [],
      attachments: null,
      applicationReferences: null,
      ...d,
      applicant: {
        avatar: 'https://resources.bamboohr.com/employees/photos/initials.php?initials=XX',
        phoneNumber: null,
        address: null,
        linkedinUrl: null,
        twitterUsername: null,
        websiteUrl: null,
        availableStartDate: null,
        education: null,
        ...d.applicant,
      },
      job: jobRef(d.job),
    },
  };
}

const apps: App[] = [
  app('NEW', {
    id: 49,
    appliedDate: '2026-04-21T23:45:58+00:00',
    status: { id: 1, label: 'New', dateChanged: '2026-04-21T23:45:58+00:00', changedByUser: null },
    rating: 4,
    applicant: { id: 111, firstName: 'Emma', lastName: 'Jones', email: 'email@email.com', source: 'LinkedIn' },
    job: 22,
  }),
  app('ACTIVE', {
    id: 59,
    appliedDate: '2025-11-20T20:59:36+00:00',
    status: { id: 20, label: 'Technical Assessment', dateChanged: '2025-12-02T17:00:00+00:00', changedByUser: null },
    rating: null,
    applicant: { id: 116, firstName: 'Anderson', lastName: 'Pierce', email: 'apierce@efficientoffice.com', source: 'Indeed' },
    job: 22,
  }),
  app('ACTIVE', {
    id: 33,
    appliedDate: '2025-12-29T21:03:16+00:00',
    status: { id: 5, label: 'Schedule Interview', dateChanged: '2026-01-06T19:25:03+00:00', changedByUser: changer(2388, 'Ashley', 'Adams') },
    rating: 5,
    applicant: {
      id: 95,
      firstName: 'Nathan',
      lastName: 'Rose',
      avatar: null,
      email: 'nathan@efficientoffice.com',
      source: 'LinkedIn',
      phoneNumber: '+44 20 5555 2023',
      address: { addressLine1: '33 Bothwell St', addressLine2: null, city: null, state: 'Glasgow City', zipcode: 'G2 6AU', country: 'United Kingdom' },
      linkedinUrl: 'https://www.linkedin.com/in/nathanrose',
      twitterUsername: null,
      websiteUrl: 'http://www.blogger.com',
      availableStartDate: '2026-02-15',
      education: { institution: 'University of Glasgow', level: { id: 7, label: 'College - Bachelor of Science' } },
    },
    job: 15,
    resumeFileId: 177,
    referredBy: 'Ashley Adams',
    desiredSalary: '₤85,000',
    commentCount: 2,
    emailCount: 3,
    attachmentCount: 1,
    eventCount: 4,
    questionsAndAnswers: [
      {
        question: { id: 37, label: 'How did you hear about this position?' },
        answer: { id: 147, label: 'My friend told me to apply to this position.' },
        hasRevisions: false,
        isArchived: false,
        archivedDate: null,
        editedDate: null,
        editedEndDate: null,
      },
      {
        question: { id: 36, label: 'References (Name, Company, and Contact Info)' },
        answer: { id: 146, label: 'Paul Clayton\r\nDirector of Digital Security\r\nSoftware Company\r\n+44 20 5555 0920' },
        hasRevisions: false,
        isArchived: false,
        archivedDate: null,
        editedDate: null,
        editedEndDate: null,
      },
    ],
    attachments: [{ id: 212, name: 'portfolio.pdf', fileUrl: 'https://acme.bamboohr.com/files/download.php?id=212' }],
  }),
  app('ACTIVE', {
    id: 46,
    appliedDate: '2026-04-15T14:10:32+00:00',
    status: { id: 2, label: 'Reviewed', dateChanged: '2026-04-16T09:00:00+00:00', changedByUser: changer(2370, 'Dwight', 'Goodman') },
    rating: 3,
    applicant: { id: 108, firstName: 'Anderson', lastName: 'Pierce', email: 'apierce@efficientoffice.com', source: '11' },
    job: 15,
    commentCount: 1,
  }),
  // Moved from job 14 (application 61). movedTo/movedFrom item shapes are undocumented; these are illustrative.
  app('ACTIVE', {
    id: 64,
    appliedDate: '2026-03-01T12:00:00+00:00',
    status: { id: 9, label: 'Made an Offer', dateChanged: '2026-03-20T15:30:00+00:00', changedByUser: changer(2388, 'Ashley', 'Adams') },
    rating: null,
    applicant: { id: 119, firstName: 'Rosa', lastName: 'Diaz', email: 'rosa.diaz@example.org', source: 'Referral' },
    job: 22,
    referredBy: 'N/A',
    movedFrom: [{ id: 61, jobId: 14 }],
  }),
  app('INACTIVE', {
    id: 20,
    appliedDate: '2025-12-20T16:37:35+00:00',
    status: { id: 10, label: 'Not a Fit', dateChanged: '2026-01-02T09:15:00+00:00', changedByUser: changer(2370, 'Dwight', 'Goodman') },
    rating: 2,
    applicant: { id: 82, firstName: 'Kimberly', lastName: 'Hughes', email: 'kimberly@efficientoffice.com', source: null },
    job: 14,
  }),
  app('INACTIVE', {
    id: 27,
    appliedDate: '2026-01-10T12:00:00+00:00',
    status: { id: 21, label: 'Withdrew', dateChanged: '2026-01-15T10:00:00+00:00', changedByUser: null },
    rating: null,
    applicant: { id: 90, firstName: 'Priya', lastName: 'Natarajan', email: 'priya.n@example.org', source: 'Company Website' },
    job: 15,
  }),
  app('INACTIVE', {
    id: 61,
    appliedDate: '2026-02-03T10:00:00+00:00',
    status: { id: 19, label: 'Moved', dateChanged: '2026-03-01T12:00:00+00:00', changedByUser: changer(2388, 'Ashley', 'Adams') },
    rating: null,
    applicant: { id: 118, firstName: 'Rosa', lastName: 'Diaz', email: 'rosa.diaz@example.org', source: 'Referral' },
    job: 14,
    movedTo: [{ id: 64, jobId: 22 }],
  }),
  app('HIRED', {
    id: 12,
    appliedDate: '2025-12-19T18:00:00+00:00',
    status: { id: 15, label: 'Hired', dateChanged: '2026-01-20T16:45:00+00:00', changedByUser: changer(2382, 'Daniel', 'Vance') },
    rating: 5,
    applicant: { id: 70, firstName: 'Oscar', lastName: 'Martinez', email: 'oscar.martinez@example.org', source: 'ZipRecruiter' },
    job: 14,
  }),
  // On the deleted job 25, so only jobStatusGroups=Deleted lists it.
  app('INACTIVE', {
    id: 8,
    appliedDate: '2025-10-02T08:00:00+00:00',
    status: { id: 12, label: 'Not Qualified', dateChanged: '2025-10-09T11:00:00+00:00', changedByUser: changer(2370, 'Dwight', 'Goodman') },
    rating: null,
    applicant: { id: 60, firstName: 'Marcus', lastName: 'Webb', email: 'marcus.webb@example.org', source: 'Indeed' },
    job: 25,
  }),
];

/** The list endpoint returns only these fields per row. */
const listRow = ({ detail: d }: App) => ({
  id: d.id,
  appliedDate: d.appliedDate,
  status: { id: d.status.id, label: d.status.label },
  rating: d.rating,
  applicant: { id: d.applicant.id, firstName: d.applicant.firstName, lastName: d.applicant.lastName, avatar: d.applicant.avatar, email: d.applicant.email, source: d.applicant.source },
  job: { id: d.job.id, title: d.job.title },
});

const comments33 = [
  { id: 28, applicationId: 33, userId: 2388, userData: { firstName: 'Ashley', lastName: 'Adams' }, type: 'comment', comment: 'Strong security background; schedule with the IT team.', dateCreated: '2026-01-06T19:30:12+00:00' },
  { id: 31, applicationId: 33, userId: 2370, userData: { firstName: 'Dwight', lastName: 'Goodman' }, type: 'comment', comment: 'Phone screen went well.\r\nAsked about on-call expectations.', dateCreated: '2026-01-08T15:02:44+00:00' },
];

const PAGE_SIZE = 2; // the real size is unknown (at least 18); two forces multi-page walks

const html = (status: number, body = '<html><body>Not found</body></html>') =>
  new Response(body, { status, headers: { 'content-type': 'text/html' } });

const GROUPS: Record<string, Group[]> = { ALL: ['NEW', 'ACTIVE', 'INACTIVE', 'HIRED'], ALL_ACTIVE: ['NEW', 'ACTIVE'] };

type TenantOptions = {
  apps?: App[];
  statuses?: Status[];
  overrides?: Record<string, RouteHandler>;
  /** How applicationStatus and applicationStatusId combine: undocumented, so tests try both. */
  filters?: 'and' | 'id-overrides-group';
  /** 'omitted' sends nextPageUrl: null even when paginationComplete is false. */
  nextPageUrl?: 'sent' | 'omitted';
  /** Runs after a list page is computed, to change the tenant mid-walk. */
  afterList?: (q: URLSearchParams, apps: App[]) => void;
};

/**
 * The careers API is fetched with the global fetch (it must not go through
 * the credentialed client), so the mock is installed there too.
 */
function tenant(opts: TenantOptions = {}) {
  const data = structuredClone(opts.apps ?? apps);
  const routes: Record<string, RouteHandler> = {
    [`GET ${API}/company_information`]: () =>
      json({ legalName: 'Efficient Office LLC', displayName: 'Efficient Office', address: { line1: '335 S 560 W', line2: 'Suite 200', city: 'Lindon', state: 'UT', zip: '84042' }, phone: '801-724-6600' }),
    [`GET ${API}/meta/users`]: () => json(users),
    [`GET ${API}/applicant_tracking/statuses`]: () => json(opts.statuses ?? statuses),
    [`GET ${API}/applicant_tracking/jobs`]: ({ url }) =>
      json(jobs.filter((j) => (url.searchParams.get('statusGroups') === 'Deleted') === (j.status.label === 'Deleted'))),
    [`GET ${HOST}/careers/22/detail`]: () => json(careers22),
    [`GET ${HOST}/careers/15/detail`]: () => html(404), // open, but not on the public careers page
    [`GET ${API}/applicant_tracking/applications`]: ({ url }) => {
      const q = url.searchParams;
      const groups = (q.get('applicationStatus') ?? 'ALL_ACTIVE').split(',').flatMap((g) => GROUPS[g] ?? [g as Group]);
      const deleted = q.get('jobStatusGroups') === 'Deleted';
      const ids = q.get('applicationStatusId')?.split(',');
      const since = q.get('newSince');
      let rows = data.filter((a) => jobDeleted(a.detail.job.id) === deleted);
      if (ids && opts.filters === 'id-overrides-group') rows = rows.filter((a) => ids.includes(String(a.detail.status.id)));
      else {
        rows = rows.filter((a) => groups.includes(a.group));
        if (ids) rows = rows.filter((a) => ids.includes(String(a.detail.status.id)));
      }
      if (since) rows = rows.filter((a) => new Date(a.detail.appliedDate) >= new Date(`${since.replace(' ', 'T')}Z`));
      rows.sort((a, b) => a.detail.appliedDate.localeCompare(b.detail.appliedDate) * (q.get('sortOrder') === 'ASC' ? 1 : -1));
      const page = Number(q.get('page') ?? '1');
      const complete = page * PAGE_SIZE >= rows.length;
      const next = new URL(url);
      next.searchParams.set('page', String(page + 1));
      const body = {
        paginationComplete: complete,
        applications: rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map(listRow),
        nextPageUrl: complete || opts.nextPageUrl === 'omitted' ? null : next.toString(),
      };
      opts.afterList?.(q, data);
      return json(body);
    },
    [`GET ${API}/applicant_tracking/applications/33/comments`]: () => json(comments33),
    [`GET ${API}/applicant_tracking/applications/46/comments`]: () => new Response('', { status: 403 }),
    // Hypothetical: no applicant file download path is verified. This one redirects to a
    // pre-signed S3 URL so the test can check the key never reaches another host.
    [`GET ${API}/files/177`]: () =>
      new Response(null, { status: 302, headers: { location: `https://${S3}/applicants/177/Nathan_Rose_Resume.pdf?X-Amz-Expires=300&X-Amz-Signature=abc123` } }),
    [`GET ${S3}/applicants/177/Nathan_Rose_Resume.pdf`]: () =>
      new Response(Buffer.from('%PDF-1.4 Nathan Rose resume'), {
        headers: { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="Nathan_Rose_Resume.pdf"' },
      }),
    // What the spec expects for applicant files: the API won't serve it, and the fileUrl bounces to the login page.
    [`GET ${API}/files/212`]: () => html(404),
    [`GET ${HOST}/files/download.php`]: () => new Response(null, { status: 302, headers: { location: '/login.php' } }),
    [`GET ${HOST}/login.php`]: () => html(200, '<html><body>Log in to BambooHR</body></html>'),
  };
  for (const a of data) {
    routes[`GET ${API}/applicant_tracking/applications/${a.detail.id}`] = () => json(data.find((x) => x.detail.id === a.detail.id)!.detail);
  }
  const mock = mockFetch({ ...routes, ...opts.overrides });
  vi.stubGlobal('fetch', mock.impl);
  return { ...mock, apps: data };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

type Call = ReturnType<typeof tenant>['calls'][number];

const importedId = (o: { customFields: unknown }) => (o.customFields as { imported: { id: string } }).imported.id;
const importedFields = (o: { customFields: unknown }) => (o.customFields as { imported: { fields?: Record<string, string> } }).imported.fields ?? {};
const isListCall = (u: URL) => u.pathname === '/api/v1/applicant_tracking/applications' && !u.searchParams.has('applicationStatusId');
const listed = (calls: Call[]) =>
  calls
    .filter((c) => isListCall(c.url))
    .map((c) => `${c.url.searchParams.get('applicationStatus')}/${c.url.searchParams.get('jobStatusGroups')}:${c.url.searchParams.get('page')}`);
const isFanOut = (u: URL) =>
  /^\/api\/v1\/applicant_tracking\/applications\/\d+/.test(u.pathname) || u.pathname.startsWith('/api/v1/files/') || u.pathname.startsWith('/careers/');
const hits = (calls: Call[], path: string) => calls.filter((c) => `${c.url.host}${c.url.pathname}` === path).length;

/**
 * Like runImportForTest into an existing org, but a failed slice (one the
 * runner will retry after a backoff) is retried at once instead of failing
 * the test. Returns the finished job and how many slices failed.
 */
async function runThroughFailures(orgId: string, adminId: string, fetchImpl: typeof fetch) {
  registerProviderForTests({ ...bamboohrProvider, minIntervalMs: 0 });
  const job = await db.importJob.create({
    data: {
      orgId,
      provider: bamboohrProvider.id,
      credentials: sealCredentials(credentials),
      options: { ...DEFAULT_IMPORT_OPTIONS } as Prisma.InputJsonValue,
      createdById: adminId,
    },
  });
  const ctx = { userId: adminId, orgId, accessRole: 'ADMIN' };
  let failed = 0;
  const settle = async () => {
    for (let i = 0; i < 100; i++) {
      const current = await db.importJob.findUniqueOrThrow({ where: { id: job.id } });
      if (current.status !== 'DISCOVERING' && current.status !== 'RUNNING') return current;
      if ((await runSlice(job.id, 30_000, { fetchImpl })) === 'failed') {
        failed++;
        await db.importJob.update({ where: { id: job.id }, data: { leaseUntil: null } });
      }
    }
    throw new Error('Import did not settle');
  };
  await settle();
  const review = (await getImportJob(ctx, job.id))!.review!;
  await confirmImportMapping(ctx, job.id, {
    stages: Object.fromEntries(review.stages.map((s) => [s.key, s.target])),
    reasons: Object.fromEntries(review.reasons.map((r) => [r.key, r.target])),
  });
  const done = await settle();
  return { job: done, failed, view: (await getImportJob(ctx, job.id))! };
}

// ---------- tests ----------

describe.skipIf(!hasDb)('bamboohr adapter', () => {
  it('builds with no credentials and lists its phases', () => {
    const adapter = bamboohrProvider.create({}, createHttpClient({ resolveHost: publicDns, auth: { hosts: [] }, minIntervalMs: 0 }));
    expect(adapter.discover.map((p) => p.id)).toEqual(['users', 'statuses']);
    expect(adapter.load.map((p) => p.id)).toEqual([
      'postings',
      'applications-new',
      'applications-active',
      'applications-archived',
      'applications-hired',
      'applications-sweep',
      'applications-deleted-jobs',
    ]);
    expect(bamboohrProvider.auth({})).toEqual({ hosts: [] });
  });

  it('verifies with Basic auth (key as username, "x" as password) and returns the company name', async () => {
    for (const companyDomain of [' https://ACME.bamboohr.com/hiring/jobs ', 'https://api.bamboohr.com/api/gateway.php/acme/v1/', 'acme.bamboohr.com:443']) {
      const mock = tenant();
      const result = await verifyForTest(bamboohrProvider, { companyDomain, apiKey: KEY }, mock.impl);
      expect(result).toEqual({ accountName: 'Efficient Office' });
      expect(mock.calls.map((c) => `${c.method} ${c.url.host}${c.url.pathname}`)).toEqual([
        `GET ${API}/applicant_tracking/statuses`,
        `GET ${API}/company_information`,
      ]);
      for (const c of mock.calls) {
        expect(c.headers.authorization).toBe(BASIC);
        expect(c.headers.accept).toBe('application/json');
      }
      expect(JSON.stringify(result)).not.toContain(KEY);
    }
    expect(Buffer.from(BASIC.slice('Basic '.length), 'base64').toString()).toBe(`${KEY}:x`);
  });

  it('rejects a malformed or non-tenant subdomain before calling out, and a key without ATS access', async () => {
    const none = tenant();
    for (const companyDomain of ['acme corp', 'https://www.bamboohr.com', 'https://api.bamboohr.com/api/v1/']) {
      await expect(verifyForTest(bamboohrProvider, { companyDomain, apiKey: KEY }, none.impl)).rejects.toThrow(/subdomain/);
      expect(bamboohrProvider.auth({ companyDomain, apiKey: KEY })).toEqual({ hosts: [] });
    }
    expect(none.calls).toHaveLength(0);

    const noAts = tenant({ overrides: { [`GET ${API}/applicant_tracking/statuses`]: () => new Response('', { status: 403 }) } });
    const err = await verifyForTest(bamboohrProvider, credentials, noAts.impl).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImportAuthError);
    expect((err as ImportAuthError).status).toBe(403);

    const noInfo = tenant({ overrides: { [`GET ${API}/company_information`]: () => new Response('', { status: 403 }) } });
    await expect(verifyForTest(bamboohrProvider, credentials, noInfo.impl)).resolves.toEqual({ accountName: 'acme.bamboohr.com' });
  });

  it('imports jobs, applications, ratings, comments and resumes, then re-runs without duplicating', async () => {
    const mock = tenant();
    const run = await runImportForTest({ module: bamboohrProvider, credentials, fetchImpl: mock.impl });
    expect(run.error).toBeNull();
    expect(run.status).toBe('SUCCEEDED');
    expect(mock.unmatched).toEqual([]);

    // Review: stages are the pipeline statuses (plus a disabled one an application holds), reasons the "not hired" ones.
    const review = run.review!;
    expect(review.stages.map((s) => s.name)).toEqual([
      'New',
      'Reviewed',
      'Schedule Phone Screen',
      'Phone Screened',
      'Schedule Interview',
      'Interviewed',
      'Put on Hold',
      'Checking References',
      'Made an Offer',
      'Hired',
      'Offer Sent',
      'Offer Signed',
      'Technical Assessment',
      'Culture Interview',
    ]);
    const stage = Object.fromEntries(review.stages.map((s) => [s.key, s]));
    expect(stage['hired'].target).toHaveProperty('stageId'); // the org's own Hired stage
    expect(stage['new'].target).toEqual({ create: { name: 'New', type: 'APPLICANT' } });
    expect(stage['schedule interview'].target).toEqual({ create: { name: 'Schedule Interview', type: 'ONSITE' } });
    expect(stage['made an offer'].target).toEqual({ create: { name: 'Made an Offer', type: 'OFFER' } });
    expect(stage['offer signed'].suggestedType).toBe('OFFER');
    expect(stage['technical assessment'].suggestedType).toBe('SCREEN');
    expect(Object.fromEntries(review.reasons.map((r) => [r.name, r.kind]))).toEqual({
      'Not a Fit': 'rejection',
      'Declined Offer': 'withdrawn',
      'Not Qualified': 'rejection',
      'Over Qualified': 'rejection',
      'Hired Elsewhere': 'withdrawn',
      Hired: 'hired',
      'Moved to another job': 'withdrawn',
      Withdrew: 'withdrawn', // custom status found in the INACTIVE group
      'No Longer Interested': 'withdrawn', // custom and unused: filed by its name
    });
    expect(review.reasons.find((r) => r.name === 'Moved to another job')!.target).toEqual({
      create: { name: 'Moved to another job', countsAsRejection: false },
    });
    expect(review.users).toMatchObject({ total: 4, matched: 1 });

    expect(run.view.created).toEqual({ posting: 5, contact: 8, opportunity: 10, feedback: 5, note: 3, file: 1 });
    expect(run.view.linked.contact).toBe(2); // Anderson Pierce and Rosa Diaz each applied twice under two applicant ids
    expect(run.view.stats['stage.created']).toBeUndefined(); // every status an application holds was reviewed
    expect(run.view.stats['reason.created']).toBeUndefined();

    // Only GETs, credentials only to the tenant's API (not the public careers pages), never in anything stored.
    for (const c of mock.calls) {
      expect(c.method).toBe('GET');
      expect(c.headers.authorization).toBe(c.url.host === HOST && !c.url.pathname.startsWith('/careers/') ? BASIC : undefined);
      expect(c.url.toString()).not.toContain(KEY);
    }
    expect(hits(mock.calls, `${HOST}/careers/22/detail`)).toBe(1);
    expect(mock.calls.some((c) => c.url.host === S3)).toBe(true);
    const job = await db.importJob.findUniqueOrThrow({ where: { id: run.jobId } });
    expect(JSON.stringify([job.issues, job.stats, job.catalog, job.cursor])).not.toMatch(new RegExp(`${KEY}|${BASIC.slice(6)}`));

    // Every group walked with explicit ordering and paged until paginationComplete, then the
    // all-status sweep (everything already imported) and the deleted-jobs pass.
    expect(listed(mock.calls)).toEqual([
      'NEW/ALL:1',
      'ACTIVE/ALL:1',
      'ACTIVE/ALL:2',
      'INACTIVE/ALL:1',
      'INACTIVE/ALL:2',
      'HIRED/ALL:1',
      'ALL/ALL:1',
      'ALL/ALL:2',
      'ALL/ALL:3',
      'ALL/ALL:4',
      'ALL/ALL:5',
      'ALL/Deleted:1',
    ]);
    for (const c of mock.calls.filter((x) => isListCall(x.url))) {
      expect(c.url.searchParams.get('sortBy')).toBe('created_date');
      expect(c.url.searchParams.get('sortOrder')).toBe('ASC');
      expect(c.url.searchParams.has('newSince')).toBe(false);
    }
    // One detail call per application, none for the sweep's already-imported rows.
    expect(mock.calls.filter((c) => /\/applications\/\d+$/.test(c.url.pathname))).toHaveLength(apps.length);

    // Postings
    const postings = await db.posting.findMany({ where: { orgId: run.orgId }, include: { department: true } });
    const posting = Object.fromEntries(postings.map((p) => [p.title, p]));
    expect(posting['Financial Analyst']).toMatchObject({
      state: 'DRAFT', // open roles never go live by themselves
      workplaceType: 'HYBRID',
      commitment: 'FULL_TIME',
      location: 'Salt Lake City, Utah, United States',
    });
    expect(posting['Financial Analyst'].department!.name).toBe('Finance');
    expect(posting['Financial Analyst'].createdAt.toISOString()).toBe('2026-04-22T20:21:18.000Z');
    const description = (posting['Financial Analyst'].content as { description: string }).description;
    expect(description).toContain('MAIN DUTIES & RESPONSIBILITIES:');
    expect(description).toContain('• Own the monthly close.');
    expect(description).toContain('Compensation: $70,000 - $85,000 a year');
    expect(posting['IT Security Engineer']).toMatchObject({ state: 'DRAFT', content: null });
    expect(posting['Customer Success Advocate'].state).toBe('CLOSED');
    expect(posting['Videographer']).toMatchObject({ state: 'DRAFT', location: null });
    expect(posting['Warehouse Associate'].state).toBe('CLOSED'); // a deleted job

    // Applications
    const opps = await db.opportunity.findMany({
      where: { orgId: run.orgId },
      include: {
        stage: true,
        archiveReason: true,
        posting: true,
        contact: true,
        stageTransitions: { orderBy: { occurredAt: 'asc' }, include: { toStage: true } },
      },
    });
    expect(opps).toHaveLength(apps.length);
    const opp = Object.fromEntries(opps.map((o) => [importedId(o), o]));

    const nathan = opp['33'];
    expect(nathan).toMatchObject({ status: 'ACTIVE', origin: 'REFERRED', source: 'LinkedIn', ownerId: run.adminId, archivedAt: null });
    expect(nathan.stage.name).toBe('Schedule Interview');
    expect(nathan.posting!.title).toBe('IT Security Engineer');
    expect(nathan.createdAt.toISOString()).toBe('2025-12-29T21:03:16.000Z');
    expect(nathan.stageChangedAt.toISOString()).toBe('2026-01-06T19:25:03.000Z');
    expect(nathan.stageTransitions.map((t) => [t.toStage.name, t.occurredAt.toISOString(), t.actorId])).toEqual([
      ['Schedule Interview', '2026-01-06T19:25:03.000Z', run.adminId],
    ]);
    expect(importedFields(nathan)).toEqual({
      'Referred by': 'Ashley Adams',
      'Desired salary': '₤85,000',
      'Available start date': '2026-02-15',
      Education: 'College - Bachelor of Science, University of Glasgow',
      'How did you hear about this position?': 'My friend told me to apply to this position.',
      'References (Name, Company, and Contact Info)': 'Paul Clayton\nDirector of Digital Security\nSoftware Company\n+44 20 5555 0920',
    });
    expect(nathan.contact).toMatchObject({
      name: 'Nathan Rose',
      emails: ['nathan@efficientoffice.com'],
      phones: ['+44 20 5555 2023'],
      links: ['https://www.linkedin.com/in/nathanrose', 'http://www.blogger.com'],
      location: 'Glasgow City, United Kingdom',
    });
    expect(nathan.contact.createdAt.toISOString()).toBe('2025-12-29T21:03:16.000Z');

    expect(opp['49']).toMatchObject({ status: 'ACTIVE', origin: 'APPLIED', ownerId: null }); // hiring lead has no user account
    expect(opp['49'].stage.name).toBe('New');
    expect(opp['59'].stage.name).toBe('Technical Assessment');
    expect(opp['46'].source).toBe('Unknown source (BambooHR #11)');
    expect(opp['46'].contactId).toBe(opp['59'].contactId);

    // A disabled status still held; "N/A" is not a referrer; the move is kept raw.
    expect(opp['64']).toMatchObject({ status: 'ACTIVE', origin: 'APPLIED' });
    expect(opp['64'].stage.name).toBe('Made an Offer');
    expect(importedFields(opp['64'])).toEqual({ 'Referred by': 'N/A', 'Moved from': '[{"id":61,"jobId":14}]' });

    const rejected = opp['20'];
    expect(rejected.status).toBe('ARCHIVED');
    expect(rejected.archiveReason).toMatchObject({ name: 'Not a Fit', countsAsRejection: true });
    expect(rejected.archivedAt!.toISOString()).toBe('2026-01-02T09:15:00.000Z');
    // BambooHR keeps no stage from before the rejection: just the one transition into where it sits.
    expect(rejected.stageTransitions.map((t) => t.toStageId)).toEqual([rejected.stageId]);
    expect(opp['27'].archiveReason).toMatchObject({ name: 'Withdrew', countsAsRejection: false });

    const moved = opp['61'];
    expect(moved).toMatchObject({ status: 'ARCHIVED' });
    expect(moved.archiveReason).toMatchObject({ name: 'Moved to another job', countsAsRejection: false });
    expect(moved.archivedAt!.toISOString()).toBe('2026-03-01T12:00:00.000Z');
    expect(importedFields(moved)).toEqual({ 'Moved to': '[{"id":64,"jobId":22}]' });
    expect(moved.contactId).toBe(opp['64'].contactId);

    const onDeletedJob = opp['8'];
    expect(onDeletedJob.status).toBe('ARCHIVED');
    expect(onDeletedJob.archiveReason!.name).toBe('Not Qualified');
    expect(onDeletedJob.posting!.title).toBe('Warehouse Associate');

    const hired = opp['12'];
    expect(hired.status).toBe('HIRED');
    expect(hired.stage.name).toBe('Hired');
    // Like a hire made in Source: no archive reason or date; entering Hired is the hire date.
    expect(hired.archiveReason).toBeNull();
    expect(hired.archivedAt).toBeNull();
    expect(hired.stageChangedAt.toISOString()).toBe('2026-01-20T16:45:00.000Z');
    expect(hired.stageTransitions.map((t) => [t.toStage.name, t.actorId])).toEqual([['Hired', null]]); // Daniel Vance isn't a teammate

    // Star ratings: 5→strong yes, 4→yes, 2→no; 3 is neutral and stays a note; none → nothing.
    const feedback = await db.feedbackSubmission.findMany({ where: { orgId: run.orgId } });
    expect(Object.fromEntries(feedback.map((f) => [importedId(opps.find((o) => o.id === f.opportunityId)!), f.overallRating]))).toEqual({
      '49': 3,
      '33': 4,
      '20': 2,
      '12': 4,
    });
    expect(feedback.find((f) => f.opportunityId === nathan.id)!.summary).toMatch(/Star rating: 5\/5/);

    // Notes: a matched teammate gets no byline; an unmatched one keeps their name. The attachment
    // BambooHR wouldn't serve is named in a note.
    const notes = await db.note.findMany({ where: { orgId: run.orgId }, orderBy: { createdAt: 'asc' } });
    const byOpp = (id: string) => notes.filter((n) => n.opportunityId === opp[id].id);
    expect(byOpp('33').map((n) => [n.body, n.createdAt.toISOString(), n.authorId])).toEqual([
      [expect.stringMatching(/^\[[^\]]*\] Attachment "portfolio\.pdf" is stored in BambooHR \(file ID 212\)/), '2025-12-29T21:03:16.000Z', run.adminId],
      ['Strong security background; schedule with the IT team.', '2026-01-06T19:30:12.000Z', run.adminId],
      [expect.stringMatching(/^\[[^\]]*Dwight Goodman\] Phone screen went well\.\nAsked about on-call expectations\.$/), '2026-01-08T15:02:44.000Z', run.adminId],
    ]);
    expect(byOpp('46').map((n) => n.body)).toEqual([expect.stringMatching(/Star rating: 3\/5/)]);

    // Resume stored from the pre-signed URL.
    const resume = await db.storedFile.findUniqueOrThrow({ where: { id: nathan.contact.resumeFileId! } });
    expect(resume).toMatchObject({ filename: 'Nathan_Rose_Resume.pdf', mime: 'application/pdf' });

    // The 403 on comments, the unlisted job and the failed attachment are warnings, not failures.
    const issues = run.view.issues.map((i) => i.message);
    expect(issues).toEqual(
      expect.arrayContaining([
        'Notes on some applications could not be read (HTTP 403). BambooHR does not document reading comments.',
        expect.stringMatching(/^An open job is not on the public careers page.*careers\/15\/detail/),
        'Some BambooHR files could not be downloaded (HTTP 404), so a note on the application names each one',
      ]),
    );
    expect(run.view.issues.find((i) => i.message.startsWith('Notes on some'))).toMatchObject({ externalId: '46' });

    // Re-running into the same org creates nothing and skips per-application fan-out.
    const again = tenant();
    const rerun = await runImportForTest({ module: bamboohrProvider, credentials, fetchImpl: again.impl, orgId: run.orgId });
    expect(rerun.status).toBe('SUCCEEDED');
    expect(again.unmatched).toEqual([]);
    expect(rerun.view.created).toEqual({});
    expect(again.calls.filter((c) => isFanOut(c.url))).toEqual([]);
    expect(await db.opportunity.count({ where: { orgId: run.orgId } })).toBe(apps.length);
    expect(await db.contact.count({ where: { orgId: run.orgId } })).toBe(8);
    expect(await db.note.count({ where: { orgId: run.orgId } })).toBe(4); // two comments, the file note, the 3-star rating
    expect(await db.feedbackSubmission.count({ where: { orgId: run.orgId } })).toBe(4);
  });

  it('filters server-side when archived is off and a since date is set', async () => {
    const mock = tenant();
    const run = await runImportForTest({
      module: bamboohrProvider,
      credentials,
      fetchImpl: mock.impl,
      options: { archived: false, since: '2026-01-01T00:00:00.000Z' },
    });
    expect(run.status).toBe('SUCCEEDED');
    expect(mock.unmatched).toEqual([]);
    expect(run.view.phases.map((p) => p.id)).not.toContain('applications-archived');
    expect(run.view.phases.map((p) => p.id)).not.toContain('applications-hired');

    // The sweep and the deleted-jobs pass ask for active groups only, too.
    expect(listed(mock.calls)).toEqual(['NEW/ALL:1', 'ACTIVE/ALL:1', 'NEW,ACTIVE/ALL:1', 'NEW,ACTIVE/ALL:2', 'NEW,ACTIVE/Deleted:1']);
    for (const c of mock.calls.filter((x) => isListCall(x.url))) expect(c.url.searchParams.get('newSince')).toBe('2026-01-01 00:00:00');

    const opps = await db.opportunity.findMany({ where: { orgId: run.orgId } });
    expect(opps.map(importedId).sort()).toEqual(['46', '49', '64']);
    expect(run.view.created).toMatchObject({ opportunity: 3, contact: 3 });
  });

  it("files custom statuses by name when the status filters don't combine as AND", async () => {
    // With applicationStatusId overriding applicationStatus, every used custom status shows up in both
    // probes. Trusting the INACTIVE probe alone would make "Technical Assessment" an archive reason.
    const finalRound = app('ACTIVE', {
      id: 70,
      appliedDate: '2026-05-04T09:00:00+00:00',
      status: { id: 25, label: 'Final Round', dateChanged: '2026-05-10T09:00:00+00:00', changedByUser: null },
      rating: null,
      applicant: { id: 130, firstName: 'Lena', lastName: 'Park', email: 'lena.park@example.org', source: 'LinkedIn' },
      job: 15,
    });
    const mock = tenant({ filters: 'id-overrides-group', apps: [...apps, finalRound], statuses: [...statuses, status(25, null, 'Final Round')] });
    const run = await runImportForTest({ module: bamboohrProvider, credentials, fetchImpl: mock.impl });
    expect(run.status).toBe('SUCCEEDED');

    const review = run.review!;
    expect(review.stages.map((s) => s.name)).toEqual(expect.arrayContaining(['Technical Assessment', 'Culture Interview', 'Final Round']));
    expect(review.reasons.map((r) => r.name)).not.toContain('Technical Assessment');
    expect(review.reasons.find((r) => r.name === 'Withdrew')).toMatchObject({ kind: 'withdrawn' });
    expect(run.view.issues.map((i) => i.message)).toContain(
      "BambooHR's status filters didn't isolate one status, so custom statuses were sorted into stages and archive reasons by name.",
    );

    const opps = await db.opportunity.findMany({ where: { orgId: run.orgId }, include: { stage: true, archiveReason: true } });
    const opp = Object.fromEntries(opps.map((o) => [importedId(o), o]));
    expect(opp['59']).toMatchObject({ status: 'ACTIVE' });
    expect(opp['59'].stage.name).toBe('Technical Assessment');
    expect(opp['70'].stage.name).toBe('Final Round');
    expect(opp['27'].archiveReason!.name).toBe('Withdrew');
    expect(run.view.stats['stage.created']).toBeUndefined();
  });

  it('finds applications hidden when another one leaves a group mid-walk, and trusts the newer detail status', async () => {
    const person = (id: number, first: string) => ({ id, firstName: first, lastName: 'Ortiz', email: `${first.toLowerCase()}@example.org`, source: 'Indeed' });
    const three = [101, 102, 103].map((id, i) =>
      app('ACTIVE', {
        id,
        appliedDate: `2026-02-0${i + 1}T10:00:00+00:00`,
        status: { id: 2, label: 'Reviewed', dateChanged: `2026-02-0${i + 2}T10:00:00+00:00`, changedByUser: changer(2370, 'Dwight', 'Goodman') },
        rating: null,
        applicant: person(200 + i, ['Ana', 'Ben', 'Cruz'][i]),
        job: 15,
      }),
    );
    const mock = tenant({
      apps: three,
      afterList: (q, data) => {
        // A recruiter rejects 102 right after the first ACTIVE page is served.
        if (q.get('applicationStatus') !== 'ACTIVE' || q.get('page') !== '1') return;
        const rejected = data.find((a) => a.detail.id === 102)!;
        rejected.group = 'INACTIVE';
        rejected.detail.status = { id: 10, label: 'Not a Fit', dateChanged: '2026-02-20T08:00:00+00:00', changedByUser: changer(2370, 'Dwight', 'Goodman') };
      },
    });
    const run = await runImportForTest({ module: bamboohrProvider, credentials, fetchImpl: mock.impl });
    expect(run.status).toBe('SUCCEEDED');

    // ACTIVE page 2 comes back empty because 103 slid onto page 1; the sweep picks it up.
    expect(listed(mock.calls)).toEqual(['NEW/ALL:1', 'ACTIVE/ALL:1', 'ACTIVE/ALL:2', 'INACTIVE/ALL:1', 'HIRED/ALL:1', 'ALL/ALL:1', 'ALL/ALL:2', 'ALL/Deleted:1']);
    const opps = await db.opportunity.findMany({ where: { orgId: run.orgId }, include: { stage: true, archiveReason: true } });
    const opp = Object.fromEntries(opps.map((o) => [importedId(o), o]));
    expect(Object.keys(opp).sort()).toEqual(['101', '102', '103']);
    expect(opp['103']).toMatchObject({ status: 'ACTIVE' });
    expect(opp['103'].stage.name).toBe('Reviewed');

    // 102 was listed as Reviewed, but its detail says Not a Fit: archived with that reason, not a new stage.
    expect(opp['102']).toMatchObject({ status: 'ARCHIVED' });
    expect(opp['102'].archiveReason).toMatchObject({ name: 'Not a Fit', countsAsRejection: true });
    expect(opp['102'].archivedAt!.toISOString()).toBe('2026-02-20T08:00:00.000Z');
    expect(await db.stage.count({ where: { orgId: run.orgId, name: 'Not a Fit' } })).toBe(0);
    expect(mock.calls.filter((c) => /\/applications\/\d+$/.test(c.url.pathname))).toHaveLength(3);
  });

  it('replays an application whose comments or resume hit a long rate limit, without losing either', async () => {
    let commentCalls = 0;
    let resumeCalls = 0;
    // Retry-After outlasts the slice, so the client yields and the runner replays the page.
    const limited = () => new Response('', { status: 429, headers: { 'retry-after': '3600' } });
    const mock = tenant({
      overrides: {
        [`GET ${API}/applicant_tracking/applications/33/comments`]: () => (++commentCalls === 1 ? limited() : json(comments33)),
        [`GET ${API}/files/177`]: () =>
          ++resumeCalls === 1
            ? limited()
            : new Response(null, { status: 302, headers: { location: `https://${S3}/applicants/177/Nathan_Rose_Resume.pdf?X-Amz-Signature=abc123` } }),
      },
    });
    const run = await runImportForTest({ module: bamboohrProvider, credentials, fetchImpl: mock.impl });
    expect(run.status).toBe('SUCCEEDED');
    expect(commentCalls).toBeGreaterThan(1);
    expect(resumeCalls).toBe(2);

    const nathan = await db.opportunity.findFirstOrThrow({
      where: { orgId: run.orgId, customFields: { path: ['imported', 'id'], equals: '33' } },
      include: { contact: true, notes: true },
    });
    expect(nathan.notes.map((n) => n.body)).toEqual(
      expect.arrayContaining(['Strong security background; schedule with the IT team.', expect.stringMatching(/Phone screen went well/)]),
    );
    expect(nathan.contact.resumeFileId).not.toBeNull();
    expect(await db.opportunity.count({ where: { orgId: run.orgId } })).toBe(apps.length);
  });

  it('retries the slice when a download is still rate-limited after every retry, instead of dropping the file', async () => {
    // An org with the jobs already imported and nothing else.
    const seed = await runImportForTest({ module: bamboohrProvider, credentials, fetchImpl: tenant({ apps: [] }).impl });
    let resumeCalls = 0;
    const mock = tenant({
      apps: apps.filter((a) => a.detail.id === 33),
      overrides: {
        // The client makes six attempts; Retry-After 0 means each fails at once.
        [`GET ${API}/files/177`]: () =>
          ++resumeCalls <= 6
            ? new Response('', { status: 429, headers: { 'retry-after': '0' } })
            : new Response(null, { status: 302, headers: { location: `https://${S3}/applicants/177/Nathan_Rose_Resume.pdf?X-Amz-Signature=abc123` } }),
      },
    });
    const { job, failed, view } = await runThroughFailures(seed.orgId, seed.adminId, mock.impl);
    expect(job.status).toBe('SUCCEEDED');
    expect(failed).toBe(1);
    expect(resumeCalls).toBe(7);
    const nathan = await db.opportunity.findFirstOrThrow({ where: { orgId: seed.orgId }, include: { contact: true, notes: true } });
    expect(nathan.contact.resumeFileId).not.toBeNull();
    expect(nathan.notes.map((n) => n.body)).not.toContainEqual(expect.stringMatching(/Resume is stored in BambooHR/));
    expect(view.issues.map((i) => i.message)).not.toContainEqual(expect.stringMatching(/could not be downloaded \(HTTP 429\)|Couldn't download/));
  });

  it('treats a 401 from the undocumented comments endpoint as missing notes, not a bad key', async () => {
    const mock = tenant({ overrides: { [`GET ${API}/applicant_tracking/applications/33/comments`]: () => new Response('', { status: 401 }) } });
    const run = await runImportForTest({ module: bamboohrProvider, credentials, fetchImpl: mock.impl });
    expect(run.status).toBe('SUCCEEDED');
    expect(run.error).toBeNull();
    expect(run.view.created.opportunity).toBe(apps.length);
    expect(run.view.issues.map((i) => i.message)).toContain(
      'Notes on some applications could not be read (HTTP 401). BambooHR does not document reading comments.',
    );
  });

  it("names every file BambooHR won't serve in a note, and stops trying after five failures", async () => {
    const file = (id: number, name: string) => ({ id, name, fileUrl: `https://acme.bamboohr.com/files/download.php?id=${id}` });
    const withFiles = [
      app('ACTIVE', {
        id: 81,
        appliedDate: '2026-03-02T10:00:00+00:00',
        status: { id: 2, label: 'Reviewed', dateChanged: '2026-03-03T10:00:00+00:00', changedByUser: null },
        rating: null,
        applicant: { id: 301, firstName: 'Ivy', lastName: 'Chen', email: 'ivy.chen@example.org', source: 'LinkedIn' },
        job: 15,
        resumeFileId: 501,
        coverLetterFileId: 502,
        attachmentCount: 2,
        attachments: [file(503, 'portfolio.pdf'), file(504, 'references.docx')],
      }),
      app('ACTIVE', {
        id: 82,
        appliedDate: '2026-03-05T10:00:00+00:00',
        status: { id: 2, label: 'Reviewed', dateChanged: '2026-03-06T10:00:00+00:00', changedByUser: null },
        rating: null,
        applicant: { id: 302, firstName: 'Omar', lastName: 'Haddad', email: 'omar.haddad@example.org', source: 'Indeed' },
        job: 15,
        resumeFileId: 505,
        attachmentCount: 2,
        attachments: [file(506, 'writing-sample.pdf'), file(507, 'transcript.pdf')],
      }),
    ];
    const overrides: Record<string, RouteHandler> = {};
    for (const id of [501, 502, 503, 504, 505, 506, 507]) overrides[`GET ${API}/files/${id}`] = () => new Response('', { status: 403 });
    const mock = tenant({ apps: withFiles, overrides });
    const run = await runImportForTest({ module: bamboohrProvider, credentials, fetchImpl: mock.impl });
    expect(run.status).toBe('SUCCEEDED');
    expect(mock.unmatched).toEqual([]);

    // Five failures in a row open the breaker, so 506 and 507 are never requested.
    expect(mock.calls.filter((c) => c.url.pathname.startsWith('/api/v1/files/')).map((c) => c.url.pathname.split('/').pop())).toEqual([
      '501',
      '502',
      '503',
      '504',
      '505',
    ]);
    const issues = run.view.issues.map((i) => i.message);
    expect(issues).toEqual(
      expect.arrayContaining([
        'Some BambooHR files could not be downloaded (HTTP 403), so a note on the application names each one',
        'Stopped downloading BambooHR files after repeated failures. The API may not serve applicant files for this account.',
      ]),
    );

    const notes = await db.note.findMany({ where: { orgId: run.orgId }, include: { opportunity: true } });
    const bodies = notes.map((n) => `${importedId(n.opportunity)}: ${n.body.replace(/^\[[^\]]*\] /, '')}`).sort();
    expect(bodies).toEqual([
      '81: Attachment "portfolio.pdf" is stored in BambooHR (file ID 503) but could not be downloaded through its API.',
      '81: Attachment "references.docx" is stored in BambooHR (file ID 504) but could not be downloaded through its API.',
      '81: Cover letter is stored in BambooHR (file ID 502) but could not be downloaded through its API.',
      '81: Resume is stored in BambooHR (file ID 501) but could not be downloaded through its API.',
      '82: Attachment "transcript.pdf" is stored in BambooHR (file ID 507) but could not be downloaded through its API.',
      '82: Attachment "writing-sample.pdf" is stored in BambooHR (file ID 506) but could not be downloaded through its API.',
      '82: Resume is stored in BambooHR (file ID 505) but could not be downloaded through its API.',
    ]);
    expect(await db.storedFile.count({ where: { orgId: run.orgId } })).toBe(0);
  });

  it('keeps paging while paginationComplete is false, even without a nextPageUrl', async () => {
    const mock = tenant({ nextPageUrl: 'omitted' });
    const run = await runImportForTest({ module: bamboohrProvider, credentials, fetchImpl: mock.impl });
    expect(run.status).toBe('SUCCEEDED');
    expect(listed(mock.calls)).toEqual(expect.arrayContaining(['ACTIVE/ALL:2', 'INACTIVE/ALL:2', 'ALL/ALL:5']));
    expect(run.view.created.opportunity).toBe(apps.length);
  });
});
