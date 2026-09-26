import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/session', () => ({ isAdmin: () => true }));

import { createHttpClient, ImportAuthError, ImportHttpError } from '@/server/imports/http';
import { mergeProvider } from '@/server/imports/providers/merge';
import {
  DEFAULT_IMPORT_OPTIONS,
  type CatalogReason,
  type CatalogStage,
  type Cursor,
  type ImportedApplication,
  type ImportedFeedback,
  type ImportedNote,
  type ImportedOffer,
  type ImportOptions,
  type Loader,
  type PhaseContext,
} from '@/server/imports/types';
import { db, json, mockFetch, runImportForTest, verifyForTest, type RouteHandler } from '@/server/imports/__tests__/harness';
import { hasDb, publicDns } from '@/server/imports/__tests__/harness';

/**
 * Merge adapter against a mock of the Unified ATS API, built from the
 * payloads in Merge's reference docs: {next, previous, results} envelopes,
 * bare-token cursors, UUID ids, ISO timestamps, and `expand` swapping ids for
 * objects under the same key. The account is SAP SuccessFactors-shaped, so
 * notes, scorecards, interviews and offers all exist. Its RejectReason Scope
 * is disabled, which Merge answers with nulls rather than an error (§6 #22),
 * so only the linked-account-scopes preflight can say why reasons are empty.
 * Smaller tests run single phases against Workday-, iCIMS- and
 * SmartRecruiters-shaped payloads (Appendix B field coverage).
 */

const CREDS = { region: 'us', apiKey: 'mrg_live_TESTKEY_9f8e7d6c5b4a', accountToken: 'acct_TESTTOKEN_1a2b3c4d5e' };
const API = 'api.merge.dev/api/ats/v1';
const FILES = 'files.example-ats.com';
const APPLICATION_EXPAND =
  'candidate,current_stage,job,offers,reject_reason,screening_question_answers,screening_question_answers.question';

// ---------- fixtures (ids from the spec's consistent dataset, plus a few more) ----------

const meta = (id: string, remoteId: string | null, createdAt = '2026-09-20T14:03:11.482913Z') => ({
  id,
  remote_id: remoteId,
  created_at: createdAt,
  modified_at: createdAt,
});
const tail = { remote_was_deleted: false, field_mappings: null, remote_data: null };

const ACCOUNT = {
  id: '0f4e2b8c-6a1d-4c3e-9b7f-2d5a8e1c4b90',
  integration: 'SAP SuccessFactors',
  integration_slug: 'sap-successfactors',
  category: 'ats',
  end_user_origin_id: 'acme-talent-import',
  end_user_organization_name: 'Acme Robotics',
  end_user_email_address: 'talent-ops@acmerobotics.com',
  status: 'COMPLETE',
  webhook_listener_url: 'https://api.merge.dev/api/integrations/webhook-listener/q8Zt3LmW0pXv2Rk',
  is_duplicate: false,
  account_type: 'PRODUCTION',
  completed_at: '2026-09-20T14:01:52.918274Z',
  instance_id: null,
  instance_display_value: null,
};

/** A /linked-account-scopes common_models row. */
const scope = (model: string, read = true, disabledFields: string[] = []) => ({
  model_name: model,
  model_permissions: { READ: { is_enabled: read }, WRITE: { is_enabled: false } },
  field_permissions: { enabled_fields: [], disabled_fields: disabledFields },
});

const DANA = '7f3c2a10-5b8e-4c1d-9a2f-3e4b5c6d7e81';
const MARCUS = 'b2e9d4c7-1a3f-4e6b-8c5d-9f0a1b2c3d42';
const LENA = 'c8a1f5e2-7d4b-4a9c-b3e6-2f1d0c9b8a73';

const users = [
  // Dana's email matches the harness org's admin, so her records attribute to a real teammate.
  { ...meta(DANA, 'dwhitfield'), first_name: 'Dana', last_name: 'Whitfield', email: 'Admin@Example.test', disabled: false, remote_created_at: '2022-03-14T09:12:00Z', access_role: 'ADMIN', ...tail },
  { ...meta(MARCUS, 'moyelaran'), first_name: 'Marcus', last_name: 'Oyelaran', email: 'marcus.oyelaran@acmerobotics.com', disabled: false, remote_created_at: '2023-01-09T15:40:22Z', access_role: 'TEAM_MEMBER', ...tail },
  { ...meta(LENA, 'lfischer'), first_name: 'Lena', last_name: 'Fischer', email: 'lena.fischer@acmerobotics.com', disabled: true, remote_created_at: null, access_role: 'INTERVIEWER', ...tail },
];
const userById = new Map(users.map((u) => [u.id, u]));

const JOB1 = 'e4f7a2c9-3b6d-4e1f-8a5c-7d9b0e2f4a36';
const JOB2 = 'd2b8e6f4-9a1c-4e7b-b3d5-8f2a6c4e0d19';
const JOB3 = '0e6a2c8f-4b1d-4f7a-9c3e-5d8b2f6a1c47';

const S_APPLIED = { ...meta('2d7b5f9e-1c3a-4e8d-b6f2-9a0c4e7d1b63', 'APPLIED'), name: 'Applied', job: null, stage_order: null, ...tail };
const S_PHONE1 = { ...meta('4a8c2e6f-0b9d-4f1a-8e3c-7d5b1a9f3e20', '88213'), name: 'Phone Screen', job: JOB1, stage_order: 2, ...tail };
const S_ONSITE1 = { ...meta('8e2a6c0f-4d1b-4b7e-a9f3-1c5e9b3d7a64', '88214'), name: 'Onsite', job: JOB1, stage_order: 3, ...tail };
const S_OFFER1 = { ...meta('5c9e3a7d-1f6b-4e2c-b8d0-6a4f2e8c0b15', '88215'), name: 'Offer', job: JOB1, stage_order: 4, ...tail };
const S_PHONE2 = { ...meta('3f1b7d5a-9c2e-4a8f-b6d0-2e4c6a8b0d31', '91102'), name: 'Phone Screen', job: JOB2, stage_order: null, ...tail };
const S_HIRED2 = { ...meta('7b3d9f1c-5e2a-4c6b-8d0f-4a6c8e0b2d53', '91109'), name: 'Hired', job: JOB2, stage_order: null, ...tail };
const stages = [S_APPLIED, S_PHONE1, S_ONSITE1, S_OFFER1, S_PHONE2, S_HIRED2];

const REASON_EXPERIENCE = { ...meta('5f2a8c1e-9d4b-4a7f-8e3c-6b1d0a9f2e74', 'RJ-004'), name: 'Not enough relevant experience', ...tail };
const reasonById = new Map([[REASON_EXPERIENCE.id, REASON_EXPERIENCE]]);

const ENGINEERING = { ...meta('3a9f7c21-4e8b-4d6a-a1c3-5b7e9f0d2c14', '1100'), name: 'Engineering', ...tail };
const AUSTIN = { ...meta('6e1d8b4f-2c7a-4f93-8e5d-1a0b9c8d7e65', 'LOC_AUS_01'), name: 'Austin HQ', location: '500 W 2nd St, Austin, TX 78701, United States', ...tail };
const REMOTE_US = { ...meta('9b4c2e7a-6f1d-4a8b-b5c3-0e2d4f6a8c97', 'LOC_REMOTE_US'), name: 'Remote - US', location: null, ...tail };
const JP1 = {
  ...meta('1c5e9a3b-7d2f-4b6e-9c8a-4f0e2d1b3a58', 'JP-40211-EXT'),
  title: 'Senior Backend Engineer (Austin or Remote US)',
  job_posting_urls: [{ value: 'https://careers.acmerobotics.com/jobs/40211', url_type: 'JOB_POSTING' }],
  job: JOB1,
  status: 'PUBLISHED',
  content: '<p>Acme Robotics builds autonomous picking systems…</p>',
  remote_created_at: '2026-06-03T09:00:00Z',
  remote_updated_at: '2026-09-18T10:04:12Z',
  is_internal: false,
  ...tail,
};
const JP3 = {
  ...meta('8d2f6b0a-3e7c-4d1a-a5f9-0c4e8a2d6b15', 'JP-41007-INT'),
  title: 'Warehouse Robotics Intern',
  job_posting_urls: [],
  job: JOB3,
  status: 'INTERNAL',
  content: '<p>Spend the summer tuning pick paths on real robots.</p>',
  remote_created_at: '2026-08-01T09:00:00Z',
  remote_updated_at: '2026-08-01T09:00:00Z',
  is_internal: true,
  ...tail,
};

const jobs = [
  {
    ...meta(JOB1, '40211'),
    name: 'Senior Backend Engineer',
    description: '<p><strong>About the role</strong></p><p>You will own the telemetry ingestion pipeline for our fleet of warehouse robots.</p><ul><li>5+ years building distributed systems</li><li>Go or Rust in production</li></ul>',
    code: 'REQ-2026-0142',
    status: 'OPEN',
    type: 'REQUISITION',
    job_postings: [JP1],
    job_posting_urls: [{ value: 'https://careers.acmerobotics.com/jobs/40211', url_type: 'JOB_POSTING' }],
    remote_created_at: '2026-06-02T17:45:31Z',
    remote_updated_at: '2026-09-18T10:03:57Z',
    confidential: false,
    departments: [ENGINEERING],
    offices: [AUSTIN, REMOTE_US],
    hiring_managers: [MARCUS],
    recruiters: [DANA],
    ...tail,
  },
  {
    ...meta(JOB2, '39877'),
    name: 'Solutions Architect',
    description: '<p>Partner with enterprise customers to design automation rollouts.</p>',
    code: 'REQ-2026-0098',
    status: 'CLOSED',
    type: 'REQUISITION',
    job_postings: [],
    job_posting_urls: [],
    remote_created_at: '2026-02-11T12:00:00Z',
    remote_updated_at: '2026-07-30T08:15:44Z',
    confidential: null,
    departments: [],
    offices: [AUSTIN],
    hiring_managers: [],
    recruiters: [LENA],
    ...tail,
  },
  {
    ...meta(JOB3, '41007'),
    name: 'Warehouse Robotics Intern (Summer 2027)',
    description: null,
    code: null,
    status: 'OPEN',
    type: 'POSTING',
    job_postings: [JP3],
    job_posting_urls: [],
    remote_created_at: null,
    remote_updated_at: null,
    confidential: null,
    departments: [ENGINEERING],
    offices: [REMOTE_US],
    hiring_managers: [],
    recruiters: [],
    ...tail,
  },
];
const jobById = new Map(jobs.map((j) => [j.id, j]));

const JORDAN = 'f1a9c3e7-5b2d-4e8f-a6c4-3d7b9e1f5a20';
const PRIYA = '2c6e0a4d-8f3b-4e1c-9a7d-5b1f3e9c7a02';
const SAM = '9e3a7c1f-5d0b-4b8e-a2c6-7f1d5b9e3a64';
const CASEY = '4d8f2b6e-0a9c-4e3d-b7f1-3c5a9e1d7b85';

