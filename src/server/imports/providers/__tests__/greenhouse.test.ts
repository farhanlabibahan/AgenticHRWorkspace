import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/session', () => ({ isAdmin: () => true }));

import { providerMeta } from '@/lib/import-providers';
import { createHttpClient, ImportAuthError, ImportHttpError } from '@/server/imports/http';
import { catalogWriter, emptyCatalog } from '@/server/imports/mapping';
import {
  db,
  json,
  mockFetch,
  runImportForTest,
  verifyForTest,
  type RouteHandler,
} from '@/server/imports/__tests__/harness';
import { hasDb, publicDns } from '@/server/imports/__tests__/harness';
import { greenhouseProvider } from '@/server/imports/providers/greenhouse';
import {
  DEFAULT_IMPORT_OPTIONS,
  type Credentials,
  type Cursor,
  type DownloadedFile,
  type ImportedApplication,
  type ImportedFile,
  type ImportedInterview,
  type ImportedPosting,
  type ImportedRequisition,
  type ImportOptions,
  type Loader,
  type Phase,
  type PhaseContext,
  type ProviderAdapter,
  type RefKind,
} from '@/server/imports/types';

/**
 * Greenhouse Harvest v3 adapter against a mock of the v3 API built from the
 * documented payloads: OAuth client-credentials tokens (JWTs), bare-array
 * list responses, Link rel="next" keyset cursors, 50-id filters, and signed
 * attachment URLs on S3 that expire.
 */

const CREDENTIALS = { clientId: 's5D99Sk7QniWKDwqyhDTH4rLDn6Lv3V9YKVe-4', clientSecret: 'gh-secret-7f3c9a1e5b2d4086' };
const BASIC = `Basic ${Buffer.from(`${CREDENTIALS.clientId}:${CREDENTIALS.clientSecret}`).toString('base64')}`;
const ORG_NAME = 'Business & Corporation (Business Corporation)';
const BYLINE = providerMeta('greenhouse')?.name ?? 'greenhouse';

const API = 'harvest.greenhouse.io';
const S3 = 'grnhse-use1-prod-s1-ghr.s3.us-east-1.amazonaws.com';
const s3Url = (path: string, sig: string) =>
  `https://${S3}${path}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAEXAMPLE%2F20260923%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20260923T170000Z&X-Amz-Expires=604800&X-Amz-SignedHeaders=host&X-Amz-Signature=${sig}`;

// ---------- Fixtures (shapes from the Harvest v3 reference) ----------

type Row = { id: number; [key: string]: unknown };
const T0 = { created_at: '2021-01-05T00:00:00.000Z', updated_at: '2021-01-05T00:00:00.000Z' };

const USERS: Row[] = [
  // Priya is the Source admin running the import: matched by email.
  { id: 4455100011, first_name: 'Priya', last_name: 'Raman', name: 'Priya Raman', primary_email: 'admin@example.test', emails: ['admin@example.test', 'priya@acme.example'], job_title: 'Senior Technical Recruiter', agency_id: null, deactivated: false, site_admin: true, employee_id: 'E-10442', linked_candidate_ids: [], office_ids: [4455090001], department_ids: [4455080002], interviewer_tags: [{ id: 4455095001, name: 'Bar Raiser' }], custom_fields: { select_custom_field: { name: 'Select custom field', type: 'single_select', value: null } }, created_at: '2022-03-14T15:02:11.000Z', updated_at: '2026-08-30T09:41:27.512Z' },
  { id: 4455100012, first_name: 'Marcus', last_name: 'Oyelaran', name: 'Marcus Oyelaran', primary_email: 'marcus.oyelaran@acme.example', emails: ['marcus.oyelaran@acme.example'], job_title: 'Engineering Manager', agency_id: null, deactivated: true, site_admin: false, employee_id: null, linked_candidate_ids: [4455120007], office_ids: [], department_ids: [4455080002], interviewer_tags: [], custom_fields: {}, created_at: '2021-11-02T18:20:00.000Z', updated_at: '2025-06-01T12:00:00.000Z' },
  { id: 4455100013, first_name: 'Sam', last_name: 'Okafor', name: 'Sam Okafor', primary_email: 'sam.okafor@acme.example', emails: ['sam.okafor@acme.example'], job_title: 'Recruiting Coordinator', agency_id: null, deactivated: false, site_admin: false, employee_id: null, linked_candidate_ids: [], office_ids: [4455090001], department_ids: [], interviewer_tags: [], custom_fields: {}, created_at: '2023-02-01T10:00:00.000Z', updated_at: '2023-02-01T10:00:00.000Z' },
  // Integration service user: hidden unless show_service_accounts=true.
  { id: 4455100099, first_name: 'Source', last_name: 'Importer', name: 'Source Importer', primary_email: '', emails: [], job_title: null, agency_id: null, deactivated: false, site_admin: true, employee_id: null, linked_candidate_ids: [], office_ids: [], department_ids: [], interviewer_tags: [], custom_fields: {}, created_at: '2026-09-23T09:00:00.000Z', updated_at: '2026-09-23T09:00:00.000Z' },
];

const stage = (id: number, jobId: number, name: string, sortOrder: number): Row => ({
  id, job_id: jobId, name, sort_order: sortOrder, active: true, created_at: '2025-01-10T15:00:00.000Z', updated_at: '2025-01-10T15:00:00.000Z',
});
const JOB_INTERVIEW_STAGES: Row[] = [
  stage(4455300001, 4455200001, 'Application Review', 0),
  stage(4455300002, 4455200001, 'Recruiter Phone Screen', 1),
  stage(4455300003, 4455200001, 'Technical Interview', 2),
  stage(4455300004, 4455200001, 'Onsite', 3),
  stage(4455300005, 4455200001, 'Offer', 4),
  stage(4455300011, 4455200002, 'Application Review', 0),
  stage(4455300012, 4455200002, 'Portfolio Review', 1),
  stage(4455300013, 4455200002, 'Onsite', 2),
  stage(4455300014, 4455200002, 'Offer', 3),
];

const DEFAULT_REASONS = new Set([4455400002]);
const REJECTION_REASONS: Row[] = [
  { id: 4455400001, name: 'Lacking skill(s)/qualification(s)', type: { id: 2, key: 'WE_REJECTED_THEM', name: 'We rejected them' }, ...T0 },
  { id: 4455400002, name: 'Took another offer', type: { id: 3, key: 'THEY_REJECTED_US', name: 'They rejected us' }, ...T0 },
  { id: 4455400003, name: 'Spam', type: { id: 4, key: 'NONE_SPECIFIED', name: 'None specified' }, created_at: '2023-07-19T00:00:00.000Z', updated_at: '2023-07-19T00:00:00.000Z' },
  // One name under two types: they must not merge into a single Source reason.
  { id: 4455400004, name: 'Other (add notes below)', type: { id: 2, key: 'WE_REJECTED_THEM', name: 'We rejected them' }, ...T0 },
  { id: 4455400005, name: 'Other (add notes below)', type: { id: 3, key: 'THEY_REJECTED_US', name: 'They rejected us' }, ...T0 },
];

const JOBS: Row[] = [
  { id: 4455200001, name: 'Senior Backend Engineer', requisition_id: 'REQ-2026-014', notes: '<p>Backfill for Dana. Focus on payments infra.</p>', confidential: false, status: 'open', is_template: false, copied_from_id: 4455200000, opened_at: '2026-01-12T16:00:00.000Z', closed_at: null, department_id: 4455080002, office_ids: [4455090001, 4455090002], custom_fields: { employment_type: { name: 'Employment Type', type: 'single_select', value: 'Full-time' }, salary_range: { name: 'Salary Range', type: 'currency_range', value: { min_value: 180000, max_value: 220000, unit: 'USD' } } }, created_at: '2026-01-10T15:00:00.000Z', updated_at: '2026-09-01T08:12:45.000Z' },
  // v3 write shape for currency ranges, which reads may mirror.
  { id: 4455200002, name: 'Product Designer', requisition_id: null, notes: null, confidential: true, status: 'closed', is_template: false, copied_from_id: null, opened_at: '2025-09-01T16:00:00.000Z', closed_at: '2026-06-01T12:00:00.000Z', department_id: 4455080003, office_ids: [4455090001], custom_fields: { employment_type: { name: 'Employment Type', type: 'single_select', value: 'Contract' }, salary_range: { name: 'Salary Range', type: 'currency_range', value: { min_amount: 140000, max_amount: 165000, currency_code: 'EUR' } } }, created_at: '2025-08-20T12:00:00.000Z', updated_at: '2026-06-01T12:00:00.000Z' },
  { id: 4455200000, name: 'Backend Engineer (template)', requisition_id: null, notes: null, confidential: false, status: 'draft', is_template: true, copied_from_id: null, opened_at: null, closed_at: null, department_id: 4455080002, office_ids: [], custom_fields: {}, created_at: '2024-01-10T15:00:00.000Z', updated_at: '2024-01-10T15:00:00.000Z' },
];

const DEPARTMENTS: Row[] = [
  { id: 4455080001, name: 'Engineering', external_id: 'ENG', parent_id: null, created_at: '2021-01-05T00:00:00.000Z', updated_at: '2024-02-10T11:00:00.000Z' },
  { id: 4455080002, name: 'Platform Engineering', external_id: null, parent_id: 4455080001, created_at: '2022-06-01T00:00:00.000Z', updated_at: '2022-06-01T00:00:00.000Z' },
  { id: 4455080003, name: 'Design', external_id: null, parent_id: null, created_at: '2022-06-01T00:00:00.000Z', updated_at: '2022-06-01T00:00:00.000Z' },
];
const OFFICES: Row[] = [
  { id: 4455090001, name: 'San Francisco', external_id: null, location: 'San Francisco, CA, USA', parent_id: null, primary_in_house_contact_user_id: 4455100011, ...T0 },
  { id: 4455090002, name: 'Remote (US)', external_id: null, location: null, parent_id: null, primary_in_house_contact_user_id: null, created_at: '2022-01-10T00:00:00.000Z', updated_at: '2022-01-10T00:00:00.000Z' },
];

const OPENINGS: Row[] = [
  { id: 4455270001, job_id: 4455200001, opening_id: 'REQ-2026-014-1', open: false, opened_at: '2026-01-12T16:00:00.000Z', closed_at: '2026-06-20T14:03:00.000Z', close_reason_id: 4455420001, application_id: 4455500003, target_start_on: '2026-07-13', sort_order: 0, custom_fields: {}, created_at: '2026-01-10T15:00:00.000Z', updated_at: '2026-06-20T14:03:00.000Z' },
  { id: 4455270002, job_id: 4455200001, opening_id: 'REQ-2026-014-2', open: true, opened_at: '2026-01-12T16:00:00.000Z', closed_at: null, close_reason_id: null, application_id: null, target_start_on: null, sort_order: 1, custom_fields: {}, created_at: '2026-01-10T15:00:00.000Z', updated_at: '2026-01-10T15:00:00.000Z' },
  { id: 4455270003, job_id: 4455200002, opening_id: null, open: false, opened_at: '2025-09-01T16:00:00.000Z', closed_at: '2026-06-01T12:00:00.000Z', close_reason_id: 4455420002, application_id: null, target_start_on: null, sort_order: 0, custom_fields: {}, created_at: '2025-08-20T12:00:00.000Z', updated_at: '2026-06-01T12:00:00.000Z' },
];

const post = (id: number, jobId: number, title: string, flags: { internal: boolean; active: boolean; live: boolean }, content: string): Row => ({
  id, job_id: jobId, job_board_id: 4455220001, title, language: 'en', ...flags, featured: false,
  first_published_at: '2026-01-12T16:05:00.000Z', public_url: `https://job-boards.greenhouse.io/acme/jobs/${id}?gh_jid=${id}`,
  demographic_question_set_id: null, content, questions: [], created_at: '2026-01-10T15:10:00.000Z', updated_at: '2026-06-30T12:00:00.000Z',
});
const JOB_POSTS: Row[] = [
  post(4455210001, 4455200001, 'Senior Backend Engineer, Payments', { internal: false, active: true, live: true }, "<p><strong>About Acme</strong></p><p>We build payments infrastructure...</p><h3>What you'll do</h3><ul><li>Own the ledger service</li></ul>"),
  post(4455210002, 4455200001, 'Senior Backend Engineer (internal transfer)', { internal: true, active: true, live: true }, '<p>Internal applicants only.</p>'),
  // Closed job whose only post was soft-deleted: hidden unless active=false.
  post(4455210003, 4455200002, 'Product Designer', { internal: false, active: false, live: false }, '<p>Design the future of payments.</p><ul><li>Own our design system</li></ul>'),
];

const postLocation = (id: number, fields: Partial<Row>): Row => ({
  id, job_post_id: 4455210001, type: 'free_text', plain_text_location: null, office_id: null, custom_location_id: null,
  created_at: '2026-01-10T15:10:00.000Z', updated_at: '2026-01-10T15:10:00.000Z', ...fields,
});
// Where the post says the job is, which is not where the job's offices are.
const JOB_POST_LOCATIONS: Row[] = [
  postLocation(4455240001, { type: 'free_text', plain_text_location: 'Remote (US)' }),
  postLocation(4455240002, { type: 'office', office_id: 4455090001 }),
  postLocation(4455240003, { type: 'custom_list', custom_location_id: 4455241001 }),
];
const JOB_BOARD_CUSTOM_LOCATIONS: Row[] = [
  { id: 4455241001, value: 'Toronto, Canada', active: true, greenhouse_job_board_id: 4455220001, created_at: '2026-01-10T15:10:00.000Z', updated_at: '2026-01-10T15:10:00.000Z' },
];

