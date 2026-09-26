import { describe, expect, it, vi } from 'vitest';
import { hasDb, publicDns } from '@/server/imports/__tests__/harness';
import type { HttpClient } from '@/server/imports/http';
import type {
  Cursor,
  ImportedFeedback,
  ImportedFile,
  ImportedOffer,
  ImportedPosting,
  ImportOptions,
  Phase,
  PhaseContext,
  RefKind,
} from '@/server/imports/types';

vi.mock('@/lib/session', () => ({ isAdmin: () => true }));

const { db, json, mockFetch, runImportForTest, verifyForTest } = await import('@/server/imports/__tests__/harness');
const { smartrecruitersProvider } = await import('@/server/imports/providers/smartrecruiters');
const { providerMeta } = await import('@/lib/import-providers');
const { createHttpClient, ImportAuthError } = await import('@/server/imports/http');
const { DEFAULT_IMPORT_OPTIONS } = await import('@/server/imports/types');

type Handler = Parameters<typeof mockFetch>[0][string];
type Req = Parameters<Handler>[0];

/**
 * A small SmartRecruiters account, shaped like the Customer API's OpenAPI
 * payloads (see the spec): 24-hex user ids, UUID candidates/jobs, ISO
 * timestamps with milliseconds, bare-array messages/reviews, Link-header
 * paging, one candidate row per application, and a resume that redirects to
 * a storage host.
 */

const CREDS = { clientId: '82e4424135fe01c169165228a84e7c5c', clientSecret: '9165228a82e44244e7c5c8135fe01c16' };
const API = 'api.smartrecruiters.com';
const S3 = 'sr-attachments-prod.s3.eu-central-1.amazonaws.com';

const PRIYA = '5f32c6ae3f4eff0713727b6e'; // matches the test org's admin by email
const MARCUS = '60f818625414a64b384c8705';
const DANA = '6086ef05e26a732d0ac22157'; // deactivated

const BACKEND = '8b9939df-8756-4332-94c0-34f2af250f5c';
const DESIGNER = '6a07afa3-cd71-4576-b603-7fc03dd5f5ab';
const TEMPLATE = '1f2e3d4c-5b6a-4798-8a7b-6c5d4e3f2a1b';

const JAKUB = '90e2bb61-28ef-4ca6-abae-62edcaf4ff5c';
const WITEK = '788dfc72-a6eb-441b-837f-d7c39efb3f04';
const ANA = '4c8e2f1a-7b3d-4e9f-a0c6-5d1b8e7f2a93';
const HIDDEN = 'd1e2f3a4-b5c6-4d7e-8f9a-0b1c2d3e4f5a'; // outside the credential's access group

const APP_ID: Record<string, string> = {
  [`${JAKUB}:${BACKEND}`]: '3e7a1b52-9c4d-4f0e-8a6b-2d5f1c7e9a40',
  [`${JAKUB}:${DESIGNER}`]: '5c9d3e74-1b6f-4a2e-9c8d-4f7e3b1a6c52',
  [`${WITEK}:${BACKEND}`]: '7e1f5a96-3d8b-4c4a-8e0f-6b9d5c3e8a74',
  [`${ANA}:${DESIGNER}`]: '9a3b7c18-5f0d-4e6c-a2b1-8d1f7e5a0c96',
};

const CANDIDATE_PAGE_2 = 'SKYfn51wTboVGco6/vIsIC/YbyYP/4WgqHLArvCRtYhQEMCgvp1Zj0ya0wpjfKIblyGRcbHytMcvCehVazcjQA==';
const MESSAGES_PAGE_2 = 'bXNnLXBhZ2UtMg==';
const RESUME_ID = 'efab3632-1cc4-4abb-993b-cc0a5d2f3b21';
const RESUME_BYTES = Buffer.from('%PDF-1.4 Jakub Kowalski resume');
const WITEK_CV_ID = '3c2b1a09-8f7e-4d6c-9b5a-493827160f5e';
const PORTFOLIO_ID = '4e5f6a7b-8c9d-4e0f-a1b2-c3d4e5f6a7b8';
const OFFER_ACCEPTED = '4a3b2c1d-0e9f-4a8b-9c7d-6e5f4a3b2c1d';
const OFFER_PENDING = '5b4c3d2e-1f0a-4b9c-8d7e-7f6a5b4c3d2e';
const OFFER_NOT_APPROVED = '6c5d4e3f-2a1b-4c0d-9e8f-8a7b6c5d4e3f';
const OFFER_DOCUMENT_ID = '2f3e4d5c-6b7a-4899-8a0b-1c2d3e4f5a6b';

const link = (path: string) => ({ url: `https://${API}${path}`, method: 'GET' });
const jobRef = (id: string, title: string) => ({ id, title, actions: { details: link(`/jobs/${id}`) } });
const forbidden = (message: string) => json({ message: 'Permission denied', errors: [{ code: 'PERMISSION_DENIED', message }] }, { status: 403 });

// ---------- payloads ----------

const users = [
  { id: PRIYA, firstName: 'Priya', lastName: 'Raman', email: 'Admin@Example.test', active: true, systemRole: { id: 'ADMINISTRATOR' }, updatedOn: '2026-05-11T08:14:22.901Z', language: { code: 'en' }, ssoLoginMode: 'SSO' },
  { id: MARCUS, firstName: 'Marcus', lastName: 'Lee', email: 'marcus.lee@acme.example', active: true, systemRole: { id: 'STANDARD' }, updatedOn: '2026-02-01T10:00:00.000Z', language: { code: 'en' } },
  { id: DANA, firstName: 'Dana', lastName: 'Wójcik', email: 'dana.wojcik@acme.example', active: false, systemRole: { id: 'RESTRICTED' }, updatedOn: '2026-06-30T17:45:00.000Z', language: { code: 'en' }, accessGroups: [] },
];

const hiringProcesses = {
  totalFound: 2,
  content: [
    {
      id: 'c1f4e2a0-5b7d-4e8a-9f3c-1a2b3c4d5e6f',
      name: 'Default hiring process',
      active: true,
      subStatuses: {
        IN_REVIEW: ['Recruiter Screen', 'Hiring Manager Review'],
        INTERVIEW: ['Phone Screen', 'Technical Interview', 'Onsite'],
        OFFERED: ['Offer Preparation', 'Offer Sent'],
      },
    },
    {
      id: 'd2a5f3b1-6c8e-4f9b-a04d-2b3c4d5e6f70',
      name: 'Hourly roles',
      active: false,
      subStatuses: { IN_REVIEW: ['Phone Screen'], INTERVIEW: ['In-person Interview'], OFFERED: [] },
    },
  ],
};

const rejectionReasons = {
  totalFound: 3,
  content: [
    { id: '5d3f9a2c-1b7e-4c8d-9e0f-a1b2c3d4e5f6', label: 'Not enough experience' },
    { id: '6e4a0b3d-2c8f-4d9e-8f1a-b2c3d4e5f6a7', label: 'Salary expectations too high' },
    { id: '7f5b1c4e-3d9a-4e0f-9a2b-c3d4e5f6a7b8', label: 'Position filled' },
  ],
};

const jobRow = (id: string, title: string, status: string, postingStatus: string) => ({
  id,
  title,
  refNumber: `REF-${id.slice(0, 4)}`,
  createdOn: '2026-01-14T10:02:44.120Z',
  updatedOn: '2026-04-02T16:40:03.551Z',
  status,
  postingStatus,
  language: { code: 'en', label: 'English', labelNative: 'English (US)' },
  actions: { details: link(`/jobs/${id}`) },
});

const jobs: Record<string, object> = {
  [BACKEND]: {
    id: BACKEND,
    title: 'Senior Backend Engineer',
    refNumber: 'REF-1042',
    createdOn: '2026-02-03T09:15:10.000Z',
    updatedOn: '2026-09-01T12:00:31.204Z',
    department: { id: '13437', label: 'Engineering', description: 'Product & platform engineering' },
    location: { country: 'United States', countryCode: 'us', regionCode: 'CA', region: 'California', city: 'San Francisco', address: '548 Market St', manual: false, remote: true, hybrid: false },
    status: 'SOURCING',
    postingStatus: 'PUBLIC',
    hiringProcessId: 'c1f4e2a0-5b7d-4e8a-9f3c-1a2b3c4d5e6f',
    typeOfEmployment: { id: 'permanent', label: 'Full-time' },
    template: false,
    creator: { id: PRIYA, firstName: 'Priya', lastName: 'Raman' },
    compensation: { min: 170000, max: 210000, currency: 'USD', period: 'YEARLY' },
    jobAd: {
      sections: {
        companyDescription: { title: 'Company Description', text: '<p>Acme builds <strong>developer tools</strong> used by 40,000 teams.</p>' },
        jobDescription: { title: 'Job Description', text: '<p>You will own our event ingestion pipeline.</p><ul><li>Design APIs</li><li>Run on-call</li></ul>' },
        qualifications: { title: 'Qualifications', text: '<ul><li>6+ years building distributed systems</li></ul>' },
        additionalInformation: { title: 'Additional Information', text: '' },
        videos: { urls: [] },
      },
      language: { code: 'en', label: 'English', labelNative: 'English (US)' },
    },
    properties: [],
  },
  [DESIGNER]: {
    id: DESIGNER,
    title: 'Product Designer',
    refNumber: 'REF-1051',
    createdOn: '2026-01-14T10:02:44.120Z',
    department: { id: 13438, label: 'Design' },
    location: { country: 'Poland', countryCode: 'pl', city: 'Kraków', manual: false, remote: false, hybrid: true, hybridDescription: '3 days in office' },
    status: 'FILLED',
    postingStatus: 'NOT_PUBLISHED',
    typeOfEmployment: { id: 'contract', label: 'Contract' },
    template: false,
    compensation: { min: 45, max: 60, currency: 'EUR', period: 'HOURLY' },
    jobAd: { sections: { jobDescription: { title: 'Job Description', text: '<p>Shape our design system.&nbsp;Figma daily.</p>' } } },
  },
  [TEMPLATE]: { id: TEMPLATE, title: 'Warehouse Associate (template)', status: 'CREATED', postingStatus: 'NOT_PUBLISHED', template: true },
};