const A1 = 'a7d3f1b9-6e4c-4a2d-8f5b-1c9e7a3d5b48';
const A2 = '6b1f9d5a-3c8e-4f2b-9a6d-0e4c8b2f6a91';
const A3 = '1f5b9d3a-7e2c-4a6f-8b0d-2c6e0a4f8b17';
const A4 = '8a2c6e0b-4f9d-4b3a-a7e1-9d3f7b1c5e28';
const A5 = '3e7a1c5f-9b4d-4d8e-b2a6-6f0c4e8a2d39';

const OFR1 = {
  ...meta('4b8f2d6a-1e9c-4d3b-a7f5-6c0e8a2b4d61', 'OFR-3310'),
  application: A1,
  creator: DANA,
  remote_created_at: '2026-08-20T14:10:00Z',
  closed_at: null,
  sent_at: '2026-08-22T16:45:00Z',
  start_date: '2026-10-19T00:00:00Z',
  status: 'SENT',
  ...tail,
};
const OFR2 = {
  ...meta('0c4e8a2d-6b1f-4f5c-9e3a-7d1b5f9c3e82', 'OFR-3187'),
  application: A3,
  creator: LENA,
  remote_created_at: '2026-05-20T10:00:00Z',
  closed_at: '2026-06-01T18:00:00Z',
  sent_at: '2026-05-28T15:30:00Z',
  start_date: '2026-07-06T00:00:00Z',
  status: 'SIGNED',
  ...tail,
};
const offers = [OFR1, OFR2];
const offerById = new Map(offers.map((o) => [o.id, o]));

// Screening question and answer from the spec's §5.6.3 / §5.9 examples.
const SQ_WORK_AUTH = {
  ...meta('0b5d9f3a-7c2e-4a6b-8d1f-4e9c3a7b5d26', 'SQ-771', '2026-09-20T14:02:44.100912Z'),
  job: JOB1,
  description: 'Are you currently authorized to work in the United States?',
  title: 'Work authorization',
  type: 'SINGLE_SELECT',
  required: true,
  options: [
    { ...meta('5e1a7c3f-9b2d-4f8e-a6c0-1d3b5f7a9c21', 'SQ-771-1'), label: 'Yes, without sponsorship', remote_was_deleted: false },
    { ...meta('7a3c9e1b-5d4f-4b2a-8c6e-0f2d4b6a8e32', 'SQ-771-2'), label: 'Yes, with sponsorship', remote_was_deleted: false },
    { ...meta('9c5e1a3d-7f6b-4d4c-a8e0-2b4f6d8c0a43', 'SQ-771-3'), label: 'No', remote_was_deleted: false },
  ],
  remote_was_deleted: false,
};
const questionById = new Map([[SQ_WORK_AUTH.id, SQ_WORK_AUTH]]);

type ScreeningAnswer = ReturnType<typeof screeningAnswer>;
function screeningAnswer(id: string, remoteId: string, question: string | null, answer: string | null) {
  return { ...meta(id, remoteId, '2026-09-20T14:03:30.011002Z'), question, answer, remote_was_deleted: false };
}

/** An /applications row with relations as ids, the way Merge returns it unexpanded. */
type AppFixture = {
  id: string;
  candidate: string | null;
  job: string | null;
  offers: string[];
  credited_to: string | null;
  current_stage: string | null;
  reject_reason: string | null;
  screening_question_answers: ScreeningAnswer[];
  [key: string]: unknown;
};

const candidates = [
  {
    ...meta(JORDAN, '187342'),
    first_name: 'Jordan',
    last_name: 'Alvarez',
    company: 'Northwind Logistics',
    title: 'Staff Software Engineer',
    remote_created_at: '2025-11-04T16:22:09Z',
    remote_updated_at: '2026-09-17T21:40:55Z',
    last_interaction_at: '2026-09-16T18:00:00Z',
    is_private: false,
    can_email: true,
    locations: ['Austin, TX, United States'],
    phone_numbers: [{ value: '+15125550148', phone_number_type: 'MOBILE' }],
    email_addresses: [
      { value: 'Jordan.Alvarez@example.com', email_address_type: 'PERSONAL' },
      { value: 'jalvarez@northwind.example', email_address_type: 'WORK' },
    ],
    urls: [
      { value: 'https://www.linkedin.com/in/jordan-alvarez-dev', url_type: 'SOCIAL_MEDIA' },
      { value: 'https://github.com/jalvarez', url_type: 'PORTFOLIO' },
    ],
    tags: ['Silver Medalist', 'Distributed Systems'],
    applications: [A1, A2],
    attachments: ['3d9b7f5c-1a4e-4c8d-a2f6-9e0b4d8c2a17', '5a1c7e3b-9f2d-4b6a-8e0c-1d5f9b3a7c26'],
    ...tail,
  },
  {
    // iCIMS-like: no remote_created_at, so the earliest applied_at stands in.
    ...meta(PRIYA, '187590'),
    first_name: 'Priya',
    last_name: 'Raman',
    company: null,
    title: 'Platform Engineer',
    remote_created_at: null,
    remote_updated_at: null,
    last_interaction_at: null,
    is_private: true,
    can_email: null,
    locations: null,
    phone_numbers: [],
    email_addresses: [{ value: 'priya.raman@example.org', email_address_type: 'PERSONAL' }],
    urls: [],
    tags: [],
    applications: [A4, A5],
    attachments: ['6c2e8a4f-0d7b-4f1e-a3c9-5b7d1f3e9a40'],
    ...tail,
  },
  {
    ...meta(SAM, '186011'),
    first_name: 'Sam',
    last_name: 'Okafor',
    company: 'Contoso Automation',
    title: null,
    remote_created_at: '2026-03-01T08:00:00Z',
    remote_updated_at: '2026-06-01T18:00:00Z',
    last_interaction_at: null,
    is_private: false,
    can_email: true,
    locations: ['Denver, CO, United States'],
    phone_numbers: [],
    email_addresses: [{ value: 'sam.okafor@example.net', email_address_type: 'PERSONAL' }],
    urls: [],
    tags: [],
    applications: [A3],
    attachments: ['2b6d0f4a-8c3e-4a7d-b1f5-9e3c7a1d5b62'],
    ...tail,
  },
  {
    // A prospect with no applications: a contact, nothing else.
    ...meta(CASEY, '188204'),
    first_name: 'Casey',
    last_name: 'Lin',
    company: 'Fabrikam',
    title: 'Robotics Engineer',
    remote_created_at: '2026-08-11T12:00:00Z',
    remote_updated_at: '2026-08-11T12:00:00Z',
    last_interaction_at: null,
    is_private: false,
    can_email: true,
    locations: ['Seattle, WA, United States'],
    phone_numbers: [],
    email_addresses: [{ value: 'casey.lin@example.com', email_address_type: 'PERSONAL' }],
    urls: [{ value: 'https://caseylin.dev', url_type: 'PERSONAL' }],
    tags: ['Robotics'],
    applications: [],
    attachments: [],
    ...tail,
  },
];
const candidateById = new Map(candidates.map((c) => [c.id, c]));

const applications: AppFixture[] = [
  {
    ...meta(A1, 'APP-552910', '2026-09-20T14:03:30.009188Z'),
    candidate: JORDAN,
    job: JOB1,
    applied_at: '2026-07-08T13:15:00Z',
    rejected_at: null,
    offers: [OFR1.id],
    source: 'Employee Referral',
    credited_to: MARCUS,
    screening_question_answers: [screeningAnswer('c3e7a1f5-9b2d-4d6e-8a0c-2f4b6d8e0a13', 'SQA-99120', SQ_WORK_AUTH.id, 'Yes, without sponsorship')],
    current_stage: S_OFFER1.id,
    reject_reason: null,
    remote_was_deleted: false,
    field_mappings: { organization_defined_targets: { visa_status: 'H-1B transfer' }, linked_account_defined_targets: {} },
    remote_data: null,
  },
  {
    ...meta(A2, 'APP-531077', '2026-09-20T14:03:30.018870Z'),
    candidate: JORDAN,
    job: JOB2,
    applied_at: '2026-02-20T09:41:12Z',
    rejected_at: '2026-03-05T16:00:00Z',
    offers: [],
    source: 'LinkedIn',
    credited_to: null,
    screening_question_answers: [],
    current_stage: S_APPLIED.id,
    reject_reason: REASON_EXPERIENCE.id,
    ...tail,
  },
  {
    ...meta(A3, 'APP-529440', '2026-09-20T14:03:30.021004Z'),
    candidate: SAM,
    job: JOB2,
    applied_at: '2026-03-02T11:20:00Z',
    rejected_at: null,
    offers: [OFR2.id],
    source: 'Acme Staffing Partners',
    // Job 2's recruiter (Lena) isn't a teammate; the credited user is.
    credited_to: DANA,
    screening_question_answers: [],
    current_stage: S_HIRED2.id,
    reject_reason: null,
    ...tail,
  },
  {
    ...meta(A4, 'APP-548812', '2026-09-20T14:03:30.024117Z'),
    candidate: PRIYA,
    job: JOB1,
    applied_at: '2026-05-02T10:00:00Z',
    rejected_at: null,
    offers: [],
    source: 'LinkedIn Recruiter',
    credited_to: LENA,
    // Its question isn't in Merge's list, so it stays an id and has no title to file it under.
    screening_question_answers: [screeningAnswer('d4f8b2a6-0c3e-4e7f-9b1d-3a5c7e9f1b24', 'SQA-99311', '9f1b3d5e-7a2c-4c8e-a0f2-4b6d8e0a2c35', 'Kubernetes, Terraform')],
    current_stage: S_PHONE1.id,
    reject_reason: null,
    ...tail,
  },
  {
    // Still "in process" on a job that has since closed.
    ...meta(A5, 'APP-520031', '2026-09-20T14:03:30.027350Z'),
    candidate: PRIYA,
    job: JOB2,
    applied_at: '2026-01-15T15:00:00Z',
    rejected_at: null,
    offers: [],
    source: null,
    credited_to: null,
    screening_question_answers: [],
    current_stage: S_PHONE2.id,
    reject_reason: null,
    ...tail,
  },
];
const applicationById = new Map(applications.map((a) => [a.id, a]));
const stageById = new Map(stages.map((s) => [s.id, s]));