// Base salary plus on-target earnings; OTE has the higher priority and the bigger numbers.
const PAY_INPUTS: Row[] = [
  { id: 4455251001, title: 'Base Salary', blurb: null, priority: 1, linked_custom_field_id: null, locked: false, ...T0 },
  { id: 4455251002, title: 'On-target earnings', blurb: '<p>Base plus commission at plan.</p>', priority: 0, linked_custom_field_id: null, locked: false, ...T0 },
];
const payRange = (id: number, inputId: number, postId: number, currency: string, min: number, max: number): Row => ({
  id, pay_input_id: inputId, job_post_id: postId, currency_type: currency, min_cents: min, max_cents: max,
  created_at: '2026-01-10T15:10:00.000Z', updated_at: '2026-01-10T15:10:00.000Z',
});
const PAY_INPUT_RANGES: Row[] = [
  payRange(4455250001, 4455251001, 4455210001, 'USD', 18500000, 21500000),
  payRange(4455250002, 4455251002, 4455210001, 'USD', 25000000, 30000000),
];

const SOURCES: Row[] = [
  { id: 14, name: 'LinkedIn', type: { id: 8, name: 'Third-party boards' }, created_at: '2024-01-01T00:00:00.000Z', updated_at: '2024-01-01T00:00:00.000Z' },
  { id: 24, name: 'LinkedIn (Prospecting)', type: { id: 10, name: 'Prospecting' }, created_at: '2024-01-01T00:00:00.000Z', updated_at: '2024-01-01T00:00:00.000Z' },
  { id: 27, name: 'Referral', type: { id: 2, name: 'Referral' }, created_at: '2024-01-01T00:00:00.000Z', updated_at: '2024-01-01T00:00:00.000Z' },
  { id: 18, name: 'Internal Applicant', type: { id: 19, name: 'Company marketing' }, created_at: '2024-01-01T00:00:00.000Z', updated_at: '2024-01-01T00:00:00.000Z' },
];
const REFERRERS: Row[] = [
  { id: 4455700001, user_id: 4455100012, name: 'Marcus Oyelaran', created_at: '2026-03-15T10:00:00.000Z', updated_at: '2026-03-15T10:00:00.000Z' },
];

const candidate = (id: number, fields: Partial<Row>): Row => ({
  id, first_name: null, last_name: null, preferred_name: null, company: null, title: null, can_email: true,
  time_zone: 'Pacific Time (US & Canada)', private: false, tags: [], linked_user_ids: [], phone_numbers: [], addresses: [],
  email_addresses: [], website_addresses: [], social_media_addresses: [], custom_fields: {}, ...fields,
});
const CANDIDATES: Row[] = [
  candidate(4455120007, {
    first_name: 'Jordan', last_name: 'Alvarez', preferred_name: 'Jo', company: 'Stripe', title: 'Software Engineer II',
    created_at: '2026-02-03T19:44:10.000Z', updated_at: '2026-06-20T14:03:12.000Z', last_activity_at: '2026-06-20T14:03:12.000Z',
    tags: ['backend', 'referral-2026'],
    phone_numbers: [{ value: '+1 415-555-0142', type: 'mobile' }],
    addresses: [{ value: '1 Market St\nSan Francisco, CA 94105', type: 'home' }],
    email_addresses: [{ value: 'jordan.alvarez@example.com', type: 'personal' }, { value: 'JAlvarez@stripe.example', type: 'work' }],
    website_addresses: [{ value: 'https://jordanalvarez.dev', type: 'portfolio' }],
    social_media_addresses: [{ value: 'https://www.linkedin.com/in/jordanalvarez' }, { value: 'https://github.com/jalvarez' }],
    custom_fields: { desired_salary: { name: 'Desired Salary', type: 'short_text', value: '$210k' } },
  }),
  candidate(4455120008, {
    first_name: 'Morgan', last_name: 'Lee', company: 'Figma', title: 'Senior Product Designer',
    created_at: '2026-04-21T09:58:00.000Z', updated_at: '2026-05-04T17:22:09.000Z', last_activity_at: '2026-05-04T17:22:09.000Z',
    email_addresses: [{ value: 'morgan.lee@example.com', type: 'personal' }],
  }),
  // A private candidate: only some Greenhouse users can see them.
  candidate(4455120009, {
    first_name: 'Riley', last_name: 'Park', company: 'Plaid', title: 'Staff Engineer', private: true,
    created_at: '2026-07-01T08:55:00.000Z', updated_at: '2026-07-01T09:00:00.000Z', last_activity_at: '2026-07-01T09:00:00.000Z',
    email_addresses: [{ value: 'riley@example.org', type: 'personal' }],
    social_media_addresses: [{ value: 'https://www.linkedin.com/in/rileypark' }],
  }),
  candidate(4455120010, {
    first_name: 'Casey', last_name: 'Nguyen', company: 'Square', title: 'Backend Engineer',
    created_at: '2026-03-15T09:58:00.000Z', updated_at: '2026-06-20T14:03:00.000Z', last_activity_at: '2026-06-20T14:03:00.000Z',
    email_addresses: [{ value: 'casey.nguyen@example.net', type: 'personal' }],
  }),
];

const application = (id: number, fields: Partial<Row>): Row => ({
  id, candidate_id: 0, job_id: null, job_post_id: null, status: 'in_process', prospect: false, prospective_job_ids: [],
  stage_id: null, job_interview_stage_id: null, stage_name: null, rejection_reason_id: null, rejected_at: null,
  source_id: null, referrer_id: null, agency_note_id: null, recruiter_id: null, coordinator_id: null, needs_decision: false,
  last_activity_at: null, location_address: null, answers: [], custom_fields: {}, created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-01T00:00:00.000Z', ...fields,
});
const APPLICATIONS: Row[] = [
  application(4455500001, {
    candidate_id: 4455120007, job_id: 4455200001, job_post_id: 4455210001, stage_id: 4455510004,
    job_interview_stage_id: 4455300003, stage_name: 'Technical Interview', source_id: 14, recruiter_id: 4455100011,
    coordinator_id: 4455100013, needs_decision: true, last_activity_at: '2026-09-18T21:05:00.000Z', location_address: 'San Francisco, CA',
    answers: [{ question: 'Why Acme?', answer: 'I love payments infra.' }],
    custom_fields: { notice_period: { name: 'Notice period', type: 'short_text', value: '2 weeks' } },
    created_at: '2026-08-30T17:12:44.000Z', updated_at: '2026-09-18T21:05:00.000Z',
  }),
  application(4455500002, {
    candidate_id: 4455120008, job_id: 4455200002, status: 'rejected', rejection_reason_id: 4455400001,
    rejected_at: '2026-05-04T17:22:09.000Z', source_id: 24, recruiter_id: 4455100011, last_activity_at: '2026-05-04T17:22:09.000Z',
    created_at: '2026-04-21T10:00:00.000Z', updated_at: '2026-05-04T17:22:09.000Z',
  }),
  application(4455500003, {
    candidate_id: 4455120010, job_id: 4455200001, job_post_id: 4455210001, status: 'hired', source_id: 27,
    referrer_id: 4455700001, recruiter_id: 4455100011, last_activity_at: '2026-06-20T14:03:00.000Z',
    created_at: '2026-03-15T10:00:00.000Z', updated_at: '2026-06-20T14:03:00.000Z',
  }),
  // The docs' prospect: sourced through a Prospecting source, with someone credited (referrer_id).
  application(4455500004, {
    candidate_id: 4455120009, prospect: true, prospective_job_ids: [4455200001], source_id: 24, referrer_id: 4455700001,
    needs_decision: null, answers: null, custom_fields: null, last_activity_at: '2026-07-01T09:00:00.000Z',
    created_at: '2026-07-01T09:00:00.000Z', updated_at: '2026-07-01T09:00:00.000Z',
  }),
];

const move = (id: number, appId: number, stageId: number, entered: string, exited: string | null): Row => ({
  id, application_id: appId, job_interview_stage_id: stageId, entered_at: entered, exited_at: exited,
  days_in_stage: 1, current: exited === null, created_at: entered, updated_at: exited ?? entered,
});
const APPLICATION_STAGES: Row[] = [
  move(4455510001, 4455500001, 4455300001, '2026-08-30T17:12:44.000Z', '2026-09-02T14:00:00.000Z'),
  move(4455510002, 4455500001, 4455300002, '2026-09-02T14:00:00.000Z', '2026-09-10T16:30:00.000Z'),
  move(4455510004, 4455500001, 4455300003, '2026-09-10T16:30:00.000Z', null),
  move(4455510011, 4455500002, 4455300011, '2026-04-21T10:00:00.000Z', '2026-04-28T09:00:00.000Z'),
  move(4455510012, 4455500002, 4455300012, '2026-04-28T09:00:00.000Z', '2026-05-04T17:22:09.000Z'),
  move(4455510021, 4455500003, 4455300001, '2026-03-15T10:00:00.000Z', '2026-03-20T10:00:00.000Z'),
  move(4455510022, 4455500003, 4455300002, '2026-03-20T10:00:00.000Z', '2026-04-02T10:00:00.000Z'),
  move(4455510023, 4455500003, 4455300003, '2026-04-02T10:00:00.000Z', '2026-04-20T10:00:00.000Z'),
  move(4455510024, 4455500003, 4455300004, '2026-04-20T10:00:00.000Z', '2026-06-09T20:00:00.000Z'),
  // Hiring doesn't close the last stage: the hire still sits in Offer.
  move(4455510025, 4455500003, 4455300005, '2026-06-09T20:00:00.000Z', null),
];

const PROSPECT_DETAILS: Row[] = [
  { id: 4455520001, application_id: 4455500004, pool_id: 4455530001, pool_stage_id: 4455531002, prospect_owner_id: 4455100011, department_id: 4455080002, office_id: 4455090001, created_at: '2026-07-01T09:00:00.000Z', updated_at: '2026-07-01T09:00:00.000Z' },
];

const note = (id: number, fields: Partial<Row>): Row => ({
  id, candidate_id: null, application_id: null, user_id: null, type: 'NOTE', visibility: 'publicly_visible', subject: null,
  body: null, body_with_tags: null, email_from: null, email_to: null, email_cc: null, email_attachment_file_names: null,
  import_hash: null, ...fields, updated_at: fields.created_at,
});
const NOTES: Row[] = [
  note(4455600001, { candidate_id: 4455120007, application_id: 4455500001, user_id: 4455100011, body: 'Strong phone screen. Moving to technical.\nNeeds sponsorship: no.', body_with_tags: 'Strong phone screen. Moving to technical. cc @[Marcus Oyelaran](user:4455100012)\nNeeds sponsorship: no.', created_at: '2026-09-10T16:31:02.000Z' }),
  note(4455600002, { candidate_id: 4455120007, user_id: 4455100011, type: 'EMAIL', subject: 'Next steps with Acme', body: 'Hi Jordan,\n\nThanks for your time today...', email_from: 'priya.raman@acme.example', email_to: 'jordan.alvarez@example.com', email_cc: ['marcus.oyelaran@acme.example'], created_at: '2026-09-02T14:05:00.000Z' }),
  note(4455600003, { candidate_id: 4455120007, application_id: 4455500001, type: 'ACTIVITY', body: 'Jordan Alvarez was moved into Technical Interview for Senior Backend Engineer', created_at: '2026-09-10T16:30:00.000Z' }),
  note(4455600004, { candidate_id: 4455120008, application_id: 4455500002, user_id: 4455100012, body: 'Portfolio is strong but the case study lacked depth on research.', created_at: '2026-05-03T16:00:00.000Z' }),
  note(4455600005, { candidate_id: 4455120010, application_id: 4455500003, user_id: 4455100011, visibility: 'privately_visible', body: 'Comp expectations: 205k base. Keep confidential.', created_at: '2026-06-05T11:00:00.000Z' }),
  note(4455600006, { candidate_id: 4455120007, application_id: 4455500001, user_id: 4455100012, type: 'FEEDBACK', body: 'Marcus submitted a scorecard', created_at: '2026-09-15T19:12:30.000Z' }),
  note(4455600007, { candidate_id: 4455120010, application_id: 4455500003, user_id: 4455100011, visibility: 'admin_only_visible', body: 'Background check cleared. Salary history on file.', created_at: '2026-06-15T11:00:00.000Z' }),
];

const JOB_INTERVIEWS: Row[] = [
  { id: 4455310001, job_id: 4455200001, job_interview_stage_id: 4455300003, name: 'Systems Design', sort_order: 1, scheduling_type: 'needs_scheduling', duration: 60, summary: 'A 60-minute collaborative design session.', instructions: 'Use the shared whiteboard link.', active: true, require_scorecard: true, created_at: '2025-01-10T15:00:00.000Z', updated_at: '2025-01-10T15:00:00.000Z' },
  { id: 4455310002, job_id: 4455200001, job_interview_stage_id: 4455300004, name: 'Hiring Manager Chat', sort_order: 2, scheduling_type: 'needs_scheduling', duration: 30, summary: null, instructions: null, active: true, require_scorecard: true, created_at: '2025-01-10T15:00:00.000Z', updated_at: '2025-01-10T15:00:00.000Z' },
  { id: 4455310003, job_id: 4455200002, job_interview_stage_id: 4455300012, name: 'Portfolio Review Session', sort_order: 1, scheduling_type: 'needs_scheduling', duration: 90, summary: null, instructions: null, active: true, require_scorecard: true, created_at: '2025-01-10T15:00:00.000Z', updated_at: '2025-01-10T15:00:00.000Z' },
];
const INTERVIEW_KITS: Row[] = [
  { id: 4455320001, job_id: 4455200001, job_interview_id: 4455310001, exercises: '<p>Design a rate limiter for a multi-tenant API.</p>', anonymize_candidate: false, anonymize_resumes: false, created_at: '2025-01-10T15:00:00.000Z', updated_at: '2025-03-02T10:15:00.000Z' },
  { id: 4455320002, job_id: 4455200001, job_interview_id: 4455310002, exercises: null, anonymize_candidate: false, anonymize_resumes: false, created_at: '2025-01-10T15:00:00.000Z', updated_at: '2025-01-10T15:00:00.000Z' },
  { id: 4455320003, job_id: 4455200002, job_interview_id: 4455310003, exercises: null, anonymize_candidate: false, anonymize_resumes: false, created_at: '2025-01-10T15:00:00.000Z', updated_at: '2025-01-10T15:00:00.000Z' },
];