const positions = {
  totalFound: 2,
  content: [
    { id: 'f1e2d3c4-b5a6-4978-8a9b-0c1d2e3f4a5b', positionId: 'REQ-2026-0117', type: 'NEW', incumbentName: '', positionOpenDate: '2026-02-01T00:00:00.000Z', targetStartDate: '2026-11-01T00:00:00.000Z', createdOn: '2026-02-03T09:16:02.000Z', status: 'FILLED', hiringManagerId: MARCUS },
    { id: 'a0b1c2d3-e4f5-4617-8829-3a4b5c6d7e8f', positionId: 'REQ-2025-0988', type: 'REPLACEMENT', incumbentName: 'Tomasz Nowak', positionOpenDate: '2026-02-01T00:00:00.000Z', targetStartDate: '2026-10-15T00:00:00.000Z', createdOn: '2026-02-03T09:16:02.000Z', status: 'OPEN', hiringManagerId: MARCUS },
  ],
  positionsPendingApproval: [],
};

const hiringTeams: Record<string, object> = {
  [BACKEND]: {
    totalFound: 2,
    content: [
      { id: PRIYA, role: 'RECRUITER', actions: { details: link(`/user-api/v201804/users/${PRIYA}`) } },
      { id: MARCUS, role: 'HIRING_MANAGER', actions: { details: link(`/user-api/v201804/users/${MARCUS}`) } },
    ],
  },
  [DESIGNER]: { totalFound: 1, content: [{ id: MARCUS, role: 'RECRUITER', actions: { details: link(`/user-api/v201804/users/${MARCUS}`) } }] },
};

// One list row per application: Jakub (two applications) shows up on both pages.
const row = (id: string, first: string, last: string, email: string, primary: [string, string], secondary: string[] = []) => ({
  id,
  internal: false,
  firstName: first,
  lastName: last,
  email,
  createdOn: '2026-01-20T08:00:00.000Z',
  updatedOn: '2026-09-18T16:03:12.609Z',
  tags: [],
  consent: { status: 'ACQUIRED' },
  primaryAssignment: { job: jobRef(...primary), status: 'NEW', subStatus: '' },
  secondaryAssignments: secondary.map((j) => ({ job: { id: j, actions: { details: link(`/jobs/${j}`) } } })),
  actions: { details: link(`/candidates/${id}`) },
});
const rows = {
  jakub: row(JAKUB, 'Jakub', 'Kowalski', 'j.kowalski@example.com', [BACKEND, 'Senior Backend Engineer'], [DESIGNER]),
  witek: row(WITEK, 'Witek', 'Pulawski', 'witek@example.com', [BACKEND, 'Senior Backend Engineer']),
  ana: row(ANA, 'Ana', 'Silva', 'ana.silva@example.com', [DESIGNER, 'Product Designer']),
  hidden: row(HIDDEN, 'Hidden', 'Person', 'hidden@example.com', [BACKEND, 'Senior Backend Engineer']),
};

const sourceDetails = (type: string) => ({ sourceDetails: link(`/configuration/sources/${type}/values/2b1c4d7e-0f3a-4c5b-8d9e-1f2a3b4c5d6e`) });

const candidates: Record<string, object> = {
  [JAKUB]: {
    id: JAKUB,
    internal: false,
    firstName: 'Jakub',
    lastName: 'Kowalski',
    email: 'J.Kowalski@example.com',
    phoneNumber: '+48 600 123 456',
    location: { country: 'Poland', countryCode: 'pl', regionCode: '', region: 'Lesser Poland', city: 'Kraków', lat: 50.0647, lng: 19.945 },
    web: { skype: 'j.kowalski', linkedin: 'https://www.linkedin.com/in/jkowalski', twitter: 'jkowalski', website: 'http://jkowalski.com' },
    createdOn: '2026-02-10T08:55:00.000Z',
    updatedOn: '2026-09-18T16:03:12.609Z',
    tags: ['Architect', 'Go'],
    averageRating: 4,
    experience: [
      { title: 'Staff Engineer, Platform', company: 'Globex', current: true, startDate: '2021-01' },
      { title: 'Senior Engineer', company: 'Initech', current: false, startDate: '2016-10', endDate: '2020-12' },
    ],
    primaryAssignment: {
      job: jobRef(BACKEND, 'Senior Backend Engineer'),
      status: 'HIRED',
      subStatus: '',
      startsOn: '2026-11-02T00:00:00.000Z',
      source: 'LinkedIn',
      actions: sourceDetails('SOCIAL_MEDIA'),
    },
    secondaryAssignments: [
      {
        job: jobRef(DESIGNER, 'Product Designer'),
        status: 'REJECTED',
        subStatus: '',
        source: 'Career Site',
        reasonOfRejection: { id: '5d3f9a2c-1b7e-4c8d-9e0f-a1b2c3d4e5f6', label: 'Not enough experience' },
      },
    ],
    actions: { attachments: link(`/candidates/${JAKUB}/attachments`) },
  },
  [WITEK]: {
    id: WITEK,
    internal: false,
    firstName: 'Witek',
    lastName: 'Pulawski',
    email: 'witek@example.com',
    // A returning candidate: the profile is older than this application.
    createdOn: '2025-11-03T15:42:10.000Z',
    tags: [],
    primaryAssignment: {
      job: jobRef(BACKEND, 'Senior Backend Engineer'),
      status: 'INTERVIEW',
      subStatus: 'Technical Interview',
      source: 'Employee Referral',
      actions: sourceDetails('EMPLOYEE_REFERRAL'),
    },
    secondaryAssignments: [],
  },
  [ANA]: {
    id: ANA,
    internal: false,
    firstName: 'Ana',
    lastName: 'Silva',
    email: 'ana.silva@example.com',
    createdOn: '2026-01-20T08:00:00.000Z',
    tags: ['Design systems'],
    primaryAssignment: {
      job: jobRef(DESIGNER, 'Product Designer'),
      status: 'WITHDRAWN',
      subStatus: '',
      source: 'Sourcing Tools',
      reasonOfWithdrawal: { id: '9b7d3e6a-2c1f-4a8e-b5d0-3f6e9c2a1b74', label: 'Accepted another offer' },
    },
    secondaryAssignments: [],
  },
};

const history = (entries: [string, string, string?][]) => ({
  totalFound: entries.length,
  content: entries.map(([changedOn, status, subStatus]) => ({ changedOn, status, ...(subStatus ? { subStatus } : {}), actions: {} })),
});
const histories: Record<string, { content: { changedOn: string }[] }> = {
  // Deliberately not in order: the adapter sorts by changedOn itself.
  [`${JAKUB}:${BACKEND}`]: history([
    ['2026-03-04T09:30:00.118Z', 'IN_REVIEW', 'Recruiter Screen'],
    ['2026-03-02T14:11:05.412Z', 'NEW'],
    ['2026-03-10T15:02:41.007Z', 'INTERVIEW', 'Phone Screen'],
    ['2026-03-19T11:45:12.330Z', 'INTERVIEW', 'Technical Interview'],
    ['2026-04-02T08:00:03.951Z', 'OFFERED', 'Offer Preparation'],
    ['2026-04-06T17:21:40.604Z', 'OFFERED', 'Offer Sent'],
    ['2026-04-09T13:47:29.512Z', 'HIRED'],
  ]),
  [`${JAKUB}:${DESIGNER}`]: history([
    ['2026-02-10T09:00:00.000Z', 'NEW'],
    ['2026-02-12T10:15:00.000Z', 'IN_REVIEW', 'Phone Screen'],
    ['2026-02-20T16:30:00.000Z', 'REJECTED'],
  ]),
  [`${WITEK}:${BACKEND}`]: history([
    ['2026-05-06T11:20:31.000Z', 'NEW'],
    ['2026-05-08T09:00:00.000Z', 'IN_REVIEW', 'Recruiter Screen'],
    ['2026-05-15T14:00:00.000Z', 'INTERVIEW', 'Phone Screen'],
    ['2026-05-22T10:30:00.000Z', 'INTERVIEW', 'Technical Interview'],
  ]),
  [`${ANA}:${DESIGNER}`]: history([
    ['2026-01-20T08:00:00.000Z', 'LEAD'],
    ['2026-01-25T12:00:00.000Z', 'NEW'],
    ['2026-02-01T09:45:00.000Z', 'WITHDRAWN'],
  ]),
};

// Job Applications API: createDate is the application's first status change.
const jobApplication = (key: string) => {
  const [cid, jid] = key.split(':');
  const first = histories[key].content.map((h) => h.changedOn).sort()[0];
  return { status: 'NEW', sourceIdentifier: '9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a', createDate: first, profileId: cid, jobId: jid };
};