const INT1 = 'e9c5a1f7-3d8b-4b2e-9f6c-0a4d8e2b6c37';
const interviews = [
  {
    ...meta(INT1, 'INT-20931'),
    application: A1,
    job_interview_stage: S_ONSITE1.id,
    organizer: DANA,
    interviewers: [LENA, MARCUS, DANA],
    location: 'Austin HQ – Room 4B (Pecan)',
    start_at: '2026-08-14T15:00:00Z',
    end_at: '2026-08-14T17:30:00Z',
    remote_created_at: '2026-08-01T12:44:09Z',
    remote_updated_at: '2026-08-14T21:31:02Z',
    status: 'COMPLETE',
    ...tail,
  },
];
const interviewById = new Map(interviews.map((i) => [i.id, i]));

const scorecards = [
  {
    ...meta('2f6d0b4e-8a3c-4e9f-b1d7-5a9c3e7f1b82', 'SC-440918'),
    application: A1,
    interview: INT1,
    interviewer: LENA,
    remote_created_at: '2026-08-14T20:02:11Z',
    submitted_at: '2026-08-14T21:30:47Z',
    overall_recommendation: 'STRONG_YES',
    ...tail,
  },
  {
    ...meta('9a3f7c1e-5d0b-4e8a-a6f2-4c8e0b2d6f59', 'SC-440921'),
    application: A1,
    interview: null,
    interviewer: MARCUS,
    remote_created_at: '2026-08-15T09:10:00Z',
    submitted_at: null,
    overall_recommendation: 'NO_DECISION',
    ...tail,
  },
  {
    ...meta('c1e5a9d3-7b2f-4c6e-8a0d-3f7b1e5c9a04', 'SC-439702'),
    application: A4,
    interview: null,
    interviewer: DANA,
    remote_created_at: '2026-05-06T17:00:00Z',
    submitted_at: '2026-05-06T17:25:00Z',
    overall_recommendation: 'DEFINITELY_NO',
    ...tail,
  },
];

const activities = [
  {
    ...meta('6a0e4c8b-2f7d-4a1e-9c5b-3e8d2a6f0c94', 'NOTE-7781302'),
    user: DANA,
    remote_created_at: '2026-07-10T19:22:41Z',
    activity_type: 'NOTE',
    subject: 'Recruiter screen',
    body: 'Strong on Kafka + Go. Wants hybrid in Austin. Comp expectation < $220k base.',
    visibility: 'PUBLIC',
    candidate: JORDAN,
    ...tail,
  },
  {
    ...meta('0d4b8f2c-6e1a-4c9d-b3f7-5a9e1c3d7b28', 'MAIL-99310'),
    user: MARCUS,
    remote_created_at: '2026-07-11T08:05:00Z',
    activity_type: 'EMAIL',
    subject: 'Next steps with Acme Robotics',
    body: "<p>Hi Jordan,</p><p>Thanks for your time yesterday &mdash; we'd love to bring you onsite.</p>",
    visibility: 'PRIVATE',
    candidate: JORDAN,
    ...tail,
  },
  {
    ...meta('b5d9f3a7-1c6e-4e0b-8f4a-7c3e9b5d1f86', 'NOTE-7781990'),
    user: DANA,
    remote_created_at: '2026-07-12T10:00:00Z',
    activity_type: 'NOTE',
    subject: null,
    body: 'Pipeline sync notes for the week.',
    visibility: 'PUBLIC',
    candidate: null,
    ...tail,
  },
];

const ATT_EXPIRED = '2b6d0f4a-8c3e-4a7d-b1f5-9e3c7a1d5b62';
const attachments = [
  {
    ...meta('3d9b7f5c-1a4e-4c8d-a2f6-9e0b4d8c2a17', 'ATT-6602915'),
    file_name: 'Jordan_Alvarez_Resume_2026.pdf',
    file_url: `https://${FILES}/attachments/6602915/Jordan_Alvarez_Resume_2026.pdf?X-Amz-Expires=3600&X-Amz-Signature=5f1c0e`,
    candidate: JORDAN,
    attachment_type: 'RESUME',
    ...tail,
  },
  {
    ...meta('5a1c7e3b-9f2d-4b6a-8e0c-1d5f9b3a7c26', 'ATT-6602916'),
    file_name: 'Jordan_Alvarez_Cover_Letter.pdf',
    file_url: `https://${FILES}/attachments/6602916/Jordan_Alvarez_Cover_Letter.pdf?X-Amz-Expires=3600&X-Amz-Signature=77ab10`,
    candidate: JORDAN,
    attachment_type: 'COVER_LETTER',
    ...tail,
  },
  {
    // Untyped, named like a CV, and its signed link has already expired.
    ...meta(ATT_EXPIRED, 'ATT-7710452'),
    file_name: 'Sam_Okafor_CV.pdf',
    file_url: `https://${FILES}/attachments/7710452/Sam_Okafor_CV.pdf?X-Amz-Expires=3600&X-Amz-Signature=expired`,
    candidate: SAM,
    attachment_type: null,
    ...tail,
  },
  {
    // Metadata-only integrations (Jobvite, CATS, …) give no file_url.
    ...meta('6c2e8a4f-0d7b-4f1e-a3c9-5b7d1f3e9a40', 'ATT-8120077'),
    file_name: 'Priya_Raman_Portfolio.pdf',
    file_url: null,
    candidate: PRIYA,
    attachment_type: 'OTHER',
    ...tail,
  },
];

// ---------- mock server ----------

/** Merge-style opaque cursor: URL-safe base64 of a DRF position. */
const cursorFor = (page: number) => Buffer.from(`p=2026-09-20+14%3A03%3A1${page}.482913%2B00%3A00`).toString('base64url');

/** Serve `chunks` as consecutive pages linked by bare `next` tokens. */
function paged(chunks: (url: URL) => unknown[][]): RouteHandler {
  return ({ url }) => {
    const pages = chunks(url);
    const token = url.searchParams.get('cursor');
    const index = token === null ? 0 : pages.findIndex((_, i) => i > 0 && cursorFor(i) === token);
    if (index < 0) return json({ detail: 'Invalid cursor.' }, { status: 400 });
    return json({
      next: index + 1 < pages.length ? cursorFor(index + 1) : null,
      previous: index > 0 ? Buffer.from(`r=1&p=page-${index}`).toString('base64url') : null,
      results: pages[index],
    });
  };
}

const wants = (url: URL, field: string) => (url.searchParams.get('expand') ?? '').split(',').includes(field);
/** `expand` swaps the id for the object under the same key. */
function rel<T>(url: URL, field: string, id: string | null, lookup: ReadonlyMap<string, T>): string | T | null {
  if (!id) return null;
  return wants(url, field) ? (lookup.get(id) ?? id) : id;
}

type Lookup = ReadonlyMap<string, unknown>;
const NONE: Lookup = new Map();

/** /applications rows with whatever the request asked to expand swapped in. */
function expandApplications(
  url: URL,
  rows: AppFixture[],
  look: { candidates?: Lookup; jobs?: Lookup; stages?: Lookup; reasons?: Lookup; offers?: Lookup },
) {
  return rows.map((a) => ({
    ...a,
    candidate: rel(url, 'candidate', a.candidate, look.candidates ?? NONE),
    job: rel(url, 'job', a.job, look.jobs ?? NONE),
    current_stage: rel(url, 'current_stage', a.current_stage, look.stages ?? NONE),
    reject_reason: rel(url, 'reject_reason', a.reject_reason, look.reasons ?? NONE),
    offers: a.offers.map((id) => rel(url, 'offers', id, look.offers ?? NONE)),
    screening_question_answers: a.screening_question_answers.map((ans) =>
      wants(url, 'screening_question_answers')
        ? { ...ans, question: rel(url, 'screening_question_answers.question', ans.question, questionById) }
        : ans.id,
    ),
  }));
}