const interview = (id: number, fields: Partial<Row>): Row => ({
  id, application_id: 0, job_id: null, job_interview_id: null, status: 'scheduled', starts_at: null, ends_at: null,
  all_day_start_on: null, all_day_end_on: null, location: null, video_conferencing_url: null, organizer_id: null,
  scheduled_at: null, external_event_id: null, availability_received_at: null, created_at: '2026-09-10T16:30:00.000Z',
  updated_at: '2026-09-10T16:30:00.000Z', ...fields,
});
const INTERVIEWS: Row[] = [
  interview(4455900001, { application_id: 4455500001, job_id: 4455200001, job_interview_id: 4455310001, status: 'complete', starts_at: '2026-09-15T18:00:00.000Z', ends_at: '2026-09-15T19:00:00.000Z', location: 'SF HQ — Room Golden Gate', video_conferencing_url: 'https://acme.zoom.us/j/81234567890', organizer_id: 4455100013, scheduled_at: '2026-09-11T10:02:00.000Z', external_event_id: '7k2f9s0q1v8b3n4m5c6x7z8a9', availability_received_at: '2026-09-10T22:15:00.000Z', updated_at: '2026-09-15T19:12:30.000Z' }),
  // Not scheduled yet: no start time, so nothing to import.
  interview(4455900002, { application_id: 4455500001, job_id: 4455200001, job_interview_id: 4455310002, status: 'to_be_scheduled', created_at: '2026-09-16T09:00:00.000Z', updated_at: '2026-09-16T09:00:00.000Z' }),
  interview(4455900003, { application_id: 4455500002, job_id: 4455200002, job_interview_id: 4455310003, status: 'complete', starts_at: '2026-04-30T17:00:00.000Z', ends_at: '2026-04-30T18:30:00.000Z', video_conferencing_url: 'https://acme.zoom.us/j/80000000001', organizer_id: 4455100013, scheduled_at: '2026-04-28T10:00:00.000Z', created_at: '2026-04-28T09:30:00.000Z', updated_at: '2026-04-30T19:00:00.000Z' }),
];
const interviewer = (id: number, interviewId: number, userId: number | null, email: string, scorecardId: number | null): Row => ({
  id, interview_id: interviewId, user_id: userId, email, scorecard_id: scorecardId, response_status: 'accepted',
  created_at: '2026-09-11T10:02:00.000Z', updated_at: '2026-09-11T10:02:00.000Z',
});
const INTERVIEWERS: Row[] = [
  interviewer(4455910001, 4455900001, 4455100012, 'marcus.oyelaran@acme.example', 4455800001),
  { ...interviewer(4455910002, 4455900001, null, 'contractor@partner.example', null), response_status: 'needs_action' },
  interviewer(4455910003, 4455900001, 4455100011, 'admin@example.test', 4455800003),
  interviewer(4455910004, 4455900003, 4455100011, 'admin@example.test', 4455800004),
];

const scorecard = (id: number, fields: Partial<Row>): Row => ({
  id, application_id: 0, interview_kit_id: null, interviewer_id: null, submitter_id: null, status: 'complete',
  candidate_rating: 'no_decision', interviewed_at: null, submitted_at: null, notes: null, notes_with_tags: null,
  private_notes: null, private_notes_with_tags: null, public_notes: null, public_notes_with_tags: null, ...fields,
});
const SCORECARDS: Row[] = [
  scorecard(4455800001, { application_id: 4455500001, interview_kit_id: 4455320001, interviewer_id: 4455100012, submitter_id: 4455100012, candidate_rating: 'strong_yes', interviewed_at: '2026-09-15T18:00:00.000Z', submitted_at: '2026-09-15T19:12:30.000Z', notes: 'Excellent systems design. Drove the conversation and handled failure modes well.', private_notes: 'Comp expectations may be above band.', public_notes: 'Recommend a deeper dive on data modeling in the onsite.', created_at: '2026-09-15T18:00:00.000Z', updated_at: '2026-09-15T19:12:30.000Z' }),
  scorecard(4455800002, { application_id: 4455500001, interview_kit_id: 4455320002, interviewer_id: 4455100011, submitter_id: 4455100011, status: 'draft', interviewed_at: '2026-09-16T17:00:00.000Z', created_at: '2026-09-16T17:00:00.000Z', updated_at: '2026-09-16T17:00:00.000Z' }),
  scorecard(4455800003, { application_id: 4455500001, interview_kit_id: 4455320001, interviewer_id: 4455100011, submitter_id: 4455100011, candidate_rating: 'no_decision', interviewed_at: '2026-09-15T18:00:00.000Z', submitted_at: '2026-09-15T20:00:00.000Z', notes: 'Need to see more on data modeling before deciding.', created_at: '2026-09-15T18:00:00.000Z', updated_at: '2026-09-15T20:00:00.000Z' }),
  scorecard(4455800004, { application_id: 4455500002, interview_kit_id: 4455320003, interviewer_id: 4455100011, submitter_id: 4455100011, candidate_rating: 'strong_no', interviewed_at: '2026-04-30T17:00:00.000Z', submitted_at: '2026-04-30T19:00:00.000Z', notes: 'Could not walk through their research process.', created_at: '2026-04-30T17:00:00.000Z', updated_at: '2026-04-30T19:00:00.000Z' }),
];
const answer = (id: number, scorecardId: number, questionId: number, fields: Partial<Row>): Row => ({
  id, scorecard_id: scorecardId, scorecard_question_id: questionId, answer: null, answer_with_tags: null, boolean_value: null,
  value: null, created_at: '2026-09-15T19:12:30.000Z', updated_at: '2026-09-15T19:12:30.000Z', ...fields,
});
const ANSWERS: Row[] = [
  answer(4455810001, 4455800001, 4455820001, { answer: 'Proposed token bucket per tenant with Redis; discussed hot-key mitigation.', answer_with_tags: '<p>Proposed <strong>token bucket</strong> per tenant with Redis; discussed hot-key mitigation.</p>', value: 'Proposed token bucket per tenant with Redis; discussed hot-key mitigation.' }),
  answer(4455810002, 4455800001, 4455820002, { boolean_value: true, value: true }),
  answer(4455810003, 4455800001, 4455820003, { value: [4455830001, 4455830003] }),
  // A single_select answer on another scorecard: option names are fetched in one batch for both.
  answer(4455810004, 4455800004, 4455820004, { value: 4455830004, created_at: '2026-04-30T19:00:00.000Z', updated_at: '2026-04-30T19:00:00.000Z' }),
];
const QUESTIONS: Row[] = [
  { id: 4455820001, interview_kit_id: 4455320001, question: '<p>How did the candidate <strong>approach</strong> the design problem?</p>', answer_type: 'text', required: true, active: true, sort_order: 0, created_at: '2025-01-10T15:00:00.000Z', updated_at: '2025-01-10T15:00:00.000Z' },
  { id: 4455820002, interview_kit_id: 4455320001, question: 'Would you want to work with this person?', answer_type: 'yes_no', required: true, active: true, sort_order: 1, created_at: '2025-01-10T15:00:00.000Z', updated_at: '2025-01-10T15:00:00.000Z' },
  { id: 4455820003, interview_kit_id: 4455320001, question: 'Strengths observed', answer_type: 'multi_select', required: false, active: true, sort_order: 2, created_at: '2025-01-10T15:00:00.000Z', updated_at: '2025-01-10T15:00:00.000Z' },
  { id: 4455820004, interview_kit_id: 4455320003, question: 'Research depth', answer_type: 'single_select', required: true, active: true, sort_order: 0, created_at: '2025-01-10T15:00:00.000Z', updated_at: '2025-01-10T15:00:00.000Z' },
];
const OPTIONS: Row[] = [
  { id: 4455830001, scorecard_question_id: 4455820003, name: 'Distributed systems', sort_order: 0, active: true, ...T0 },
  { id: 4455830002, scorecard_question_id: 4455820003, name: 'Testing', sort_order: 1, active: true, ...T0 },
  { id: 4455830003, scorecard_question_id: 4455820003, name: 'Communication', sort_order: 2, active: true, ...T0 },
  { id: 4455830004, scorecard_question_id: 4455820004, name: 'Shallow', sort_order: 0, active: true, ...T0 },
];
// The scorecard's "key attributes" section.
const JOB_CANDIDATE_ATTRIBUTES: Row[] = [
  { id: 4455850001, job_id: 4455200001, candidate_attribute_type_id: 4455851001, name: 'Systems thinking', active: true, sort_order: 0, ...T0 },
  { id: 4455850002, job_id: 4455200001, candidate_attribute_type_id: 4455851002, name: 'Communication', active: true, sort_order: 1, ...T0 },
];
const attributeRating = (id: number, scorecardId: number, attributeId: number, rating: string, noteText: string | null): Row => ({
  id, scorecard_id: scorecardId, job_candidate_attribute_id: attributeId, candidate_attribute_rating: rating, note: noteText,
  value: rating, created_at: '2026-09-15T19:12:30.000Z', updated_at: '2026-09-15T19:12:30.000Z',
});
const SCORECARD_CANDIDATE_ATTRIBUTES: Row[] = [
  attributeRating(4455840001, 4455800001, 4455850002, 'mixed', null),
  attributeRating(4455840002, 4455800001, 4455850001, 'strong_yes', 'Clear, structured thinker'),
  attributeRating(4455840003, 4455800003, 4455850002, 'no_decision', 'Hard to read over video'),
];

const OFFERS: Row[] = [
  { id: 4455950002, application_id: 4455500003, candidate_id: 4455120010, job_id: 4455200001, opening_id: 4455270001, version: 2, status: 'Accepted', sent_on: '2026-06-10', starts_on: '2026-07-13', resolved_at: '2026-06-12T12:00:00.000Z', custom_fields: { employment_type: { name: 'Employment Type', type: 'single_select', value: 'Full-time' }, salary: { name: 'Salary', type: 'currency', value: { value: 205000, currency: 'USD' } }, equity: { name: 'Equity', type: 'short_text', value: '0.05% over 4 years' } }, created_at: '2026-06-09T20:00:00.000Z', updated_at: '2026-06-12T12:00:00.000Z' },
  { id: 4455950001, application_id: 4455500003, candidate_id: 4455120010, job_id: 4455200001, opening_id: 4455270001, version: 1, status: 'Deprecated', sent_on: null, starts_on: '2026-07-06', resolved_at: null, custom_fields: { salary: { name: 'Salary', type: 'currency', value: { value: 195000, currency: 'USD' } } }, created_at: '2026-06-08T15:00:00.000Z', updated_at: '2026-06-09T20:00:00.000Z' },
  // v3 write shape for currency values; datetime-formatted _on field as in the docs' example.
  { id: 4455950003, application_id: 4455500001, candidate_id: 4455120007, job_id: 4455200001, opening_id: 4455270002, version: 1, status: 'Created', sent_on: null, starts_on: '2026-10-19T00:00:00.000Z', resolved_at: null, custom_fields: { salary: { name: 'Salary', type: 'currency', value: { amount: 198000, currency_code: 'USD' } }, equity: { name: 'Equity', type: 'short_text', value: null } }, created_at: '2026-09-20T12:00:00.000Z', updated_at: '2026-09-20T12:00:00.000Z' },
];

const RESUME_PATH = '/person_attachments/data/445/512/0007/original/Jordan_Alvarez_Resume.pdf';
const COVER_PATH = '/person_attachments/data/445/512/0007/original/cover_letter.docx';
const TAKE_HOME_PATH = '/person_attachments/data/445/512/0007/original/Take_Home.pdf';
const OFFER_LETTER_PATH = '/person_attachments/data/445/512/0010/original/Offer_Letter.pdf';
const CASEY_RESUME_PATH = '/person_attachments/data/445/512/0010/original/Casey_Nguyen_Resume.pdf';
const attachment = (id: number, fields: Partial<Row>): Row => ({
  id, application_id: null, candidate_id: null, type: 'other', filename: null, url: null,
  created_at: '2026-08-30T17:12:44.000Z', updated_at: '2026-08-30T17:12:44.000Z', ...fields,
});
const ATTACHMENTS: Row[] = [
  attachment(4455960001, { application_id: 4455500001, candidate_id: 4455120007, type: 'resume', filename: 'Jordan_Alvarez_Resume.pdf', url: s3Url(RESUME_PATH, 'good1') }),
  // Served through Greenhouse's redirect endpoint, which 302s to a fresh S3 link.
  attachment(4455960002, { application_id: 4455500001, candidate_id: 4455120007, type: 'cover_letter', filename: 'cover_letter.docx', url: 'https://app.greenhouse.io/attachments/redirect/4455960002?token=opaque' }),
  attachment(4455960003, { application_id: 4455500003, candidate_id: 4455120010, type: 'offer_letter', filename: 'Offer_Letter.pdf', url: s3Url(OFFER_LETTER_PATH, 'good3'), created_at: '2026-06-10T09:00:00.000Z', updated_at: '2026-06-10T09:00:00.000Z' }),
  // Listed with a link that has already expired; re-listing by id returns a fresh one.
  attachment(4455960004, { application_id: 4455500003, candidate_id: 4455120010, type: 'resume', filename: 'Casey_Nguyen_Resume.pdf', url: s3Url(CASEY_RESUME_PATH, 'expired'), created_at: '2026-03-15T10:00:00.000Z', updated_at: '2026-03-15T10:00:00.000Z' }),
  // Storage refuses this one every time: the file is skipped, not the import.
  attachment(4455960005, { application_id: 4455500001, candidate_id: 4455120007, type: 'take_home_test', filename: 'Take_Home.pdf', url: s3Url(TAKE_HOME_PATH, 'denied'), created_at: '2026-09-12T10:00:00.000Z', updated_at: '2026-09-12T10:00:00.000Z' }),
];