const propertyConfig = (id: string) => ({ configuration: link(`/configuration/candidate-properties/${id}`) });
const properties: Record<string, object> = {
  [`${JAKUB}:${BACKEND}`]: {
    content: [
      { id: 'e1d2c3b4-a596-4877-8695-a4b3c2d1e0f9', key: 'notice_period', label: 'Notice period (weeks)', type: 'NUMBER', value: 4, actions: propertyConfig('e1d2c3b4-a596-4877-8695-a4b3c2d1e0f9') },
      {
        id: 'f0e1d2c3-b4a5-4968-8776-b5a4c3d2e1f0',
        key: 'work_auth',
        label: 'Work authorization',
        type: 'SINGLE_SELECT',
        value: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
        valueLabel: 'EU citizen',
        selectedValueLabels: [{ id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', label: 'EU citizen', externalCode: 'EU' }],
        actions: propertyConfig('f0e1d2c3-b4a5-4968-8776-b5a4c3d2e1f0'),
      },
      { id: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', key: 'expected_salary', label: 'Expected salary', type: 'CURRENCY', value: { code: 'USD', value: 190000 }, actions: propertyConfig('0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d') },
      {
        id: '1b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e',
        key: 'tech_stack',
        label: 'Tech stack',
        type: 'MULTI_SELECT',
        value: ['c0ffee00-0000-4000-8000-000000000001', 'c0ffee00-0000-4000-8000-000000000002'],
        selectedValueLabels: [
          { id: 'c0ffee00-0000-4000-8000-000000000001', label: 'Go' },
          { id: 'c0ffee00-0000-4000-8000-000000000002', label: 'Kafka' },
        ],
        actions: propertyConfig('1b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e'),
      },
      { id: '2c3d4e5f-6a7b-4c8d-8e9f-1a2b3c4d5e6f', key: 'relocation', label: 'Open to relocation', type: 'BOOLEAN', value: false, actions: propertyConfig('2c3d4e5f-6a7b-4c8d-8e9f-1a2b3c4d5e6f') },
      { id: '3d4e5f6a-7b8c-4d9e-9f0a-2b3c4d5e6f7a', key: 'referred_by', label: 'Referred by', type: 'USER', value: MARCUS, actions: propertyConfig('3d4e5f6a-7b8c-4d9e-9f0a-2b3c4d5e6f7a') },
      // "Returns {} when there is no value set."
      { id: '4e5f6a7b-8c9d-4e0f-a01b-3c4d5e6f7a8b', key: 'security_clearance', label: 'Security clearance', type: 'TEXT', value: {}, actions: propertyConfig('4e5f6a7b-8c9d-4e0f-a01b-3c4d5e6f7a8b') },
    ],
  },
};

// Trimmed from the vendor's example, including an EEO entry that must stay out of the fields.
const screeningAnswers: Record<string, object> = {
  [`${JAKUB}:${BACKEND}`]: {
    totalFound: 4,
    content: [
      {
        id: '0e91d24a-d85b-487d-99ef-eeaca7277d77',
        type: 'radio',
        category: 'drivingCurrent',
        name: 'Driving Current',
        label: "Do you have a current driver's license?",
        records: [{ fields: [{ id: 'value', label: 'Value', values: [{ id: '0', label: 'No' }] }] }],
      },
      {
        id: 'a00c06fb-6693-4138-a005-57c92ab796b6',
        type: 'textarea',
        category: '04f8fac1-8799-47ef-af54-7dcc4cd10bb9',
        name: 'Free text question',
        label: 'Why Acme?',
        records: [{ fields: [{ id: 'value', label: 'Value', values: [{ id: 'I use your CLI every day.', label: 'I use your CLI every day.' }] }] }],
      },
      {
        id: '1549f34c-fdda-459a-8c01-be8ab6cef19f',
        type: 'languages',
        category: 'languages',
        name: 'Languages',
        label: 'Languages',
        records: [
          { fields: [{ id: 'lang', label: 'Language', values: [{ id: 'English', label: 'English' }] }, { id: 'level', label: 'Proficiency level', values: [{ id: '2', label: 'Advanced' }] }] },
          { fields: [{ id: 'lang', label: 'Language', values: [{ id: 'Spanish', label: 'Spanish' }] }, { id: 'level', label: 'Proficiency level', values: [{ id: '0', label: 'Beginner' }] }] },
        ],
      },
      {
        id: '40bc2e3b-fd1c-47e8-b514-2365fc705447',
        type: 'eeo',
        category: 'eeoInformation',
        name: 'EEO - Race and Gender',
        label: 'Gender, Race and Ethnicity [(definitions)](https://smartrecruiters.com/oneclick/static/html/en/eeoGeneral.html)',
        records: [
          {
            fields: [
              { id: 'gender', label: 'Gender', values: [{ id: '0', label: 'Male' }] },
              { id: 'ethnicity', label: 'Race/Ethnicity', values: [{ id: '6', label: 'Prefer not to answer' }] },
            ],
          },
        ],
      },
    ],
  },
};

const reviews: Record<string, object[]> = {
  [`${JAKUB}:${BACKEND}`]: [
    { id: 'b4d2f9a0-1c3e-4b5a-9d7f-2e6c8a0b1d34', candidateId: JAKUB, jobId: BACKEND, reviewerId: MARCUS, overallRating: 5, comment: 'Excellent depth on distributed systems. Hire.', createdOn: '2026-03-19T16:40:02.117Z', updatedOn: '2026-03-19T16:40:02.117Z' },
    { id: 'c5e3a0b1-2d4f-4c6b-8e9a-3f7d9b1c2e45', candidateId: JAKUB, jobId: BACKEND, reviewerId: PRIYA, overallRating: 3, comment: 'Solid; a few gaps in SQL tuning.', createdOn: '2026-03-20T09:12:00.000Z', updatedOn: '2026-03-20T09:12:00.000Z' },
  ],
  [`${WITEK}:${BACKEND}`]: [
    { id: 'e8f0a2c4-6b8d-4e0f-a2c4-6e8f0a2c4b6d', candidateId: WITEK, jobId: BACKEND, reviewerId: DANA, overallRating: null, comment: 'Communication was unclear in the pairing session.', createdOn: '2026-05-22T12:05:51.662Z', updatedOn: '2026-05-22T12:05:51.662Z' },
    { id: 'f9a1b3d5-7c9e-4f1a-b3d5-7f9a1b3d5c7e', candidateId: WITEK, jobId: BACKEND, reviewerId: MARCUS, overallRating: 2, comment: 'Not strong enough on system design.', createdOn: '2026-05-22T15:00:00.000Z', updatedOn: '2026-05-22T15:00:00.000Z' },
  ],
};

const interviews: Record<string, object[]> = {
  [APP_ID[`${JAKUB}:${BACKEND}`]]: [
    {
      id: 'c7e1a3b5-2d4f-4a6c-8e0b-9f1d3c5a7e29',
      candidate: { id: JAKUB, status: 'accepted' },
      jobId: BACKEND,
      location: 'https://acme.zoom.us/j/81234567890',
      locationType: 'VIDEO_MEETING_ZOOM',
      organizerId: PRIYA,
      timezone: 'Europe/Warsaw',
      timeslots: [
        {
          id: '0d9c8b7a-6f5e-4d3c-9b2a-1f0e9d8c7b6a',
          interviewType: 'Technical Interview',
          title: 'Technical interview — Jakub Kowalski',
          place: 'Zoom',
          startsOn: '2026-03-19T13:00:00.000Z',
          endsOn: '2026-03-19T14:00:00.000Z',
          interviewers: [
            { id: PRIYA, status: 'accepted' },
            { id: MARCUS, status: 'accepted' },
            { id: DANA, status: 'declined' },
          ],
          candidateStatus: 'accepted',
          noShow: false,
        },
      ],
      createdOn: '2026-03-12T10:22:18.004Z',
      source: 'smartrecruiters',
    },
  ],
  [APP_ID[`${WITEK}:${BACKEND}`]]: [
    {
      id: 'd8f2b4c6-3e5a-4b7d-9f1c-0a2e4d6b8f30',
      candidate: { id: WITEK, status: 'pending' },
      jobId: BACKEND,
      location: 'Acme HQ, 548 Market St',
      locationType: 'ONSITE_JOB',
      organizerId: PRIYA,
      timezone: 'America/Los_Angeles',
      timeslots: [
        {
          id: '1e0d9c8b-7a6f-4e5d-8c3b-2a1f0e9d8c7b',
          interviewType: 'Onsite',
          title: '',
          startsOn: '2027-01-12T17:00:00.000Z',
          endsOn: '2027-01-12T17:45:00.000Z',
          interviewers: [{ id: PRIYA, status: 'pending' }],
          candidateStatus: 'pending',
          noShow: false,
        },
      ],
      createdOn: '2026-09-01T08:00:00.000Z',
    },
  ],
};

const offerActions = (cid: string, jid: string, id: string) => ({
  candidate: link(`/candidates/${cid}`),
  job: link(`/jobs/${jid}`),
  details: link(`/candidates/${cid}/jobs/${jid}/offers/${id}`),
});

const offers = [
  {
    id: OFFER_ACCEPTED,
    status: 'ACCEPTED',
    createdOn: '2026-04-02T08:05:11.000Z',
    updatedOn: '2026-04-09T13:47:29.512Z',
    // A band and a bonus percentage come first and only look like salaries.
    properties: { jobTitle: 'Senior Backend Engineer', salaryBand: 'B3', bonusTarget: '15', baseSalary: '195000', currency: 'USD', startDate: '2026-11-02', signOnBonus: '15000', reportsTo: MARCUS },
    actions: offerActions(JAKUB, BACKEND, OFFER_ACCEPTED),
  },
  {
    // actions.job is optional in the schema. This details link has the per-application shape, which the spec
    // documents only for the per-application list; the search's details shape is an unverified assumption.
    id: OFFER_PENDING,
    status: 'PENDING_APPROVAL',
    createdOn: '2026-09-10T10:00:00.000Z',
    updatedOn: '2026-09-11T10:00:00.000Z',
    properties: { baseSalary: '172,500.00', currency: 'USD' },
    actions: {
      candidate: link(`/candidates/${WITEK}`),
      details: link(`/candidates/${WITEK}/jobs/${BACKEND}/offers/${OFFER_PENDING}`),
    },
  },
  {
    // No job link and a details link that names no job: found through the candidate's per-application lists.
    id: OFFER_NOT_APPROVED,
    status: 'NOT_APPROVED',
    createdOn: '2026-02-18T11:30:00.000Z',
    updatedOn: '2026-02-19T09:00:00.000Z',
    properties: { jobTitle: 'Product Designer', baseSalary: '98000', currency: 'EUR' },
    actions: { candidate: link(`/candidates/${JAKUB}`), details: link(`/offers/${OFFER_NOT_APPROVED}`) },
  },
];
const applicationOffers: Record<string, object[]> = {
  [`${JAKUB}:${BACKEND}`]: [{ ...offers[0] }],
  [`${JAKUB}:${DESIGNER}`]: [{ ...offers[2], actions: offerActions(JAKUB, DESIGNER, OFFER_NOT_APPROVED) }],
};

const offerProperties = {
  categories: [
    {
      id: 'compensation',
      properties: [
        { key: 'jobTitle', label: 'Job Title', required: true, type: 'TEXT' },
        { key: 'salaryBand', label: 'Salary Band', required: false, type: 'TEXT' },
        { key: 'bonusTarget', label: 'Annual bonus (% of base salary)', required: false, type: 'PERCENT' },
        { key: 'baseSalary', label: 'Base Salary', required: true, type: 'NUMBER' },
        { key: 'currency', label: 'Currency', required: true, type: 'CURRENCY' },
        { key: 'startDate', label: 'Start Date', required: true, type: 'DATE' },
        { key: 'signOnBonus', label: 'Sign-on Bonus', required: false, type: 'NUMBER' },
        { key: 'reportsTo', label: 'Reports To', required: false, type: 'USER' },
      ],
    },
  ],
};

const offerDocuments = {
  documents: [{ id: OFFER_DOCUMENT_ID, name: 'Offer Letter - Kowalski.pdf', createdDate: '2026-04-09T13:47:00.000Z' }],
  isCurrentlySyncing: false,
  provider: 'DOCUSIGN',
};

const attachments: Record<string, object[]> = {
  [JAKUB]: [
    { id: '92fc3ebe-e204-492c-8c80-1ab7a6eb6777', name: 'generated-avatar.jpg', type: 'AVATAR', contentType: 'image/jpeg', actions: { download: link(`/candidates/${JAKUB}/attachments/92fc3ebe-e204-492c-8c80-1ab7a6eb6777`) } },
    { id: RESUME_ID, name: 'CV_Jakub_Kowalski.pdf', type: 'RESUME', contentType: 'application/pdf', actions: { download: link(`/candidates/${JAKUB}/attachments/${RESUME_ID}`) } },
    { id: '7d6c5b4a-3928-4f17-8e6d-5c4b3a291807', name: 'Cover_Letter.pdf', type: 'COVER_LETTER', contentType: 'application/pdf', actions: { download: link('/candidates/attachments/7d6c5b4a-3928-4f17-8e6d-5c4b3a291807') } },
  ],
  // The candidate-level schema requires only id and actions.download; the application-level entry has the rest.
  [WITEK]: [{ id: WITEK_CV_ID, actions: { download: link(`/candidates/${WITEK}/attachments/${WITEK_CV_ID}`) } }],
  [ANA]: [],
};
const jobAttachment = (cid: string, jid: string, id: string, name: string, type: string) => ({
  id,
  name,
  type,
  contentType: 'application/pdf',
  actions: { download: link(`/candidates/attachments/${id}`), remove: link(`/candidates/${cid}/jobs/${jid}/attachments/${id}`) },
});
const jobAttachments: Record<string, object[]> = {
  [`${JAKUB}:${BACKEND}`]: [],
  // A portfolio sent only with this application, next to the profile resume listed again.
  [`${JAKUB}:${DESIGNER}`]: [
    jobAttachment(JAKUB, DESIGNER, PORTFOLIO_ID, 'Portfolio_Case_Study.pdf', 'GENERIC_FILE'),
    jobAttachment(JAKUB, DESIGNER, RESUME_ID, 'CV_Jakub_Kowalski.pdf', 'RESUME'),
  ],
  [`${WITEK}:${BACKEND}`]: [jobAttachment(WITEK, BACKEND, WITEK_CV_ID, 'Witek_Pulawski_CV.pdf', 'RESUME')],
  [`${ANA}:${DESIGNER}`]: [],
};

const messages: Record<string, object[][]> = {
  [JAKUB]: [
    [
      {
        content: `Strong systems design. @[USER:${MARCUS}] can you do the architecture round this week?`,
        createdOn: '2026-03-19T12:10:44.201Z',
        visibility: 'OPEN',
        authorId: PRIYA,
        context: { applications: [{ candidateId: JAKUB, jobId: BACKEND }] },
      },
    ],
    [
      {
        content: 'Candidate asked to move start date to Nov 2.',
        createdOn: '2026-04-07T09:03:10.000Z',
        visibility: 'PRIVATE',
        authorId: DANA,
        context: { applications: [] },
      },
    ],
  ],
};

// ---------- the mock server ----------

/** Tokens the mock has issued. Shared across tests, like the real service: the adapter caches tokens across slices. */
const issued = new Set<string>();

function vendor(opts: { secret?: string; routes?: Record<string, Handler> } = {}) {
  const unauthorized = () => json({ message: 'Unauthorized', errors: [{ code: 'UNAUTHORIZED', message: 'Invalid token' }] }, { status: 401 });
  const authed =
    (handler: Handler): Handler =>
    (req) => {
      const token = req.headers.authorization?.replace(/^Bearer /, '');
      return token && issued.has(token) ? handler(req) : unauthorized();
    };
  const param = (req: Req, name: string) => req.url.searchParams.get(name);

  const routes: Record<string, Handler> = {
    // client_secret_post (the spec's example); the secret never travels in a header.
    [`POST ${API}/identity/oauth/token`]: (req) => {
      const form = new URLSearchParams(typeof req.body === 'string' ? req.body : '');
      const ok =
        form.get('grant_type') === 'client_credentials' &&
        form.get('client_id') === CREDS.clientId &&
        form.get('client_secret') === (opts.secret ?? CREDS.clientSecret);
      if (!ok || req.headers.authorization) return json({ error: 'invalid_client' }, { status: 401 });
      const token = `DCRD10-e7c5c8139165228a82e44244${String(issued.size).padStart(4, '0')}`;
      issued.add(token);
      return json({ access_token: token, token_type: 'bearer', expires_in: 1799 });
    },
    [`GET ${API}/configuration/company`]: authed(() =>
      json({ identifier: 'AcmeCorp1', name: 'Acme Corp', website: 'https://www.acme.example', spamStatus: 'SPAM_STATUS_WHITELIST' }),
    ),

    // Users: the cursor is the last item's id, and the last cursor returns an empty page.
    [`GET ${API}/user-api/v201804/users`]: authed((req) => {
      const page = param(req, 'pageId');
      if (!page) return json({ limit: 2, nextPageId: MARCUS, content: users.slice(0, 2) });
      if (page === MARCUS) return json({ limit: 2, nextPageId: DANA, content: users.slice(2) });
      return json({ limit: 2, content: [] });
    }),
    ...Object.fromEntries(users.map((u) => [`GET ${API}/user-api/v201804/users/${u.id}`, authed(() => json({ ...u, accessGroups: [] }))])),

    [`GET ${API}/configuration/hiring-processes`]: authed(() => json(hiringProcesses)),
    [`GET ${API}/configuration/rejection-reasons`]: authed(() => json(rejectionReasons)),
    [`GET ${API}/configuration/withdrawal-reasons`]: authed(() => forbidden('Not permitted to read configuration')),

    [`GET ${API}/jobs`]: authed((req) => {
      if (param(req, 'sort') !== 'job_id') return json({ errors: [{ code: 'DEPRECATED_OFFSET_USAGE' }] }, { status: 400 });
      if (!param(req, 'pageId')) {
        return json({
          limit: 100,
          nextPageId: BACKEND,
          totalFound: 3,
          content: [
            jobRow(TEMPLATE, 'Warehouse Associate (template)', 'CREATED', 'NOT_PUBLISHED'),
            jobRow(DESIGNER, 'Product Designer', 'FILLED', 'NOT_PUBLISHED'),
            jobRow(BACKEND, 'Senior Backend Engineer', 'SOURCING', 'PUBLIC'),
          ],
        });
      }
      return json({ limit: 100, totalFound: 3, content: [] });
    }),
    ...Object.fromEntries(Object.entries(jobs).map(([id, job]) => [`GET ${API}/jobs/${id}`, authed(() => json(job))])),
    [`GET ${API}/jobs/${BACKEND}/positions`]: authed(() => json(positions)),
    [`GET ${API}/jobs/${DESIGNER}/positions`]: authed(() => forbidden('Job access forbidden')),
    ...Object.fromEntries(Object.entries(hiringTeams).map(([id, team]) => [`GET ${API}/jobs/${id}/hiring-team`, authed(() => json(team))])),

    [`GET ${API}/candidates`]: authed((req) => {
      if (param(req, 'limit') !== '100') return json({ error: 'expected limit=100' }, { status: 400 });
      if (!param(req, 'pageId')) {
        return json(
          { limit: 100, nextPageId: CANDIDATE_PAGE_2, totalFound: 5, content: [rows.jakub, rows.witek] },
          { headers: { link: `</candidates?limit=100&pageId=${encodeURIComponent(CANDIDATE_PAGE_2)}>; rel="next"` } },
        );
      }
      if (param(req, 'pageId') === CANDIDATE_PAGE_2) return json({ limit: 100, totalFound: 5, content: [rows.jakub, rows.ana, rows.hidden] });
      return json({ errors: [{ code: 'INVALID_PAGE_ID' }] }, { status: 400 });
    }),
    ...Object.fromEntries(Object.entries(candidates).map(([id, c]) => [`GET ${API}/candidates/${id}`, authed(() => json(c))])),
    [`GET ${API}/candidates/${HIDDEN}`]: authed(() => json({ message: 'Candidate access denied' }, { status: 401 })),
    ...Object.fromEntries(
      Object.keys(APP_ID).flatMap((key) => {
        const [cid, jid] = key.split(':');
        const c = candidates[cid] as { primaryAssignment: object; secondaryAssignments: { job: { id: string } }[] };
        const assignment = [c.primaryAssignment as { job: { id: string } }, ...c.secondaryAssignments].find((a) => a.job.id === jid)!;
        const base = `GET ${API}/candidates/${cid}/jobs/${jid}`;
        return [
          [base, authed(() => json({ ...assignment, job: undefined, applicationId: APP_ID[key], url: link(`/candidates/${cid}/jobs/${jid}`).url }))],
          [`${base}/status/history`, authed(() => json(histories[key]))],
          [`${base}/properties`, authed(() => json(properties[key] ?? { content: [] }))],
          [`${base}/screening-answers`, authed(() => json(screeningAnswers[key] ?? { totalFound: 0, content: [] }))],
          [`GET ${API}/job-applications-api/v202112/job-applications/${APP_ID[key]}`, authed(() => json(jobApplication(key)))],
        ];
      }),
    ),

    [`GET ${API}/reviews-api/v201910/reviews`]: authed((req) => json(reviews[`${param(req, 'candidateId')}:${param(req, 'jobId')}`] ?? [])),
    [`GET ${API}/interviews-api/v201904/interviews`]: authed((req) => json({ content: interviews[param(req, 'applicationId') ?? ''] ?? [] })),
    [`GET ${API}/messages`]: authed((req) => {
      const pages = messages[param(req, 'candidateId') ?? ''] ?? [[]];
      if (!param(req, 'pageId') && pages.length > 1) {
        return json(pages[0], { headers: { link: `</messages?candidateId=${JAKUB}&limit=100&pageId=${encodeURIComponent(MESSAGES_PAGE_2)}>; rel="next"` } });
      }
      return json(param(req, 'pageId') === MESSAGES_PAGE_2 ? pages[1] : pages[0]);
    }),

    [`GET ${API}/offers`]: authed((req) => {
      const offset = Number(param(req, 'offset') ?? 0);
      const after = param(req, 'createdAfter');
      const matching = offers.filter((o) => !after || Date.parse(o.createdOn) >= Date.parse(after));
      // Page size 1 here so the offset paging terminates on totalFound.
      return json({ totalFound: matching.length, limit: 1, offset, content: matching.slice(offset, offset + 1) });
    }),
    [`GET ${API}/configuration/offer-properties`]: authed(() => json(offerProperties)),
    ...Object.fromEntries(
      Object.entries(applicationOffers).map(([key, list]) => {
        const [cid, jid] = key.split(':');
        return [`GET ${API}/candidates/${cid}/jobs/${jid}/offers`, authed(() => json({ totalFound: list.length, content: list }))];
      }),
    ),
    [`GET ${API}/offers/${OFFER_ACCEPTED}/documents`]: authed(() => json(offerDocuments)),
    [`GET ${API}/offers/${OFFER_ACCEPTED}/documents/${OFFER_DOCUMENT_ID}`]: authed(
      () => new Response(Buffer.from('%PDF-1.4 signed offer letter'), { headers: { 'content-type': 'application/octet-stream' } }),
    ),

    ...Object.fromEntries(
      Object.entries(attachments).map(([cid, list]) => [`GET ${API}/candidates/${cid}/attachments`, authed(() => json({ totalFound: list.length, content: list }))]),
    ),
    ...Object.fromEntries(
      Object.entries(jobAttachments).map(([key, list]) => {
        const [cid, jid] = key.split(':');
        return [`GET ${API}/candidates/${cid}/jobs/${jid}/attachments`, authed(() => json({ totalFound: list.length, content: list }))];
      }),
    ),
    // The resume download answers with a short-lived storage link on another host.
    [`GET ${API}/candidates/${JAKUB}/attachments/${RESUME_ID}`]: authed(
      () => new Response(null, { status: 302, headers: { location: `https://${S3}/${JAKUB}/${RESUME_ID}?X-Amz-Expires=300&X-Amz-Signature=abc123` } }),
    ),
    [`GET ${S3}/${JAKUB}/${RESUME_ID}`]: () =>
      new Response(RESUME_BYTES, { headers: { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="download.pdf"' } }),
    [`GET ${API}/candidates/attachments/7d6c5b4a-3928-4f17-8e6d-5c4b3a291807`]: authed(
      () => new Response(Buffer.from('%PDF-1.4 cover letter'), { headers: { 'content-type': 'application/octet-stream' } }),
    ),
    [`GET ${API}/candidates/${WITEK}/attachments/${WITEK_CV_ID}`]: authed(
      () => new Response(Buffer.from('%PDF-1.4 Witek resume'), { headers: { 'content-type': 'application/pdf' } }),
    ),
    [`GET ${API}/candidates/attachments/${PORTFOLIO_ID}`]: authed(
      () => new Response(Buffer.from('%PDF-1.4 portfolio'), { headers: { 'content-type': 'application/pdf' } }),
    ),
  };
  // Overrides on the API host need a token like everything else there.
  for (const [key, handler] of Object.entries(opts.routes ?? {})) {
    routes[key] = key.startsWith(`GET ${API}/`) ? authed(handler) : handler;
  }
  return mockFetch(routes);
}

const label = providerMeta('smartrecruiters')?.name ?? 'smartrecruiters';
const appOf = (o: { customFields: unknown }) => (o.customFields as { imported: { id: string; fields?: Record<string, string> } }).imported;

function clientFor(impl: typeof fetch, credentials = CREDS): HttpClient {
  return createHttpClient({ resolveHost: publicDns,
    auth: smartrecruitersProvider.auth(credentials),
    minIntervalMs: 0,
    fetchImpl: impl,
  });
}

/** A PhaseContext that records what a phase hands the loader, for running one phase directly. */
function stubContext(http: HttpClient, opts: { has?: (kind: RefKind, id: string) => boolean; options?: Partial<ImportOptions> } = {}) {
  const records = { offers: [] as ImportedOffer[], files: [] as ImportedFile[], postings: [] as ImportedPosting[], feedback: [] as ImportedFeedback[] };
  const warnings: string[] = [];
  const noop = async () => undefined;
  const ctx: PhaseContext = {
    http,
    catalog: { stage: () => undefined, reason: () => undefined, user: () => undefined },
    load: {
      has: async (kind, id) => opts.has?.(kind, id) ?? false,
      handled: async () => false,
      posting: async (p) => void records.postings.push(p),
      requisition: noop,
      candidate: noop,
      application: noop,
      note: noop,
      feedback: async (f) => void records.feedback.push(f),
      interview: noop,
      offer: async (o) => void records.offers.push(o),
      file: async (f) => void records.files.push(f),
    },
    options: { ...DEFAULT_IMPORT_OPTIONS, ...opts.options },
    since: null,
    outOfTime: () => false,
    warn: (m) => void warnings.push(m),
  };
  return { ctx, records, warnings };
}

async function runPhase(phase: Phase, ctx: PhaseContext) {
  let cursor: Cursor | null = null;
  for (let step = 0; step < 50; step++) {
    cursor = await phase.run(ctx, cursor);
    if (cursor === null) return;
  }
  throw new Error(`${phase.id} did not finish`);
}

const loadPhase = (http: HttpClient, id: string) => smartrecruitersProvider.create(CREDS, http).load.find((p) => p.id === id)!;

// ---------- tests ----------

describe.skipIf(!hasDb)('SmartRecruiters adapter', () => {
  it('verifies with a client-credentials token and returns the company name', async () => {
    const { impl, calls, unmatched } = vendor();
    await expect(verifyForTest(smartrecruitersProvider, CREDS, impl)).resolves.toEqual({ accountName: 'Acme Corp' });

    const [tokenCall, companyCall] = calls;
    expect(tokenCall.method).toBe('POST');
    expect(tokenCall.url.href).toBe(`https://${API}/identity/oauth/token`);
    expect(tokenCall.headers.authorization).toBeUndefined();
    expect(tokenCall.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(tokenCall.body as string))).toEqual({
      grant_type: 'client_credentials',
      client_id: CREDS.clientId,
      client_secret: CREDS.clientSecret,
    });
    expect(companyCall.url.pathname).toBe('/configuration/company');
    expect(companyCall.headers.authorization).toMatch(/^Bearer DCRD10-/);
    expect(companyCall.headers['accept-language']).toBe('en');
    expect(unmatched).toEqual([]);
  });

  it('reports a wrong client secret as rejected credentials', async () => {
    const { impl } = vendor({ secret: 'something-else' });
    const err = await verifyForTest(smartrecruitersProvider, CREDS, impl).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImportAuthError);
    expect((err as InstanceType<typeof ImportAuthError>).status).toBe(401);
    expect(String((err as Error).message)).not.toContain(CREDS.clientSecret);
  });

  it('never lets the client secret follow a redirect off the token endpoint', async () => {
    const creds = { clientId: 'b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6', clientSecret: 'e6d5c4b3a2f1e0d9c8b7a6f5e4d3c2b1' };
    const ELSEWHERE = 'login.elsewhere.example';
    const { impl, calls } = vendor({
      routes: {
        [`POST ${API}/identity/oauth/token`]: () => new Response(null, { status: 307, headers: { location: `https://${ELSEWHERE}/oauth/token` } }),
        [`GET ${ELSEWHERE}/oauth/token`]: () => json({ access_token: 'not-a-smartrecruiters-token', token_type: 'bearer', expires_in: 1799 }),
      },
    });
    await expect(smartrecruitersProvider.create(creds, clientFor(impl, creds)).verify()).rejects.toBeInstanceOf(ImportAuthError);

    const foreign = calls.filter((c) => c.url.host === ELSEWHERE);
    expect(foreign.length).toBeGreaterThan(0);
    for (const c of foreign) {
      expect(c.headers.authorization).toBeUndefined();
      expect(c.body).toBeNull();
      expect(c.url.href).not.toContain(creds.clientSecret);
    }
    const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64');
    for (const c of calls) expect(JSON.stringify(c.headers)).not.toContain(basic);
  });

  it('builds a phase list without credentials', () => {
    const adapter = smartrecruitersProvider.create({}, {} as never);
    expect(adapter.discover.map((p) => p.id)).toEqual(['users', 'stages', 'reasons']);
    expect(adapter.load.map((p) => p.id)).toEqual(['postings', 'candidates', 'interviews', 'feedback', 'notes', 'offers', 'files']);
  });

  it('imports the whole account, then re-runs without duplicating anything', async () => {
    const first = vendor();
    const result = await runImportForTest({ module: smartrecruitersProvider, credentials: CREDS, fetchImpl: first.impl });
    expect(result.error).toBeNull();
    expect(result.status).toBe('SUCCEEDED');
    expect(first.unmatched).toEqual([]);
    const { orgId, adminId, view, review } = result;

    // ---- counts ----
    expect(view.created).toEqual({
      posting: 2, // the template job is skipped
      requisition: 2,
      contact: 3, // the access-denied candidate is skipped
      opportunity: 4,
      note: 2,
      feedback: 4,
      interview: 2,
      offer: 3,
      file: 5, // two resumes, a cover letter, an application-only portfolio, a signed offer letter; the avatar is skipped
    });

    // ---- review: statuses × sub-statuses, grouped by name across hiring processes ----
    const stages = Object.fromEntries(review!.stages.map((s) => [s.key, s]));
    expect(Object.keys(stages).sort()).toEqual(
      [
        'lead',
        'new',
        'recruiter screen',
        'hiring manager review',
        'phone screen',
        'technical interview',
        'onsite',
        'offer preparation',
        'offer sent',
        'hired',
        'in-person interview',
        'offered',
      ].sort(),
    );
    expect(stages['phone screen'].count).toBe(2); // INTERVIEW/Phone Screen + IN_REVIEW/Phone Screen
    expect(stages['phone screen'].target).toHaveProperty('stageId');
    expect(stages['hired'].target).toHaveProperty('stageId');
    expect(stages['lead'].target).toEqual({ create: { name: 'Lead', type: 'LEAD' } });
    expect(stages['new'].target).toEqual({ create: { name: 'New', type: 'APPLICANT' } });
    expect(stages['hiring manager review'].target).toEqual({ create: { name: 'Hiring Manager Review', type: 'SCREEN' } });
    expect(stages['onsite'].target).toHaveProperty('stageId'); // Matches the org's existing "On-site" (punctuation doesn't matter), rather than a near-duplicate.
    expect(stages['offer sent'].target).toEqual({ create: { name: 'Offer Sent', type: 'OFFER' } });
    expect(stages['offered'].target).toEqual({ create: { name: 'Offered', type: 'OFFER' } });
    expect(Object.fromEntries(review!.reasons.map((r) => [r.name, r.kind]))).toEqual({
      'Not enough experience': 'rejection',
      'Salary expectations too high': 'rejection',
      'Position filled': 'rejection',
      Hired: 'hired',
      Rejected: 'rejection',
      Withdrawn: 'withdrawn',
      'Transferred to another job': 'withdrawn', // a move to another job, not a rejection
    });
    const transferred = review!.reasons.find((r) => r.name === 'Transferred to another job')!;
    expect(transferred.target).toEqual({ create: { name: 'Transferred to another job', countsAsRejection: false } });
    expect(review!.users).toMatchObject({ total: 3, matched: 1 });

    // ---- degraded, not failed: withheld candidate, missing scope, forbidden positions ----
    expect(view.issues.map((i) => i.message).sort()).toEqual(
      [
        "Withdrawal reasons: This key doesn't have permission for GET api.smartrecruiters.com/configuration/withdrawal-reasons",
        "Job positions: the credential's scopes or system role don't allow it (HTTP 403)",
        'Candidates: SmartRecruiters withheld some records from this credential (HTTP 401); they were skipped',
      ].sort(),
    );

    // ---- postings & requisitions ----
    const postings = await db.posting.findMany({ where: { orgId }, include: { department: true, requisition: true } });
    const backend = postings.find((p) => p.title === 'Senior Backend Engineer')!;
    expect(backend).toMatchObject({
      state: 'DRAFT',
      workplaceType: 'REMOTE',
      commitment: 'FULL_TIME',
      salaryMin: 170000,
      salaryMax: 210000,
      salaryCurrency: 'USD',
      location: 'San Francisco, California, United States',
    });
    expect(backend.department!.name).toBe('Engineering');
    expect(backend.requisition!.code).toBe('REQ-2025-0988'); // the open position
    expect(backend.createdAt.toISOString()).toBe('2026-02-03T09:15:10.000Z');
    const text = (backend.content as { description: string }).description;
    expect(text).toContain('Job Description\nYou will own our event ingestion pipeline.');
    expect(text).toContain('• Design APIs\n• Run on-call');
    expect(text).not.toContain('<');
    const designer = postings.find((p) => p.title === 'Product Designer')!;
    expect(designer).toMatchObject({ state: 'CLOSED', workplaceType: 'HYBRID', commitment: 'CONTRACT', salaryMin: null, location: 'Kraków, Poland' });
    // Hourly pay has no annual figure; it stays readable in the description.
    expect((designer.content as { description: string }).description).toBe(
      'Job Description\nShape our design system. Figma daily.\n\nSalary: 45–60 EUR per hour',
    );
    expect(designer.requisitionId).toBeNull();

    const reqs = await db.requisition.findMany({ where: { orgId }, orderBy: { code: 'asc' } });
    expect(reqs.map((r) => ({ code: r.code, state: r.state, filled: r.filled, backfill: r.backfill }))).toEqual([
      { code: 'REQ-2025-0988', state: 'OPEN', filled: 0, backfill: true },
      { code: 'REQ-2026-0117', state: 'CLOSED', filled: 1, backfill: false },
    ]);

    // ---- candidates ----
    const contacts = await db.contact.findMany({ where: { orgId } });
    expect(contacts.map((c) => c.name).sort()).toEqual(['Ana Silva', 'Jakub Kowalski', 'Witek Pulawski']);
    const jakub = contacts.find((c) => c.name === 'Jakub Kowalski')!;
    expect(jakub).toMatchObject({
      emails: ['j.kowalski@example.com'],
      phones: ['+48 600 123 456'],
      headline: 'Staff Engineer, Platform at Globex',
      location: 'Kraków, Lesser Poland, Poland',
      tags: ['Architect', 'Go'],
    });
    expect(jakub.links.sort()).toEqual(['http://jkowalski.com', 'https://www.linkedin.com/in/jkowalski', 'https://x.com/jkowalski']);
    expect(jakub.createdAt.toISOString()).toBe('2026-02-10T08:55:00.000Z');

    // ---- applications ----
    const opps = await db.opportunity.findMany({
      where: { orgId },
      include: {
        stage: true,
        archiveReason: true,
        posting: true,
        contact: true,
        stageTransitions: { orderBy: { occurredAt: 'asc' }, include: { toStage: true } },
      },
    });
    const opp = (cid: string, jid: string) => opps.find((o) => appOf(o).id === `${cid}:${jid}`)!;

    const hired = opp(JAKUB, BACKEND);
    expect(hired).toMatchObject({ status: 'HIRED', origin: 'APPLIED', source: 'LinkedIn', ownerId: adminId });
    expect(hired.stage.name).toBe('Hired');
    // A hire looks like one made in Source: Hired stage, no archive reason or date; entering Hired is the hire date.
    expect(hired.archiveReason).toBeNull();
    expect(hired.createdAt.toISOString()).toBe('2026-03-02T14:11:05.412Z');
    expect(hired.archivedAt).toBeNull();
    expect(hired.stageChangedAt.toISOString()).toBe('2026-04-09T13:47:29.512Z');
    expect(hired.stageTransitions.map((t) => t.toStage.name)).toEqual([
      'New',
      'Recruiter Screen',
      'Phone screen', // the org's existing stage
      'Technical Interview',
      'Offer Preparation',
      'Offer Sent',
      'Hired',
    ]);
    expect(hired.stageTransitions[0].fromStageId).toBeNull();
    // Candidate properties and screening answers; the unset property and the EEO answer are left out.
    expect(appOf(hired).fields).toEqual({
      'Start date': '2026-11-02',
      'Notice period (weeks)': '4',
      'Work authorization': 'EU citizen',
      'Expected salary': '190000 USD',
      'Tech stack': 'Go, Kafka',
      'Open to relocation': 'No',
      'Referred by': 'Marcus Lee',
      "Do you have a current driver's license?": 'No',
      'Why Acme?': 'I use your CLI every day.',
      Languages: 'Language: English; Proficiency level: Advanced | Language: Spanish; Proficiency level: Beginner',
    });

    const rejected = opp(JAKUB, DESIGNER);
    expect(rejected).toMatchObject({ status: 'ARCHIVED', ownerId: null });
    expect(rejected.stage.name).toBe('Phone screen'); // where they were when rejected
    expect(rejected.archiveReason).toMatchObject({ name: 'Not enough experience', countsAsRejection: true });
    expect(rejected.archivedAt!.toISOString()).toBe('2026-02-20T16:30:00.000Z');
    expect(rejected.posting!.state).toBe('CLOSED');

    const active = opp(WITEK, BACKEND);
    expect(active).toMatchObject({ status: 'ACTIVE', origin: 'REFERRED', source: 'Employee Referral', archivedAt: null, archiveReasonId: null });
    expect(active.stage.name).toBe('Technical Interview');
    expect(active.stageTransitions.map((t) => t.toStage.name)).toEqual(['New', 'Recruiter Screen', 'Phone screen', 'Technical Interview']);
    expect(active.stageChangedAt.toISOString()).toBe('2026-05-22T10:30:00.000Z');

    const withdrawn = opp(ANA, DESIGNER);
    expect(withdrawn).toMatchObject({ status: 'ARCHIVED', origin: 'SOURCED' });
    // Discovery couldn't list withdrawal reasons (403), so the loader creates this one from its name; it must not
    // count as a rejection.
    expect(withdrawn.archiveReason).toMatchObject({ name: 'Withdrew: Accepted another offer', countsAsRejection: false });
    expect(withdrawn.stageTransitions.map((t) => t.toStage.name)).toEqual(['Lead', 'New']);

    // ---- notes: teammate by id, others by byline; mentions resolved; candidate-level note on latest app ----
    const notes = await db.note.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' } });
    const byBody = (s: string) => notes.find((n) => n.body.includes(s))!;
    const mention = byBody('Strong systems design');
    expect(mention).toMatchObject({ authorId: adminId, opportunityId: hired.id });
    expect(mention.body).toBe('Strong systems design. @Marcus Lee can you do the architecture round this week?');
    expect(mention.createdAt.toISOString()).toBe('2026-03-19T12:10:44.201Z');
    const privateNote = byBody('move start date');
    expect(privateNote.body).toBe(`[${label} · Dana Wójcik] (Private in SmartRecruiters) Candidate asked to move start date to Nov 2.`);
    expect(privateNote.opportunityId).toBe(hired.id); // Jakub's most recent application
    // Review without a decision → note, credited by name.
    expect(byBody('pairing session').body).toBe(
      `[${label} · Dana Wójcik] Communication was unclear in the pairing session.`,
    );
    expect(byBody('pairing session').opportunityId).toBe(active.id);
    expect(byBody('Attachment: Cover_Letter.pdf').body).toMatch(new RegExp(`^\\[${label}\\] Attachment: Cover_Letter\\.pdf — /api/files/`));
    // Only in the Product Designer application's list, so it lands on that application.
    expect(byBody('Attachment: Portfolio_Case_Study.pdf').opportunityId).toBe(rejected.id);
    expect(byBody('Attachment: Offer Letter - Kowalski.pdf').opportunityId).toBe(hired.id);

    // ---- reviews: 5 → strong yes, 3 → no (neutral kept), 2 → no ----
    const fb = await db.feedbackSubmission.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' } });
    expect(fb.map((f) => [f.overallRating, f.summary, f.opportunityId])).toEqual([
      [4, `[${label} · Marcus Lee] Excellent depth on distributed systems. Hire.`, hired.id],
      [2, 'Original rating: 3/5 (neutral)\nSolid; a few gaps in SQL tuning.', hired.id],
      [2, `[${label} · Marcus Lee] Not strong enough on system design.`, active.id],
    ]);
    expect(fb[1].authorId).toBe(adminId);
    expect(fb[0].answers).toEqual({ 'imported-0': { label: 'SmartRecruiters rating', kind: 'TEXT', value: '5/5' } });
    expect(fb[0].createdAt.toISOString()).toBe('2026-03-19T16:40:02.117Z');

    // ---- interviews: one per timeslot ----
    const ivs = await db.interview.findMany({ where: { orgId }, include: { panelists: true }, orderBy: { startAt: 'asc' } });
    expect(ivs.map((i) => ({ title: i.title, state: i.state, durationMins: i.durationMins, location: i.location, opp: i.opportunityId }))).toEqual([
      { title: 'Technical interview — Jakub Kowalski', state: 'COMPLETED', durationMins: 60, location: 'Zoom · https://acme.zoom.us/j/81234567890', opp: hired.id },
      { title: 'Onsite', state: 'SCHEDULED', durationMins: 45, location: 'Acme HQ, 548 Market St', opp: active.id },
    ]);
    expect(ivs[0].startAt.toISOString()).toBe('2026-03-19T13:00:00.000Z');
    expect(ivs[0].panelists.map((p) => p.id)).toEqual([adminId]);

    // ---- offers ----
    const offerRows = await db.offer.findMany({ where: { orgId } });
    const offerIn = (status: string) => offerRows.find((o) => o.status === status)!;
    expect(offerIn('ACCEPTED')).toMatchObject({
      opportunityId: hired.id,
      jobTitle: 'Senior Backend Engineer',
      salaryAmount: 195000, // not the "B3" band or the 15 % bonus listed before it
      salaryCurrency: 'USD',
      sentAt: null,
    });
    expect(offerIn('ACCEPTED').startDate!.toISOString()).toBe('2026-11-02T00:00:00.000Z');
    expect(offerIn('ACCEPTED').respondedAt!.toISOString()).toBe('2026-04-09T13:47:29.512Z');
    expect(offerIn('ACCEPTED').notes).toContain('Salary Band: B3');
    expect(offerIn('ACCEPTED').notes).toContain('Sign-on Bonus: 15000');
    expect(offerIn('ACCEPTED').notes).toContain('Reports To: Marcus Lee');
    // Awaiting approval in SmartRecruiters → a draft here (there's no approval request to act on).
    expect(offerIn('DRAFT')).toMatchObject({ opportunityId: active.id, salaryAmount: 172500, jobTitle: 'Senior Backend Engineer' });
    // No job link in the search result: placed through Jakub's per-application offer lists.
    expect(offerIn('WITHDRAWN')).toMatchObject({ opportunityId: rejected.id, jobTitle: 'Product Designer', salaryAmount: 98000, salaryCurrency: 'EUR' });

    // ---- files: resume via a redirect to storage; a resume whose type only the application's list gives ----
    const witek = contacts.find((c) => c.name === 'Witek Pulawski')!;
    const stored = await db.storedFile.findMany({ where: { id: { in: [jakub.resumeFileId!, witek.resumeFileId!] } } });
    expect(stored.map((f) => [f.filename, f.mime, f.size]).sort()).toEqual([
      ['CV_Jakub_Kowalski.pdf', 'application/pdf', RESUME_BYTES.byteLength],
      ['Witek_Pulawski_CV.pdf', 'application/pdf', Buffer.from('%PDF-1.4 Witek resume').byteLength],
    ]);

    // ---- credentials stay on the API host ----
    const storage = first.calls.filter((c) => c.url.host !== API);
    expect(storage.map((c) => c.url.host)).toEqual([S3]);
    for (const c of storage) {
      expect(c.headers.authorization).toBeUndefined();
      expect(c.headers['x-smarttoken']).toBeUndefined();
    }
    for (const c of first.calls) {
      expect(c.url.href).not.toContain(CREDS.clientSecret);
      expect(c.url.href).not.toContain(CREDS.clientId);
      if (c.url.host === API && c.url.pathname !== '/identity/oauth/token') expect(c.headers.authorization).toMatch(/^Bearer /);
    }
    expect(JSON.stringify(view.issues)).not.toContain(CREDS.clientSecret);

    // ---- efficiency: one detail call per candidate despite duplicate list rows ----
    const hits = (path: string) => first.calls.filter((c) => c.url.pathname === path).length;
    // Once for the candidate, once to place the offer whose search result has no job link.
    expect(hits(`/candidates/${JAKUB}`)).toBe(2);
    expect(hits(`/candidates/${WITEK}`)).toBe(1);
    // …and one call per application in the activity phases, even though Jakub is listed twice.
    expect(hits('/reviews-api/v201910/reviews')).toBe(4);
    expect(hits('/interviews-api/v201904/interviews')).toBe(4);
    expect(hits(`/candidates/${JAKUB}/jobs/${BACKEND}`)).toBe(1);
    expect(hits(`/candidates/${JAKUB}/attachments`)).toBe(1);
    expect(first.calls.filter((c) => c.url.pathname === '/messages' && c.url.searchParams.get('candidateId') === JAKUB)).toHaveLength(2);
    expect(hits('/candidates')).toBe(2 * 5); // two pages, walked by each of the five candidate phases
    // Each application's attachment list is read, even when the profile already has a resume.
    expect(hits(`/candidates/${JAKUB}/jobs/${DESIGNER}/attachments`)).toBe(1);
    expect(hits(`/candidates/${JAKUB}/jobs/${BACKEND}/attachments`)).toBe(1);
    const propertyCalls = first.calls.filter((c) => c.url.pathname.endsWith('/properties'));
    expect(propertyCalls).toHaveLength(4);
    expect(propertyCalls.every((c) => c.url.searchParams.get('includeMultiSelect') === 'true')).toBe(true);
    expect(hits('/job-applications-api/v202112/job-applications/' + APP_ID[`${JAKUB}:${BACKEND}`])).toBe(0); // history had the date
    expect(hits(`/offers/${OFFER_PENDING}/documents`)).toBe(0); // never sent, so no documents to ask for

    // ---- re-run into the same org: nothing new, and no detail refetches ----
    const second = vendor();
    const again = await runImportForTest({ module: smartrecruitersProvider, credentials: CREDS, fetchImpl: second.impl, orgId });
    expect(again.status).toBe('SUCCEEDED');
    expect(second.unmatched).toEqual([]);
    expect(again.view.created).toEqual({});
    expect(await db.contact.count({ where: { orgId } })).toBe(3);
    expect(await db.opportunity.count({ where: { orgId } })).toBe(4);
    expect(await db.note.count({ where: { orgId } })).toBe(notes.length);
    expect(await db.feedbackSubmission.count({ where: { orgId } })).toBe(3);
    expect(await db.interview.count({ where: { orgId } })).toBe(2);
    expect(await db.offer.count({ where: { orgId } })).toBe(3);
    const refetched = second.calls
      .map((c) => c.url.pathname)
      .filter(
        (p) =>
          /^\/candidates\/[^/]+$/.test(p) ||
          /\/jobs\/[^/]+\/(status\/history|properties|screening-answers|offers)$/.test(p) ||
          p === `/jobs/${BACKEND}`,
      );
    expect(refetched).toEqual([`/candidates/${HIDDEN}`, `/candidates/${HIDDEN}`]); // still withheld (retried once with a fresh token)
    expect(second.calls.some((c) => c.url.host === S3)).toBe(false);
  });

  it('resumes mid-page one record per step, without redoing duplicate candidates', async () => {
    const { impl, calls } = vendor();
    const http = clientFor(impl);
    const loaded = new Set<string>();
    const applications: string[] = [];
    const warnings: string[] = [];
    const noop = async () => undefined;
    const ctx: PhaseContext = {
      http,
      catalog: { stage: () => undefined, reason: () => undefined, user: () => undefined },
      load: {
        has: async (kind, id) => loaded.has(`${kind}:${id}`),
        handled: async () => false,
        candidate: async (c) => void loaded.add(`contact:${c.externalId}`),
        application: async (a) => {
          applications.push(a.externalId);
          loaded.add(`opportunity:${a.externalId}`);
        },
        posting: noop,
        requisition: noop,
        note: noop,
        feedback: noop,
        interview: noop,
        offer: noop,
        file: noop,
      },
      options: DEFAULT_IMPORT_OPTIONS,
      since: null,
      outOfTime: () => true, // every step stops after its first record
      warn: (m) => void warnings.push(m),
    };
    const phase = loadPhase(http, 'candidates');
    let cursor: Cursor | null = null;
    let steps = 0;
    do {
      // The runner stores cursors as JSON between slices.
      cursor = JSON.parse(JSON.stringify(await phase.run(ctx, cursor))) as Cursor | null;
      steps++;
    } while (cursor !== null && steps < 20);

    expect(cursor).toBeNull();
    expect(steps).toBe(5); // jakub · witek · (jakub again, skipped) ana · hidden
    expect(applications.sort()).toEqual(Object.keys(APP_ID).sort());
    expect(calls.filter((c) => c.url.pathname === `/candidates/${JAKUB}`)).toHaveLength(1);
    expect(warnings).toEqual(['Candidates: SmartRecruiters withheld some records from this credential (HTTP 401); they were skipped']);
  });

  it('honors archived=false and since server-side where it can', async () => {
    const { impl, calls, unmatched } = vendor();
    const result = await runImportForTest({
      module: smartrecruitersProvider,
      credentials: CREDS,
      fetchImpl: impl,
      options: { archived: false, since: '2026-05-01T00:00:00.000Z' },
    });
    expect(result.status).toBe('SUCCEEDED');
    expect(unmatched).toEqual([]);
    expect(result.view.created).toMatchObject({ contact: 1, opportunity: 1, offer: 1 });
    const opps = await db.opportunity.findMany({ where: { orgId: result.orgId }, include: { contact: true } });
    // Witek's profile is from 2025; his application (and so his contact, inline) is from May 2026.
    expect(opps.map((o) => o.contact.name)).toEqual(['Witek Pulawski']);
    expect(opps[0].createdAt.toISOString()).toBe('2026-05-06T11:20:31.000Z');

    const candidateLists = calls.filter((c) => c.url.pathname === '/candidates');
    expect(candidateLists.every((c) => c.url.searchParams.get('updatedAfter') === '2026-05-01T00:00:00.000Z')).toBe(true);
    expect(calls.find((c) => c.url.pathname === '/offers')!.url.searchParams.get('createdAfter')).toBe('2026-05-01T00:00:00.000Z');
    // No stage-history (or field) calls for applications the loader would skip anyway.
    expect(calls.filter((c) => c.url.pathname.endsWith('/status/history')).map((c) => c.url.pathname)).toEqual([
      `/candidates/${WITEK}/jobs/${BACKEND}/status/history`,
    ]);
    expect(calls.filter((c) => c.url.pathname.endsWith('/properties')).map((c) => c.url.pathname)).toEqual([
      `/candidates/${WITEK}/jobs/${BACKEND}/properties`,
    ]);
  });

  it('keeps an application whose stage history it may not read, dated by its application record', async () => {
    const historyWarning =
      "Stage history: the credential can't read it (HTTP 403; it needs the candidate_status_read scope). Those applications were imported without their stage moves";
    const witekApplication = `GET ${API}/job-applications-api/v202112/job-applications/${APP_ID[`${WITEK}:${BACKEND}`]}`;
    for (const jobApplications of ['readable', 'forbidden'] as const) {
      const { impl, unmatched } = vendor({
        routes: {
          [`GET ${API}/candidates/${WITEK}/jobs/${BACKEND}/status/history`]: () => forbidden('NO_ACCESS_TO_CANDIDATE'),
          ...(jobApplications === 'forbidden' ? { [witekApplication]: () => forbidden('Not permitted') } : {}),
        },
      });
      const result = await runImportForTest({
        module: smartrecruitersProvider,
        credentials: CREDS,
        fetchImpl: impl,
        options: { archived: false, since: '2026-05-01T00:00:00.000Z' },
      });
      expect(result.status).toBe('SUCCEEDED');
      expect(unmatched).toEqual([]);
      expect(result.view.issues.map((i) => i.message)).toContain(historyWarning);
      const opps = await db.opportunity.findMany({ where: { orgId: result.orgId }, include: { contact: true, stage: true, stageTransitions: true } });
      // The profile (2025) predates `since`; using it as the application date would drop this application.
      expect(opps.map((o) => o.contact.name)).toEqual(['Witek Pulawski']);
      expect(opps[0].stage.name).toBe('Technical Interview');
      // No readable history still leaves one transition into the current stage, for the funnel.
      expect(opps[0].stageTransitions.map((t) => t.toStageId)).toEqual([opps[0].stageId]);
      if (jobApplications === 'readable') expect(opps[0].createdAt.toISOString()).toBe('2026-05-06T11:20:31.000Z');
      else expect(opps[0].createdAt.getTime()).toBeGreaterThan(Date.parse('2026-05-01T00:00:00.000Z'));
    }
  });

  it('reads the offer salary only from number fields, in either separator convention', async () => {
    const offer = (id: string, properties: Record<string, string>) => ({
      id,
      status: 'PENDING_APPROVAL',
      createdOn: '2026-09-10T10:00:00.000Z',
      updatedOn: '2026-09-11T10:00:00.000Z',
      properties,
      actions: offerActions(JAKUB, BACKEND, id),
    });
    const withDefinitions = [
      offer('7c6d5e4f-3a2b-4c1d-8e0f-9a8b7c6d5e4f', {
        salaryBand: 'B3',
        bonusTarget: '15',
        salaryReviewDate: '2027-01-01',
        baseSalary: '60.000,00',
        currency: 'EUR',
        startDate: '2027-01-04',
      }),
      offer('8d7e6f5a-4b3c-4d2e-9f1a-0b9c8d7e6f5a', { annualSalary: '65.000 EUR' }),
    ];
    const definitions = {
      categories: [
        {
          id: 'compensation',
          properties: [
            { key: 'salaryBand', label: 'Salary Band', required: false, type: 'TEXT' },
            { key: 'bonusTarget', label: 'Annual bonus (% of base salary)', required: false, type: 'PERCENT' },
            { key: 'salaryReviewDate', label: 'Salary Review Date', required: false, type: 'DATE' },
            { key: 'baseSalary', label: 'Base Salary', required: true, type: 'NUMBER' },
            { key: 'annualSalary', label: 'Annual Salary', required: false, type: 'NUMBER' },
            { key: 'currency', label: 'Currency', required: true, type: 'CURRENCY' },
            { key: 'startDate', label: 'Start Date', required: true, type: 'DATE' },
          ],
        },
      ],
    };
    // Without readable definitions, only the key names are left to go on.
    const withoutDefinitions = [offer('9e8f7a6b-5c4d-4e3f-8a2b-1c0d9e8f7a6b', { salaryGrade: 'G7', startingSalary: '85000', startDate: '2026-11-02' })];

    const run = async (list: object[], defs: Handler) => {
      const { impl } = vendor({
        routes: {
          [`GET ${API}/offers`]: () => json({ totalFound: list.length, limit: 100, offset: 0, content: list }),
          [`GET ${API}/configuration/offer-properties`]: defs,
        },
      });
      const http = clientFor(impl);
      const { ctx, records } = stubContext(http, { has: (kind, id) => kind === 'contact' && id === JAKUB, options: { files: false } });
      await runPhase(loadPhase(http, 'offers'), ctx);
      return records.offers.map((o) => ({ salary: o.salaryAmount ?? null, currency: o.salaryCurrency ?? null, start: o.startDate?.toISOString() ?? null }));
    };

    expect(await run(withDefinitions, () => json(definitions))).toEqual([
      { salary: 60000, currency: 'EUR', start: '2027-01-04T00:00:00.000Z' },
      { salary: 65000, currency: 'EUR', start: null },
    ]);
    expect(await run(withoutDefinitions, () => forbidden('Not permitted to read configuration'))).toEqual([
      { salary: 85000, currency: null, start: '2026-11-02T00:00:00.000Z' },
    ]);
  });

  it("keeps one application's failure from costing the candidate's other applications", async () => {
    const { impl, calls } = vendor({
      routes: {
        [`GET ${API}/reviews-api/v201910/reviews`]: (req) =>
          req.url.searchParams.get('jobId') === BACKEND
            ? json({ message: 'Bad request', errors: [{ code: 'INVALID_REQUEST' }] }, { status: 400 })
            : json([]),
        [`GET ${API}/candidates/${JAKUB}/jobs/${BACKEND}`]: () =>
          new Response('<html>Service temporarily unavailable</html>', { headers: { 'content-type': 'text/html' } }),
        [`GET ${API}/candidates/${JAKUB}/attachments`]: () => json({ message: 'Bad request' }, { status: 400 }),
      },
    });
    const http = clientFor(impl);
    const { ctx, records, warnings } = stubContext(http, {
      has: (kind, id) => (kind === 'opportunity' && id.startsWith(`${JAKUB}:`)) || (kind === 'contact' && id === JAKUB),
    });
    for (const id of ['interviews', 'feedback', 'files']) await runPhase(loadPhase(http, id), ctx);

    const jobsCalled = (path: string, param: string) =>
      calls.filter((c) => c.url.pathname === path).map((c) => c.url.searchParams.get(param));
    expect(jobsCalled('/reviews-api/v201910/reviews', 'jobId').sort()).toEqual([BACKEND, DESIGNER].sort());
    expect(jobsCalled('/interviews-api/v201904/interviews', 'applicationId')).toEqual([APP_ID[`${JAKUB}:${DESIGNER}`]]);
    // The profile list failed; the application lists still came through.
    expect(records.files.map((f) => [f.filename, f.kind, f.applicationExternalId])).toEqual([
      ['Portfolio_Case_Study.pdf', 'other', `${JAKUB}:${DESIGNER}`],
      ['CV_Jakub_Kowalski.pdf', 'resume', `${JAKUB}:${DESIGNER}`],
    ]);
    expect(warnings).toHaveLength(3);
    expect(warnings.every((w) => w.startsWith('Skipped a record that could not be imported'))).toBe(true);
  });

  it('merges an attachment listed twice, taking the type and name the candidate-level entry lacks', async () => {
    const { impl } = vendor();
    const http = clientFor(impl);
    const { ctx, records } = stubContext(http, {
      has: (kind, id) => (kind === 'contact' && id === WITEK) || (kind === 'opportunity' && id === `${WITEK}:${BACKEND}`),
    });
    await runPhase(loadPhase(http, 'files'), ctx);
    expect(records.files.map((f) => ({ id: f.externalId, filename: f.filename, kind: f.kind, app: f.applicationExternalId }))).toEqual([
      { id: WITEK_CV_ID, filename: 'Witek_Pulawski_CV.pdf', kind: 'resume', app: `${WITEK}:${BACKEND}` },
    ]);
    const file = await records.files[0].download();
    expect(file).toMatchObject({ filename: 'Witek_Pulawski_CV.pdf', contentType: 'application/pdf' });
  });

  it('annualizes monthly pay and keeps hourly pay readable', async () => {
    const MONTHLY = 'b7c8d9e0-f1a2-4b3c-8d4e-5f6a7b8c9d0e';
    const { impl } = vendor({
      routes: {
        [`GET ${API}/jobs`]: () =>
          json({ limit: 100, totalFound: 2, content: [jobRow(MONTHLY, 'Warehouse Lead', 'SOURCING', 'PUBLIC'), jobRow(DESIGNER, 'Product Designer', 'FILLED', 'NOT_PUBLISHED')] }),
        [`GET ${API}/jobs/${MONTHLY}`]: () =>
          json({
            id: MONTHLY,
            title: 'Warehouse Lead',
            createdOn: '2026-06-01T09:00:00.000Z',
            status: 'SOURCING',
            postingStatus: 'PUBLIC',
            location: { country: 'Germany', countryCode: 'de', city: 'Berlin', manual: false, remote: false, hybrid: false },
            typeOfEmployment: { id: 'permanent', label: 'Full-time' },
            template: false,
            compensation: { min: 4000, max: 5000, currency: 'EUR', period: 'MONTHLY' },
            jobAd: { sections: { jobDescription: { title: 'Job Description', text: '<p>Run the night shift.</p>' } } },
          }),
        [`GET ${API}/jobs/${MONTHLY}/positions`]: () => json({ totalFound: 0, content: [], positionsPendingApproval: [] }),
      },
    });
    const http = clientFor(impl);
    const { ctx, records } = stubContext(http);
    await runPhase(loadPhase(http, 'postings'), ctx);
    expect(records.postings.map((p) => ({ title: p.title, min: p.salaryMin, max: p.salaryMax, currency: p.salaryCurrency, description: p.description }))).toEqual([
      { title: 'Warehouse Lead', min: 48000, max: 60000, currency: 'EUR', description: 'Job Description\nRun the night shift.\n\nSalary: 4000–5000 EUR per month' },
      { title: 'Product Designer', min: null, max: null, currency: null, description: 'Job Description\nShape our design system. Figma daily.\n\nSalary: 45–60 EUR per hour' },
    ]);
  });
});