function pdf(text: string): Buffer {
  const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const pdfResponse = (text: string) => new Response(new Uint8Array(pdf(text)), { headers: { 'content-type': 'application/pdf' } });

function mergeRoutes(overrides: Record<string, RouteHandler> = {}): Record<string, RouteHandler> {
  return {
    [`GET ${API}/account-details`]: () => json(ACCOUNT),
    [`GET ${API}/sync-status`]: () =>
      json({
        next: null,
        previous: null,
        results: [
          { model_name: 'Candidate', model_id: 'ats.Candidate', status: 'DONE', sync_status_reason: null, is_initial_sync: false, last_sync_start: '2026-09-22T03:00:04.118302Z', next_sync_start: '2026-09-23T03:00:00.000000Z', last_sync_result: 'DONE', last_sync_finished: '2026-09-22T03:41:57.662941Z', data_fresh_as_of: '2026-09-22T03:00:04.118302Z', selective_sync_configurations_usage: 'IN_NEXT_SYNC' },
          { model_name: 'Application', model_id: 'ats.Application', status: 'SYNCING', sync_status_reason: 'RATE_LIMITED', is_initial_sync: true, last_sync_start: '2026-09-22T03:00:04.118302Z', next_sync_start: '2026-09-23T03:00:00.000000Z', last_sync_result: 'PARTIALLY_SYNCED', last_sync_finished: '2026-09-21T05:12:40.001337Z', data_fresh_as_of: null, selective_sync_configurations_usage: 'IN_NEXT_SYNC' },
          { model_name: 'EEOC', model_id: 'ats.EEOC', status: 'FAILED', sync_status_reason: null, is_initial_sync: false },
        ],
      }),
    [`GET ${API}/linked-account-scopes`]: () =>
      json({
        common_models: [
          scope('Candidate'),
          scope('Application'),
          scope('Job'),
          scope('RejectReason', false),
          scope('EEOC', false),
          scope('Offer'),
          scope('Attachment'),
        ],
      }),
    [`GET ${API}/users`]: paged(() => [users]),
    [`GET ${API}/job-interview-stages`]: paged(() => [stages]),
    // RejectReason Scope disabled for this linked account: Merge answers with nulls, not an error.
    [`GET ${API}/reject-reasons`]: paged(() => [
      [{ id: REASON_EXPERIENCE.id, remote_id: null, created_at: REASON_EXPERIENCE.created_at, modified_at: REASON_EXPERIENCE.modified_at, name: null, remote_was_deleted: null, field_mappings: null, remote_data: null }],
    ]),
    [`GET ${API}/jobs`]: paged((url) => [
      jobs.map((j) => ({
        ...j,
        departments: wants(url, 'departments') ? j.departments : j.departments.map((d) => d.id),
        offices: wants(url, 'offices') ? j.offices : j.offices.map((o) => o.id),
        job_postings: wants(url, 'job_postings') ? j.job_postings : j.job_postings.map((p) => p.id),
      })),
    ]),
    [`GET ${API}/candidates`]: paged((url) => {
      const rows = candidates.map((c) => ({
        ...c,
        applications: c.applications.map((id) => rel(url, 'applications', id, applicationById)),
      }));
      return [rows.slice(0, 2), rows.slice(2)];
    }),
    [`GET ${API}/applications`]: paged((url) => {
      const rows = expandApplications(url, applications, {
        candidates: candidateById,
        jobs: jobById,
        stages: stageById,
        reasons: reasonById,
        offers: offerById,
      });
      return [rows.slice(0, 2), rows.slice(2)];
    }),
    [`GET ${API}/interviews`]: paged((url) => [
      interviews.map((i) => ({ ...i, job_interview_stage: rel(url, 'job_interview_stage', i.job_interview_stage, stageById) })),
    ]),
    [`GET ${API}/scorecards`]: paged((url) => [
      scorecards.map((s) => ({
        ...s,
        interview: rel(url, 'interview', s.interview, interviewById),
        interviewer: rel(url, 'interviewer', s.interviewer, userById),
      })),
    ]),
    [`GET ${API}/activities`]: paged((url) => [activities.map((n) => ({ ...n, user: rel(url, 'user', n.user, userById) }))]),
    [`GET ${API}/offers`]: paged(() => [offers]),
    [`GET ${API}/attachments`]: paged(() => [attachments]),
    [`GET ${API}/attachments/${ATT_EXPIRED}`]: () =>
      json({
        ...attachments[2],
        file_url: `https://${FILES}/attachments/7710452/Sam_Okafor_CV.pdf?X-Amz-Expires=3600&X-Amz-Signature=fresh`,
      }),
    [`GET ${FILES}/attachments/6602915/Jordan_Alvarez_Resume_2026.pdf`]: () => pdfResponse('Jordan Alvarez Staff Software Engineer'),
    [`GET ${FILES}/attachments/6602916/Jordan_Alvarez_Cover_Letter.pdf`]: () => pdfResponse('Dear Acme Robotics'),
    [`GET ${FILES}/attachments/7710452/Sam_Okafor_CV.pdf`]: ({ url }) =>
      url.searchParams.get('X-Amz-Signature') === 'fresh'
        ? pdfResponse('Sam Okafor')
        : new Response('<Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>', {
            status: 403,
            headers: { 'content-type': 'application/xml' },
          }),
    ...overrides,
  };
}

const importedId = (o: { customFields: unknown }) => (o.customFields as { imported: { id: string } }).imported.id;
const importedFields = (o: { customFields: unknown }) => (o.customFields as { imported: { fields?: Record<string, string> } }).imported.fields;

/**
 * Run single phases against the mock with a recording loader instead of the
 * database: for payload shapes the SAP SF account above doesn't have.
 */
function phaseHarness(routes: Record<string, RouteHandler>, opts: { options?: Partial<ImportOptions>; teammates?: string[] } = {}) {
  const { impl, calls, unmatched } = mockFetch(routes);
  const http = createHttpClient({ resolveHost: publicDns, auth: mergeProvider.auth(CREDS), minIntervalMs: 0, fetchImpl: impl });
  const adapter = mergeProvider.create(CREDS, http);
  const options: ImportOptions = { ...DEFAULT_IMPORT_OPTIONS, ...opts.options };
  const out = {
    warnings: [] as string[],
    stages: [] as CatalogStage[],
    reasons: [] as CatalogReason[],
    applications: [] as ImportedApplication[],
    feedback: [] as ImportedFeedback[],
    notes: [] as ImportedNote[],
    offers: [] as ImportedOffer[],
    files: [] as { externalId: string; error: string | null }[],
  };
  const skip = async () => undefined;
  const load: Loader = {
    posting: skip,
    requisition: skip,
    candidate: skip,
    interview: skip,
    application: async (r) => void out.applications.push(r),
    feedback: async (r) => void out.feedback.push(r),
    note: async (r) => void out.notes.push(r),
    offer: async (r) => void out.offers.push(r),
    // Like the real loader: a failed download skips the file, anything else propagates.
    async file(f) {
      try {
        await f.download();
        out.files.push({ externalId: f.externalId, error: null });
      } catch (err) {
        if (!(err instanceof ImportHttpError)) throw err;
        out.files.push({ externalId: f.externalId, error: err.message });
      }
    },
    has: async (kind, id) => kind === 'user' && (opts.teammates ?? []).includes(id),
    handled: async () => false,
  };
  const ctx: PhaseContext = {
    http,
    catalog: { stage: (s) => void out.stages.push(s), reason: (r) => void out.reasons.push(r), user: () => undefined },
    load,
    options,
    since: options.since ? new Date(options.since) : null,
    outOfTime: () => false,
    warn: (m) => void out.warnings.push(m),
  };
  async function run(id: string) {
    const phase = [...adapter.discover, ...adapter.load].find((p) => p.id === id)!;
    let cursor: Cursor | null = null;
    for (let step = 0; step < 50; step++) {
      cursor = await phase.run(ctx, cursor);
      if (cursor === null) return;
    }
    throw new Error(`Phase ${id} did not finish`);
  }
  return { ...out, run, calls, unmatched };
}

// Outcome stages: how SuccessFactors, SmartRecruiters and iCIMS show rejections and withdrawals.
const stageRow = (id: string, remoteId: string, name: string) => ({ ...meta(id, remoteId), name, job: null, stage_order: null, ...tail });
const S_NOT_SELECTED = stageRow('6d0f4b8a-2c7e-4a1d-9f3b-5e8c1a7d3b90', 'NOT_SELECTED', 'Not Selected');
const S_REJECTED = stageRow('1e5a9c3f-7b2d-4f6a-8c0e-4d2b6f0a8e13', 'REJECTED', 'REJECTED');
const S_WITHDRAWN = stageRow('7c3e1a5f-9d4b-4b8e-a2f6-0e4c8a2d6f57', 'WITHDRAWN', 'Withdrawn');
const S_ELSEWHERE = stageRow('3a7c1e5b-9f2d-4d6a-b8e0-2c4f6a8b0d79', '14', 'Hired Elsewhere');
const S_OTHER_REQ = stageRow('9f3b7d1a-5c8e-4e2b-a6d0-8b2f4c6e0a91', '15', 'Hired On Other Requisition');
const S_NOT_HIRED = stageRow('5b9d3f7a-1e6c-4c0a-8d4f-6a0e2b4d8f13', '16', 'Not Hired');
const OUTCOME_STAGES = [S_NOT_SELECTED, S_REJECTED, S_WITHDRAWN, S_ELSEWHERE, S_OTHER_REQ, S_NOT_HIRED];

/** An /applications row with every key present; integrations that lack a field send null. */
const appRow = (id: string, fields: Partial<AppFixture>): AppFixture => ({
  ...meta(id, `APP-${id.slice(0, 6)}`),
  candidate: JORDAN,
  job: JOB1,
  applied_at: '2026-04-01T09:00:00Z',
  rejected_at: null,
  offers: [],
  source: null,
  credited_to: null,
  screening_question_answers: [],
  current_stage: S_PHONE1.id,
  reject_reason: null,
  ...tail,
  ...fields,
});

// ---------- tests ----------

describe.skipIf(!hasDb)('merge adapter', () => {
  it('lists its phases without credentials', () => {
    const http = createHttpClient({ resolveHost: publicDns, auth: { hosts: [], headers: {} }, minIntervalMs: 0 });
    const adapter = mergeProvider.create({}, http);
    expect(adapter.discover.map((p) => p.id)).toEqual(['users', 'stages', 'reasons']);
    expect(adapter.load.map((p) => p.id)).toEqual(['jobs', 'candidates', 'applications', 'interviews', 'feedback', 'notes', 'offers', 'files']);
    expect(mergeProvider.auth(CREDS).hosts).toEqual(['api.merge.dev', 'api-eu.merge.dev', 'api-ap.merge.dev']);
  });

  it('verifies with the key and account token and names the linked account', async () => {
    const { impl, calls, unmatched } = mockFetch(mergeRoutes());
    await expect(verifyForTest(mergeProvider, CREDS, impl)).resolves.toEqual({
      accountName: 'Acme Robotics (SAP SuccessFactors via Merge)',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url.toString()).toBe('https://api.merge.dev/api/ats/v1/account-details');
    expect(calls[0].headers.authorization).toBe(`Bearer ${CREDS.apiKey}`);
    expect(calls[0].headers['x-account-token']).toBe(CREDS.accountToken);
    expect(unmatched).toEqual([]);
  });

  it('uses the region host, and explains a rejected key or a non-ATS token', async () => {
    const eu = mockFetch({ 'GET api-eu.merge.dev/api/ats/v1/account-details': () => json({ integration: 'Workday', end_user_organization_name: null, category: 'ats', status: 'COMPLETE' }) });
    // A pasted "Bearer " prefix is tolerated.
    await expect(verifyForTest(mergeProvider, { ...CREDS, region: 'eu', apiKey: `Bearer ${CREDS.apiKey}` }, eu.impl)).resolves.toEqual({ accountName: 'Workday' });
    expect(eu.calls[0].headers.authorization).toBe(`Bearer ${CREDS.apiKey}`);

    const rejected = mockFetch({ [`GET ${API}/account-details`]: () => json({ detail: 'Invalid Production Key.' }, { status: 401 }) });
    await expect(verifyForTest(mergeProvider, CREDS, rejected.impl)).rejects.toThrow(/rejected the API key.*region/);

    const hris = mockFetch({ [`GET ${API}/account-details`]: () => json({ integration: 'BambooHR', category: 'hris', status: 'COMPLETE' }) });
    await expect(verifyForTest(mergeProvider, CREDS, hris.impl)).rejects.toThrow(/HRIS integration, not an ATS/);

    const relink = mockFetch({ [`GET ${API}/account-details`]: () => json({ integration: 'iCIMS', category: 'ats', status: 'RELINK_NEEDED' }) });
    await expect(verifyForTest(mergeProvider, CREDS, relink.impl)).rejects.toThrow(/relinked/);
  });

  it('warns before discovery about an idle or test linked account and disabled Scopes', async () => {
    const h = phaseHarness(
      {
        [`GET ${API}/account-details`]: () => json({ ...ACCOUNT, status: 'IDLE', account_type: 'TEST', is_duplicate: null }),
        [`GET ${API}/sync-status`]: () => json({ next: null, previous: null, results: [] }),
        [`GET ${API}/linked-account-scopes`]: () =>
          json({
            common_models: [
              scope('Candidate', true, ['email_addresses', 'phone_numbers']),
              scope('Offer', false),
              scope('Attachment', false), // files are off for this import: not worth a warning
              scope('Activity'),
            ],
          }),
        [`GET ${API}/users`]: paged(() => [users]),
      },
      { options: { files: false } },
    );
    await h.run('users');
    expect(h.unmatched).toEqual([]);
    expect(h.warnings).toEqual([
      expect.stringMatching(/^Merge marks this linked account as idle.*Resync it/),
      expect.stringMatching(/^This is a Merge test linked account.*production linked account would add every record again/),
      expect.stringMatching(/^Merge's Scopes hide some fields of candidates .*\(email_addresses, phone_numbers\)/),
      expect.stringMatching(/^Merge's Scopes turn off reading offers .*Turn them on under Scopes/),
    ]);
  });

  it('classifies rejection reasons by name', async () => {
    const reason = (id: string, remoteId: string, name: string) => ({ ...meta(id, remoteId), name, ...tail });
    const reasons = [
      { ...REASON_EXPERIENCE },
      reason('8c3e1a7f-2b9d-4f6a-a5e8-0d4c7b2f1e93', 'RJ-011', 'Candidate withdrew'),
      reason('1a5c9e3b-7d2f-4b8a-9c6e-3f1d7b5a9c20', 'RJ-015', 'Declined offer'),
      reason('4e8a2c6f-0b3d-4d9e-a1f7-5c3e9a7b1d48', 'RJ-020', 'Duplicate application'),
      reason('6b0d4f8a-2c7e-4e1b-9d3f-5a9c1e7b3d06', 'RJ-021', 'Hired Elsewhere'),
      reason('2e6a0c4f-8d3b-4f7e-a1c5-9b3d7f1a5c68', 'RJ-022', 'Another candidate hired'),
      reason('9c3e7a1d-5f0b-4b8e-8a2c-6d0f4b8e2a91', 'RJ-023', 'Position filled - other candidate hired'),
      reason('0f4b8d2a-6e1c-4c5f-b9a3-7e1c5a9d3f24', 'RJ-024', 'Not hired'),
      reason('5a9d3f7b-1c6e-4a0d-8f2b-4c8e2a6d0f57', 'RJ-025', 'Accepted another offer'),
    ];
    const h = phaseHarness({ [`GET ${API}/reject-reasons`]: paged(() => [reasons]) });
    await h.run('reasons');
    expect(h.reasons.map((r) => [r.name, r.kind])).toEqual([
      ['Not enough relevant experience', 'rejection'],
      ['Candidate withdrew', 'withdrawn'],
      ['Declined offer', 'withdrawn'],
      ['Duplicate application', 'other'],
      ['Hired Elsewhere', 'withdrawn'],
      ['Another candidate hired', 'other'], // counts as a rejection, unlike a hire
      ['Position filled - other candidate hired', 'other'],
      ['Not hired', 'rejection'],
      ['Accepted another offer', 'withdrawn'],
    ]);
    expect(h.reasons[0].externalId).toBe(REASON_EXPERIENCE.id);
    expect(h.calls[0].url.searchParams.get('page_size')).toBe('100');
  });

  it('offers outcome stages as reasons to map, not as pipeline stages', async () => {
    const h = phaseHarness({ [`GET ${API}/job-interview-stages`]: paged(() => [[S_APPLIED, S_PHONE1, S_HIRED2, ...OUTCOME_STAGES]]) });
    await h.run('stages');
    expect(h.stages.map((s) => s.name)).toEqual(['Applied', 'Phone Screen', 'Hired']);
    expect(h.reasons.map((r) => [r.externalId, r.name, r.kind])).toEqual([
      [`stage:${S_NOT_SELECTED.id}`, 'Not Selected', 'rejection'],
      [`stage:${S_REJECTED.id}`, 'REJECTED', 'rejection'],
      [`stage:${S_WITHDRAWN.id}`, 'Withdrawn', 'withdrawn'],
      [`stage:${S_ELSEWHERE.id}`, 'Hired Elsewhere', 'withdrawn'],
      [`stage:${S_OTHER_REQ.id}`, 'Hired On Other Requisition', 'other'],
      [`stage:${S_NOT_HIRED.id}`, 'Not Hired', 'rejection'],
    ]);
  });

  it('derives status from offers, rejections and outcome stages, and picks a teammate as owner', async () => {
    const X = {
      notSelected: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
      rejected: '1b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e',
      withdrawn: '2c3d4e5f-6a7b-4c8d-ae9f-1a2b3c4d5e6f',
      elsewhere: '3d4e5f6a-7b8c-4d9e-bf0a-2b3c4d5e6f7a',
      otherReq: '4e5f6a7b-8c9d-4eaf-80b1-3c4d5e6f7a8b',
      notHired: '5f6a7b8c-9d0e-4fb0-91c2-4d5e6f7a8b9c',
      hiredStage: '6a7b8c9d-0e1f-40c1-a2d3-5e6f7a8b9c0d',
      signedNoStage: '7b8c9d0e-1f2a-41d2-b3e4-6f7a8b9c0d1e',
      closedJob: '8c9d0e1f-2a3b-42e3-84f5-7a8b9c0d1e2f',
    };
    const SIGNED = {
      ...meta('9d0e1f2a-3b4c-43f4-95a6-8b9c0d1e2f3a', 'OFR-4410'),
      application: X.signedNoStage,
      creator: DANA,
      remote_created_at: '2026-06-01T10:00:00Z',
      closed_at: '2026-06-15T17:00:00Z',
      sent_at: '2026-06-02T15:00:00Z',
      start_date: '2026-07-13T00:00:00Z',
      status: 'SIGNED',
      ...tail,
    };
    const rows = [
      appRow(X.notSelected, { current_stage: S_NOT_SELECTED.id }),
      appRow(X.rejected, { current_stage: S_REJECTED.id }),
      appRow(X.withdrawn, { current_stage: S_WITHDRAWN.id }),
      appRow(X.elsewhere, { current_stage: S_ELSEWHERE.id }),
      appRow(X.otherReq, { current_stage: S_OTHER_REQ.id }),
      appRow(X.notHired, { current_stage: S_NOT_HIRED.id, rejected_at: '2026-06-01T12:00:00Z', reject_reason: REASON_EXPERIENCE.id }),
      appRow(X.hiredStage, { current_stage: S_HIRED2.id }),
      appRow(X.signedNoStage, { current_stage: null, offers: [SIGNED.id] }),
      // Job 2 is CLOSED; its recruiter Lena isn't a teammate, the credited Dana is.
      appRow(X.closedJob, { job: JOB2, current_stage: S_PHONE2.id, credited_to: DANA }),
    ];
    const h = phaseHarness(
      {
        [`GET ${API}/applications`]: paged((url) => [
          expandApplications(url, rows, {
            candidates: candidateById,
            jobs: jobById,
            stages: new Map([...stages, ...OUTCOME_STAGES].map((s) => [s.id, s])),
            reasons: reasonById,
            offers: new Map([[SIGNED.id, SIGNED]]),
          }),
        ]),
      },
      { teammates: [DANA] },
    );
    await h.run('applications');
    expect(h.unmatched).toEqual([]);
    const app = (id: string) => h.applications.find((a) => a.externalId === id)!;
    const outcome = (id: string, stage: { id: string; name: string }) =>
      expect(app(id)).toMatchObject({
        status: 'archived',
        stage: null,
        archiveReason: { externalId: `stage:${stage.id}`, name: stage.name },
        history: [{ stage: {}, at: new Date('2026-04-01T09:00:00Z') }],
      });
    outcome(X.notSelected, S_NOT_SELECTED);
    outcome(X.rejected, S_REJECTED);
    outcome(X.withdrawn, S_WITHDRAWN);
    outcome(X.elsewhere, S_ELSEWHERE); // never a hire
    outcome(X.otherReq, S_OTHER_REQ);
    // An explicit rejection wins over the stage name, and keeps its reason.
    expect(app(X.notHired)).toMatchObject({
      status: 'archived',
      stage: null,
      archiveReason: { externalId: REASON_EXPERIENCE.id, name: 'Not enough relevant experience' },
      archivedAt: new Date('2026-06-01T12:00:00Z'),
    });
    expect(app(X.hiredStage)).toMatchObject({ status: 'hired', stage: { externalId: S_HIRED2.id, name: 'Hired' } });
    // A signed offer with no stage lands in Hired, entered when the offer closed.
    expect(app(X.signedNoStage)).toMatchObject({
      status: 'hired',
      stage: { name: 'Hired' },
      archivedAt: new Date('2026-06-15T17:00:00Z'),
      createdAt: new Date('2026-04-01T09:00:00Z'),
      history: [{ stage: { name: 'Hired' }, at: new Date('2026-06-15T17:00:00Z') }],
    });
    expect(app(X.closedJob)).toMatchObject({
      status: 'archived',
      archiveReason: null,
      archivedAt: new Date('2026-07-30T08:15:44Z'),
      ownerExternalUserId: DANA,
    });
    expect(app(X.notSelected).ownerExternalUserId).toBe(DANA); // job 1's recruiter
    expect(h.warnings).toEqual(['Archived applications that were still open on a closed or archived job (Merge has no application status)']);
  });

  it('keeps an undated application from bringing back a candidate the date filter left out', async () => {
    // iCIMS: no applied_at, and neither the candidate nor the job has a creation date.
    const ICIMS_CAND = { ...candidates[1], id: '4f8b2d6a-0e3c-4a7f-9b1d-5c9e3a7f1b46', remote_id: '5521', applications: [] };
    const ICIMS_JOB = { ...jobs[0], id: '8b2d6f0a-4c7e-4e1b-a5d9-3f7b1d5a9c68', remote_id: '1187', remote_created_at: null, remote_updated_at: null, recruiters: [] };
    const row = appRow('0c6e2a8f-4d1b-4f5a-9e3c-7b1d5f9a3e82', {
      candidate: ICIMS_CAND.id,
      job: ICIMS_JOB.id,
      applied_at: null,
      source: 'Indeed',
    });
    const routes = {
      [`GET ${API}/applications`]: paged((url) => [
        expandApplications(url, [row], { candidates: new Map([[ICIMS_CAND.id, ICIMS_CAND]]), jobs: new Map([[ICIMS_JOB.id, ICIMS_JOB]]), stages: stageById }),
      ]),
    };

    const filtered = phaseHarness(routes, { options: { since: '2026-01-01' } });
    await filtered.run('applications');
    expect(filtered.applications[0]).toMatchObject({ createdAt: null, history: [], candidate: null });
    expect(filtered.warnings).toEqual([
      "Some applications have no date in this ATS, so they're dated to the import and the 'added since' date couldn't be applied to them",
    ]);

    const all = phaseHarness(routes);
    await all.run('applications');
    expect(all.applications[0].candidate).toMatchObject({ externalId: ICIMS_CAND.id, name: 'Priya Raman' });
    expect(all.warnings).toEqual(["Some applications have no date in this ATS, so they're dated to the import"]);
  });

  it('dates scorecards, offers and notes from what the ATS does share', async () => {
    // Workday scorecards and offers, and a SuccessFactors note (Appendix B field coverage).
    const WD_INTERVIEW = {
      ...meta('b7d1f5a9-3c8e-4a2f-9e6b-1d5a9c3e7f40', 'INT-WD-88'),
      application: A1,
      job_interview_stage: null,
      organizer: null,
      interviewers: [MARCUS],
      location: null,
      start_at: '2026-08-20T15:00:00Z',
      end_at: '2026-08-20T16:00:00Z',
      remote_created_at: null,
      remote_updated_at: null,
      status: null,
      ...tail,
    };
    const WD_SCORECARD = {
      ...meta('e1a5c9f3-7d2b-4b6e-8f0a-3c7e1b5d9f62', 'SC-WD-88'),
      application: A1,
      interview: WD_INTERVIEW.id,
      interviewer: MARCUS,
      remote_created_at: null,
      submitted_at: null,
      overall_recommendation: 'YES',
      ...tail,
    };
    const WD_OFFER = {
      ...meta('f2b6d0a4-8e3c-4c7f-9a1b-4d8f2c6e0a73', 'OFR-WD-12'),
      application: A1,
      creator: null,
      remote_created_at: null,
      closed_at: null,
      sent_at: '2026-08-22T16:45:00Z',
      start_date: null,
      status: 'SENT',
      ...tail,
    };
    const SF_NOTE = {
      ...meta('a3c7e1b5-9d4f-4d8a-b0c2-5e9a3d7b1f84', 'NOTE-SF-301'),
      user: DANA,
      remote_created_at: null,
      activity_type: 'NOTE',
      subject: null,
      body: 'Called about relocation to Austin.',
      visibility: null,
      candidate: JORDAN,
      ...tail,
    };
    const h = phaseHarness({
      [`GET ${API}/scorecards`]: paged((url) => [
        [
          {
            ...WD_SCORECARD,
            interview: rel(url, 'interview', WD_SCORECARD.interview, new Map([[WD_INTERVIEW.id, WD_INTERVIEW]])),
            interviewer: rel(url, 'interviewer', WD_SCORECARD.interviewer, userById),
          },
        ],
      ]),
      [`GET ${API}/offers`]: paged(() => [[WD_OFFER]]),
      [`GET ${API}/activities`]: paged((url) => [[{ ...SF_NOTE, user: rel(url, 'user', SF_NOTE.user, userById) }]]),
    });
    await h.run('feedback');
    await h.run('offers');
    await h.run('notes');
    expect(h.unmatched).toEqual([]);
    expect(h.calls.find((c) => c.url.pathname.endsWith('/scorecards'))!.url.searchParams.get('expand')).toBe('interview,interviewer');
    expect(h.feedback[0]).toMatchObject({ interviewExternalId: WD_INTERVIEW.id, rating: 3, createdAt: new Date('2026-08-20T16:00:00Z') });
    expect(h.offers[0]).toMatchObject({ status: 'SENT', createdAt: new Date('2026-08-22T16:45:00Z') });
    expect(h.notes[0]).toMatchObject({ body: 'Called about relocation to Austin.', createdAt: null });
    expect(h.warnings).toEqual(["Some notes have no date in this ATS, so they're dated to the import"]);
  });

  it('treats a core model the ATS lacks as empty, but not a rejected key or a failed later page', async () => {
    const missing = phaseHarness({ [`GET ${API}/applications`]: () => json({ detail: 'Not found.' }, { status: 404 }) });
    await missing.run('applications');
    expect(missing.applications).toEqual([]);
    expect(missing.warnings).toEqual([
      expect.stringMatching(/^Merge doesn't provide applications for this ATS, so none were imported: GET api\.merge\.dev\/api\/ats\/v1\/applications → HTTP 404/),
    ]);

    const denied = phaseHarness({ [`GET ${API}/jobs`]: () => json({ detail: 'Invalid Production Key.' }, { status: 401 }) });
    await expect(denied.run('jobs')).rejects.toBeInstanceOf(ImportAuthError);

    const later = phaseHarness({
      [`GET ${API}/candidates`]: ({ url }) =>
        url.searchParams.get('cursor')
          ? json({ detail: 'Not found.' }, { status: 404 })
          : json({ next: cursorFor(1), previous: null, results: [candidates[3]] }),
    });
    await expect(later.run('candidates')).rejects.toThrow(/HTTP 404/);
  });

  it('stops refreshing attachment links that never download', async () => {
    // Vendor API links that need the ATS's own auth: every download and every refresh fails the same way.
    const dead = Array.from({ length: 12 }, (_, i) => {
      const n = String(i + 1).padStart(2, '0');
      return {
        ...meta(`c0ffee${n}-1a2b-4c3d-8e4f-5a6b7c8d9e0f`, `ATT-90${n}`),
        file_name: `Resume_${n}.pdf`,
        file_url: `https://${FILES}/vendor-api/attachments/90${n}`,
        candidate: JORDAN,
        attachment_type: 'RESUME',
        ...tail,
      };
    });
    const h = phaseHarness({
      // Two pages: the failure streak has to survive the step boundary.
      [`GET ${API}/attachments`]: paged(() => [dead.slice(0, 6), dead.slice(6)]),
      ...Object.fromEntries(dead.map((a) => [`GET ${API}/attachments/${a.id}`, () => json(a)])),
      ...Object.fromEntries(
        dead.map((a) => [`GET ${FILES}/vendor-api/attachments/${a.remote_id!.slice(4)}`, () => json({ error: 'unauthorized' }, { status: 401 })]),
      ),
    });
    await h.run('files');
    expect(h.unmatched).toEqual([]);
    expect(h.files).toHaveLength(10);
    expect(h.files.every((f) => f.error?.includes('HTTP 401'))).toBe(true);
    expect(h.calls.filter((c) => c.url.host === FILES)).toHaveLength(10);
    expect(h.calls.filter((c) => /\/attachments\/c0ffee/.test(c.url.pathname))).toHaveLength(10); // one refresh each, then none
    expect(h.warnings).toEqual(
      Array(2).fill(
        "Skipped the remaining attachments after 10 downloads in a row failed; this ATS's file links don't seem to download through Merge. Run the import again to retry them.",
      ),
    );
  });

  it('never refreshes a missing file, and never sends Merge credentials over plain HTTP', async () => {
    const GONE = {
      ...meta('d1e2f3a4-b5c6-4d7e-8f9a-0b1c2d3e4f5a', 'ATT-1001'),
      file_name: 'Old_Resume.pdf',
      file_url: `https://${FILES}/attachments/1001/Old_Resume.pdf?X-Amz-Expires=3600&X-Amz-Signature=abc`,
      candidate: JORDAN,
      attachment_type: 'RESUME',
      ...tail,
    };
    const PLAIN = {
      ...meta('e2f3a4b5-c6d7-4e8f-9a0b-1c2d3e4f5a6b', 'ATT-1002'),
      file_name: 'Portfolio.pdf',
      file_url: 'http://api.merge.dev/api/ats/v1/attachments/e2f3a4b5/download',
      candidate: JORDAN,
      attachment_type: 'OTHER',
      ...tail,
    };
    const FINE = {
      ...meta('f3a4b5c6-d7e8-4f9a-8b1c-2d3e4f5a6b7c', 'ATT-1003'),
      file_name: 'Cover_Letter.pdf',
      file_url: `https://${FILES}/attachments/1003/Cover_Letter.pdf`,
      candidate: JORDAN,
      attachment_type: 'COVER_LETTER',
      ...tail,
    };
    const h = phaseHarness({
      [`GET ${API}/attachments`]: paged(() => [[GONE, PLAIN, FINE]]),
      [`GET ${FILES}/attachments/1001/Old_Resume.pdf`]: () =>
        new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404, headers: { 'content-type': 'application/xml' } }),
      [`GET ${FILES}/attachments/1003/Cover_Letter.pdf`]: () => pdfResponse('Dear Acme Robotics'),
    });
    await h.run('files');
    expect(h.unmatched).toEqual([]);
    expect(h.files).toEqual([
      { externalId: GONE.id, error: expect.stringMatching(/HTTP 404/) },
      { externalId: PLAIN.id, error: expect.stringMatching(/not HTTPS/) },
      { externalId: FINE.id, error: null },
    ]);
    expect(h.calls.filter((c) => c.url.protocol === 'http:')).toEqual([]);
    expect(h.calls.map((c) => `${c.url.host}${c.url.pathname}`)).toEqual([
      `${API}/attachments`,
      `${FILES}/attachments/1001/Old_Resume.pdf`,
      `${FILES}/attachments/1003/Cover_Letter.pdf`,
    ]);
  });

  let orgId = '';

  it('imports a linked account end to end', async () => {
    const { impl, calls, unmatched } = mockFetch(mergeRoutes());
    const result = await runImportForTest({ module: mergeProvider, credentials: CREDS, fetchImpl: impl });
    orgId = result.orgId;
    expect(result.error).toBeNull();
    expect(result.status).toBe('SUCCEEDED');
    expect(unmatched).toEqual([]);

    // ----- what was created -----
    expect(result.view.created).toEqual({
      requisition: 2,
      posting: 3,
      contact: 4,
      opportunity: 5,
      interview: 1,
      feedback: 3,
      note: 2,
      offer: 2,
      file: 3,
    });

    // ----- review: per-job stages grouped by name; teammates matched by email -----
    const review = Object.fromEntries(result.review!.stages.map((s) => [s.key, s]));
    expect(Object.keys(review).sort()).toEqual(['applied', 'hired', 'offer', 'onsite', 'phone screen']);
    expect(review['phone screen'].count).toBe(2); // job 1's and job 2's "Phone Screen"
    expect(review['phone screen'].target).toHaveProperty('stageId');
    expect(review['offer'].target).toHaveProperty('stageId');
    expect(review['hired'].target).toHaveProperty('stageId');
    expect(review['applied'].target).toEqual({ create: { name: 'Applied', type: 'APPLICANT' } });
    expect(review['onsite'].target).toHaveProperty('stageId'); // Matches the org's existing "On-site" (punctuation doesn't matter), rather than a near-duplicate.
    expect(result.review!.reasons).toEqual([]); // Scope disabled → Merge sent nulls
    expect(result.review!.users).toMatchObject({ total: 3, matched: 1 });

    // ----- warnings: preflight, unlinkable records, derived statuses -----
    const issues = result.view.issues.map((i) => i.message);
    expect(issues).toContainEqual(expect.stringMatching(/^Merge's Scopes turn off reading rejection reasons for this linked account/));
    expect(issues).toContainEqual(expect.stringMatching(/first sync of applications/));
    expect(issues.some((m) => /EEOC/i.test(m))).toBe(false); // models we don't import stay quiet
    expect(issues).toContain('Skipped notes that Merge does not link to a candidate');
    expect(issues).toContainEqual(expect.stringMatching(/by name only, without a download link/));
    expect(issues).toContainEqual(expect.stringMatching(/private or admin-only/));
    expect(issues).toContain('Archived applications that were still open on a closed or archived job (Merge has no application status)');
    expect(issues.some((m) => /idle|test linked account|no date|no application date/.test(m))).toBe(false);
    for (const secret of [CREDS.apiKey, CREDS.accountToken]) expect(JSON.stringify(result.view.issues)).not.toContain(secret);

    // ----- requests: page size, expand, cursors, credentials -----
    const merge = calls.filter((c) => c.url.host === 'api.merge.dev');
    for (const c of merge) {
      expect(c.headers.authorization).toBe(`Bearer ${CREDS.apiKey}`);
      expect(c.headers['x-account-token']).toBe(CREDS.accountToken);
      expect(c.url.searchParams.has('created_after')).toBe(false); // Merge's own sync time, not the ATS's
    }
    expect(merge.filter((c) => c.url.pathname.endsWith('/linked-account-scopes'))).toHaveLength(1);
    const appCalls = merge.filter((c) => c.url.pathname.endsWith('/applications'));
    expect(appCalls.map((c) => c.url.searchParams.get('cursor'))).toEqual([null, cursorFor(1)]);
    for (const c of appCalls) {
      expect(c.url.searchParams.get('page_size')).toBe('50'); // every row repeats its job
      expect(c.url.searchParams.get('expand')).toBe(APPLICATION_EXPAND);
    }
    const candidateCalls = merge.filter((c) => c.url.pathname.endsWith('/candidates'));
    expect(candidateCalls.map((c) => c.url.searchParams.get('cursor'))).toEqual([null, cursorFor(1)]);
    expect(candidateCalls[0].url.searchParams.get('page_size')).toBe('100');
    expect(merge.filter((c) => c.url.pathname.endsWith(`/attachments/${ATT_EXPIRED}`))).toHaveLength(1);

    const fileCalls = calls.filter((c) => c.url.host === FILES);
    expect(fileCalls).toHaveLength(4); // resume, cover letter, expired CV, refreshed CV
    for (const c of fileCalls) {
      expect(c.headers.authorization).toBeUndefined();
      expect(c.headers['x-account-token']).toBeUndefined();
      expect(c.url.toString()).not.toContain(CREDS.apiKey);
      expect(c.url.toString()).not.toContain(CREDS.accountToken);
    }

    // ----- jobs → requisitions + postings -----
    const postings = await db.posting.findMany({ where: { orgId }, include: { department: true, requisition: true } });
    const byTitle = Object.fromEntries(postings.map((p) => [p.title, p]));
    const backend = byTitle['Senior Backend Engineer'];
    expect(backend).toMatchObject({
      state: 'DRAFT',
      location: '500 W 2nd St, Austin, TX 78701, United States',
      workplaceType: 'HYBRID', // Austin HQ + Remote - US
      commitment: 'FULL_TIME',
    });
    expect(backend.department!.name).toBe('Engineering');
    expect(backend.requisition).toMatchObject({ code: 'REQ-2026-0142', state: 'OPEN' });
    expect(backend.createdAt.toISOString()).toBe('2026-06-02T17:45:31.000Z');
    expect((backend.content as { description: string }).description).toContain('About the role');
    expect((backend.content as { description: string }).description).toContain('• 5+ years building distributed systems');
    expect(byTitle['Solutions Architect']).toMatchObject({ state: 'CLOSED' });
    expect(byTitle['Solutions Architect'].requisition).toMatchObject({ code: 'REQ-2026-0098', state: 'CLOSED' });
    const intern = byTitle['Warehouse Robotics Intern (Summer 2027)'];
    expect(intern).toMatchObject({ state: 'DRAFT', workplaceType: 'REMOTE', commitment: 'INTERNSHIP', requisitionId: null });
    expect((intern.content as { description: string }).description).toBe('Spend the summer tuning pick paths on real robots.');

    // ----- candidates -----
    const contacts = await db.contact.findMany({ where: { orgId } });
    const contact = (name: string) => contacts.find((c) => c.name === name)!;
    expect(contacts.map((c) => c.name).sort()).toEqual(['Casey Lin', 'Jordan Alvarez', 'Priya Raman', 'Sam Okafor']);
    expect(contact('Jordan Alvarez')).toMatchObject({
      emails: ['jordan.alvarez@example.com', 'jalvarez@northwind.example'],
      phones: ['+15125550148'],
      links: ['https://www.linkedin.com/in/jordan-alvarez-dev', 'https://github.com/jalvarez'],
      tags: ['Silver Medalist', 'Distributed Systems'],
      headline: 'Staff Software Engineer at Northwind Logistics',
      location: 'Austin, TX, United States',
    });
    expect(contact('Jordan Alvarez').createdAt.toISOString()).toBe('2025-11-04T16:22:09.000Z');
    // No remote_created_at: the earliest expanded application's applied_at.
    expect(contact('Priya Raman').createdAt.toISOString()).toBe('2026-01-15T15:00:00.000Z');

    // ----- applications -----
    const opps = await db.opportunity.findMany({
      where: { orgId },
      include: {
        stage: true,
        archiveReason: true,
        posting: true,
        stageTransitions: { include: { toStage: true }, orderBy: { occurredAt: 'asc' } },
      },
    });
    const opp = (id: string) => opps.find((o) => importedId(o) === id)!;

    const a1 = opp(A1);
    expect(a1).toMatchObject({ status: 'ACTIVE', origin: 'REFERRED', source: 'Employee Referral', ownerId: result.adminId, confidential: false });
    expect(a1.stage.name).toBe('Offer');
    expect(a1.posting!.title).toBe('Senior Backend Engineer');
    expect(a1.createdAt.toISOString()).toBe('2026-07-08T13:15:00.000Z');
    expect(a1.stageTransitions.map((t) => [t.fromStageId, t.toStage.name, t.occurredAt.toISOString()])).toEqual([
      [null, 'Offer', '2026-07-08T13:15:00.000Z'],
    ]);
    expect(a1.stageChangedAt.toISOString()).toBe('2026-07-08T13:15:00.000Z');
    expect(a1.customFields).toMatchObject({ imported: { provider: 'merge', id: A1 } });
    expect(importedFields(a1)).toEqual({
      visa_status: 'H-1B transfer',
      remote_id: 'APP-552910',
      'Work authorization': 'Yes, without sponsorship', // screening answer, titled by its expanded question
    });

    const a2 = opp(A2);
    expect(a2).toMatchObject({ status: 'ARCHIVED', origin: 'APPLIED', source: 'LinkedIn' });
    expect(a2.archiveReason).toMatchObject({ name: 'Not enough relevant experience', countsAsRejection: true });
    expect(a2.archivedAt!.toISOString()).toBe('2026-03-05T16:00:00.000Z');
    expect(a2.stage.name).toBe('Applied');
    expect(a2.posting!.state).toBe('CLOSED');

    const a3 = opp(A3);
    expect(a3).toMatchObject({ status: 'HIRED', origin: 'AGENCY', archiveReasonId: null, ownerId: result.adminId });
    expect(a3.stage.name).toBe('Hired');
    expect(a3.archivedAt).toBeNull();
    expect(a3.stageChangedAt.toISOString()).toBe('2026-06-01T18:00:00.000Z'); // the signed offer's closed_at
    // Entered Hired when the offer was signed, so days-to-hire is real rather than 0.
    expect(a3.createdAt.toISOString()).toBe('2026-03-02T11:20:00.000Z');
    expect(a3.stageChangedAt.toISOString()).toBe('2026-06-01T18:00:00.000Z');
    expect(a3.stageTransitions.map((t) => [t.toStage.name, t.occurredAt.toISOString()])).toEqual([['Hired', '2026-06-01T18:00:00.000Z']]);

    const a4 = opp(A4);
    expect(a4).toMatchObject({ status: 'ACTIVE', origin: 'SOURCED', confidential: true, ownerId: result.adminId }); // is_private candidate
    expect(a4.stage.name).toBe('Phone screen'); // mapped onto the org's existing stage
    expect(importedFields(a4)).toEqual({ remote_id: 'APP-548812' }); // an answer with no question title is skipped

    const a5 = opp(A5);
    expect(a5).toMatchObject({ status: 'ARCHIVED', archiveReasonId: null, origin: 'APPLIED' });
    expect(a5.archivedAt!.toISOString()).toBe('2026-07-30T08:15:44.000Z'); // the closed job's last update

    // ----- notes, scorecards, interviews -----
    const [interview] = await db.interview.findMany({ where: { orgId }, include: { panelists: true } });
    expect(interview).toMatchObject({ title: 'Onsite', durationMins: 150, state: 'COMPLETED', location: 'Austin HQ – Room 4B (Pecan)', opportunityId: a1.id });
    expect(interview.startAt.toISOString()).toBe('2026-08-14T15:00:00.000Z');
    expect(interview.panelists.map((p) => p.id)).toEqual([result.adminId]); // only Dana matches a teammate

    const byline = (name: string) => `[${result.view.providerName} · ${name}] `;
    const feedback = await db.feedbackSubmission.findMany({ where: { orgId }, orderBy: { overallRating: 'desc' } });
    expect(feedback.map((f) => [f.overallRating, f.summary])).toEqual([
      [4, `${byline('Lena Fischer')}Overall recommendation: Strong yes`],
      [1, 'Overall recommendation: Definitely no'],
    ]);
    expect(feedback[0]).toMatchObject({ opportunityId: a1.id, interviewId: interview.id, authorId: result.adminId });
    expect(feedback[0].createdAt.toISOString()).toBe('2026-08-14T21:30:47.000Z');
    expect(feedback[1].opportunityId).toBe(a4.id);
    const scorecardCall = merge.find((c) => c.url.pathname.endsWith('/scorecards'))!;
    expect(scorecardCall.url.searchParams.get('expand')).toBe('interview,interviewer');

    const notes = await db.note.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' } });
    const noteBodies = notes.map((n) => n.body);
    expect(noteBodies).toContain('Recruiter screen\n\nStrong on Kafka + Go. Wants hybrid in Austin. Comp expectation < $220k base.');
    expect(noteBodies).toContain(
      `${byline('Marcus Oyelaran')}[Email] Next steps with Acme Robotics\n\nHi Jordan,\n\nThanks for your time yesterday — we'd love to bring you onsite.`,
    );
    expect(noteBodies).toContain(`${byline('Marcus Oyelaran')}Scorecard submitted with no overall recommendation`);
    expect(noteBodies).toContainEqual(expect.stringMatching(/^\[[^\]]+\] Attachment: Jordan_Alvarez_Cover_Letter\.pdf — \/api\/files\//));
    const screen = notes.find((n) => n.body.startsWith('Recruiter screen'))!;
    expect(screen).toMatchObject({ opportunityId: a1.id, authorId: result.adminId }); // latest application
    expect(screen.createdAt.toISOString()).toBe('2026-07-10T19:22:41.000Z');

    // ----- offers -----
    const offerRows = await db.offer.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' } });
    expect(offerRows).toHaveLength(2);
    const [signed, sent] = offerRows;
    expect(signed).toMatchObject({ status: 'ACCEPTED', jobTitle: 'Solutions Architect', opportunityId: a3.id, salaryAmount: null });
    expect(signed.respondedAt!.toISOString()).toBe('2026-06-01T18:00:00.000Z');
    expect(sent).toMatchObject({ status: 'SENT', jobTitle: 'Senior Backend Engineer', opportunityId: a1.id, respondedAt: null });
    expect(sent.sentAt!.toISOString()).toBe('2026-08-22T16:45:00.000Z');
    expect(sent.startDate!.toISOString()).toBe('2026-10-19T00:00:00.000Z');
    expect(sent.createdAt.toISOString()).toBe('2026-08-20T14:10:00.000Z');

    // ----- resumes -----
    const jordan = await db.contact.findFirstOrThrow({ where: { orgId, name: 'Jordan Alvarez' }, include: { resumeFile: true } });
    expect(jordan.resumeFile).toMatchObject({ filename: 'Jordan_Alvarez_Resume_2026.pdf', mime: 'application/pdf' });
    expect(jordan.resumeText).toContain('Jordan Alvarez');
    const sam = await db.contact.findFirstOrThrow({ where: { orgId, name: 'Sam Okafor' }, include: { resumeFile: true } });
    expect(sam.resumeFile).toMatchObject({ filename: 'Sam_Okafor_CV.pdf' }); // refreshed link, typed by name
    expect(contact('Priya Raman').resumeFileId).toBeNull();
  });

  it('re-running into the same org creates nothing new and downloads nothing', async () => {
    expect(orgId).not.toBe('');
    const { impl, calls, unmatched } = mockFetch(mergeRoutes());
    const again = await runImportForTest({ module: mergeProvider, credentials: CREDS, fetchImpl: impl, orgId });
    expect(again.status).toBe('SUCCEEDED');
    expect(unmatched).toEqual([]);
    expect(again.view.created).toEqual({});
    expect(again.review!.stages.every((s) => 'stageId' in s.target)).toBe(true); // remembers the first run's stages
    expect(calls.filter((c) => c.url.host === FILES)).toEqual([]);
    expect(await db.opportunity.count({ where: { orgId } })).toBe(5);
    expect(await db.contact.count({ where: { orgId } })).toBe(4);
  });

  it('dates applications from the candidate or job when the ATS shares no applied_at, and applies the since date', async () => {
    // SmartRecruiters: /applications has no applied_at; candidates and jobs do have remote_created_at.
    const SR_STAGE = stageRow('6f0b4d8a-2e7c-4c1f-9a5d-3b7e1f5c9a02', 'INTERVIEW', 'Interview');
    const srJob = (id: string, name: string, createdAt: string | null) => ({
      ...meta(id, id.slice(0, 8)),
      name,
      description: `<p>${name}, Acme Robotics.</p>`,
      code: null,
      status: 'OPEN',
      type: null,
      job_postings: [],
      job_posting_urls: [],
      remote_created_at: createdAt,
      remote_updated_at: createdAt,
      confidential: false,
      departments: [],
      offices: [],
      hiring_managers: [],
      recruiters: [DANA],
      ...tail,
    });
    const OLD_JOB = srJob('2a6e0c4f-8b3d-4a7e-9f1c-6d0b4e8a2c53', 'Warehouse Technician', '2019-02-01T09:00:00Z');
    const NEW_JOB = srJob('7e1a5c9f-3d8b-4b2e-8c6a-0f4d8b2e6a17', 'Fleet Reliability Engineer', '2026-02-10T09:00:00Z');
    const UNDATED_JOB = srJob('4c8e2a6f-0d9b-4f3e-a7c1-2b6f0d4a8e39', 'Robotics Field Technician', null);
    const srJobs = [OLD_JOB, NEW_JOB, UNDATED_JOB];

    const VETERAN = '1d5f9b3e-7a2c-4e6f-8b0d-4c8a2e6f0b35';
    const NEWBIE = '8f2b6d0a-4e9c-4a3f-b7d1-5e9b3f7a1c46';
    const NODATE = '3b7f1d5a-9e4c-4c8b-a2f6-7d1b5f9c3e57';
    const srApp = (id: string, candidate: string, job: string): AppFixture => ({
      ...meta(id, id.slice(0, 8)),
      candidate,
      job,
      applied_at: null,
      rejected_at: null,
      offers: [],
      source: 'LinkedIn',
      credited_to: null,
      screening_question_answers: [],
      current_stage: SR_STAGE.id,
      reject_reason: null,
      ...tail,
    });
    const OLD_TO_OLD = srApp('0e4a8c2f-6b1d-4f5e-9a3c-8d2f6b0e4a61', VETERAN, OLD_JOB.id);
    const OLD_TO_NEW = srApp('5c9e3b7f-1a4d-4d8c-b2e6-9f3b7d1c5e72', VETERAN, NEW_JOB.id);
    const NEW_TO_OLD = srApp('9a3e7c1b-5f0d-4b4a-8c6e-0d4a8e2b6f83', NEWBIE, OLD_JOB.id);
    const UNDATED = srApp('6e0c4a8f-2d7b-4e1c-a5f9-1b5d9f3a7c94', NODATE, UNDATED_JOB.id);
    const srApps = [OLD_TO_OLD, OLD_TO_NEW, NEW_TO_OLD, UNDATED];

    const srCandidate = (id: string, first: string, last: string, createdAt: string | null, apps: string[]) => ({
      ...meta(id, id.slice(0, 8)),
      first_name: first,
      last_name: last,
      company: null,
      title: null,
      remote_created_at: createdAt,
      remote_updated_at: createdAt,
      last_interaction_at: null,
      is_private: null,
      can_email: null,
      locations: [],
      phone_numbers: [],
      email_addresses: [{ value: `${first}.${last}@example.com`.toLowerCase(), email_address_type: null }],
      urls: [],
      tags: [],
      applications: apps,
      attachments: [],
      ...tail,
    });
    const srCandidates = [
      srCandidate(VETERAN, 'Rosa', 'Delgado', '2019-05-01T10:00:00Z', [OLD_TO_OLD.id, OLD_TO_NEW.id]),
      srCandidate(NEWBIE, 'Theo', 'Nakamura', '2026-03-01T10:00:00Z', [NEW_TO_OLD.id]),
      srCandidate(NODATE, 'Ada', 'Okonkwo', null, [UNDATED.id]),
    ];
    const appById = new Map(srApps.map((a) => [a.id, a]));

    const { impl, unmatched } = mockFetch({
      [`GET ${API}/account-details`]: () => json({ ...ACCOUNT, id: '5e9a3c7f-1b4d-4f8a-a2c6-9d3f7b1e5a28', integration: 'SmartRecruiters', integration_slug: 'smartrecruiters' }),
      [`GET ${API}/sync-status`]: () => json({ next: null, previous: null, results: [] }),
      [`GET ${API}/linked-account-scopes`]: () => json({ common_models: [scope('Candidate'), scope('Application'), scope('Job')] }),
      [`GET ${API}/users`]: paged(() => [[users[0]]]),
      [`GET ${API}/job-interview-stages`]: paged(() => [[SR_STAGE]]),
      [`GET ${API}/reject-reasons`]: paged(() => [[]]), // not supported for SmartRecruiters: an empty list
      [`GET ${API}/jobs`]: paged(() => [srJobs]),
      [`GET ${API}/candidates`]: paged((url) => [
        srCandidates.map((c) => ({ ...c, applications: c.applications.map((id) => rel(url, 'applications', id, appById)) })),
      ]),
      [`GET ${API}/applications`]: paged((url) => [
        expandApplications(url, srApps, {
          candidates: new Map(srCandidates.map((c) => [c.id, c])),
          jobs: new Map(srJobs.map((j) => [j.id, j])),
          stages: new Map([[SR_STAGE.id, SR_STAGE]]),
        }),
      ]),
    });
    const started = new Date();
    const result = await runImportForTest({
      module: mergeProvider,
      credentials: CREDS,
      fetchImpl: impl,
      options: { since: '2026-01-01', activity: false, offers: false, files: false },
    });
    expect(result.error).toBeNull();
    expect(unmatched).toEqual([]);
    expect(result.view.created).toEqual({ posting: 3, contact: 3, opportunity: 3 });
    // Rosa (2019) is left out as a candidate and her application to the 2019 job with her;
    // her application to the 2026 job can't predate 2026-02-10, so it brings her back.
    expect(result.view.stats).toMatchObject({ 'contact.beforeSince': 1, 'opportunity.beforeSince': 1 });

    const contacts = await db.contact.findMany({ where: { orgId: result.orgId } });
    expect(contacts.map((c) => c.name).sort()).toEqual(['Ada Okonkwo', 'Rosa Delgado', 'Theo Nakamura']);
    expect(contacts.find((c) => c.name === 'Rosa Delgado')!.createdAt.toISOString()).toBe('2019-05-01T10:00:00.000Z');

    const opps = await db.opportunity.findMany({
      where: { orgId: result.orgId },
      include: { stageTransitions: { include: { toStage: true } } },
    });
    const opp = (id: string) => opps.find((o) => importedId(o) === id);
    expect(opp(OLD_TO_OLD.id)).toBeUndefined();
    const toNew = opp(OLD_TO_NEW.id)!;
    expect(toNew.createdAt.toISOString()).toBe('2026-02-10T09:00:00.000Z'); // the job's creation
    expect(toNew.stageChangedAt.toISOString()).toBe('2026-02-10T09:00:00.000Z');
    expect(toNew.stageTransitions.map((t) => [t.toStage.name, t.occurredAt.toISOString()])).toEqual([['Interview', '2026-02-10T09:00:00.000Z']]);
    expect(opp(NEW_TO_OLD.id)!.createdAt.toISOString()).toBe('2026-03-01T10:00:00.000Z'); // the candidate's creation
    const undatedOpp = opp(UNDATED.id)!;
    expect(undatedOpp.stageTransitions.map((t) => t.toStageId)).toEqual([undatedOpp.stageId]); // one, for the funnel
    expect(undatedOpp.createdAt.getTime()).toBeGreaterThanOrEqual(started.getTime() - 1000);

    const count = (pattern: RegExp) => result.view.issues.find((i) => pattern.test(i.message))?.count;
    expect(count(/^Some applications have no application date in this ATS, so they're dated from when the candidate or job was added\. The 'added since' date was checked against that/)).toBe(3);
    expect(count(/^Some applications have no date in this ATS, so they're dated to the import and the 'added since' date couldn't be applied/)).toBe(1);
    expect(count(/^Some candidates have no date in this ATS, so they're dated to the import and the 'added since' date couldn't be applied/)).toBe(1);
  });
});