const FIXTURES = {
  users: USERS,
  job_interview_stages: JOB_INTERVIEW_STAGES,
  rejection_reasons: REJECTION_REASONS,
  jobs: JOBS,
  openings: OPENINGS,
  job_posts: JOB_POSTS,
  job_post_locations: JOB_POST_LOCATIONS,
  job_board_custom_locations: JOB_BOARD_CUSTOM_LOCATIONS,
  pay_inputs: PAY_INPUTS,
  pay_input_ranges: PAY_INPUT_RANGES,
  departments: DEPARTMENTS,
  offices: OFFICES,
  sources: SOURCES,
  referrers: REFERRERS,
  candidates: CANDIDATES,
  applications: APPLICATIONS,
  application_stages: APPLICATION_STAGES,
  prospect_details: PROSPECT_DETAILS,
  notes: NOTES,
  interviews: INTERVIEWS,
  interviewers: INTERVIEWERS,
  job_interviews: JOB_INTERVIEWS,
  interview_kits: INTERVIEW_KITS,
  scorecards: SCORECARDS,
  scorecard_question_answers: ANSWERS,
  scorecard_questions: QUESTIONS,
  scorecard_question_options: OPTIONS,
  scorecard_candidate_attributes: SCORECARD_CANDIDATE_ATTRIBUTES,
  job_candidate_attributes: JOB_CANDIDATE_ATTRIBUTES,
  offers: OFFERS,
  attachments: ATTACHMENTS,
} satisfies Record<string, Row[]>;
type Table = keyof typeof FIXTURES;

/** Every list scope the adapter reads; the default credential has them all. */
const GRANTED = (Object.keys(FIXTURES) as Table[]).map((t) => `harvest:${t}:list`);

// ---------- The mock Harvest v3 API ----------

const ID_FILTERS: Record<string, string> = {
  ids: 'id',
  job_ids: 'job_id',
  application_ids: 'application_id',
  candidate_ids: 'candidate_id',
  interview_ids: 'interview_id',
  scorecard_ids: 'scorecard_id',
  job_post_ids: 'job_post_id',
};

const UNAUTHORIZED = { message: 'Unauthorized', errors: ['Token could not be decoded. Please ensure your token is from a trusted source.'] };
const unprocessable = (errors: unknown[]) => json({ message: 'Unprocessable Content', errors }, { status: 422 });

/** Tokens differ between mock instances, so one cached from an earlier test is never mistaken for a live one. */
let mockSerial = 0;

function jwt(n: string, scopes: string[], withExp = true): string {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: 'auth.greenhouse.io', sub: 5124862004, aud: ['harvest.greenhouse.io'], ...(withExp ? { exp: now + 3600 } : {}), iat: now,
    jti: `test-token-${n}`, scope: scopes.join(' '), version: 1.0, silo: 4,
    act: {
      'organization.id': 4000001004, 'organization.name': ORG_NAME, 'credential.type': 'Auth::Provider::Models::AccessTokenMeta',
      'credential.id': 4019751004, 'credential.description': null, 'partner.id': null, 'partner.name': null,
      'client.id': CREDENTIALS.clientId, 'client.name': 'Source importer',
      'client.type': 'Auth::ClientApplications::Models::HarvestOrganizationClientApplication',
    },
  };
  return `${enc({ alg: 'RS256' })}.${enc(claims)}.signature-${n}`;
}

type MockOptions = {
  scopes?: string[];
  /** Replace a table's rows (pass a mutable array to change it mid-run). */
  data?: Partial<Record<Table, Row[]>>;
  pageSize?: Partial<Record<Table, number>>;
  /** Refuse a list outright, as a missing scope does (403, or 401 even on a fresh token). */
  deny?: Partial<Record<Table, 401 | 403>>;
  /** Filters a list silently ignores, or rejects with 422. */
  ignore?: Partial<Record<Table, string[]>>;
  reject?: Partial<Record<Table, string[]>>;
  /** Harvest calls each token survives before Greenhouse answers 401 (simulates expiry). */
  tokenLifetime?: number;
  /** Where the token endpoint wants grant_type: the guide's form body or the OpenAPI page's query string. */
  tokenGrant?: 'form' | 'query';
  /** expires_in in seconds, the OpenAPI example's timestamp string, or the partner flow's expires_at (JWT without exp). */
  tokenExpiry?: 'seconds' | 'iso' | 'expires_at';
  /** The token endpoint answers 307 to this URL instead. */
  tokenRedirect?: string;
  /** Which created-after syntax Greenhouse accepts (the docs show two). */
  dateSyntax?: 'pipe' | 'bracket' | 'none';
  /** Reject the first saved cursor on this path, as if it had gone stale. */
  staleCursorOnce?: string;
  /** Greenhouse's attachment redirect endpoint wants the bearer token. */
  redirectNeedsBearer?: boolean;
  apiHost?: string;
  /** Host written into Link headers (defaults to apiHost). */
  linkHost?: string;
};

const LIST_BEHAVIOUR: Partial<Record<Table, { filter?: (r: Row, q: URLSearchParams, all: Row[]) => boolean; view?: (r: Row, q: URLSearchParams) => Row }>> = {
  users: { filter: (r, q) => q.get('show_service_accounts') === 'true' || r.primary_email !== '' },
  rejection_reasons: { filter: (r, q) => q.get('include_defaults') === 'true' || !DEFAULT_REASONS.has(r.id) },
  job_posts: { filter: (r, q) => String(r.active) === (q.get('active') ?? 'true') },
  applications: {
    filter: (r, q) => {
      const status = q.get('status');
      if (status && r.status !== (status === 'active' ? 'in_process' : status)) return false;
      return q.get('prospect') == null || String(r.prospect) === q.get('prospect');
    },
  },
  notes: { filter: (r, q) => !q.get('type') || q.get('type')!.split(',').includes(String(r.type)) },
  scorecards: { filter: (r, q) => !q.get('status') || r.status === q.get('status') },
  offers: {
    filter: (r, q, all) =>
      q.get('current_only') !== 'true' ||
      r.version === Math.max(...all.filter((o) => o.application_id === r.application_id).map((o) => o.version as number)),
  },
  attachments: {
    // Re-listing hands out a freshly signed link.
    view: (r, q) => (q.get('ids') && r.id === 4455960004 ? { ...r, url: s3Url(CASEY_RESUME_PATH, 'fresh4') } : r),
  },
};

/** Small pages where paging itself is under test. */
const DEFAULT_PAGE_SIZE: Partial<Record<Table, number>> = { candidates: 2, applications: 2 };

function greenhouseApi(opts: MockOptions = {}) {
  const host = opts.apiHost ?? API;
  const serial = ++mockSerial;
  const issued: string[] = [];
  const uses = new Map<string, number>();
  const expired: string[] = [];
  const dateSyntax = opts.dateSyntax ?? 'pipe';
  let staleServed = false;

  const token: RouteHandler = ({ url, headers, body }) => {
    if (opts.tokenRedirect) return new Response(null, { status: 307, headers: { location: opts.tokenRedirect } });
    if (headers.authorization !== BASIC) return json({ message: 'Unauthorized', errorId: 'err-1790182685636-901' }, { status: 401 });
    const granted =
      opts.tokenGrant === 'query'
        ? url.searchParams.get('grant_type') === 'client_credentials'
        : headers['content-type'] === 'application/x-www-form-urlencoded' && body === 'grant_type=client_credentials';
    if (!granted) return json({ message: 'Bad Request Params', errors: ['grant_type is missing'] }, { status: 400 });
    const t = jwt(`${serial}-${issued.length + 1}`, opts.scopes ?? GRANTED, opts.tokenExpiry !== 'expires_at');
    issued.push(t);
    const expiry =
      opts.tokenExpiry === 'iso'
        ? { expires_in: '2025-03-12T20:12:18Z' } // the OpenAPI page's own example, long past
        : opts.tokenExpiry === 'expires_at'
          ? { expires_at: new Date(Date.now() + 3_600_000).toISOString() }
          : { expires_in: 3600 };
    return json({ token_type: 'Bearer', access_token: t, ...expiry });
  };

  /** A Harvest list endpoint: bare JSON array, id-descending, Link rel="next" keyset cursors. */
  const list =
    (table: Table): RouteHandler =>
    ({ url, headers }) => {
      const bearer = headers.authorization?.replace(/^Bearer /, '') ?? '';
      if (!issued.includes(bearer)) return json(UNAUTHORIZED, { status: 401 });
      const used = (uses.get(bearer) ?? 0) + 1;
      uses.set(bearer, used);
      if (opts.tokenLifetime && used > opts.tokenLifetime) {
        expired.push(url.pathname);
        return json(UNAUTHORIZED, { status: 401 });
      }
      const denied = opts.deny?.[table];
      if (denied === 401) return json(UNAUTHORIZED, { status: 401 });
      if (denied === 403) return json({ message: 'Forbidden', errors: ['Missing required scope'] }, { status: 403 });

      let q = url.searchParams;
      let lastId: number | null = null;
      const cursor = q.get('cursor');
      if (cursor && opts.staleCursorOnce === url.pathname && !staleServed) {
        staleServed = true;
        return unprocessable(['Invalid cursor']);
      }
      if (cursor) {
        if ([...q.keys()].length !== 1) return unprocessable(['When passing a cursor, do not include other query params.']);
        const state = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as { last_id: number; q: string };
        q = new URLSearchParams(state.q);
        lastId = state.last_id;
      }
      for (const param of opts.reject?.[table] ?? []) {
        if (q.has(param)) return unprocessable([{ [param]: 'is not a permitted filter' }]);
      }
      const perPage = Number(q.get('per_page') ?? 100);
      if (!Number.isInteger(perPage) || perPage < 1 || perPage > 500) return unprocessable([{ per_page: `\`${perPage}\` number is greater than: 500` }]);

      const tests: ((r: Row) => boolean)[] = [];
      for (const [param, field] of Object.entries(ID_FILTERS)) {
        const raw = q.get(param);
        if (raw == null || opts.ignore?.[table]?.includes(param)) continue;
        const ids = raw.split(',').map(Number);
        if (ids.length > 50) return unprocessable([{ [param]: 'too many items' }]);
        tests.push((r) => ids.includes(r[field] as number));
      }
      const pipe = q.get('created_at');
      const bracket = q.get('created_at[gte]');
      if (pipe != null) {
        const [op, at] = pipe.split('|');
        if (dateSyntax !== 'pipe' || op !== 'gte' || !at || Number.isNaN(Date.parse(at))) return unprocessable([{ created_at: 'invalid' }]);
        tests.push((r) => Date.parse(String(r.created_at)) >= Date.parse(at));
      }
      if (bracket != null) {
        if (dateSyntax !== 'bracket' || Number.isNaN(Date.parse(bracket))) return unprocessable([{ 'created_at[gte]': 'invalid' }]);
        tests.push((r) => Date.parse(String(r.created_at)) >= Date.parse(bracket));
      }
      const all = opts.data?.[table] ?? FIXTURES[table];
      const behaviour = LIST_BEHAVIOUR[table];
      const matching = all
        .filter((r) => tests.every((t) => t(r)) && (behaviour?.filter?.(r, q, all) ?? true))
        .sort((a, b) => b.id - a.id);
      const remaining = lastId == null ? matching : matching.filter((r) => r.id < lastId);
      const size = Math.min(perPage, opts.pageSize?.[table] ?? DEFAULT_PAGE_SIZE[table] ?? 500);
      const page = remaining.slice(0, size);
      const responseHeaders: Record<string, string> = {
        'x-ratelimit-limit': '75',
        'x-ratelimit-remaining': '74',
        'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 30),
      };
      if (remaining.length > size) {
        const next = Buffer.from(JSON.stringify({ last_id: page[page.length - 1].id, q: q.toString() })).toString('base64url');
        responseHeaders.link = `<https://${opts.linkHost ?? host}${url.pathname}?cursor=${next}>; rel="next"`;
      }
      return json(page.map((r) => behaviour?.view?.(r, q) ?? r), { headers: responseHeaders });
    };

  const file =
    (name: string, contentType: string): RouteHandler =>
    ({ url, headers }) => {
      // Pre-signed: carries its own auth; S3 rejects a second method.
      if (headers.authorization) return new Response('<Error><Code>InvalidArgument</Code></Error>', { status: 400 });
      const sig = url.searchParams.get('X-Amz-Signature');
      if (sig === 'expired' || sig === 'denied') {
        return new Response('<Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>', { status: 403 });
      }
      return new Response(Buffer.from(`%PDF-1.7 fake ${name}`), { headers: { 'content-type': contentType } });
    };

  const routes: Record<string, RouteHandler> = {
    'POST auth.greenhouse.io/token': token,
    ...Object.fromEntries((Object.keys(FIXTURES) as Table[]).map((t) => [`GET ${host}/v3/${t}`, list(t)])),
    [`GET ${S3}${RESUME_PATH}`]: file('resume', 'application/pdf'),
    [`GET ${S3}${COVER_PATH}`]: file('cover', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    [`GET ${S3}${TAKE_HOME_PATH}`]: file('take home', 'application/pdf'),
    // A storage host's idea of a content type is not to be trusted.
    [`GET ${S3}${OFFER_LETTER_PATH}`]: file('offer letter', 'text/html'),
    [`GET ${S3}${CASEY_RESUME_PATH}`]: file('casey', 'application/pdf'),
    'GET app.greenhouse.io/attachments/redirect/4455960002': ({ headers }) => {
      const bearer = headers.authorization?.replace(/^Bearer /, '') ?? '';
      if (opts.redirectNeedsBearer && !issued.includes(bearer)) return json(UNAUTHORIZED, { status: 401 });
      return new Response(null, { status: 302, headers: { location: s3Url(COVER_PATH, 'good2') } });
    },
  };

  return { ...mockFetch(routes), issued, expired };
}

type Mock = ReturnType<typeof greenhouseApi>;

const secrets = (mock: Mock) => [CREDENTIALS.clientSecret, BASIC.slice(6), ...mock.issued];

/** The secret only ever reaches the token host; the token only Greenhouse's own hosts. */
function expectNoLeaks(mock: Mock) {
  for (const call of mock.calls) {
    const host = call.url.host;
    const wire = `${call.url.toString()} ${JSON.stringify(call.headers)} ${JSON.stringify(call.body ?? null)}`;
    if (host === 'auth.greenhouse.io') {
      expect(call.headers.authorization).toBe(BASIC);
      continue;
    }
    expect(wire).not.toContain(CREDENTIALS.clientSecret);
    expect(wire).not.toContain(BASIC.slice(6));
    if (host === API) {
      expect(call.headers.authorization).toMatch(/^Bearer /);
    } else if (host.endsWith('.greenhouse.io')) {
      // A Greenhouse redirect endpoint may be retried with the token, and gets nothing else.
      if (call.headers.authorization) expect(mock.issued).toContain(call.headers.authorization.replace(/^Bearer /, ''));
    } else {
      expect(call.headers.authorization).toBeUndefined();
      for (const s of secrets(mock)) expect(wire).not.toContain(s);
    }
  }
}

const importedId = (o: { customFields: unknown }) => (o.customFields as { imported: { id: string } }).imported.id;
const importedFields = (o: { customFields: unknown }) =>
  (o.customFields as { imported: { fields?: Record<string, string> } }).imported.fields;

// ---------- No-database helpers: one phase against the mock, with a recording loader ----------

type Loaded = { externalId: string; download?: () => Promise<DownloadedFile> };

function phaseContext(
  mock: Mock,
  opts: {
    credentials?: Credentials;
    has?: (kind: RefKind, id: string) => boolean;
    options?: Partial<ImportOptions>;
    since?: Date | null;
  } = {},
) {
  // A fresh object each time, as the runner opens credentials anew every slice.
  const credentials = { ...(opts.credentials ?? CREDENTIALS) };
  const http = createHttpClient({
    resolveHost: publicDns,
    auth: greenhouseProvider.auth(credentials),
    minIntervalMs: 0,
    fetchImpl: mock.impl,
  });
  const adapter = greenhouseProvider.create(credentials, http);
  const warnings: string[] = [];
  const loaded: Record<string, Loaded[]> = {};
  const downloads = new Map<string, DownloadedFile | unknown>();
  const has = opts.has ?? (() => false);
  const load = new Proxy({} as Loader, {
    get: (_target, kind: string) =>
      kind === 'has'
        ? async (k: RefKind, id: string) => has(k, id)
        : async (record: Loaded) => {
            (loaded[kind] ??= []).push(record);
            if (record.download) downloads.set(record.externalId, await record.download().catch((err: unknown) => err));
          },
  });
  const ctx: PhaseContext = {
    http,
    catalog: catalogWriter(emptyCatalog()),
    load,
    options: { ...DEFAULT_IMPORT_OPTIONS, ...opts.options },
    since: opts.since ?? null,
    outOfTime: () => false,
    warn: (message) => warnings.push(message),
  };
  return { ctx, adapter, warnings, loaded, downloads };
}

const loadPhase = (adapter: ProviderAdapter, id: string): Phase => adapter.load.find((p) => p.id === id)!;

/** Run a phase to completion, round-tripping each cursor as the runner stores it. */
async function runPhase(phase: Phase, ctx: PhaseContext, between?: (step: number) => void) {
  let cursor: Cursor | null = null;
  for (let step = 0; step < 1_000; step++) {
    cursor = await phase.run(ctx, cursor);
    if (cursor === null) return step + 1;
    cursor = JSON.parse(JSON.stringify(cursor)) as Cursor;
    between?.(step);
  }
  throw new Error(`${phase.id} did not finish`);
}

/**
 * Calls to one list that carried a token this mock issued. The adapter caches its token across
 * slices, so a phase test's first call may bring one from an earlier test's mock: refused once, then replaced.
 */
const listCalls = (mock: Mock, table: Table) =>
  mock.calls.filter(
    (c) => c.url.pathname === `/v3/${table}` && mock.issued.includes(c.headers.authorization?.replace(/^Bearer /, '') ?? ''),
  );

// ---------- Tests ----------

describe.skipIf(!hasDb)('greenhouse adapter', () => {
  it('builds its phase list from empty credentials without touching the network', () => {
    const http = createHttpClient({ resolveHost: publicDns, auth: { hosts: [], headers: {} }, minIntervalMs: 0 });
    const adapter = greenhouseProvider.create({}, http);
    expect(adapter.discover.map((p) => p.id)).toEqual(['users', 'stages', 'reasons']);
    expect(adapter.load.map((p) => p.id)).toEqual([
      'requisitions', 'postings', 'candidates', 'applications', 'interviews', 'feedback', 'notes', 'offers', 'files',
    ]);
    expect(greenhouseProvider.auth(CREDENTIALS).hosts).toEqual([API]);
  });

  it('verify mints a client-credentials token, probes a list, and names the org from the JWT', async () => {
    const mock = greenhouseApi();
    await expect(verifyForTest(greenhouseProvider, CREDENTIALS, mock.impl)).resolves.toEqual({ accountName: ORG_NAME });

    expect(mock.calls.map((c) => `${c.method} ${c.url.host}${c.url.pathname}`)).toEqual([
      'POST auth.greenhouse.io/token',
      `GET ${API}/v3/jobs`,
    ]);
    const [tokenCall, probe] = mock.calls;
    expect(tokenCall.headers.authorization).toBe(BASIC);
    expect(tokenCall.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(tokenCall.body).toBe('grant_type=client_credentials');
    expect(probe.headers.authorization).toBe(`Bearer ${mock.issued[0]}`);
    expect(probe.url.searchParams.get('per_page')).toBe('1');
    expect(mock.unmatched).toEqual([]);
  });

  it('verify rejects a wrong secret and a credential without the core scopes', async () => {
    const wrong = greenhouseApi();
    const err = await verifyForTest(greenhouseProvider, { ...CREDENTIALS, clientSecret: 'wrong' }, wrong.impl).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImportAuthError);
    expect((err as ImportAuthError).status).toBe(401);
    expect((err as Error).message).not.toContain('wrong');

    const narrow = greenhouseApi({ scopes: GRANTED.filter((s) => s !== 'harvest:candidates:list') });
    const scopeErr = await verifyForTest(greenhouseProvider, CREDENTIALS, narrow.impl).catch((e: unknown) => e);
    expect(scopeErr).toBeInstanceOf(ImportAuthError);
    expect((scopeErr as ImportAuthError).status).toBe(403);
    expect((scopeErr as Error).message).toContain('harvest:candidates:list');
  });

  it('verify retries with grant_type in the query string when the token endpoint wants it there', async () => {
    const mock = greenhouseApi({ tokenGrant: 'query' });
    await expect(verifyForTest(greenhouseProvider, CREDENTIALS, mock.impl)).resolves.toEqual({ accountName: ORG_NAME });
    const tokenCalls = mock.calls.filter((c) => c.url.host === 'auth.greenhouse.io');
    expect(tokenCalls.map((c) => c.url.searchParams.get('grant_type'))).toEqual([null, 'client_credentials']);
    expect(tokenCalls.every((c) => c.headers.authorization === BASIC)).toBe(true);
    expect(mock.issued).toHaveLength(1);
  });

  it('never sends the client secret to a host the token endpoint redirects to', async () => {
    const mock = greenhouseApi({ tokenRedirect: 'https://login.example-idp.test/oauth/token' });
    const err = await verifyForTest(greenhouseProvider, CREDENTIALS, mock.impl).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImportHttpError);
    const hop = mock.calls.find((c) => c.url.host === 'login.example-idp.test');
    expect(hop).toBeDefined();
    expect(hop!.headers.authorization).toBeUndefined();
    expect(hop!.body).toBeNull();
    expect(JSON.stringify({ ...hop, url: hop!.url.toString() })).not.toContain(CREDENTIALS.clientSecret);
    expect((err as Error).message).not.toContain(CREDENTIALS.clientSecret);
  });

  it('uses a support-set API host on greenhouse.io, and nothing else', async () => {
    const EU = 'harvest.eu.greenhouse.io';
    const creds = { ...CREDENTIALS, apiBaseUrl: `https://${EU}` };
    expect(greenhouseProvider.auth(creds).hosts).toEqual([EU]);
    // Link headers naming another host are pinned back to the one configured.
    const mock = greenhouseApi({ apiHost: EU, linkHost: API, pageSize: { users: 2 } });
    await expect(verifyForTest(greenhouseProvider, creds, mock.impl)).resolves.toEqual({ accountName: ORG_NAME });
    const { ctx, adapter } = phaseContext(mock, { credentials: creds });
    await runPhase(adapter.discover.find((p) => p.id === 'users')!, ctx);
    const users = listCalls(mock, 'users');
    expect(users).toHaveLength(2);
    expect(users.every((c) => c.url.host === EU && c.headers.authorization?.startsWith('Bearer '))).toBe(true);
    expect(mock.unmatched).toEqual([]);

    for (const bad of ['http://harvest.eu.greenhouse.io', 'https://harvest.example.com', 'https://auth.greenhouse.io']) {
      const c = { ...CREDENTIALS, apiBaseUrl: bad };
      expect(greenhouseProvider.auth(c).hosts).toEqual([API]);
      const before = mock.calls.length;
      await expect(verifyForTest(greenhouseProvider, c, mock.impl)).rejects.toThrow('override');
      expect(mock.calls.length).toBe(before);
    }
  });

  let firstOrg = '';

  it('imports a whole Greenhouse account', async () => {
    const mock = greenhouseApi({ redirectNeedsBearer: true });
    const result = await runImportForTest({ module: greenhouseProvider, credentials: CREDENTIALS, fetchImpl: mock.impl });
    expect(result.error).toBeNull();
    expect(result.status).toBe('SUCCEEDED');
    firstOrg = result.orgId;
    const { orgId, adminId } = result;

    expect(mock.unmatched).toEqual([]);
    expectNoLeaks(mock);
    // One token for the whole job: it's reused across slices, not minted per slice.
    expect(mock.issued).toHaveLength(1);

    // ----- Review: per-job stages grouped by name, plus synthetic Hired/Prospect -----
    const stages = Object.fromEntries(result.review!.stages.map((s) => [s.key, s]));
    expect(Object.keys(stages).sort()).toEqual([
      'application review', 'hired', 'offer', 'onsite', 'portfolio review', 'prospect', 'recruiter phone screen', 'technical interview',
    ]);
    expect(stages['application review'].count).toBe(2);
    expect(stages['onsite'].count).toBe(2);
    expect(stages['offer'].count).toBe(2);
    expect(stages['application review'].suggestedType).toBe('APPLICANT');
    expect(stages['offer'].target).toHaveProperty('stageId'); // existing "Offer"
    expect(stages['hired'].target).toHaveProperty('stageId'); // existing "Hired"
    expect(stages['prospect'].target).toEqual({ create: { name: 'Prospect', type: 'LEAD' } });
    // A name reused across rejection types stays two reasons.
    const reasons = Object.fromEntries(result.review!.reasons.map((r) => [r.name, r.kind]));
    expect(reasons).toEqual({
      'Lacking skill(s)/qualification(s)': 'rejection',
      'Took another offer': 'withdrawn',
      Spam: 'other',
      'Other (add notes below)': 'rejection',
      'Other (add notes below) — They rejected us': 'withdrawn',
    });
    const archiveReasons = await db.archiveReason.findMany({ where: { orgId, name: { startsWith: 'Other (add notes below)' } } });
    expect(Object.fromEntries(archiveReasons.map((r) => [r.name, r.countsAsRejection]))).toEqual({
      'Other (add notes below)': true,
      'Other (add notes below) — They rejected us': false,
    });
    expect(result.review!.users).toMatchObject({ total: 4, matched: 1 });

    // ----- What was created, and what was only warned about -----
    expect(result.view.created).toEqual({
      requisition: 2, posting: 2, contact: 4, opportunity: 4, interview: 2, feedback: 3, note: 4, offer: 2, file: 4,
    });
    const issues = result.view.issues.map((i) => i.message);
    expect(issues).toHaveLength(2);
    expect(issues).toContainEqual(expect.stringContaining("Couldn't download Take_Home.pdf"));
    expect(issues).toContainEqual(expect.stringContaining('Skipped Greenhouse notes visible only to admins'));
    expect(issues.join(' ')).not.toContain('X-Amz');

    // ----- Requests: paging, filters, batching, and no per-candidate fan-out -----
    const gets = (table: Table) => listCalls(mock, table).filter((c) => c.url.host === API);
    const candidatePages = gets('candidates').filter((c) => !c.url.searchParams.has('ids'));
    // Two pages, then the closing pass reads the first page again for candidates added meanwhile.
    expect(candidatePages).toHaveLength(3);
    expect(candidatePages[0].url.searchParams.get('per_page')).toBe('500');
    expect([...candidatePages[1].url.searchParams.keys()]).toEqual(['cursor']);
    expect(candidatePages[2].url.searchParams.get('per_page')).toBe('500');
    expect(gets('applications').filter((c) => c.url.searchParams.has('cursor'))).toHaveLength(1);
    expect(gets('rejection_reasons')[0].url.searchParams.get('include_defaults')).toBe('true');
    expect(gets('users')[0].url.searchParams.get('show_service_accounts')).toBe('true');
    expect(gets('offers')[0].url.searchParams.get('current_only')).toBe('true');
    expect(gets('notes')[0].url.searchParams.get('type')).toBe('NOTE,EMAIL,LINKEDIN_NOTE,LINKEDIN_INMAIL,TOUCHPOINT');
    // One batched call per applications page for each join, the candidate row included.
    expect(gets('application_stages')).toHaveLength(2);
    expect(gets('candidates').filter((c) => c.url.searchParams.has('ids')).map((c) => c.url.searchParams.get('ids'))).toEqual([
      '4455120009,4455120010',
      '4455120008,4455120007',
    ]);
    expect(gets('job_posts').map((c) => c.url.searchParams.get('active'))).toEqual([null, 'false']);
    // Scorecard joins are batched across scorecards, not fetched one scorecard at a time.
    expect(gets('scorecard_question_answers')).toHaveLength(1);
    expect(gets('scorecard_questions')).toHaveLength(1);
    expect(gets('scorecard_question_options')).toHaveLength(1);
    expect(gets('scorecard_candidate_attributes')).toHaveLength(1);

    // ----- Jobs and requisitions -----
    const reqs = await db.requisition.findMany({ where: { orgId }, orderBy: { code: 'asc' } });
    expect(reqs.map((r) => ({ code: r.code, state: r.state, openings: r.openings, filled: r.filled }))).toEqual([
      { code: 'GH-4455200002', state: 'CLOSED', openings: 1, filled: 0 },
      { code: 'REQ-2026-014', state: 'OPEN', openings: 2, filled: 1 },
    ]);
    const postings = await db.posting.findMany({ where: { orgId }, include: { department: true, requisition: true } });
    const backend = postings.find((p) => p.title === 'Senior Backend Engineer, Payments')!;
    expect(backend).toMatchObject({
      state: 'DRAFT',
      // The post's own locations (free text, an office, a board location), not the job's offices.
      location: 'Remote (US); San Francisco, CA, USA; Toronto, Canada',
      workplaceType: 'REMOTE',
      commitment: 'FULL_TIME',
      // The Base Salary range, though OTE has the higher priority and the larger numbers.
      salaryMin: 185000,
      salaryMax: 215000,
      salaryCurrency: 'USD',
    });
    expect(backend.department!.name).toBe('Platform Engineering');
    expect(backend.requisition!.code).toBe('REQ-2026-014');
    expect((backend.content as { description: string }).description).toContain('• Own the ledger service');
    expect(backend.createdAt.toISOString()).toBe('2026-01-10T15:00:00.000Z');
    const designer = postings.find((p) => p.title === 'Product Designer')!;
    // No post locations or pay ranges: the job's office and its salary custom field.
    expect(designer).toMatchObject({
      state: 'CLOSED', location: 'San Francisco, CA, USA', workplaceType: 'ONSITE', commitment: 'CONTRACT',
      salaryMin: 140000, salaryMax: 165000, salaryCurrency: 'EUR',
    });
    expect((designer.content as { description: string }).description).toContain('Design the future of payments.');
    expect(postings).toHaveLength(2); // the template job is skipped

    // ----- Candidates -----
    const contacts = await db.contact.findMany({ where: { orgId } });
    const jordan = contacts.find((c) => c.emails.includes('jordan.alvarez@example.com'))!;
    expect(jordan).toMatchObject({
      name: 'Jo Alvarez',
      emails: ['jordan.alvarez@example.com', 'jalvarez@stripe.example'],
      phones: ['+1 415-555-0142'],
      links: ['https://jordanalvarez.dev', 'https://www.linkedin.com/in/jordanalvarez', 'https://github.com/jalvarez'],
      headline: 'Software Engineer II at Stripe',
      location: '1 Market St, San Francisco, CA 94105',
      tags: ['backend', 'referral-2026'],
    });
    expect(jordan.createdAt.toISOString()).toBe('2026-02-03T19:44:10.000Z');
    expect(jordan.resumeFileId).not.toBeNull();
    const casey = contacts.find((c) => c.name === 'Casey Nguyen')!;
    expect(casey.resumeFileId).not.toBeNull(); // expired link was refreshed

    // ----- Applications -----
    const opps = await db.opportunity.findMany({
      where: { orgId },
      include: {
        stage: true,
        archiveReason: true,
        posting: true,
        stageTransitions: { orderBy: { occurredAt: 'asc' }, include: { toStage: true } },
      },
    });
    const opp = (id: number) => opps.find((o) => importedId(o) === String(id))!;

    const active = opp(4455500001);
    expect(active).toMatchObject({
      status: 'ACTIVE',
      origin: 'APPLIED',
      source: 'LinkedIn',
      ownerId: adminId,
      archivedAt: null,
      confidential: false,
    });
    expect(active.stage.name).toBe('Technical Interview');
    expect(active.posting!.title).toBe('Senior Backend Engineer, Payments');
    expect(active.stageTransitions.map((t) => t.toStage.name)).toEqual(['Application Review', 'Recruiter Phone Screen', 'Technical Interview']);
    expect(active.stageTransitions[0].fromStageId).toBeNull();
    expect(active.stageTransitions[1].occurredAt.toISOString()).toBe('2026-09-02T14:00:00.000Z');
    expect(active.stageChangedAt.toISOString()).toBe('2026-09-10T16:30:00.000Z');
    expect(active.createdAt.toISOString()).toBe('2026-08-30T17:12:44.000Z');
    // Application custom fields and answers, plus the candidate's own custom fields.
    expect(importedFields(active)).toEqual({
      'Notice period': '2 weeks',
      'Why Acme?': 'I love payments infra.',
      'Candidate · Desired Salary': '$210k',
    });

    const rejected = opp(4455500002);
    expect(rejected).toMatchObject({ status: 'ARCHIVED', origin: 'SOURCED', source: 'LinkedIn (Prospecting)', confidential: true });
    expect(rejected.archiveReason).toMatchObject({ name: 'Lacking skill(s)/qualification(s)', countsAsRejection: true });
    expect(rejected.archivedAt!.toISOString()).toBe('2026-05-04T17:22:09.000Z');
    expect(rejected.stage.name).toBe('Portfolio Review'); // where they stopped
    expect(rejected.posting).toMatchObject({ title: 'Product Designer', state: 'CLOSED' });

    // A hire sits in Hired like one made in Source: no archive date or reason. It was hired when the
    // opening it filled closed, weeks after entering Offer (which it never left in Greenhouse).
    const hired = opp(4455500003);
    expect(hired).toMatchObject({ status: 'HIRED', origin: 'REFERRED', source: 'Referral', archiveReasonId: null, archivedAt: null });
    expect(hired.stage).toMatchObject({ name: 'Hired', type: 'HIRED' });
    expect(hired.stageTransitions.map((t) => t.toStage.name)).toEqual([
      'Application Review', 'Recruiter Phone Screen', 'Technical Interview', 'On-site', 'Offer', 'Hired', // Onsite → the org's On-site
    ]);
    expect(hired.stageTransitions.at(-2)!.occurredAt.toISOString()).toBe('2026-06-09T20:00:00.000Z');
    expect(hired.stageTransitions.at(-1)!.occurredAt.toISOString()).toBe('2026-06-20T14:03:00.000Z');
    expect(hired.stageChangedAt.toISOString()).toBe('2026-06-20T14:03:00.000Z');
    expect(importedFields(hired)).toEqual({ 'Referred by': 'Marcus Oyelaran' });

    // Credited to someone, but sourced: the Prospecting source decides the origin.
    const prospect = opp(4455500004);
    expect(prospect).toMatchObject({ status: 'ACTIVE', origin: 'SOURCED', ownerId: adminId, confidential: true });
    expect(prospect.stage).toMatchObject({ name: 'Prospect', type: 'LEAD' });
    expect(prospect.posting!.title).toBe('Senior Backend Engineer, Payments');
    expect(prospect.stageTransitions.map((t) => t.toStage.name)).toEqual(['Prospect']);
    expect(importedFields(prospect)).toEqual({ 'Credited to': 'Marcus Oyelaran' });

    // ----- Notes (bylines only for authors who aren't teammates) -----
    const notes = await db.note.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' } });
    const bodies = notes.map((n) => n.body);
    expect(bodies).toEqual(
      expect.arrayContaining([
        'Strong phone screen. Moving to technical.\nNeeds sponsorship: no.',
        'Email: Next steps with Acme\nFrom priya.raman@acme.example to jordan.alvarez@example.com\n\nHi Jordan,\n\nThanks for your time today...',
        `[${BYLINE} · Marcus Oyelaran] Portfolio is strong but the case study lacked depth on research.`,
        '(Private note in Greenhouse)\nComp expectations: 205k base. Keep confidential.',
        // A scorecard with no decision, attribute notes included.
        'Systems Design\nNeed to see more on data modeling before deciding.\nCommunication: Hard to read over video',
      ]),
    );
    expect(bodies.some((b) => b.includes('was moved into'))).toBe(false); // ACTIVITY filtered
    expect(bodies.some((b) => b.includes('Background check'))).toBe(false); // admin-only
    const email = notes.find((n) => n.body.startsWith('Email:'))!;
    expect(email.opportunityId).toBe(active.id); // candidate-level → latest application
    expect(email.authorId).toBe(adminId);
    expect(notes.filter((n) => n.body.includes('Attachment:')).map((n) => n.body.split(' — ')[0]).sort()).toEqual([
      `[${BYLINE}] Attachment: Offer_Letter.pdf`,
      `[${BYLINE}] Attachment: cover_letter.docx`,
    ]);

    // ----- Interviews and scorecards -----
    const interviews = await db.interview.findMany({ where: { orgId }, include: { panelists: true }, orderBy: { startAt: 'desc' } });
    expect(interviews).toHaveLength(2);
    expect(interviews[0]).toMatchObject({
      title: 'Systems Design',
      durationMins: 60,
      location: 'SF HQ — Room Golden Gate · https://acme.zoom.us/j/81234567890',
      state: 'COMPLETED',
      opportunityId: active.id,
    });
    expect(interviews[0].startAt.toISOString()).toBe('2026-09-15T18:00:00.000Z');
    expect(interviews[0].panelists.map((p) => p.id)).toEqual([adminId]);
    expect(interviews[1]).toMatchObject({ title: 'Portfolio Review Session', durationMins: 90 });

    const feedback = await db.feedbackSubmission.findMany({ where: { orgId } });
    expect(feedback).toHaveLength(2);
    const strongYes = feedback.find((f) => f.overallRating === 4)!;
    expect(strongYes.interviewId).toBe(interviews[0].id);
    expect(strongYes.summary).toBe(
      `[${BYLINE} · Marcus Oyelaran] Systems Design\nExcellent systems design. Drove the conversation and handled failure modes well.\n\n` +
        'Public notes: Recommend a deeper dive on data modeling in the onsite.\n\nPrivate notes: Comp expectations may be above band.',
    );
    expect(strongYes.answers).toEqual({
      'imported-0': { label: 'How did the candidate approach the design problem?', kind: 'TEXT', value: 'Proposed token bucket per tenant with Redis; discussed hot-key mitigation.' },
      'imported-1': { label: 'Would you want to work with this person?', kind: 'TEXT', value: 'Yes' },
      'imported-2': { label: 'Strengths observed', kind: 'TEXT', value: 'Distributed systems, Communication' },
      // Key attributes, in the job's attribute order.
      'imported-3': { label: 'Systems thinking', kind: 'TEXT', value: 'Strong yes — Clear, structured thinker' },
      'imported-4': { label: 'Communication', kind: 'TEXT', value: 'Mixed' },
    });
    expect(strongYes.createdAt.toISOString()).toBe('2026-09-15T19:12:30.000Z');
    const strongNo = feedback.find((f) => f.overallRating === 1)!;
    expect(strongNo).toMatchObject({ authorId: adminId, interviewId: interviews[1].id, opportunityId: rejected.id });
    expect(strongNo.answers).toEqual({ 'imported-0': { label: 'Research depth', kind: 'TEXT', value: 'Shallow' } });

    // ----- Offers -----
    const offers = await db.offer.findMany({ where: { orgId } });
    expect(offers).toHaveLength(2); // the Deprecated version is not current
    const accepted = offers.find((o) => o.status === 'ACCEPTED')!;
    expect(accepted).toMatchObject({
      opportunityId: hired.id,
      jobTitle: 'Senior Backend Engineer',
      salaryAmount: 205000,
      salaryCurrency: 'USD',
      equity: '0.05% over 4 years',
      notes: 'Employment Type: Full-time',
    });
    expect(accepted.startDate!.toISOString()).toBe('2026-07-13T00:00:00.000Z');
    expect(accepted.sentAt!.toISOString()).toBe('2026-06-10T00:00:00.000Z');
    expect(accepted.respondedAt!.toISOString()).toBe('2026-06-12T12:00:00.000Z');
    const draft = offers.find((o) => o.status === 'DRAFT')!;
    expect(draft).toMatchObject({ opportunityId: active.id, salaryAmount: 198000, salaryCurrency: 'USD', equity: null, sentAt: null });
    expect(draft.startDate!.toISOString()).toBe('2026-10-19T00:00:00.000Z');

    // ----- Files: signed S3 links fetched without credentials; the expired one refreshed -----
    const s3 = mock.calls.filter((c) => c.url.host === S3);
    expect(s3.map((c) => c.url.searchParams.get('X-Amz-Signature'))).toEqual(['denied', 'expired', 'fresh4', 'good3', 'good2', 'good1']);
    const relisted = gets('attachments').map((c) => c.url.searchParams.get('ids')).filter(Boolean);
    expect(relisted).toEqual(['4455960005', '4455960004']);
    // The redirect endpoint refused a bare request, so it got one retry with the token; S3 never sees it.
    const redirect = mock.calls.filter((c) => c.url.host === 'app.greenhouse.io');
    expect(redirect.map((c) => c.headers.authorization ?? null)).toEqual([null, `Bearer ${mock.issued[0]}`]);
    const stored = await db.storedFile.findMany({ where: { orgId } });
    expect(Object.fromEntries(stored.map((f) => [f.filename, f.mime]))).toEqual({
      'Jordan_Alvarez_Resume.pdf': 'application/pdf',
      'cover_letter.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Offer_Letter.pdf': 'application/pdf', // served as text/html
      'Casey_Nguyen_Resume.pdf': 'application/pdf',
    });
    expect(stored.every((f) => f.contactId === (f.filename.startsWith('Jordan') || f.filename.startsWith('cover') ? jordan.id : casey.id))).toBe(true);
  });

  it('re-running into the same org creates nothing new and downloads nothing it already has', async () => {
    expect(firstOrg).not.toBe('');
    const count = async () => ({
      contacts: await db.contact.count({ where: { orgId: firstOrg } }),
      opportunities: await db.opportunity.count({ where: { orgId: firstOrg } }),
      notes: await db.note.count({ where: { orgId: firstOrg } }),
      stages: await db.stage.count({ where: { orgId: firstOrg } }),
      files: await db.storedFile.count({ where: { orgId: firstOrg } }),
      offers: await db.offer.count({ where: { orgId: firstOrg } }),
    });
    const before = await count();

    const mock = greenhouseApi({ redirectNeedsBearer: true });
    const again = await runImportForTest({ module: greenhouseProvider, credentials: CREDENTIALS, fetchImpl: mock.impl, orgId: firstOrg });
    expect(again.status).toBe('SUCCEEDED');
    expect(again.view.created).toEqual({});
    expect(await count()).toEqual(before);
    expect(again.review!.stages.every((s) => 'stageId' in s.target)).toBe(true);
    // Only the file storage refused last time is tried again.
    expect(mock.calls.filter((c) => c.url.host === S3).map((c) => c.url.searchParams.get('X-Amz-Signature'))).toEqual(['denied']);
    // Already-imported applications don't trigger history/candidate lookups.
    expect(mock.calls.filter((c) => c.url.pathname === '/v3/application_stages')).toHaveLength(0);
    expect(mock.unmatched).toEqual([]);
  });

  it('imports only the active pipeline since a date, and warns about scopes it lacks', async () => {
    const missing = ['harvest:pay_input_ranges:list', 'harvest:scorecard_candidate_attributes:list'];
    const mock = greenhouseApi({
      tokenLifetime: 6,
      scopes: GRANTED.filter((s) => !missing.includes(s)),
      // A missing scope is documented only as "an authorization error": 403, or 401 even on a fresh token.
      deny: { pay_input_ranges: 403, scorecard_candidate_attributes: 401 },
    });
    const result = await runImportForTest({
      module: greenhouseProvider,
      credentials: CREDENTIALS,
      fetchImpl: mock.impl,
      options: { archived: false, since: '2026-06-01T00:00:00.000Z' },
    });
    expect(result.error).toBeNull();
    expect(result.status).toBe('SUCCEEDED');
    expect(mock.unmatched).toEqual([]);
    expectNoLeaks(mock);

    // Tokens "expired" mid-run; each 401 was answered by minting a new one and retrying.
    expect(mock.expired.length).toBeGreaterThan(0);
    expect(mock.issued.length).toBeGreaterThan(2);

    const issues = result.view.issues.map((i) => i.message);
    expect(issues).toContainEqual(expect.stringMatching(/missing 2 scope\(s\).*harvest:pay_input_ranges:list.*harvest:scorecard_candidate_attributes:list/));
    expect(issues).toContainEqual(expect.stringMatching(/^Skipped pay ranges: .*Grant the harvest:pay_input_ranges:list scope/));
    expect(issues).toContainEqual(
      expect.stringMatching(/^Skipped scorecard attribute ratings: .*Grant the harvest:scorecard_candidate_attributes:list scope/),
    );

    const apps = mock.calls.filter((c) => c.url.pathname === '/v3/applications' && !c.url.searchParams.has('prospect'));
    expect(apps[0].url.searchParams.get('status')).toBe('active');
    expect(apps[0].url.searchParams.get('created_at')).toBe('gte|2026-06-01T00:00:00.000Z');
    // No org-wide candidate crawl: the two needed candidates came in one id-filtered call
    // (repeated only if that call hit an expired token).
    const candidateCalls = listCalls(mock, 'candidates');
    expect(candidateCalls.length).toBeGreaterThan(0);
    expect(candidateCalls.every((c) => c.url.searchParams.get('ids') === '4455120009,4455120007')).toBe(true);

    expect(result.view.created).toEqual({
      requisition: 2, posting: 2, contact: 2, opportunity: 2, interview: 1, feedback: 2, note: 2, offer: 1, file: 2,
    });
    const contacts = await db.contact.findMany({ where: { orgId: result.orgId }, select: { name: true } });
    expect(contacts.map((c) => c.name).sort()).toEqual(['Jo Alvarez', 'Riley Park']);
    const opps = await db.opportunity.findMany({ where: { orgId: result.orgId } });
    expect(opps.every((o) => o.status === 'ACTIVE')).toBe(true);
    // Without the pay ranges scope, salary falls back to the job's custom field.
    const backend = await db.posting.findFirstOrThrow({ where: { orgId: result.orgId, title: 'Senior Backend Engineer, Payments' } });
    expect(backend).toMatchObject({ salaryMin: 180000, salaryMax: 220000 });
    // Casey's hire isn't imported, so neither is the offer letter on it (nor Casey's resume: no contact).
    const files = await db.storedFile.findMany({ where: { orgId: result.orgId }, select: { filename: true } });
    expect(files.map((f) => f.filename).sort()).toEqual(['Jordan_Alvarez_Resume.pdf', 'cover_letter.docx']);
  });

  it('switches to the created_at[gte] filter syntax when Greenhouse refuses the other', async () => {
    const mock = greenhouseApi({ dateSyntax: 'bracket' });
    const result = await runImportForTest({
      module: greenhouseProvider,
      credentials: CREDENTIALS,
      fetchImpl: mock.impl,
      options: { since: '2026-06-01T00:00:00.000Z' },
    });
    expect(result.error).toBeNull();
    expect(result.status).toBe('SUCCEEDED');
    expect(mock.unmatched).toEqual([]);
    expect(result.view.issues.map((i) => i.message).join(' ')).not.toContain('created_at');

    const dated = mock.calls.filter((c) => c.url.searchParams.has('created_at') || c.url.searchParams.has('created_at[gte]'));
    // One refused attempt at the first syntax; the slice then sticks to the one that worked.
    expect(dated.filter((c) => c.url.searchParams.has('created_at')).map((c) => c.url.pathname)).toEqual(['/v3/candidates']);
    expect(dated.slice(1).every((c) => c.url.searchParams.get('created_at[gte]') === '2026-06-01T00:00:00.000Z')).toBe(true);
    // Filtered server-side: applications from before the date were never listed.
    expect(listCalls(mock, 'applications').filter((c) => c.url.searchParams.has('cursor'))).toHaveLength(0);

    expect(result.view.created).toMatchObject({ contact: 2, opportunity: 2, interview: 1, feedback: 2, note: 2, offer: 1 });
    const opps = await db.opportunity.findMany({ where: { orgId: result.orgId } });
    expect(opps.map(importedId).sort()).toEqual(['4455500001', '4455500004']);
  });

  it('survives a refused date filter and a stale page cursor', async () => {
    const mock = greenhouseApi({ dateSyntax: 'none', staleCursorOnce: '/v3/applications' });
    const result = await runImportForTest({
      module: greenhouseProvider,
      credentials: CREDENTIALS,
      fetchImpl: mock.impl,
      options: { since: '2026-06-01T00:00:00.000Z' },
    });
    expect(result.error).toBeNull();
    expect(result.status).toBe('SUCCEEDED');
    expect(mock.unmatched).toEqual([]);

    const issues = result.view.issues.map((i) => i.message);
    expect(issues).toContain('Greenhouse rejected the created_at filter on /v3/candidates; filtering after download instead');
    expect(issues.some((m) => m.includes('saved page cursor for /v3/applications'))).toBe(true);
    // The applications list was restarted from its first page after the stale cursor.
    const appPages = mock.calls.filter((c) => c.url.pathname === '/v3/applications' && !c.url.searchParams.has('prospect'));
    expect(appPages.filter((c) => c.url.searchParams.has('cursor'))).toHaveLength(2);

    // Still only what was created since the date: the loader and the adapter filter after download.
    expect(result.view.created).toMatchObject({ contact: 2, opportunity: 2, interview: 1, feedback: 2, note: 2, offer: 1, file: 2 });
    const opps = await db.opportunity.findMany({ where: { orgId: result.orgId } });
    expect(opps.map(importedId).sort()).toEqual(['4455500001', '4455500004']);
  });
});

// Phase-level checks: one phase against the mock with a recording loader, so no database.
describe('greenhouse adapter phases', () => {
  it.each(['seconds', 'iso', 'expires_at'] as const)(
    'reads a token lifetime given as %s, and reuses the token across slices',
    async (tokenExpiry) => {
      const mock = greenhouseApi({ tokenExpiry });
      for (let slice = 0; slice < 2; slice++) {
        // A new credentials object and client per slice, as the runner builds them.
        const { ctx, adapter } = phaseContext(mock);
        await runPhase(adapter.discover.find((p) => p.id === 'stages')!, ctx);
      }
      expect(listCalls(mock, 'job_interview_stages')).toHaveLength(2);
      expect(mock.issued).toHaveLength(1);
    },
  );

  it('resumes below the last id it handled when rows leave a page between slices', async () => {
    const apps = [1, 2, 3, 4, 5, 6].map((n) => application(4455500100 + n, { candidate_id: 4455120007, job_id: 4455200001 }));
    const mock = greenhouseApi({ data: { applications: apps }, pageSize: { applications: 3 } });
    const { ctx, adapter, loaded } = phaseContext(mock, { options: { archived: false } });
    ctx.outOfTime = () => true; // every step stops after one row
    await runPhase(loadPhase(adapter, 'applications'), ctx, (step) => {
      // A recruiter rejects the first one handled (it leaves the status=active list),
      // then the second is deleted: each shifts the rest of the page up a place.
      if (step === 0) apps.find((a) => a.id === 4455500106)!.status = 'rejected';
      if (step === 1) apps.splice(apps.findIndex((a) => a.id === 4455500105), 1);
    });
    expect(loaded.application.map((a) => a.externalId)).toEqual([
      '4455500106', '4455500105', '4455500104', '4455500103', '4455500102', '4455500101',
    ]);
  });

  it('ends a list with a pass for rows created while it was being read', async () => {
    const apps = [1, 2, 3, 4].map((n) => application(4455500100 + n, { candidate_id: 4455120007, job_id: 4455200001 }));
    const mock = greenhouseApi({ data: { applications: apps } });
    const { ctx, adapter, loaded } = phaseContext(mock);
    ctx.outOfTime = () => true;
    await runPhase(loadPhase(adapter, 'applications'), ctx, (step) => {
      // Created after the crawl began: a higher id than anything it will page down to.
      if (step === 0) apps.push(application(4455500200, { candidate_id: 4455120007, job_id: 4455200001 }));
    });
    expect(loaded.application.map((a) => a.externalId)).toEqual([
      '4455500104', '4455500103', '4455500102', '4455500101', '4455500200',
    ]);
    // Mid-page stops refetch their page; the closing pass cost one request, the first page,
    // where it met rows the crawl began with.
    const pages = listCalls(mock, 'applications').map((c) => (c.url.searchParams.has('cursor') ? 'next' : 'first'));
    expect(pages).toEqual(['first', 'first', 'next', 'next', 'next', 'first']);
  });

  it('dates a hire by the opening it filled, then the accepted offer, then its last stage', async () => {
    const hiredApp = (id: number) =>
      application(id, { candidate_id: 4455120010, job_id: 4455200001, status: 'hired', updated_at: '2026-08-15T09:00:00.000Z' });
    const apps = [4455500301, 4455500302, 4455500303, 4455500304].map(hiredApp);
    const opening = { ...OPENINGS[0], id: 4455270101, application_id: 4455500301, closed_at: '2026-06-20T14:03:00.000Z' };
    const offer = (id: number, appId: number, status: string, resolved: string | null, version: number): Row => ({
      ...OFFERS[0], id, application_id: appId, status, resolved_at: resolved, version,
    });
    const mock = greenhouseApi({
      pageSize: { applications: 500 },
      data: {
        applications: apps,
        openings: [opening],
        offers: [
          offer(4455950101, 4455500301, 'Accepted', '2026-06-12T12:00:00.000Z', 1),
          offer(4455950102, 4455500302, 'Accepted', '2026-05-02T10:00:00.000Z', 2),
          offer(4455950103, 4455500302, 'Deprecated', null, 1),
        ],
        application_stages: [
          move(4455510301, 4455500301, 4455300005, '2026-06-09T20:00:00.000Z', null),
          move(4455510331, 4455500303, 4455300004, '2026-04-01T09:00:00.000Z', '2026-04-10T09:00:00.000Z'),
          move(4455510332, 4455500303, 4455300005, '2026-04-10T09:00:00.000Z', null),
        ],
      },
    });
    const { ctx, adapter, loaded } = phaseContext(mock);
    await runPhase(loadPhase(adapter, 'applications'), ctx);

    const byId = new Map((loaded.application as unknown as ImportedApplication[]).map((a) => [a.externalId, a]));
    const hiredAt = (id: number) => byId.get(String(id))!.history!.at(-1)!;
    expect(hiredAt(4455500301)).toEqual({ stage: { externalId: 'hired', name: 'Hired' }, at: new Date('2026-06-20T14:03:00.000Z') });
    expect(hiredAt(4455500302).at).toEqual(new Date('2026-05-02T10:00:00.000Z')); // no opening: the accepted offer
    expect(hiredAt(4455500303).at).toEqual(new Date('2026-04-10T09:00:00.000Z')); // entered its last stage
    expect(hiredAt(4455500304).at).toEqual(new Date('2026-08-15T09:00:00.000Z')); // nothing else: last update
    expect([...byId.values()].every((a) => a.status === 'hired' && a.stage?.externalId === 'hired')).toBe(true);
    expect(byId.get('4455500301')!.archivedAt).toEqual(new Date('2026-06-20T14:03:00.000Z'));
    // Both joins batched across the page.
    expect(listCalls(mock, 'openings')).toHaveLength(1);
    expect(listCalls(mock, 'offers')).toHaveLength(1);
  });

  it('decides origin by source, and flags confidential jobs and private candidates', async () => {
    const secret = { ...JOBS[0], id: 4455200003, name: 'Secret Exec Search', requisition_id: null, confidential: true };
    const mock = greenhouseApi({
      pageSize: { applications: 500 },
      data: {
        jobs: [...JOBS, secret],
        // Only Casey is private here, so the prospect's confidentiality can only come from its job.
        candidates: CANDIDATES.map((c) => ({ ...c, private: c.id === 4455120010 })),
        applications: [
          // A prospect for a confidential search, with someone credited.
          application(4455500401, { candidate_id: 4455120009, prospect: true, prospective_job_ids: [4455200003], source_id: 24, referrer_id: 4455700001 }),
          // Submitted by an agency; the source is a job board and someone is credited.
          application(4455500402, { candidate_id: 4455120007, job_id: 4455200001, source_id: 14, agency_note_id: 4455600099, referrer_id: 4455700001 }),
          application(4455500403, { candidate_id: 4455120007, job_id: 4455200001, source_id: 27, referrer_id: 4455700001 }),
          application(4455500404, { candidate_id: 4455120007, job_id: 4455200001, referrer_id: 4455700001 }),
          // Rejected, still carrying the stage it was in (the docs allow both).
          application(4455500405, {
            candidate_id: 4455120008, job_id: 4455200001, status: 'rejected', job_interview_stage_id: 4455300003,
            stage_name: 'Technical Interview', rejection_reason_id: 4455400005, rejected_at: '2026-09-03T12:00:00.000Z',
          }),
          application(4455500406, { candidate_id: 4455120010, job_id: 4455200001, source_id: 18 }),
        ],
      },
    });
    const { ctx, adapter, loaded } = phaseContext(mock);
    await runPhase(loadPhase(adapter, 'applications'), ctx);
    const app = (id: number) => (loaded.application as unknown as ImportedApplication[]).find((a) => a.externalId === String(id))!;

    expect(app(4455500401)).toMatchObject({
      origin: 'SOURCED', postingExternalId: '4455200003', confidential: true, fields: { 'Credited to': 'Marcus Oyelaran' },
    });
    expect(app(4455500402)).toMatchObject({ origin: 'AGENCY', confidential: false });
    expect(app(4455500403)).toMatchObject({ origin: 'REFERRED', fields: { 'Referred by': 'Marcus Oyelaran' } });
    expect(app(4455500404)).toMatchObject({ origin: 'REFERRED', source: null });
    expect(app(4455500405)).toMatchObject({
      status: 'archived',
      stage: { externalId: '4455300003', name: 'Technical Interview' },
      archiveReason: { externalId: '4455400005' },
      archivedAt: new Date('2026-09-03T12:00:00.000Z'),
    });
    expect(app(4455500406)).toMatchObject({ origin: 'INTERNAL', confidential: true }); // private candidate
    expect(listCalls(mock, 'referrers')).toHaveLength(1);
  });

  it('gives a repeated requisition id its own code, so no job loses its requisition', async () => {
    const job = (id: number, name: string, extra: Partial<Row> = {}): Row => ({ ...JOBS[0], id, name, requisition_id: 'REQ-1', ...extra });
    const mock = greenhouseApi({
      data: {
        jobs: [
          job(4455200010, 'Backend Engineer (template)', { is_template: true }),
          job(4455200011, 'Backend Engineer'),
          job(4455200012, 'Secret Exec Search', { confidential: true }),
        ],
      },
    });
    const { ctx, adapter, loaded } = phaseContext(mock);
    await runPhase(loadPhase(adapter, 'requisitions'), ctx);
    const reqs = loaded.requisition as unknown as ImportedRequisition[];
    expect(Object.fromEntries(reqs.map((r) => [r.externalId, r.code]))).toEqual({
      '4455200011': 'REQ-1',
      '4455200012': 'REQ-1 (GH-4455200012)',
    });
  });

  it('picks the base pay range by name, in each currency’s own minor unit', async () => {
    const job = (id: number, name: string): Row => ({ ...JOBS[0], id, name, requisition_id: null, office_ids: [], custom_fields: {} });
    const live = { internal: false, active: true, live: true };
    const mock = greenhouseApi({
      data: {
        jobs: [job(4455200021, 'Account Executive'), job(4455200022, 'Tokyo Engineer'), job(4455200023, 'Kuwait Analyst')],
        job_posts: [
          post(4455210021, 4455200021, 'Account Executive', live, '<p>Sell.</p>'),
          post(4455210022, 4455200022, 'Tokyo Engineer', live, '<p>Build.</p>'),
          post(4455210023, 4455200023, 'Kuwait Analyst', live, '<p>Analyze.</p>'),
        ],
        job_post_locations: [],
        pay_input_ranges: [
          payRange(4455250021, 4455251001, 4455210021, 'USD', 12000000, 15000000),
          payRange(4455250022, 4455251002, 4455210021, 'USD', 24000000, 30000000),
          payRange(4455250023, 4455251001, 4455210022, 'JPY', 8000000, 12000000),
          payRange(4455250024, 4455251001, 4455210023, 'KWD', 12000000, 18000000),
        ],
      },
      // The reference documents no job_post_ids filter on pay ranges.
      reject: { pay_input_ranges: ['job_post_ids'] },
    });
    const { ctx, adapter, loaded, warnings } = phaseContext(mock);
    await runPhase(loadPhase(adapter, 'postings'), ctx);
    const salary = Object.fromEntries(
      (loaded.posting as unknown as ImportedPosting[]).map((p) => [p.title, [p.salaryMin, p.salaryMax, p.salaryCurrency]]),
    );
    expect(salary).toEqual({
      'Account Executive': [120000, 150000, 'USD'],
      'Tokyo Engineer': [8000000, 12000000, 'JPY'],
      'Kuwait Analyst': [12000, 18000, 'KWD'],
    });
    // Refused the filter once, then read the whole (small) table instead.
    expect(listCalls(mock, 'pay_input_ranges').map((c) => c.url.searchParams.has('job_post_ids'))).toEqual([true, false]);
    expect(warnings).toEqual([]);
  });

  it('credits the organizer as a panelist only when they interviewed', async () => {
    const mock = greenhouseApi({
      data: {
        interviews: [interview(4455900101, { application_id: 4455500001, job_interview_id: 4455310001, organizer_id: 4455100013, starts_at: '2026-09-20T17:00:00.000Z', ends_at: '2026-09-20T17:45:00.000Z' })],
        interviewers: [
          interviewer(4455910101, 4455900101, 4455100013, 'sam.okafor@acme.example', null), // the organizer's own row
          interviewer(4455910102, 4455900101, 4455100012, 'marcus.oyelaran@acme.example', 4455800101),
          interviewer(4455910103, 4455900101, null, 'contractor@partner.example', null),
        ],
      },
    });
    const { ctx, adapter, loaded } = phaseContext(mock, { has: (kind) => kind === 'opportunity' });
    await runPhase(loadPhase(adapter, 'interviews'), ctx);
    const [iv] = loaded.interview as unknown as ImportedInterview[];
    expect(iv).toMatchObject({ title: 'Systems Design', durationMins: 45, panelistExternalUserIds: ['4455100012'] });
  });

  it('leaves out files of applications the import skipped, but offers their resume', async () => {
    const mock = greenhouseApi({
      data: {
        attachments: [
          attachment(4455960101, { application_id: 4455500002, candidate_id: 4455120008, type: 'resume', filename: 'Morgan_Lee.pdf', url: s3Url(RESUME_PATH, 'good1') }),
          attachment(4455960102, { application_id: 4455500002, candidate_id: 4455120008, type: 'cover_letter', filename: 'old_cover.docx', url: s3Url(COVER_PATH, 'good2') }),
          attachment(4455960103, { application_id: 4455500001, candidate_id: 4455120007, type: 'cover_letter', filename: 'cover_letter.docx', url: s3Url(COVER_PATH, 'good2') }),
        ],
      },
    });
    // Application 4455500002 was archived, so this (active-only) import skipped it.
    const has = (kind: RefKind, id: string) => kind === 'contact' || (kind === 'opportunity' && id === '4455500001');
    const { ctx, adapter, loaded } = phaseContext(mock, { has, options: { archived: false } });
    await runPhase(loadPhase(adapter, 'files'), ctx);
    const files = loaded.file as unknown as ImportedFile[];
    expect(files.map((f) => [f.externalId, f.kind, f.applicationExternalId])).toEqual([
      ['4455960103', 'other', '4455500001'],
      // The engine keeps it only if the contact has no resume yet.
      ['4455960101', 'resume', '4455500002'],
    ]);
    expect(mock.calls.filter((c) => c.url.host === S3)).toHaveLength(2);
  });

  it("never stores another candidate's file when Greenhouse ignores the id filter on a re-list", async () => {
    const mock = greenhouseApi({
      data: {
        attachments: [
          // Jordan's link has expired; re-listed by id, an ignored filter would put Casey's row first.
          attachment(4455960201, { application_id: 4455500001, candidate_id: 4455120007, type: 'resume', filename: 'Jordan.pdf', url: s3Url(RESUME_PATH, 'expired') }),
          attachment(4455960202, { application_id: 4455500003, candidate_id: 4455120010, type: 'resume', filename: 'Casey.pdf', url: s3Url(CASEY_RESUME_PATH, 'good9') }),
        ],
      },
      ignore: { attachments: ['ids'] },
      pageSize: { attachments: 1 },
    });
    const { ctx, adapter, downloads } = phaseContext(mock, { has: () => true });
    await runPhase(loadPhase(adapter, 'files'), ctx);

    const jordan = downloads.get('4455960201');
    expect(jordan).toBeInstanceOf(ImportHttpError);
    expect((jordan as ImportHttpError).status).toBe(403);
    expect((downloads.get('4455960202') as DownloadedFile).data.toString()).toContain('casey');
    // Casey's file was fetched once, for Casey.
    const s3 = mock.calls.filter((c) => c.url.host === S3).map((c) => `${c.url.pathname.split('/').pop()} ${c.url.searchParams.get('X-Amz-Signature')}`);
    expect(s3).toEqual(['Casey_Nguyen_Resume.pdf good9', 'Jordan_Alvarez_Resume.pdf expired']);
    // The re-list stopped at its first page instead of paging the whole table.
    const label = (c: { url: URL }) => (c.url.searchParams.has('ids') ? 'ids' : c.url.searchParams.has('cursor') ? 'next' : 'first');
    expect(listCalls(mock, 'attachments').map(label)).toEqual(['first', 'next', 'ids', 'first']);
  });
});
