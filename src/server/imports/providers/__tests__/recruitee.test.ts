import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/session', () => ({ isAdmin: () => true }));

import { providerMeta } from '@/lib/import-providers';
import { createHttpClient, ImportAuthError } from '@/server/imports/http';
import { db, hasDb, json, mockFetch, publicDns, runImportForTest, verifyForTest, type RouteHandler } from '@/server/imports/__tests__/harness';
import { catalogWriter, emptyCatalog } from '@/server/imports/mapping';
import {
  createRecruiteeProvider,
  ratingFromLabel,
  ratingFromScore,
  recruiteeProvider,
} from '@/server/imports/providers/recruitee';
import { DEFAULT_IMPORT_OPTIONS, type Cursor, type ImportOptions, type Loader, type PhaseContext, type RefKind } from '@/server/imports/types';

/**
 * Recruitee adapter against a mock of its ATS API, built from the example
 * payloads in apidocs.recruitee.com / docs.recruitee.com: integer ids,
 * microsecond ISO timestamps (seconds on search), sideloaded `references`,
 * `meta` paging on some lists and none on others, the post-Dec-2025 basic
 * /offers list, per-job pipeline copies, search hits that carry the
 * disqualification, list placements with only the 2021 key set (hire details
 * are on the profile), requisition openings only on the detail, and
 * CV/attachment links on S3.
 *
 * Undocumented shapes (spec §5.10, §5.14, §5.17) are modelled on the nearest
 * documented vocabulary: the activity feed on the candidate_moved webhook,
 * the offer-letter list on the letter detail, form answers on evaluation
 * answers. Tests below also feed the adapter shapes and behaviours those
 * guesses could get wrong (a feed that ignores its filters, another envelope,
 * an old /offers list that ignores `page`).
 */

const TOKEN = 'djh6M1ppSSt2aTlITEpBVFM2OUc4dz09';
const COMPANY = '49498';
const HOST = 'api.recruitee.com';
const S3 = 'recruitee-main.s3.eu-central-1.amazonaws.com';
const creds = { companyId: COMPANY, apiToken: TOKEN };
const brand = providerMeta('recruitee')?.name ?? 'recruitee';
const byline = (who?: string) => new RegExp(`^\\[${brand}${who ? ` · ${who}` : ''}\\] `, 'i');
const api = (path: string) => `GET ${HOST}/c/${COMPANY}${path}`;

// Two records per page and a four-hit search window: a handful of records exercises
// every pager and the re-anchoring that works around Elasticsearch's 10,000-hit cap.
const provider = createRecruiteeProvider({ pageSize: 2, searchWindow: 4 });

type Json = Record<string, unknown>;
type Req = Parameters<RouteHandler>[0];

const RESTRICTED_NOTES =
  'Skipped notes Recruitee restricts to certain users or roles: in Source, everyone who can see an application can read its notes';
const RESTRICTED_FILES =
  'Skipped attachments Recruitee restricts to certain users or roles: in Source, everyone who can see an application can open its files';
const noHistory = (why: string) => `Stage history: ${why}, so applications keep only their current stage and dates`;

// ---------- Team ----------

const admin = (id: number, first: string, last: string, email: string) => ({
  id,
  type: 'Admin',
  email,
  timezone: 'Europe/Amsterdam',
  first_name: first,
  last_name: last,
  has_avatar: false,
  initials: `${first[0]}${last[0]}`,
  photo_normal_url: null,
  photo_thumb_url: null,
  time_format24: true,
  anonymized_at: null,
});
const MARCELINE = admin(5724, 'Marceline', 'Example', 'admin@example.test'); // the test org's admin
const FORMER = admin(5725, 'Former', 'Recruiter', 'former.recruiter@example.com');
const PAT = admin(8876, 'Pat', 'Interviewer', 'pat.interviewer@example.com');
const GUEST = { id: 110, name: 'James Smith', type: 'Guest', email: 'james@partner-agency.com', has_avatar: false, initials: 'JS', recruiter: false };

const membership = (id: number, adminId: number, role: string, roleAdmin: boolean, active: boolean) => ({
  id,
  admin_id: adminId,
  role,
  role_admin: roleAdmin,
  role_id: roleAdmin ? 2834 : 2835,
  created_at: '2024-03-11T09:02:13.137477Z',
  show_academy_button: true,
  offer_ids: [],
  talent_pool_ids: [],
  requisition_ids: [],
  is_active: active,
  accessible_placement_ids: [],
  is_approver: false,
  is_hiring_manager: roleAdmin,
  is_recruiter: true,
  two_factor_auth_enabled: false,
});
const MEMBERSHIPS = [
  { m: membership(2725, 5724, 'Admin', true, true), a: MARCELINE },
  { m: membership(2726, 5725, 'Corporate Recruiter', false, false), a: FORMER },
  { m: membership(2727, 8876, 'Hiring Manager', false, true), a: PAT },
];

// ---------- Jobs and their own pipeline copies ----------

const stage = (id: number, name: string, position: number, group: string, category: string, pipeline: number) => ({
  id,
  name,
  position,
  group,
  category,
  created_at: '2025-01-20T10:03:42.061738Z',
  updated_at: '2025-01-20T10:03:42.061738Z',
  fair_evaluations_enabled: false,
  action_templates: [],
  pipeline_template_id: pipeline,
  locked: position < 0,
  placements_count: 0,
  time_limit: category === 'phone_screen' ? 604800 : null,
  candidate_anonymization_enabled: false,
  automation_ids: [],
});
const PIPELINES: Record<number, ReturnType<typeof stage>[]> = {
  7555: [
    stage(61735, 'Referred', -3, 'applicants', 'referred', 7555),
    stage(61736, 'Sourced', -2, 'applicants', 'sourced', 7555),
    stage(61737, 'Applied', -1, 'applicants', 'apply', 7555),
    stage(61738, 'Phone interview', 1, 'active', 'phone_screen', 7555),
    stage(61739, 'On-site interview', 2, 'active', 'interview', 7555),
    stage(61740, 'Offer', 3, 'active', 'offer', 7555),
    stage(61741, 'Hired', 4, 'hires', 'hire', 7555),
  ],
  4405001: [
    stage(4405721, 'Referred', -3, 'applicants', 'referred', 4405001),
    stage(4405722, 'Sourced', -2, 'applicants', 'sourced', 4405001),
    stage(4405723, 'Applied', -1, 'applicants', 'apply', 4405001),
    stage(4405724, 'Phone interview', 1, 'active', 'phone_screen', 4405001),
    stage(4405725, 'Culture fit', 2, 'active', 'none', 4405001),
    stage(4405727, 'On-site interview', 3, 'active', 'interview', 4405001),
    stage(4405729, 'Offer', 4, 'active', 'offer', 4405001),
    stage(4405730, 'Hired', 5, 'hires', 'hire', 4405001),
  ],
};
const stageRef = (id: number) => {
  const s = Object.values(PIPELINES).flat().find((x) => x.id === id)!;
  return { ...s, type: 'Stage' };
};

/** The post-Dec-2025 basic list shape. */
const OFFERS = [
  {
    id: 744511, position: 1, status: 'published', title: 'Senior Backend Engineer', category: 'information_technology',
    slug: 'senior-backend-engineer', guid: 'k3m9x2', lang_code: 'en', published_at: '2025-02-03T09:15:00.000000Z',
    department_id: 95727, closed_at: null, education: 'bachelor_degree', employment_type: 'fulltime_permanent',
    experience: 'experienced', hiring_manager_id: 5724, pipeline_template_id: 7555, recruiter_id: 5724, followed: false,
    mailbox_email: 'job.k3m9x2.acme@inbound.recruitee.com',
  },
  {
    id: 487967, position: 3, status: 'archived', title: 'Office Manager', category: 'accountancy', slug: 'office-manager',
    guid: 'p7q2z8', lang_code: 'en', published_at: '2023-06-01T08:00:00.000000Z', department_id: null,
    closed_at: '2023-09-30T16:00:00.000000Z', education: null, employment_type: 'fulltime', experience: null,
    hiring_manager_id: null, pipeline_template_id: 4405001, recruiter_id: 5725, followed: false,
    mailbox_email: 'job.p7q2z8.acme@inbound.recruitee.com',
  },
];
const OFFER_REQUISITIONS: Record<number, number[]> = { 744511: [219], 487967: [] };

const OFFER_DETAILS: Record<number, Json> = {
  744511: {
    ...OFFERS[0], kind: 'job', primary_lang_code: 'en',
    description: '<p>We are looking for a backend engineer&hellip;</p>\n',
    requirements: '<ul>\n\t<li>5+ years Elixir or Ruby</li>\n</ul>\n',
    highlight_html: '<p>Remote-friendly</p>\n', description_html: null, requirements_html: null,
    description_json: null, requirements_json: null, wysiwyg_editor: 'redactor', department: 'Product',
    location: 'Amsterdam, Netherlands', city: 'Amsterdam', street: 'Raadhuisstraat', postal_code: '1012',
    state_code: 'NH', state_name: 'Noord-Holland', country_code: 'NL', location_ids: [214599],
    remote: false, on_site: false, hybrid: true, min_hours: 32, max_hours: 40,
    salary: { min: '60000', max: '80000', period: 'year', currency: 'EUR' }, number_of_openings: 1, priority: null,
    created_at: '2025-01-20T10:03:42.049831Z', updated_at: '2025-04-01T08:00:00.000000Z',
    careers_url: 'https://acme.recruitee.com/o/senior-backend-engineer',
    pipeline_template: { id: 7555, title: 'Engineering pipeline', default: false, custom: false, stages: [PIPELINES[7555][3]] },
    tags: [{ id: 188, name: 'Engineering' }], offer_tags: [], followers: [], admins: [], dynamic_fields: [], fields: [],
  },
  487967: {
    ...OFFERS[1], kind: 'job', primary_lang_code: 'en',
    description: '<p>Keep our Amsterdam office running.</p>\n', requirements: null, description_html: null,
    department: null, location: 'Amsterdam, Netherlands', city: 'Amsterdam', country_code: 'NL', location_ids: [214599],
    remote: false, on_site: true, hybrid: false, salary: { min: '3500', max: '4000', period: 'month', currency: 'EUR' },
    created_at: '2023-05-20T08:00:00.000000Z', updated_at: '2023-09-30T16:00:00.000000Z', tags: [],
  },
};

/** List items: `openings_count` and an empty `openings` array; no hires or fills (spec §5.7). */
const reqListItem = (p: Json) => ({
  form: { fields: ['department'], dynamic_field_ids: [] }, dynamic_fields: [], offers_count: 1, notes_count: 0,
  attachments_count: 0, followed: false, department_id: null, archived_at: null, follower_ids: [], openings: [],
  location: null, department_name: null, requester_name: 'Marceline Example', state_name: null,
  recruiter_name: 'Marceline Example', hiring_manager_name: null, ...p,
});
const REQUISITIONS: Record<string, Json[]> = {
  active: [
    reqListItem({
      id: 219, status: 'approved', title: 'Backend Engineer (2026 H1)', guid: 'REQ-0023', openings_count: 2,
      created_at: '2025-01-10T14:07:14.507253Z', updated_at: '2025-01-12T09:00:00.000000Z', notes_count: 2,
      department_id: 95727, department_name: 'Product',
    }),
    // Approved, and its only opening is filled: done hiring.
    reqListItem({
      id: 230, status: 'approved', title: 'Data Analyst', guid: 'REQ-0030', openings_count: 1, offers_count: 0,
      created_at: '2025-02-01T09:00:00.000000Z', updated_at: '2025-03-01T09:00:00.000000Z',
    }),
  ],
  archived: [
    reqListItem({
      id: 204, status: 'approved', title: 'Office Manager', guid: 'REQ-0011', openings_count: 1,
      created_at: '2023-05-10T09:00:00.000000Z', updated_at: '2023-10-01T09:00:00.000000Z', archived_at: '2023-10-01T09:00:00.000000Z',
    }),
  ],
};
const opening = (id: number, placement: { id: number; candidate: number; name: string } | null, filledAt: string | null = null) => ({
  id,
  status: placement ? 'filled' : 'open',
  placement: placement && { id: placement.id, candidate: { id: placement.candidate, name: placement.name, anonymized_at: null, deleted_at: null }, disqualify_reason: null },
  placement_id: placement?.id ?? null,
  filled_at: filledAt,
});
const reqDetailExtras = { approval_request: null, openings_with_deleted_candidate_count: 0, approval_flow_id: 281, rejection_reason: null, rejected_by_id: null };
/** GET /requisitions/{id}: the only place openings are filled in. */
const REQUISITION_DETAILS: Record<number, Json> = {
  219: {
    ...REQUISITIONS.active[0], ...reqDetailExtras, hires_count: 1,
    offers: [{ id: 744511, status: 'published', title: 'Senior Backend Engineer', slug: 'senior-backend-engineer' }],
    openings: [opening(48, null), opening(49, { id: 29327897, candidate: 28057517, name: 'Jane Doe' })],
  },
  230: { ...REQUISITIONS.active[1], ...reqDetailExtras, hires_count: 1, offers: [], openings: [opening(52, { id: 1204, candidate: 2364, name: 'Sam Lee' }, '2025-03-01T09:00:00.000000Z')] },
  204: {
    ...REQUISITIONS.archived[0], ...reqDetailExtras, hires_count: 1,
    offers: [{ id: 487967, status: 'archived', title: 'Office Manager', slug: 'office-manager' }],
    openings: [opening(31, { id: 28978242, candidate: 27746490, name: 'John Smith' }, '2021-09-10T00:00:00.000000Z')],
  },
};

const REASONS = {
  disqualify_reasons: [
    { id: 42, name: 'Not a fit', position: 1, action_templates: [{ data: { tags: ['tag1'] }, id: 171, kind: 'add_tags', references: [] }], automation_ids: [], open_questions_count: 0 },
    { id: 43, name: 'Withdrew', position: 2, action_templates: [], automation_ids: [], open_questions_count: 0 },
    { id: 44, name: 'Hired elsewhere', position: 3, action_templates: [], automation_ids: [], open_questions_count: 0 },
  ],
};

// ---------- Candidates (search hit, list item, profile) ----------

const BACKEND = { id: 744511, kind: 'job', slug: 'senior-backend-engineer', status: 'published', title: 'Senior Backend Engineer', location_ids: [214599] };
const OFFICE = { id: 487967, kind: 'job', slug: 'office-manager', status: 'archived', title: 'Office Manager', location_ids: [214599] };
/** Talent pools come through the search as placements on an offer of kind talent_pool. */
const POOL = { id: 77, kind: 'talent_pool', slug: 'future-engineers', status: 'published', title: 'Future engineers', location_ids: [] };

/** A search-hit placement: stage and job embedded, disqualification spelled out, no created_at. */
const hp = (p: Json) => ({
  disqualified: false, disqualified_at: null, disqualified_by: null, disqualified_by_name: null, disqualify_kind: null,
  disqualify_reason: null, is_hired: false, hired_at: null, job_starts_at: null, eeo_data_status: null, location_ids: [],
  overdue_at: null, overdue_diff: null, positive_ratings: null, rating_visible: true, screening_enabled: false,
  screening_score: null, ...p,
});
/** A /candidates list placement, the 2021 key set: ids, stage and dates only. */
const lp = (p: Json) => ({ language: null, overdue_at: null, overdue_diff: null, position: 1, ...p });
/** A profile placement (the 2026 show serializer): adds the hire details. */
const dp = (p: Json) => ({
  position: 1, language: null, talent_pool_id: null, ratings: {}, positive_ratings: null, hired_at: null, hired_by_id: null,
  hired_in_other_placement: false, hired_in_this_placement: false, department_id: null, department_name: null,
  work_location_id: null, overdue_diff: null, overdue_at: null, job_starts_at: null, ...p,
});
const visibility = (level: 'public' | 'protected', adminIds: number[] = []) => ({ level, admin_ids: adminIds, role_ids: [] });

type Fixture = { hit: Json & { id: number; created_at: string; updated_at: string }; listed: Json; detail?: Json; refs: number[] };

const hitBase = {
  initials: '', assigned_admins_ids: [], rating: null, positive_ratings: null, rating_visible: true, gdpr_status: 'no_consent',
  gdpr_expires_at: null, gdpr_consent_ever_given: false, deleted: false, deleted_at: null, soft_deleted_at: null,
  deleted_by: null, deleted_by_name: null, is_anonymous: false, example: false, new: false, highlight: null,
  has_avatar: false, photo_thumb_url: null, unread_notifications: false, linkedin_job_application_id: null,
};

const JOHN_HIRED = {
  hit: hp({
    id: 28978242, candidate_id: 27746490, offer: OFFICE, stage: { id: 4405730, name: 'Hired', time_limit: null },
    is_hired: true, hired_at: '2021-09-10T00:00:00Z', job_starts_at: '2021-10-01T00:00:00Z',
  }),
  listed: lp({
    candidate_id: 27746490, created_at: '2021-08-19T10:21:08.958698Z', id: 28978242, offer_id: 487967, position: 7,
    stage_id: 4405730, updated_at: '2021-09-10T12:00:00.000000Z',
  }),
  detail: dp({
    id: 28978242, position: 7, candidate_id: 27746490, created_at: '2021-08-19T10:21:08.958698Z',
    updated_at: '2021-09-10T12:00:00.000000Z', offer_id: 487967, stage_id: 4405730, ratings: { strong_yes: 1, yes: 1 },
    positive_ratings: 88, hired_at: '2021-09-10T00:00:00.000000Z', hired_by_id: 5724, hired_in_this_placement: true,
    work_location_id: 214599, job_starts_at: '2021-10-01T00:00:00.000000Z',
  }),
};
const JOHN_ELSEWHERE = {
  hit: hp({
    id: 28978243, candidate_id: 27746490, offer: BACKEND, stage: { id: 61737, name: 'Applied', time_limit: null },
    disqualified: true, disqualified_at: '2021-09-10T12:00:01Z', disqualify_kind: 'system', disqualify_reason: 'Hired elsewhere',
  }),
  listed: lp({
    candidate_id: 27746490, created_at: '2021-08-20T09:00:00.000000Z', id: 28978243, offer_id: 744511, position: 3,
    stage_id: 61737, updated_at: '2021-09-10T12:00:01.000000Z',
  }),
  detail: dp({
    id: 28978243, position: 3, candidate_id: 27746490, created_at: '2021-08-20T09:00:00.000000Z',
    updated_at: '2021-09-10T12:00:01.000000Z', offer_id: 744511, stage_id: 61737, hired_in_other_placement: true,
    disqualify_reason: 'Hired elsewhere', disqualify_kind: 'system',
  }),
};

const JOHN: Fixture = {
  hit: {
    ...hitBase, id: 27746490, company_id: 49498, name: 'John Smith', initials: 'JS',
    emails: ['john@example.com', 'john.smith@gmail.com'], phones: ['+31 6 1234 5678'],
    social_links: ['https://www.linkedin.com/in/johnsmith/'], source: 'manual', sources: ['LinkedIn'],
    tags: ['Python developer'], admin_id: 5724, positive_ratings: 88,
    created_at: '2021-08-19T10:21:07Z', updated_at: '2021-09-10T12:00:01Z', last_activity_at: '2021-09-10T12:00:01Z',
    placements: [JOHN_HIRED.hit, JOHN_ELSEWHERE.hit],
  },
  listed: {
    admin_id: 135145, created_at: '2021-08-19T10:21:07.114867Z', emails: ['john@example.com'], example: false, id: 27746490,
    name: 'John Smith', phones: ['123123123'], referrer: null, source: 'manual', ratings: { strong_yes: 1, yes: 1 },
    ratings_count: 2, is_hired: true, is_anonymous: false,
    placements: [JOHN_HIRED.listed, JOHN_ELSEWHERE.listed],
  },
  detail: {
    id: 27746490, name: 'John Smith', salutation: null, title: 'Senior Developer',
    emails: ['john@example.com', 'john.smith@gmail.com'], invalid_emails: [], phones: ['+31 6 1234 5678'],
    links: ['https://www.example.com/'], social_links: ['https://www.linkedin.com/in/johnsmith/', 'https://github.com/johnsmith'],
    source: 'manual', sources: ['LinkedIn'], sourcing_origin: null, sourcing_data: null, referrer: null, referral_referrers_ids: [],
    tags: [{ id: 46, name: 'Python developer' }, { id: 47, name: 'Relocation' }], admin_id: 5724, admin_ids: [5724],
    cover_letter: 'Example cover letter', has_cover_letter: true,
    cover_letter_file_url: `https://${S3}/candidates/27746490/pdf_cover_letter_k2j4m1.pdf`,
    cover_letter_file_original_url: `https://${S3}/candidates/27746490/cover_letter_k2j4m1.pdf`,
    cv_url: `https://${S3}/candidates/27746490/pdf_cv_x8kq2n0c.pdf`,
    cv_original_url: `https://${S3}/candidates/27746490/cv_x8kq2n0c.docx`,
    cv_processing_status: 'ok',
    fields: [
      { fixed: true, id: 50282100, kind: 'address', origin: 'manual', values: [{ text: 'Keizersgracht 313, 1016 EE Amsterdam, Netherlands' }], visibility: visibility('public'), visible: true, is_anonymous: false },
      { fixed: true, id: 50282101, kind: 'experience', origin: 'manual', values: [{ title: 'Senior Developer', company: 'Initech', location: 'Amsterdam', description: 'Backend platform', start_date: '2019-03-01', end_date: null }], visibility: visibility('public'), visible: true, is_anonymous: false },
      { fixed: true, id: null, kind: 'education', origin: 'manual', values: [], visibility: visibility('public'), visible: true, is_anonymous: false },
      { fixed: true, id: null, kind: 'skills', origin: 'manual', values: [{ text: 'SQL' }, { text: 'Elixir' }], visibility: visibility('public'), visible: true },
      { fixed: null, id: 50282189, kind: 'single_line', name: 'Notice period', origin: 'manual', values: [{ text: '1 month' }], visibility: visibility('public'), visible: true },
      // Only named admins may see it in Recruitee; everyone who can see the application would in Source.
      { fixed: null, id: 50282190, kind: 'single_line', name: 'Salary expectation', origin: 'manual', values: [{ text: '85k' }], visibility: visibility('protected', [5724]), visible: true },
    ],
    custom_fields: [],
    // Item shape undocumented (spec §5.17): modelled on the evaluation answers' vocabulary.
    open_question_answers: [
      { id: 901, open_question_id: 31, offer_id: 744511, question_title: 'Why do you want to join Acme?', question_kind: 'multi_line', content: 'I want to work on developer tools.' },
      { id: 902, open_question_id: 32, offer_id: 487967, question_title: 'Can you start within a month?', question_kind: 'boolean', content: 'yes' },
    ],
    grouped_open_question_answers: [],
    placements: [JOHN_HIRED.detail, JOHN_ELSEWHERE.detail],
    duplicates: [27721862], is_hired: true, is_anonymous: false, example: false,
    notes_count: 1, attachments_count: 1, created_at: '2021-08-19T10:21:07.114867Z', updated_at: '2021-09-10T12:00:01.000000Z',
  },
  refs: [4405730, 61737],
};

const JANE: Fixture = {
  hit: {
    ...hitBase, id: 28057517, company_id: 49498, name: 'Jane Doe', initials: 'JD', emails: ['jane@example.com'], phones: [],
    social_links: [], source: 'career_site', sources: [], tags: [], admin_id: null,
    created_at: '2021-09-01T13:51:27Z', updated_at: '2021-09-09T16:20:37Z', last_activity_at: '2021-09-09T16:20:37Z',
    placements: [hp({ id: 29327897, candidate_id: 28057517, offer: BACKEND, stage: { id: 61739, name: 'On-site interview', time_limit: null } })],
  },
  listed: {
    admin_id: null, created_at: '2021-09-01T13:51:27.079963Z', emails: ['jane@example.com'], example: false, id: 28057517,
    name: 'Jane Doe', phones: [], referrer: null, source: 'career_site',
    placements: [
      lp({ candidate_id: 28057517, created_at: '2021-09-01T13:51:30.243946Z', id: 29327897, offer_id: 744511, position: 8, stage_id: 61739, updated_at: '2021-09-08T09:30:00.000000Z' }),
    ],
  },
  detail: {
    id: 28057517, name: 'Jane Doe', title: null, emails: ['jane@example.com'], phones: [], links: [], social_links: [],
    source: 'career_site', sources: [], tags: [], fields: [], open_question_answers: [], cover_letter: null,
    // The test fixture style of path: relative, so there is no CV to fetch.
    cv_url: null, cv_original_url: 'tmp/bow/candidates/28057517/cv_7hlwffcb.pdf',
    placements: [dp({ id: 29327897, candidate_id: 28057517, created_at: '2021-09-01T13:51:30.243946Z', updated_at: '2021-09-08T09:30:00.000000Z', offer_id: 744511, stage_id: 61739 })],
    created_at: '2021-09-01T13:51:27.079963Z',
  },
  refs: [61739],
};

const STEPHANIE: Fixture = {
  hit: {
    ...hitBase, id: 1711504, company_id: 49498, name: 'Stephanie Wood', initials: 'SW', emails: ['stephanie.wood@example.com'],
    phones: ['123456789'], social_links: [], source: 'manual', sources: [], tags: [], admin_id: 21775,
    created_at: '2021-10-27T15:20:20Z', updated_at: '2022-03-25T09:00:33Z', last_activity_at: '2021-10-27T15:21:43Z',
    placements: [
      hp({
        id: 2001897, candidate_id: 1711504, offer: BACKEND, stage: { id: 61738, name: 'Phone interview', time_limit: 604800 },
        disqualified: true, disqualified_at: '2021-11-05T10:12:00Z', disqualified_by: 5724, disqualified_by_name: 'Marceline Example',
        disqualify_kind: 'admin', disqualify_reason: 'Not a fit', overdue_at: '2021-11-03T15:21:43Z', overdue_diff: -13460272,
      }),
    ],
  },
  listed: {
    id: 1711504, name: 'Stephanie Wood', referrer: null, source: 'manual', example: false,
    placements: [lp({ candidate_id: 1711504, created_at: '2021-10-27T15:21:00.000000Z', id: 2001897, offer_id: 744511, stage_id: 61738, updated_at: '2021-11-05T10:12:00.000000Z' })],
  },
  detail: {
    id: 1711504, name: 'Stephanie Wood', title: null, emails: ['stephanie.wood@example.com'], phones: ['123456789'],
    links: [], social_links: [], tags: [], cv_url: null, cv_original_url: null, source: 'manual', referrer: null, referral_referrers_ids: [],
    fields: [{ fixed: true, kind: 'address', values: [{ text: 'Utrecht, Netherlands' }], visibility: visibility('public') }],
    placements: [
      dp({ id: 2001897, candidate_id: 1711504, created_at: '2021-10-27T15:21:00.000000Z', updated_at: '2021-11-05T10:12:00.000000Z', offer_id: 744511, stage_id: 61738, disqualify_reason: 'Not a fit', disqualify_kind: 'admin' }),
    ],
    created_at: '2021-10-27T15:20:20.000000Z',
  },
  refs: [61738],
};

const ALICE: Fixture = {
  hit: {
    ...hitBase, id: 2266, company_id: 49498, name: 'Alice Bob', initials: 'AB', emails: ['bob@example.com', 'alice@example.com'],
    phones: [], social_links: [], source: null, sources: [], tags: [], admin_id: 5724,
    created_at: '2021-12-01T09:00:00Z', updated_at: '2021-12-01T09:05:00Z', last_activity_at: '2021-12-01T09:05:00Z',
    placements: [
      hp({ id: 1120, candidate_id: 2266, offer: BACKEND, stage: { id: 61735, name: 'Referred', time_limit: null } }),
      // Talent pools are placements too, on an offer of kind talent_pool.
      hp({ id: 1121, candidate_id: 2266, offer: POOL, stage: null }),
    ],
  },
  listed: {
    id: 2266, name: 'Alice Bob', referrer: null, source: null, example: false,
    placements: [
      lp({ candidate_id: 2266, created_at: '2021-12-01T09:00:05.000000Z', id: 1120, offer_id: 744511, talent_pool_id: null, stage_id: 61735, updated_at: '2021-12-01T09:00:05.000000Z' }),
      lp({ candidate_id: 2266, created_at: '2021-12-01T09:01:00.000000Z', id: 1121, offer_id: null, talent_pool_id: 77, stage_id: null, updated_at: '2021-12-01T09:01:00.000000Z' }),
    ],
  },
  detail: {
    id: 2266, name: 'Alice Bob', title: null, emails: ['bob@example.com', 'alice@example.com'], phones: [], links: [],
    social_links: [], tags: [], cv_url: null, cv_original_url: null, fields: [], created_at: '2021-12-01T09:00:00.000000Z',
    placements: [
      dp({ id: 1120, candidate_id: 2266, created_at: '2021-12-01T09:00:05.000000Z', updated_at: '2021-12-01T09:00:05.000000Z', offer_id: 744511, stage_id: 61735 }),
      dp({ id: 1121, candidate_id: 2266, created_at: '2021-12-01T09:01:00.000000Z', updated_at: '2021-12-01T09:01:00.000000Z', offer_id: null, talent_pool_id: 77, stage_id: null }),
    ],
  },
  refs: [61735],
};

/** Recruitee's demo data: must never be imported. */
const EXAMPLE: Fixture = {
  hit: {
    ...hitBase, id: 999, company_id: 49498, name: 'Example Candidate', emails: ['example@recruitee.com'], phones: [],
    social_links: [], source: 'manual', sources: [], tags: [], example: true,
    created_at: '2022-01-15T08:00:00Z', updated_at: '2022-01-15T08:00:00Z',
    placements: [hp({ id: 5000, candidate_id: 999, offer: BACKEND, stage: { id: 61737, name: 'Applied', time_limit: null } })],
  },
  listed: { id: 999, example: true, placements: [] },
  refs: [],
};

const CANDIDATES = [JOHN, JANE, STEPHANIE, ALICE, EXAMPLE];

/** 2026 search responses describe the company's rating scale. */
const SCORE_BUCKETS = { presentation: 'stars', range: 5, buckets: [] };

// ---------- Activity: history, interviews, evaluations, notes, offer letters, files ----------

const move = (id: number, candidateId: number, event: string, at: string, by: number | null, stageId: number) => ({
  id,
  event,
  created_at: at,
  admin_id: by,
  candidate_id: candidateId,
  offer_id: 744511,
  details: { to_stage: { id: stageId, name: stageRef(stageId).name, category: stageRef(stageId).category } },
});
const ACTIVITIES = [
  move(70001, 28057517, 'candidate_offer_assign', '2021-09-01T13:51:30.300000Z', null, 61737),
  move(70002, 28057517, 'candidate_stage_change', '2021-09-03T10:00:00.000000Z', 5724, 61738),
  move(70003, 28057517, 'candidate_stage_change', '2021-09-08T09:30:00.000000Z', 5725, 61739),
  // Referred, then moved on: the stage she entered through, not the current one, names the origin.
  move(70101, 1711504, 'candidate_offer_assign', '2021-10-27T15:21:00.100000Z', null, 61735),
  move(70102, 1711504, 'candidate_stage_change', '2021-10-29T09:00:00.000000Z', 5724, 61738),
];

const eventBase = {
  talent_pool_id: null, timezone: 'Europe/Amsterdam', video_provider: null, video: null, interview_meeting_rooms: [],
  event_candidate_attendees: [], exclude_candidate_from_attendees: false, candidate_email: null, note: null, public_note: null,
  private: false, hide_candidates_names: false, scheduled: true, scheduler: 'Admin', rescheduled: false, rescheduled_at: null,
  interview_result_requests: [], interview_deferred_result_requests: [], reminders: [],
};
const EVENTS = [
  {
    ...eventBase, id: 209, kind: 'meeting', custom_name: 'Onsite: system design', candidate_id: 28057517, offer_id: 744511,
    stage_id: 61739, starts_at: '2021-09-09T13:00:00.000000Z', duration: 60, location: 'Amsterdam HQ, Room 3', video_url: null,
    admin_id: 8876, organizer_id: 8876, admin_ids: [5724, 8876],
    event_attendees: [{ admin_id: 5724, response_status: 'accepted' }, { admin_id: 8876, response_status: 'needs_action' }],
    note: 'Bring laptop', created_at: '2021-08-30T07:33:46.747590Z', updated_at: '2021-08-30T07:33:46.747590Z',
  },
  {
    ...eventBase, id: 210, kind: 'call', custom_name: null, candidate_id: 27746490, offer_id: 487967, stage_id: 4405727,
    starts_at: '2021-09-05T10:00:00.000000Z', duration: 30, location: null, video_url: null, admin_id: 5725, organizer_id: 5725,
    admin_ids: [5725], event_attendees: [{ admin_id: 5725, response_status: 'accepted' }],
    created_at: '2021-09-01T07:00:00.000000Z', updated_at: '2021-09-01T07:00:00.000000Z',
  },
];

const resultBase = {
  guest_id: null, talent_pool_id: null, interview_template_name: null, interview_template_info_title: null,
  interview_template_info_description: null, rating_note: null, rating_note_html: null, rating_note_json: null,
  pre_note_html: null, pre_note_json: null, post_note_html: null, post_note_json: null, skills_count: 0,
  matching_skills_count: 0, rating_required: null, interview_result_answers: [],
};
const answer = (id: number, kind: string, title: string, content: string) => ({
  id, visible: true, visibility: null, content, question_kind: kind, question_title: title, note_html: null, note_json: null,
  question_hash: `hash-${id}`, question_required: false, question_options: {}, question_hint: null,
});
const RESULTS: Record<number, Json> = {
  28057517: {
    meta: { counters: { pending: 0, completed: 2, dismissed: 0 } },
    references: [MARCELINE, FORMER, stageRef(61739)],
    interview_results: [
      {
        ...resultBase, id: 252, kind: 'rating', admin_id: 5724, candidate_id: 28057517, rating: 'strong_yes', offer_id: 744511,
        stage_id: 61739, rating_note: 'Great system design answers.', rating_note_html: '<p>Great system design answers.</p>',
        created_at: '2021-09-09T16:20:37.294248Z', updated_at: '2021-09-09T16:20:37.294248Z',
      },
      {
        // A form with no overall recommendation at all.
        ...resultBase, id: 290, kind: 'template_form', admin_id: 5725, candidate_id: 28057517, rating: null, offer_id: 744511,
        stage_id: 61739, interview_template_name: 'Culture interview', rating_required: false,
        post_note_html: '<p>No decision yet &mdash; I want a second opinion.</p>',
        interview_result_answers: [answer(301, 'text', 'Impressions', 'Asked good questions about the team')],
        created_at: '2021-09-09T17:00:00.000000Z', updated_at: '2021-09-09T17:00:00.000000Z',
      },
    ],
    hidden_results_preview: [],
  },
  27746490: {
    meta: { counters: { pending: 0, completed: 2, dismissed: 0 } },
    references: [GUEST, PAT, stageRef(4405727)],
    interview_results: [
      {
        ...resultBase, id: 287, kind: 'template_form', admin_id: null, guest_id: 110, candidate_id: 27746490, rating: 'no',
        offer_id: 487967, stage_id: 4405727, interview_template_name: 'Technical interview', rating_required: false,
        post_note_html: '<p>Solid, but not for this role.</p>',
        interview_result_answers: [
          answer(140, 'boolean', 'Do you like coding?', 'yes'),
          { ...answer(202, 'single_choice', 'Preferred stack', 'Elixir'), options: [{ title: 'Elixir', hint: null }, { title: 'Ruby', hint: null }] },
        ],
        created_at: '2021-09-05T11:05:38.077040Z', updated_at: '2021-09-05T11:05:38.077040Z',
      },
      {
        // A numeric scale: no label, only a score answer. The settings endpoint 403s below; the search's scale stands in.
        ...resultBase, id: 291, kind: 'template_form', admin_id: 8876, candidate_id: 27746490, rating: null, offer_id: 487967,
        stage_id: 4405727, interview_template_name: 'Hiring manager scorecard',
        interview_result_answers: [answer(305, 'overall_rating', 'Overall rating', '5'), answer(306, 'text', 'Strengths', 'Very organised')],
        created_at: '2021-09-06T09:00:00.000000Z', updated_at: '2021-09-06T09:00:00.000000Z',
      },
    ],
    hidden_results_preview: [],
  },
};

const noteBase = {
  guest_id: null, talent_pool_id: null, requisition_id: null, attachments: [], reply_to_id: null, triggered: false,
  pinned_at: null, reactions: [], visibility: visibility('public'), body_json: null,
};
const NOTES: Record<number, Json> = {
  28057517: {
    references: [MARCELINE, FORMER],
    notes: [
      {
        ...noteBase, id: 96, text: 'Strong phone screen, move to onsite.', body: '<p>Strong phone screen, move to onsite.</p>',
        body_html: '<p>Strong phone screen, move to onsite.</p>', admin_id: 5724, candidate_id: 28057517, offer_id: 744511,
        created_at: '2021-09-03T14:02:01.863376Z', updated_at: '2021-09-03T14:02:01.863376Z',
        reactions: [{ count: 1, position: 1, base: '👍', reactions: [{ unicode: '👍', admin_ids: [5952] }] }],
        replies: [
          {
            ...noteBase, id: 97, text: 'Agreed', body: '<p>Agreed</p>', body_html: '<p>Agreed</p>', admin_id: 5725,
            candidate_id: 28057517, offer_id: null, reply_to_id: 96, replies: [],
            created_at: '2021-09-03T15:10:44.864721Z', updated_at: '2021-09-03T15:10:44.864721Z',
          },
        ],
      },
      {
        // Restricted to one admin in Recruitee.
        ...noteBase, id: 98, text: 'HR only: salary expectation 95k, disclosed medical leave next spring.',
        body: '<p>HR only: salary expectation 95k, disclosed medical leave next spring.</p>',
        body_html: '<p>HR only: salary expectation 95k, disclosed medical leave next spring.</p>', admin_id: 5724,
        candidate_id: 28057517, offer_id: 744511, visibility: visibility('protected', [5724]), replies: [],
        created_at: '2021-09-04T08:00:00.000000Z', updated_at: '2021-09-04T08:00:00.000000Z',
      },
      {
        // About a job she was since removed from: there is no application for it to go on.
        ...noteBase, id: 99, text: 'Office role: references were poor.', body: '<p>Office role: references were poor.</p>',
        body_html: '<p>Office role: references were poor.</p>', admin_id: 5724, candidate_id: 28057517, offer_id: 487967,
        replies: [], created_at: '2021-09-02T08:00:00.000000Z', updated_at: '2021-09-02T08:00:00.000000Z',
      },
    ],
  },
  1711504: {
    // By a user who has since been removed: not listed, not in references.
    references: [],
    notes: [
      {
        ...noteBase, id: 150, text: null, body: '<p>Recruiter screen: <strong>not a fit</strong> for backend.</p>',
        body_html: '<p>Recruiter screen: <strong>not a fit</strong> for backend.</p>', admin_id: 99999, candidate_id: 1711504,
        offer_id: null, replies: [], created_at: '2021-11-05T10:15:00.000000Z', updated_at: '2021-11-05T10:15:00.000000Z',
      },
    ],
  },
};

const letterBase = {
  token: '71a24d4d-73e5-4be8-b824-ae2e630d7817', admin_id: 5724, visibility: visibility('protected', [5724]),
  email_subject: 'Your offer from Acme', email_body_html: '<p>Please find your offer attached.</p>', lang_code: 'en',
  start_date: { date: null, description: null, title: 'Start date' },
  summary: { enabled: false, description_html: null, description_json: null, heading: null },
  heading: { enabled: true, description_html: null, description_json: null, heading: 'Welcome to the team!' },
  intro: { enabled: false, description_html: null, description_json: null, heading: null },
  role_description: { enabled: false, description_html: null, description_json: null, heading: null },
  benefits: { enabled: true, items: [{ description: 'Fully paid', title: 'Insurance' }], heading: 'Benefits' },
  disclaimer: { enabled: false, description_html: null, description_json: null, heading: null },
  email_attachment_assignments: [], link_deactivated: false,
};
const salary = (value: string, period: string, description: string | null = null) => ({
  enabled: true, value, description, period, currency: 'EUR', heading: 'Salary',
});
/** Letters are only draft or sent; the placement says how each one ended. */
const LETTERS: Record<number, Json[]> = {
  27746490: [
    {
      // The first version, replaced by the one below.
      ...letterBase, id: 55, status: 'sent', title: 'Offer Letter for John Smith', candidate_id: 27746490, offer_id: 487967,
      details: [{ description: 'Office Manager', title: 'Position' }], salary: salary('68000', 'year'),
      published_at: '2021-09-06T10:00:00.000000Z', sent_at: '2021-09-06T10:00:00.000000Z',
      created_at: '2021-09-05T16:00:00.000000Z', updated_at: '2021-09-06T10:00:00.000000Z',
    },
    {
      ...letterBase, id: 56, status: 'sent', title: 'Offer Letter for John Smith', candidate_id: 27746490, offer_id: 487967,
      details: [{ description: 'Office Manager', title: 'Position' }, { description: 'Permanent', title: 'Contract type' }],
      published_at: '2021-09-08T10:00:00.000000Z', sent_at: '2021-09-08T10:00:00.000000Z',
      created_at: '2021-09-07T16:34:13.499473Z', updated_at: '2021-09-08T10:00:00.000000Z',
      email_body_html: '<p>Hi John, please find your offer attached.</p>', salary: salary('72000', 'year', 'Gross per year'),
      start_date: { date: '2021-10-01T00:00:00.000000Z', description: null, title: 'Start date' },
    },
    {
      // He took the other job: disqualified "Hired elsewhere", so this one was declined.
      ...letterBase, id: 57, status: 'sent', title: 'Offer Letter for John Smith', candidate_id: 27746490, offer_id: 744511,
      details: [{ description: 'Senior Backend Engineer', title: 'Position' }], salary: salary('80000', 'year'),
      published_at: '2021-09-09T10:00:00.000000Z', sent_at: '2021-09-09T10:00:00.000000Z',
      created_at: '2021-09-09T09:00:00.000000Z', updated_at: '2021-09-09T10:00:00.000000Z',
    },
  ],
  1711504: [
    {
      // Disqualified "Not a fit" after it was sent: the company withdrew it. Hourly pay has no annual figure.
      ...letterBase, id: 60, status: 'sent', title: 'Contract offer', candidate_id: 1711504, offer_id: 744511,
      details: [{ description: 'Senior Backend Engineer', title: 'Position' }], salary: salary('45', 'hour'),
      published_at: '2021-11-01T10:00:00.000000Z', sent_at: '2021-11-01T10:00:00.000000Z',
      created_at: '2021-10-31T12:00:00.000000Z', updated_at: '2021-11-01T10:00:00.000000Z',
    },
  ],
  28057517: [
    {
      ...letterBase, id: 61, status: 'draft', title: 'Offer Letter for Jane Doe', candidate_id: 28057517, offer_id: 744511,
      details: [], salary: { ...salary('', 'year'), enabled: false, value: null },
      published_at: null, sent_at: null, created_at: '2021-09-09T17:30:00.000000Z', updated_at: '2021-09-09T17:30:00.000000Z',
    },
  ],
};

const attachment = (id: number, candidateId: number, filename: string, url: string, extra: Json = {}) => ({
  id, status: 'ok', filename, extension: filename.split('.').pop(), source: 'candidate', kind: 'document', admin_id: 5724,
  candidate_id: candidateId, file_size: 482113, created_at: '2021-08-20T07:31:37.291540Z', image_thumbnail_url: null,
  image_url: null, file_url: url, offer_id: null, talent_pool_id: null, requisition_id: null, guest_id: null, uploader: null,
  visibility: visibility('public'), ...extra,
});
const ATTACHMENTS: Record<number, Json[]> = {
  27746490: [
    attachment(58, 27746490, 'portfolio.pdf', `https://${S3}/attachments/58/portfolio.pdf`),
    attachment(62, 27746490, 'background-check.pdf', `https://${S3}/attachments/62/background-check.pdf`, { visibility: visibility('protected', [5724]) }),
  ],
  28057517: [
    attachment(59, 28057517, 'notes.pdf', 'tmp/bow/attachments/59/notes.pdf'),
    // Filed under a job she has no application for.
    attachment(63, 28057517, 'office-references.pdf', `https://${S3}/attachments/63/office-references.pdf`, { offer_id: 487967 }),
  ],
};

// ---------- The mock API ----------

function paged<T>(items: T[], url: URL) {
  const limit = Number(url.searchParams.get('limit') ?? 1000);
  const page = Number(url.searchParams.get('page') ?? 1);
  return { slice: items.slice((page - 1) * limit, page * limit), meta: { limit, page, total_count: items.length } };
}

const forbidden = () => json({ error: 'Forbidden', error_code: null }, { status: 403 });
const notFound = () => json({ error: ['Page not found'] }, { status: 404 });
const bytes = (body: string, type: string) => new Response(body, { headers: { 'content-type': type } });

/**
 * The Elasticsearch search: filters in Unix seconds, `total` counts every
 * match. `hidden` hits are counted but left out of their page, as when a
 * candidate is deleted between the count and the page.
 */
function searchRoute(people: Fixture[], opts: { scale?: boolean; hidden?: number[] } = {}): RouteHandler {
  return ({ url }: Req) => {
    const filters = JSON.parse(url.searchParams.get('filters_json') ?? '[]') as { field: 'created_at' | 'updated_at'; gte: number }[];
    const sorted = people
      .map((c) => c.hit)
      .filter((h) => filters.every((f) => Math.floor(Date.parse(h[f.field]) / 1000) >= f.gte))
      .sort((a, b) => (url.searchParams.get('sort_by') === 'created_at_asc' ? 1 : -1) * (Date.parse(a.created_at) - Date.parse(b.created_at)));
    const limit = Number(url.searchParams.get('limit') ?? 60);
    const page = Number(url.searchParams.get('page') ?? 1);
    const hits = sorted.slice((page - 1) * limit, page * limit).filter((h) => !opts.hidden?.includes(h.id));
    return json({ aggregations: null, total: sorted.length, hits, ...(opts.scale === false ? {} : { score_buckets: SCORE_BUCKETS }) });
  };
}

function vendorRoutes(people: Fixture[] = CANDIDATES): Record<string, RouteHandler> {
  const routes: Record<string, RouteHandler> = {
    [api('/admin')]: () =>
      json({
        admin: {
          id: 5724, membership: { id: 2725, admin_id: 5724, role: 'Admin', role_admin: true, role_id: 2834, is_active: true },
          company_id: 49498, email: 'admin@example.test', timezone: 'Europe/Amsterdam', first_name: 'Marceline', last_name: 'Example',
          role_abilities: ['view_all_jobs', 'manage_api_tokens'], role_admin: true, role_id: 2834, role_name: 'Admin',
          all_companies_count: 2,
          companies: [
            { id: 1113, name: 'Other Company', subdomain: 'other', host: 'other.recruitee.com', host_protocol: 'https', status: 'active' },
            { id: 49498, name: 'Acme B.V.', subdomain: 'acme', host: 'acme.recruitee.com', host_protocol: 'https', status: 'active', is_admin: true },
          ],
          initials: 'ME', has_avatar: false,
        },
      }),
    [api('/memberships')]: ({ url }: Req) => {
      const { slice, meta } = paged(MEMBERSHIPS, url);
      return json({ meta, references: slice.map((x) => x.a), memberships: slice.map((x) => x.m) });
    },
    [api('/offers')]: ({ url }: Req) => {
      const withReqs = url.searchParams.getAll('include[]').includes('requisition_ids');
      const { slice, meta } = paged(OFFERS, url);
      return json({ meta, offers: slice.map((o) => (withReqs ? { ...o, requisition_ids: OFFER_REQUISITIONS[o.id] } : o)) });
    },
    [api('/disqualify_reasons')]: () => json(REASONS),
    [api('/requisitions')]: ({ url }: Req) => json({ requisitions: REQUISITIONS[url.searchParams.get('scope') ?? 'active'] }),
    [api('/search/new/candidates')]: searchRoute(people),
    [api('/candidates')]: ({ url }: Req) => {
      const ids = (url.searchParams.get('ids') ?? '').split(',').map(Number);
      const found = people.filter((c) => ids.includes(c.hit.id)).slice(0, Number(url.searchParams.get('limit') ?? 100));
      return json({
        candidates: found.map((c) => c.listed),
        generated_at: '2026-09-22T07:31:43.940422Z',
        references: [
          { ...BACKEND, type: 'Offer', kind: 'job', lang_code: 'en', position: 1, location: 'Amsterdam' },
          { ...OFFICE, type: 'Offer', kind: 'job', lang_code: 'en', position: 3, location: 'Amsterdam' },
          ...[...new Set(found.flatMap((c) => c.refs))].map(stageRef),
          MARCELINE,
        ],
      });
    },
    // Modelled on an API that honours both filters; tests below cover one that doesn't.
    [api('/tracking/activities')]: ({ url }: Req) => {
      const who = url.searchParams.getAll('candidates[]').map(Number);
      const events = url.searchParams.getAll('events[]');
      const { slice } = paged(ACTIVITIES.filter((a) => who.includes(a.candidate_id) && events.includes(a.event)), url);
      return json({ activities: slice });
    },
    [api('/interview/events')]: ({ url }: Req) => {
      if (url.searchParams.get('status') !== 'all') return json({ meta: { counters: {} }, references: [], interview_events: [] });
      const candidate = url.searchParams.get('candidate_id');
      if (candidate) return json({ meta: { counters: {} }, references: [], interview_events: EVENTS.filter((e) => e.candidate_id === Number(candidate)) });
      return json({ meta: { counters: { past_due: 2, upcoming: 0 } }, references: [], interview_events: paged(EVENTS, url).slice });
    },
    [api('/interview/results')]: ({ url }: Req) =>
      json(RESULTS[Number(url.searchParams.get('candidate_id'))] ?? { meta: { counters: {} }, references: [], interview_results: [], hidden_results_preview: [] }),
    // The token's role can't read company settings.
    [api('/candidates/settings/rating_scale')]: forbidden,
    [`GET ${S3}/candidates/27746490/cv_x8kq2n0c.docx`]: () =>
      bytes('PK-docx-John-Smith', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    [`GET ${S3}/candidates/27746490/cover_letter_k2j4m1.pdf`]: () => bytes('%PDF-1.4 cover letter', 'application/pdf'),
    [`GET ${S3}/attachments/58/portfolio.pdf`]: () => bytes('%PDF-1.4 portfolio', 'application/pdf'),
  };
  for (const id of [7555, 4405001]) {
    routes[api(`/pipeline_templates/${id}`)] = () =>
      json({ pipeline_template: { default: false, id, position: 1, title: 'Pipeline', category: 'SAMPLE CATEGORY', custom: false, stages: PIPELINES[id] } });
  }
  for (const [id, offer] of Object.entries(OFFER_DETAILS)) routes[api(`/offers/${id}`)] = () => json({ offer });
  for (const [id, requisition] of Object.entries(REQUISITION_DETAILS)) routes[api(`/requisitions/${id}`)] = () => json({ requisition });
  for (const c of people.filter((x) => x.detail)) {
    const id = c.hit.id;
    routes[api(`/candidates/${id}`)] = () => json({ candidate: c.detail, references: [MARCELINE] });
    routes[api(`/candidates/${id}/notes`)] = () => json(NOTES[id] ?? { references: [], notes: [] });
    routes[api(`/offer_letters/candidates/${id}/offer_letters`)] = () => json({ offer_letters: LETTERS[id] ?? [] });
    routes[api(`/candidates/${id}/attachments`)] = () =>
      json({ references: [MARCELINE], attachments: ATTACHMENTS[id] ?? [], hidden_attachments_exist: false });
  }
  return routes;
}

const importedId = (o: { customFields: unknown }) => (o.customFields as { imported: { id: string } }).imported.id;
const importedFields = (o: { customFields: unknown }) => (o.customFields as { imported: { fields?: Record<string, string> } }).imported.fields;
const pathsOf = (calls: { url: URL }[], pattern: RegExp) => calls.map((c) => c.url.pathname).filter((p) => pattern.test(p));

// ---------- Phase-level runs (no engine, no database writes) ----------

type Loaded = Record<string, Json[]>;

/**
 * One adapter phase against the mock, with a recording loader. The HTTP
 * client's retry back-off plays out instantly, so persistent 5xx and
 * network errors run to their end.
 */
function phaseContext(
  routes: Record<string, RouteHandler>,
  opts: { options?: Partial<ImportOptions>; has?: (kind: RefKind, id: string) => boolean; loader?: Partial<Loader> } = {},
) {
  const mock = mockFetch(routes);
  const http = createHttpClient({
    resolveHost: publicDns,
    auth: provider.auth(creds),
    minIntervalMs: 0,
    fetchImpl: mock.impl,
    sleep: async () => undefined,
  });
  const warnings: string[] = [];
  const loaded: Loaded = {};
  const load = new Proxy({} as Loader, {
    get: (_target, kind: string) =>
      opts.loader?.[kind as keyof Loader] ??
      (kind === 'has'
        ? async (k: RefKind, id: string) => opts.has?.(k, id) ?? false
        : async (record: Json) => {
            (loaded[kind] ??= []).push(record);
          }),
  });
  const options = { ...DEFAULT_IMPORT_OPTIONS, ...opts.options };
  const ctx: PhaseContext = {
    http,
    catalog: catalogWriter(emptyCatalog()),
    load,
    options,
    since: options.since ? new Date(options.since) : null,
    outOfTime: () => false,
    warn: (message) => {
      warnings.push(message);
    },
  };
  return { ctx, mock, warnings, loaded };
}

async function runPhase(ctx: PhaseContext, id: string) {
  const phase = provider.create(creds, ctx.http).load.find((p) => p.id === id)!;
  let cursor: Cursor | null = null;
  for (let i = 0; i < 100; i++) {
    cursor = await phase.run(ctx, cursor);
    if (cursor === null) return;
    cursor = JSON.parse(JSON.stringify(cursor)) as Cursor; // as the runner stores it
  }
  throw new Error(`${id} did not finish`);
}

const idsOf = (records: Json[] | undefined) => [...new Set((records ?? []).map((r) => String(r.externalId)))].sort();
const recordOf = (records: Json[] | undefined, externalId: string) => (records ?? []).find((r) => r.externalId === externalId);
const isOpportunity = (kind: RefKind) => kind === 'opportunity';

// ---------- Tests ----------

describe.skipIf(!hasDb)('recruitee mapping helpers', () => {
  it('maps recommendation labels onto the 1–4 scale', () => {
    expect(['strong_no', 'no', 'neutral', 'yes', 'strong_yes', 'maybe', null].map(ratingFromLabel)).toEqual([1, 2, 2, 3, 4, null, null]);
  });

  it('decodes thumbs scores by label and numeric scores by percentage', () => {
    expect([1, 3, 4, 5].map((s) => ratingFromScore(s, { presentation: 'thumbs_4', range: 5 }))).toEqual([2, 2, 3, 4]);
    expect([1, 2, 3, 4, 5].map((s) => ratingFromScore(s, { presentation: 'thumbs_5', range: 5 }))).toEqual([1, 2, 2, 3, 4]);
    expect([1, 2, 3, 4, 5].map((s) => ratingFromScore(s, { presentation: 'stars', range: 5 }))).toEqual([1, 2, 2, 3, 4]);
    expect([2, 5, 8, 10].map((s) => ratingFromScore(s, { presentation: 'numeric', range: 10 }))).toEqual([1, 2, 3, 4]);
    expect(ratingFromScore(4, null)).toBeNull();
  });
});

describe.skipIf(!hasDb)('recruitee verify', () => {
  it('names the company and sends the bearer token', async () => {
    const mock = mockFetch(vendorRoutes());
    await expect(verifyForTest(recruiteeProvider, creds, mock.impl)).resolves.toEqual({ accountName: 'Acme B.V.' });
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].url.toString()).toBe(`https://${HOST}/c/${COMPANY}/admin`);
    expect(mock.calls[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('accepts the careers subdomain in place of the id', async () => {
    const routes = vendorRoutes();
    const mock = mockFetch({ [`GET ${HOST}/c/acme/admin`]: routes[api('/admin')] });
    const res = await verifyForTest(recruiteeProvider, { companyId: 'https://acme.recruitee.com/', apiToken: TOKEN }, mock.impl);
    expect(res).toEqual({ accountName: 'Acme B.V.' });
    expect(mock.unmatched).toEqual([]);
  });

  it("refuses a company the token's user isn't in, instead of naming their own", async () => {
    const routes = vendorRoutes();
    const mock = mockFetch({ [`GET ${HOST}/c/77777/admin`]: routes[api('/admin')] });
    await expect(verifyForTest(recruiteeProvider, { companyId: '77777', apiToken: TOKEN }, mock.impl)).rejects.toThrow(
      "This token's user isn't in Recruitee company 77777. It can reach Other Company (1113), Acme B.V. (49498).",
    );
  });

  it('rejects a revoked token', async () => {
    const mock = mockFetch({
      [api('/admin')]: () =>
        json(
          { error: 'Token not found.', error_code: 'invalid_token' },
          { status: 401, headers: { 'www-authenticate': 'Bearer realm="recruitee", error="invalid_token"' } },
        ),
    });
    await expect(verifyForTest(recruiteeProvider, creds, mock.impl)).rejects.toBeInstanceOf(ImportAuthError);
  });

  it('builds its phase list without credentials', () => {
    const adapter = recruiteeProvider.create({}, createHttpClient({ resolveHost: publicDns, auth: { hosts: [] }, minIntervalMs: 0 }));
    expect(adapter.discover.map((p) => p.id)).toEqual(['users', 'stages', 'reasons']);
    // People and their applications load in one pass.
    expect(adapter.load.map((p) => p.id)).toEqual(['requisitions', 'postings', 'candidates', 'interviews', 'feedback', 'notes', 'offers', 'files']);
    expect(recruiteeProvider.auth(creds)).toEqual({ hosts: [HOST], headers: { authorization: `Bearer ${TOKEN}` } });
  });
});

describe.skipIf(!hasDb)('recruitee import', () => {
  let orgId = '';

  it('imports the whole account', async () => {
    const mock = mockFetch(vendorRoutes());
    const run = await runImportForTest({ module: provider, credentials: creds, fetchImpl: mock.impl });
    orgId = run.orgId;
    expect(run.error).toBeNull();
    expect(run.status).toBe('SUCCEEDED');
    expect(mock.unmatched).toEqual([]);

    // Read-only, and the token only ever goes to the API host.
    for (const call of mock.calls) {
      expect(call.method).toBe('GET');
      if (call.url.host === HOST) {
        expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`);
      } else {
        expect(call.url.host).toBe(S3);
        expect(call.headers.authorization).toBeUndefined();
        expect(JSON.stringify(call.headers) + call.url.toString()).not.toContain(TOKEN);
      }
    }
    // Restricted and other-job attachments are never downloaded.
    expect(mock.calls.filter((c) => c.url.host === S3).map((c) => c.url.pathname)).toEqual([
      '/candidates/27746490/cv_x8kq2n0c.docx',
      '/candidates/27746490/cover_letter_k2j4m1.pdf',
      '/attachments/58/portfolio.pdf',
    ]);

    // Paging: the search window re-anchored on the fourth hit's creation second instead of asking for page 3.
    const searches = mock.calls.filter((c) => c.url.pathname.endsWith('/search/new/candidates'));
    expect(searches.every((c) => c.url.searchParams.get('sort_by') === 'created_at_asc')).toBe(true);
    const pages = searches.map((c) => `${c.url.searchParams.get('page')}:${c.url.searchParams.get('filters_json') ?? ''}`);
    expect(pages.slice(0, 3)).toEqual(['1:', '2:', `1:[{"field":"created_at","gte":${Date.parse('2021-12-01T09:00:00Z') / 1000}}]`]);
    expect(mock.calls.filter((c) => c.url.pathname.endsWith('/memberships')).map((c) => c.url.searchParams.get('page'))).toEqual(['1', '2']);
    // The feed at its documented page size, per search page, for the candidates with something new.
    const feed = mock.calls.filter((c) => c.url.pathname.endsWith('/tracking/activities'));
    expect(feed.map((c) => c.url.searchParams.get('page'))).toEqual(['1', '2', '1', '2']);
    expect(feed.map((c) => c.url.searchParams.getAll('candidates[]').join(','))).toEqual([
      '27746490,28057517', '27746490,28057517', '1711504,2266', '1711504,2266',
    ]);
    // Past interviews are only listed with status=all; each new scorecard's candidate is asked once for linking.
    const events = mock.calls.filter((c) => c.url.pathname.endsWith('/interview/events'));
    expect(events.filter((c) => !c.url.searchParams.has('candidate_id')).map((c) => [c.url.searchParams.get('status'), c.url.searchParams.get('page')])).toEqual([
      ['all', '1'],
      ['all', '2'],
    ]);
    expect(events.filter((c) => c.url.searchParams.has('candidate_id')).map((c) => c.url.searchParams.get('candidate_id'))).toEqual(['27746490', '28057517']);
    // Openings are read from each requisition's detail.
    expect(pathsOf(mock.calls, /\/requisitions\/\d+$/).sort()).toEqual(['/c/49498/requisitions/204', '/c/49498/requisitions/219', '/c/49498/requisitions/230']);
    // Demo data is never fetched.
    expect(mock.calls.some((c) => c.url.pathname.includes('/999'))).toBe(false);

    // Review: fifty jobs' copies of one stage collapse into one row.
    const stages = Object.fromEntries(run.review!.stages.map((s) => [s.key, s]));
    expect(stages['phone interview'].count).toBe(2);
    expect(stages['phone interview'].target).toEqual({ create: { name: 'Phone interview', type: 'SCREEN' } });
    expect(stages['on-site interview'].target).toEqual({ create: { name: 'On-site interview', type: 'ONSITE' } });
    expect(stages['sourced'].target).toEqual({ create: { name: 'Sourced', type: 'LEAD' } });
    expect(stages['referred'].target).toEqual({ create: { name: 'Referred', type: 'APPLICANT' } });
    expect(stages['culture fit'].target).toEqual({ create: { name: 'Culture fit', type: 'SCREEN' } });
    expect(stages['offer'].target).toHaveProperty('stageId');
    expect(stages['hired'].count).toBe(2);
    expect(run.review!.reasons.map((r) => [r.name, r.kind])).toEqual([
      ['Not a fit', 'rejection'],
      ['Withdrew', 'withdrawn'],
      ['Hired elsewhere', 'withdrawn'],
    ]);
    expect(run.review!.users).toMatchObject({ total: 3, matched: 1 });

    expect(run.view.created).toEqual({
      requisition: 3, posting: 2, contact: 4, file: 3, opportunity: 5, interview: 2, feedback: 4, note: 3, offer: 5,
    });
    // The rating-scale 403 is covered by the scale the search describes: no warning for it.
    expect(run.view.issues.map((i) => i.message)).toEqual([RESTRICTED_NOTES, RESTRICTED_FILES]);

    // Requisitions: fills and openings from the detail; approved and fully filled is closed.
    const reqs = await db.requisition.findMany({ where: { orgId }, orderBy: { code: 'asc' } });
    expect(reqs.map((r) => [r.code, r.title, r.state, r.openings, r.filled])).toEqual([
      ['REQ-0011', 'Office Manager', 'CLOSED', 1, 1],
      ['REQ-0023', 'Backend Engineer (2026 H1)', 'OPEN', 2, 1],
      ['REQ-0030', 'Data Analyst', 'CLOSED', 1, 1],
    ]);
    const postings = await db.posting.findMany({ where: { orgId }, include: { department: true, requisition: true } });
    const backend = postings.find((p) => p.title === 'Senior Backend Engineer')!;
    expect(backend).toMatchObject({
      state: 'DRAFT', location: 'Amsterdam, Netherlands', workplaceType: 'HYBRID', commitment: 'FULL_TIME',
      salaryMin: 60000, salaryMax: 80000, salaryCurrency: 'EUR', tags: ['Engineering'],
    });
    expect(backend.department?.name).toBe('Product');
    expect(backend.requisition?.code).toBe('REQ-0023');
    expect(backend.createdAt.toISOString()).toBe('2025-01-20T10:03:42.049Z');
    expect((backend.content as { description: string }).description).toBe(
      'We are looking for a backend engineer…\n\nRequirements\n• 5+ years Elixir or Ruby',
    );
    const office = postings.find((p) => p.title === 'Office Manager')!;
    expect(office).toMatchObject({ state: 'CLOSED', workplaceType: 'ONSITE', salaryMin: 42000, salaryMax: 48000, departmentId: null });
    expect((office.content as { description: string }).description).toContain('Salary: 3500–4000 EUR per month');

    // Candidates: the full profile, deduped emails, talent pools as tags, demo data skipped
    const contacts = await db.contact.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' } });
    expect(contacts.map((c) => c.name)).toEqual(['John Smith', 'Jane Doe', 'Stephanie Wood', 'Alice Bob']);
    const john = contacts[0];
    expect(john).toMatchObject({
      headline: 'Senior Developer at Initech',
      location: 'Keizersgracht 313, 1016 EE Amsterdam, Netherlands',
      emails: ['john@example.com', 'john.smith@gmail.com'],
      phones: ['+31 6 1234 5678'],
      links: ['https://www.example.com/', 'https://www.linkedin.com/in/johnsmith/', 'https://github.com/johnsmith'],
      tags: ['Python developer', 'Relocation'],
    });
    expect(john.createdAt.toISOString()).toBe('2021-08-19T10:21:07.114Z');
    expect(john.resumeFileId).not.toBeNull();
    const cv = await db.storedFile.findUniqueOrThrow({ where: { id: john.resumeFileId! } });
    expect(cv).toMatchObject({
      filename: 'John Smith CV.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', contactId: john.id,
    });
    expect(contacts[1].resumeFileId).toBeNull(); // relative (unusable) CV path
    expect(contacts[2].location).toBe('Utrecht, Netherlands');
    expect(contacts[3].tags).toEqual(['Talent pool: Future engineers']);

    // Applications: status, reasons, dates, origin, owner, history
    const opps = await db.opportunity.findMany({
      where: { orgId },
      include: {
        stage: true, archiveReason: true, posting: true, owner: true,
        stageTransitions: { orderBy: { occurredAt: 'asc' }, include: { toStage: true } },
      },
    });
    expect(opps.map(importedId).sort()).toEqual(
      ['1711504:744511', '2266:744511', '27746490:487967', '27746490:744511', '28057517:744511'].sort(),
    );
    const opp = (id: string) => opps.find((o) => importedId(o) === id)!;
    const moves = (o: (typeof opps)[number]) => o.stageTransitions.map((t) => [t.toStage.name, t.actorId, t.occurredAt.toISOString()]);

    // Hired like a hire made in Source: in the Hired stage since the hire, no archive date or reason.
    const hired = opp('27746490:487967');
    expect(hired).toMatchObject({ status: 'HIRED', origin: 'SOURCED', source: 'LinkedIn', ownerId: null, archivedAt: null, archiveReasonId: null });
    expect(hired.stage.name).toBe('Hired');
    expect(hired.posting?.title).toBe('Office Manager');
    expect(hired.createdAt.toISOString()).toBe('2021-08-19T10:21:08.958Z'); // from the list, not the search hit
    expect(hired.stageChangedAt.toISOString()).toBe('2021-09-10T00:00:00.000Z');
    // Who made the hire is only on the profile's placements.
    expect(moves(hired)).toEqual([['Hired', run.adminId, '2021-09-10T00:00:00.000Z']]);
    // Profile data with no Source field rides on each new application; form answers on their own job's.
    expect(importedFields(hired)).toEqual({
      'Recruitee placement ID': '28978242',
      'Start date': '2021-10-01',
      'Cover letter': 'Example cover letter',
      'Notice period': '1 month',
      'Can you start within a month?': 'yes',
    });

    const elsewhere = opp('27746490:744511');
    expect(elsewhere).toMatchObject({ status: 'ARCHIVED', origin: 'APPLIED', ownerId: run.adminId });
    expect(elsewhere.archiveReason).toMatchObject({ name: 'Hired elsewhere', countsAsRejection: false });
    expect(elsewhere.archivedAt?.toISOString()).toBe('2021-09-10T12:00:01.000Z');
    // No feed history: one move into its stage when it was created.
    expect(moves(elsewhere)).toEqual([['Applied', null, '2021-08-20T09:00:00.000Z']]);
    expect(importedFields(elsewhere)).toEqual({
      'Recruitee placement ID': '28978243',
      'Disqualified by': 'Recruitee automation',
      'Cover letter': 'Example cover letter',
      'Notice period': '1 month',
      'Why do you want to join Acme?': 'I want to work on developer tools.',
    });

    const active = opp('28057517:744511');
    expect(active).toMatchObject({ status: 'ACTIVE', origin: 'APPLIED', source: 'Careers site', archivedAt: null, ownerId: run.adminId });
    expect(active.stage.name).toBe('On-site interview');
    expect(active.createdAt.toISOString()).toBe('2021-09-01T13:51:30.243Z');
    expect(moves(active)).toEqual([
      ['Applied', null, '2021-09-01T13:51:30.300Z'],
      ['Phone interview', run.adminId, '2021-09-03T10:00:00.000Z'],
      ['On-site interview', null, '2021-09-08T09:30:00.000Z'], // Former Recruiter isn't in the org
    ]);
    expect(active.stageChangedAt.toISOString()).toBe('2021-09-08T09:30:00.000Z');

    // Entered as a referral and moved on: still REFERRED, although her source ("manual") alone would say sourced.
    const rejected = opp('1711504:744511');
    expect(rejected).toMatchObject({ status: 'ARCHIVED', origin: 'REFERRED', source: 'Added manually' });
    expect(rejected.stage.name).toBe('Phone interview');
    expect(rejected.archiveReason).toMatchObject({ name: 'Not a fit', countsAsRejection: true });
    expect(rejected.archivedAt?.toISOString()).toBe('2021-11-05T10:12:00.000Z');
    expect(moves(rejected)).toEqual([
      ['Referred', null, '2021-10-27T15:21:00.100Z'],
      ['Phone interview', run.adminId, '2021-10-29T09:00:00.000Z'],
    ]);

    // Still in the intake stage, which names the origin directly.
    const referred = opp('2266:744511');
    expect(referred).toMatchObject({ status: 'ACTIVE', origin: 'REFERRED', source: null });
    expect(referred.stage.name).toBe('Referred');
    expect(moves(referred)).toEqual([['Referred', null, '2021-12-01T09:00:05.000Z']]);

    // Interviews
    const interviews = await db.interview.findMany({ where: { orgId }, include: { panelists: true }, orderBy: { startAt: 'asc' } });
    expect(interviews.map((i) => [i.title, i.startAt.toISOString(), i.durationMins, i.location, i.state])).toEqual([
      ['Phone call for Office Manager', '2021-09-05T10:00:00.000Z', 30, null, 'COMPLETED'],
      ['Onsite: system design', '2021-09-09T13:00:00.000Z', 60, 'Amsterdam HQ, Room 3', 'COMPLETED'],
    ]);
    expect(interviews[1].panelists.map((p) => p.id)).toEqual([run.adminId]);
    expect(interviews[0].opportunityId).toBe(hired.id);

    // Evaluations: labels convert, numeric scores through the search's scale, linked to their interview
    const scorecards = await db.feedbackSubmission.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' } });
    expect(scorecards.map((f) => f.overallRating)).toEqual([2, 4, 4]);
    const [guest, scored, strongYes] = scorecards;
    expect(guest.summary).toMatch(byline('James Smith'));
    expect(guest.summary).toContain('Technical interview · On-site interview');
    expect(guest.summary).toContain('Overall: No');
    expect(guest.interviewId).toBe(interviews[0].id);
    expect(guest.answers).toEqual({
      'imported-0': { label: 'Do you like coding?', kind: 'TEXT', value: 'yes' },
      'imported-1': { label: 'Preferred stack', kind: 'TEXT', value: 'Elixir' },
    });
    expect(guest.createdAt.toISOString()).toBe('2021-09-05T11:05:38.077Z');
    expect(scored.summary).toMatch(byline('Pat Interviewer'));
    expect(scored.summary).toContain('Hiring manager scorecard · On-site interview\nOverall: 5 of 5');
    expect(scored.answers).toEqual({ 'imported-0': { label: 'Strengths', kind: 'TEXT', value: 'Very organised' } });
    expect(scored.interviewId).toBe(interviews[0].id);
    expect(strongYes).toMatchObject({ authorId: run.adminId, interviewId: interviews[1].id, opportunityId: active.id });
    expect(strongYes.summary).toBe('Quick evaluation · On-site interview\nOverall: Strong yes\n\nGreat system design answers.');

    // Notes: threads flattened, bylines for people who aren't in the org; restricted and other-job notes stay out
    const notes = await db.note.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' } });
    const body = (text: string) => notes.find((n) => n.body.includes(text))!;
    expect(body('Strong phone screen')).toMatchObject({ body: 'Strong phone screen, move to onsite.', authorId: run.adminId, opportunityId: active.id });
    expect(body('Agreed').body).toMatch(byline('Former Recruiter'));
    expect(body('Agreed').body).toMatch(/Reply: Agreed$/);
    expect(body('Agreed').opportunityId).toBe(active.id);
    expect(body('not a fit for backend').body).toMatch(byline());
    expect(body('not a fit for backend').opportunityId).toBe(rejected.id);
    expect(body('not a fit for backend').createdAt.toISOString()).toBe('2021-11-05T10:15:00.000Z');
    expect(body('No decision yet').body).toMatch(byline('Former Recruiter'));
    expect(body('No decision yet').body).toContain('Culture interview · On-site interview');
    expect(body('No decision yet').body).toContain('Impressions: Asked good questions about the team');
    expect(notes.some((n) => /HR only|Office role|background-check|office-references|Salary expectation/.test(n.body))).toBe(false);
    // Candidate-level files land on John's most recent application.
    expect(body('Attachment: portfolio.pdf').opportunityId).toBe(elsewhere.id);
    expect(body('Attachment: John Smith cover letter.pdf').opportunityId).toBe(elsewhere.id);
    const files = await db.storedFile.findMany({ where: { orgId } });
    expect(files.map((f) => [f.filename, f.mime, f.contactId]).sort()).toEqual([
      ['John Smith CV.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', john.id],
      ['John Smith cover letter.pdf', 'application/pdf', john.id],
      ['portfolio.pdf', 'application/pdf', john.id],
    ]);

    // Offer letters: the placement says how each sent letter ended
    const offers = await db.offer.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' } });
    expect(
      offers.map((o) => [o.status, o.opportunityId, o.sentAt?.toISOString() ?? null, o.respondedAt?.toISOString() ?? null, o.salaryAmount]),
    ).toEqual([
      ['WITHDRAWN', hired.id, '2021-09-06T10:00:00.000Z', null, 68000], // replaced by the next version
      ['ACCEPTED', hired.id, '2021-09-08T10:00:00.000Z', '2021-09-10T00:00:00.000Z', 72000], // the hire
      ['DECLINED', elsewhere.id, '2021-09-09T10:00:00.000Z', '2021-09-10T12:00:01.000Z', 80000], // he took the other job
      ['DRAFT', active.id, null, null, null],
      ['WITHDRAWN', rejected.id, '2021-11-01T10:00:00.000Z', '2021-11-05T10:12:00.000Z', null], // rejected after it was sent
    ]);
    expect(offers[0].notes).toContain('Replaced by a later offer letter.');
    expect(offers[1]).toMatchObject({ jobTitle: 'Office Manager', salaryCurrency: 'EUR' });
    expect(offers[1].startDate?.toISOString()).toBe('2021-10-01T00:00:00.000Z');
    expect(offers[1].notes).toContain('Contract type: Permanent');
    expect(offers[3].jobTitle).toBe('Senior Backend Engineer');
    expect(offers[4].notes).toContain('Salary: 45 EUR per hour');
  });

  it('re-running into the same org creates nothing new and skips costly fan-out', async () => {
    expect(orgId).not.toBe('');
    const before = {
      contacts: await db.contact.count({ where: { orgId } }),
      opps: await db.opportunity.count({ where: { orgId } }),
      notes: await db.note.count({ where: { orgId } }),
      files: await db.storedFile.count({ where: { orgId } }),
    };
    const mock = mockFetch(vendorRoutes());
    const run = await runImportForTest({ module: provider, credentials: creds, fetchImpl: mock.impl, orgId });
    expect(run.status).toBe('SUCCEEDED');
    expect(run.view.created).toEqual({});
    expect(mock.unmatched).toEqual([]);
    expect({
      contacts: await db.contact.count({ where: { orgId } }),
      opps: await db.opportunity.count({ where: { orgId } }),
      notes: await db.note.count({ where: { orgId } }),
      files: await db.storedFile.count({ where: { orgId } }),
    }).toEqual(before);
    // Already-imported jobs, requisitions, histories, files and scorecards aren't fetched again. A
    // profile is re-read only for a CV link Source doesn't have yet (these three have no usable CV).
    const paths = mock.calls.map((c) => c.url.pathname);
    expect([...new Set(pathsOf(mock.calls, /\/candidates\/\d+$/))].sort()).toEqual([
      '/c/49498/candidates/1711504', '/c/49498/candidates/2266', '/c/49498/candidates/28057517',
    ]);
    expect(paths.some((p) => /\/offers\/\d+$|\/requisitions\/\d+$/.test(p))).toBe(false);
    expect(paths.some((p) => p.endsWith('/tracking/activities'))).toBe(false);
    expect(mock.calls.some((c) => c.url.pathname.endsWith('/interview/events') && c.url.searchParams.has('candidate_id'))).toBe(false);
    expect(mock.calls.some((c) => c.url.host === S3)).toBe(false);
  });

  it('re-reads the profile for a fresh CV link when S3 refuses the first one', async () => {
    const cvPath = '/candidates/27746490/cv_x8kq2n0c.docx';
    const signed = (sig: string) => `https://${S3}${cvPath}?X-Amz-Expires=60&X-Amz-Signature=${sig}`;
    let profileReads = 0;
    const mock = mockFetch({
      ...vendorRoutes(),
      [api('/candidates/27746490')]: () => json({ candidate: { ...JOHN.detail, cv_original_url: signed(profileReads++ === 0 ? 'stale' : 'fresh') } }),
      [`GET ${S3}${cvPath}`]: ({ url }: Req) =>
        url.searchParams.get('X-Amz-Signature') === 'fresh'
          ? bytes('PK-docx-John-Smith', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
          : new Response('<Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>', { status: 403 }),
    });
    const run = await runImportForTest({
      module: recruiteeProvider,
      credentials: creds,
      fetchImpl: mock.impl,
      options: { activity: false, offers: false },
    });
    expect(run.status).toBe('SUCCEEDED');
    expect(run.view.issues.map((i) => i.message)).toEqual([RESTRICTED_FILES]);
    expect(profileReads).toBe(2);
    const cvCalls = mock.calls.filter((c) => c.url.host === S3 && c.url.pathname === cvPath);
    expect(cvCalls.map((c) => c.url.searchParams.get('X-Amz-Signature'))).toEqual(['stale', 'fresh']);
    expect(cvCalls.every((c) => c.headers.authorization === undefined)).toBe(true);
    const john = await db.contact.findFirstOrThrow({ where: { orgId: run.orgId, name: 'John Smith' } });
    expect(john.resumeFileId).not.toBeNull();
  });

  it('picks up CVs on a later run for contacts imported without them', async () => {
    const quiet = { activity: false, offers: false };
    const first = mockFetch(vendorRoutes());
    const run1 = await runImportForTest({ module: provider, credentials: creds, fetchImpl: first.impl, options: { ...quiet, files: false } });
    expect(run1.status).toBe('SUCCEEDED');
    expect(first.calls.some((c) => c.url.host === S3)).toBe(false);
    const before = await db.contact.findFirstOrThrow({ where: { orgId: run1.orgId, name: 'John Smith' } });
    expect(before.resumeFileId).toBeNull();

    // The CV link only comes with the profile, so the second run has to read it again for a known contact.
    const second = mockFetch(vendorRoutes());
    const run2 = await runImportForTest({ module: provider, credentials: creds, fetchImpl: second.impl, orgId: run1.orgId, options: { ...quiet, files: true } });
    expect(run2.status).toBe('SUCCEEDED');
    expect(run2.view.created).toEqual({ file: 3 });
    expect(second.calls.filter((c) => c.url.host === S3).map((c) => c.url.pathname)).toEqual([
      '/candidates/27746490/cv_x8kq2n0c.docx',
      '/candidates/27746490/cover_letter_k2j4m1.pdf',
      '/attachments/58/portfolio.pdf',
    ]);
    const after = await db.contact.findFirstOrThrow({ where: { orgId: run1.orgId, name: 'John Smith' } });
    expect(after.resumeFileId).not.toBeNull();
  });

  it('with archived applications off, reads and imports only people with something active', async () => {
    const mock = mockFetch(vendorRoutes());
    const run = await runImportForTest({ module: provider, credentials: creds, fetchImpl: mock.impl, options: { archived: false } });
    expect(run.status).toBe('SUCCEEDED');
    // John (hired, and disqualified elsewhere) and Stephanie (rejected) bring nothing active.
    expect((await db.contact.findMany({ where: { orgId: run.orgId } })).map((c) => c.name).sort()).toEqual(['Alice Bob', 'Jane Doe']);
    expect((await db.opportunity.findMany({ where: { orgId: run.orgId } })).map(importedId).sort()).toEqual(['2266:744511', '28057517:744511']);
    // Neither is read at all: no profile, no CV, no history, no per-candidate fan-out.
    for (const id of ['27746490', '1711504']) {
      expect(mock.calls.some((c) => c.url.pathname.includes(`/candidates/${id}`) || c.url.searchParams.get('candidate_id') === id)).toBe(false);
    }
    expect(mock.calls.filter((c) => c.url.pathname.endsWith('/tracking/activities')).flatMap((c) => c.url.searchParams.getAll('candidates[]'))).toEqual([
      '28057517', '28057517', '2266',
    ]);
    expect(mock.calls.some((c) => c.url.host === S3)).toBe(false);
  });

  it('brings a candidate from before `since` who applied again after it with the full profile and CV', async () => {
    // John again, re-applying to the backend job after the cut-off.
    const returning: Fixture = {
      hit: {
        ...JOHN.hit, updated_at: '2021-10-10T09:00:05Z', last_activity_at: '2021-10-10T09:00:05Z',
        placements: [JOHN_HIRED.hit, hp({ id: 28978243, candidate_id: 27746490, offer: BACKEND, stage: { id: 61737, name: 'Applied', time_limit: null } })],
      },
      listed: {
        ...JOHN.listed,
        placements: [
          JOHN_HIRED.listed,
          lp({ candidate_id: 27746490, created_at: '2021-10-10T09:00:00.000000Z', id: 28978243, offer_id: 744511, position: 3, stage_id: 61737, updated_at: '2021-10-10T09:00:05.000000Z' }),
        ],
      },
      detail: {
        ...JOHN.detail,
        placements: [
          JOHN_HIRED.detail,
          dp({ id: 28978243, candidate_id: 27746490, created_at: '2021-10-10T09:00:00.000000Z', updated_at: '2021-10-10T09:00:05.000000Z', offer_id: 744511, stage_id: 61737 }),
        ],
      },
      refs: JOHN.refs,
    };
    const mock = mockFetch(vendorRoutes([returning, JANE, STEPHANIE, ALICE, EXAMPLE]));
    const run = await runImportForTest({
      module: provider,
      credentials: creds,
      fetchImpl: mock.impl,
      options: { since: '2021-10-01T00:00:00.000Z', activity: false, offers: false },
    });
    expect(run.status).toBe('SUCCEEDED');
    const john = await db.contact.findFirstOrThrow({ where: { orgId: run.orgId, name: 'John Smith' }, include: { opportunities: true } });
    // Only the new application; the contact keeps its own creation date and the whole profile.
    expect(john.opportunities.map(importedId)).toEqual(['27746490:744511']);
    expect(john).toMatchObject({
      headline: 'Senior Developer at Initech',
      location: 'Keizersgracht 313, 1016 EE Amsterdam, Netherlands',
      links: ['https://www.example.com/', 'https://www.linkedin.com/in/johnsmith/', 'https://github.com/johnsmith'],
      tags: ['Python developer', 'Relocation'],
    });
    expect(john.createdAt.toISOString()).toBe('2021-08-19T10:21:07.114Z');
    expect(john.resumeFileId).not.toBeNull();
    expect(mock.calls.some((c) => c.url.host === S3 && c.url.pathname === '/candidates/27746490/cv_x8kq2n0c.docx')).toBe(true);
  });

  it('reads the pre-December-2025 /offers list, which ignores `page`, as a single page', async () => {
    // The old fat shape: embedded pipeline and department name, no `meta`, every job on every page.
    const legacy = OFFERS.map((o) => ({
      ...OFFER_DETAILS[o.id],
      requisition_ids: OFFER_REQUISITIONS[o.id],
      pipeline_template: { id: o.pipeline_template_id, title: 'Pipeline', stages: PIPELINES[o.pipeline_template_id] },
    }));
    const mock = mockFetch({ ...vendorRoutes(), [api('/offers')]: () => json({ offers: legacy }) });
    const run = await runImportForTest({
      module: provider,
      credentials: creds,
      fetchImpl: mock.impl,
      options: { activity: false, offers: false, files: false },
    });
    expect(run.status).toBe('SUCCEEDED');
    const lists = mock.calls.filter((c) => c.url.pathname.endsWith('/offers'));
    expect(lists.length).toBeGreaterThan(0);
    expect(lists.every((c) => c.url.searchParams.get('page') === '1')).toBe(true);
    expect(mock.calls.some((c) => c.url.pathname.includes('/pipeline_templates/'))).toBe(false);
    expect(run.review!.stages.find((s) => s.key === 'culture fit')).toBeDefined();
    expect(run.view.created).toMatchObject({ posting: 2, opportunity: 5 });
  });

  it('keeps paging when a search page comes back short but the exact total says there is more', async () => {
    // Jane was deleted between the count and her page: page 1 holds one hit of two.
    const mock = mockFetch({ ...vendorRoutes(), [api('/search/new/candidates')]: searchRoute(CANDIDATES, { hidden: [JANE.hit.id] }) });
    const run = await runImportForTest({
      module: createRecruiteeProvider({ pageSize: 2, searchWindow: 10 }),
      credentials: creds,
      fetchImpl: mock.impl,
      options: { activity: false, offers: false, files: false },
    });
    expect(run.status).toBe('SUCCEEDED');
    const firstPass = mock.calls.filter((c) => c.url.pathname.endsWith('/search/new/candidates')).slice(0, 3);
    expect(firstPass.map((c) => c.url.searchParams.get('page'))).toEqual(['1', '2', '3']);
    expect((await db.contact.findMany({ where: { orgId: run.orgId } })).map((c) => c.name).sort()).toEqual([
      'Alice Bob', 'John Smith', 'Stephanie Wood',
    ]);
  });

  it('degrades refused optional endpoints to one warning each and filters by date server-side', async () => {
    const letterCalls: string[] = [];
    const mock = mockFetch({
      ...vendorRoutes(),
      // The activity feed is undocumented: a rejected filter must cost the history, not the import.
      [api('/tracking/activities')]: () => json({ error: ['Invalid filter'], error_fields: { events: ['is invalid'] } }, { status: 422 }),
      ...Object.fromEntries(
        CANDIDATES.map((c) => [
          api(`/offer_letters/candidates/${c.hit.id}/offer_letters`),
          ({ url }: Req) => {
            letterCalls.push(url.pathname);
            return forbidden(); // no offer letters on this plan
          },
        ]),
      ),
    });
    const run = await runImportForTest({
      module: recruiteeProvider,
      credentials: creds,
      fetchImpl: mock.impl,
      options: { since: '2021-10-01T00:00:00.000Z', activity: false, files: false },
    });
    expect(run.status).toBe('SUCCEEDED');
    expect(run.error).toBeNull();
    expect(mock.unmatched).toEqual([]);

    // Offer letters are plan-gated: one 403 stops the phase, with no call per remaining candidate.
    expect(letterCalls).toHaveLength(1);
    expect(run.view.issues.map((i) => i.message)).toEqual([
      expect.stringMatching(/^Stage history: GET api\.recruitee\.com\/c\/49498\/tracking\/activities → HTTP 422/),
      "Offer letters: This key doesn't have permission for GET api.recruitee.com/c/49498/offer_letters/candidates/{id}/offer_letters — skipped for the remaining candidates",
    ]);
    const stephanie = await db.opportunity.findFirstOrThrow({ where: { orgId: run.orgId, contact: { name: 'Stephanie Wood' } } });
    expect(stephanie.status).toBe('ARCHIVED');

    // `since` goes to the search as an updated_at floor; the loader drops what was created before it.
    const searches = mock.calls.filter((c) => c.url.pathname.endsWith('/search/new/candidates'));
    expect(searches.every((c) => c.url.searchParams.get('filters_json') === `[{"field":"updated_at","gte":${Date.parse('2021-10-01T00:00:00Z') / 1000}}]`)).toBe(true);
    expect((await db.contact.findMany({ where: { orgId: run.orgId } })).map((c) => c.name).sort()).toEqual(['Alice Bob', 'Stephanie Wood']);
    expect(run.view.created).toMatchObject({ contact: 2, opportunity: 2, posting: 2 });
    expect(run.view.created.offer).toBeUndefined();

    // activity and files off: those phases never call the API.
    const paths = mock.calls.map((c) => c.url.pathname);
    expect(paths.some((p) => /\/interview\/|\/notes$|\/attachments$/.test(p))).toBe(false);
    expect(mock.calls.some((c) => c.url.host === S3)).toBe(false);
  });
});

describe.skipIf(!hasDb)('recruitee phases against an uncooperative API', () => {
  const feedCalls = (mock: ReturnType<typeof mockFetch>) => mock.calls.filter((c) => c.url.pathname.endsWith('/tracking/activities'));
  const ALL_APPS = ['1711504:744511', '2266:744511', '27746490:487967', '27746490:744511', '28057517:744511'];

  it('stops asking for stage history once the activity feed ignores its candidate filter', async () => {
    // The whole company's feed, newest first, whatever was asked for, with someone else's move on
    // top. Entries may name their candidate, or only the placement (someone else's isn't ours).
    const named = [...ACTIVITIES, move(69999, 555, 'candidate_stage_change', '2021-12-02T10:00:00.000000Z', 5724, 61738)].reverse();
    const placementOf: Record<number, number> = { 28057517: 29327897, 1711504: 2001897, 555: 424242 };
    const byPlacement = named.map((a) => ({
      id: a.id, event: a.event, created_at: a.created_at, admin_id: a.admin_id, offer_id: a.offer_id, placement_id: placementOf[a.candidate_id], details: a.details,
    }));
    for (const everyone of [named, byPlacement] as Json[][]) {
      const { ctx, mock, warnings, loaded } = phaseContext({
        ...vendorRoutes(),
        [api('/tracking/activities')]: ({ url }: Req) => json({ activities: paged(everyone, url).slice }),
      });
      await runPhase(ctx, 'candidates');
      expect(feedCalls(mock)).toHaveLength(1);
      expect(warnings).toEqual([noHistory('the activity feed ignored its candidate filter')]);
      // Nothing partial: the applications carry no feed history at all.
      expect(idsOf(loaded.application)).toEqual(ALL_APPS);
      expect(recordOf(loaded.application, '28057517:744511')?.history).toBeUndefined();
      expect(recordOf(loaded.application, '1711504:744511')?.history).toBeUndefined();
    }
  });

  it('stops paging the activity feed when a page brings nothing new', async () => {
    // A feed that ignores `page` answers every page with the first one.
    const { ctx, mock, warnings, loaded } = phaseContext({
      ...vendorRoutes(),
      [api('/tracking/activities')]: ({ url }: Req) => {
        const who = url.searchParams.getAll('candidates[]').map(Number);
        const limit = Number(url.searchParams.get('limit'));
        return json({ activities: ACTIVITIES.filter((a) => who.includes(a.candidate_id)).slice(0, limit) });
      },
    });
    await runPhase(ctx, 'candidates');
    const janes = feedCalls(mock).filter((c) => c.url.searchParams.getAll('candidates[]').includes('28057517'));
    expect(janes.map((c) => c.url.searchParams.get('page'))).toEqual(['1', '2']);
    expect(warnings).toEqual([]);
    // What the first page had, then the current stage from the placement's own dates.
    const history = recordOf(loaded.application, '28057517:744511')?.history as { stage: { name: string }; at: Date }[];
    expect(history.map((h) => [h.stage.name, h.at.toISOString()])).toEqual([
      ['Applied', '2021-09-01T13:51:30.300Z'],
      ['Phone interview', '2021-09-03T10:00:00.000Z'],
      ['On-site interview', '2021-09-08T09:30:00.000Z'],
    ]);
  });

  it('gives up on stage history when the feed answers in a shape it does not know', async () => {
    const shapes: [string, RouteHandler, string][] = [
      ['another envelope', () => json({ data: ACTIVITIES }), 'the activity feed answered in an unrecognized format'],
      [
        'entries naming no candidate',
        () => json({ activities: [{ id: 1, action: 'moved', created_at: '2021-09-03T10:00:00Z', target: { name: 'Phone interview' } }] }),
        "the activity feed's entries weren't in a recognized format",
      ],
      [
        'moves it cannot read',
        () => json({ activities: [{ id: 2, event: 'candidate_stage_change', candidate_id: 28057517, created_at: '2021-09-03T10:00:00Z', stage_name: 'Phone interview' }] }),
        "the activity feed's entries weren't in a recognized format",
      ],
    ];
    for (const [, route, why] of shapes) {
      const { ctx, mock, warnings, loaded } = phaseContext({ ...vendorRoutes(), [api('/tracking/activities')]: route });
      await runPhase(ctx, 'candidates');
      expect(feedCalls(mock)).toHaveLength(1);
      expect(warnings).toEqual([noHistory(why)]);
      expect(idsOf(loaded.application)).toEqual(ALL_APPS);
    }
  });

  it('carries on without stage history when the feed keeps failing or timing out', async () => {
    const failures: [RouteHandler, string][] = [
      [() => json({ error: 'Server internal error' }, { status: 500 }), 'GET api.recruitee.com/c/49498/tracking/activities → HTTP 500'],
      [
        () => {
          throw new TypeError('fetch failed');
        },
        'GET api.recruitee.com/c/49498/tracking/activities → HTTP 0: TypeError',
      ],
    ];
    for (const [route, message] of failures) {
      const { ctx, mock, warnings, loaded } = phaseContext({ ...vendorRoutes(), [api('/tracking/activities')]: route });
      await runPhase(ctx, 'candidates');
      expect(warnings).toEqual([noHistory(message)]);
      // The client's retries, once; later pages don't ask again.
      expect(feedCalls(mock)).toHaveLength(6);
      expect(idsOf(loaded.application)).toEqual(ALL_APPS);
    }
  });

  it('skips a candidate whose profile is gone, and imports one whose profile is refused from the search hit', async () => {
    // Stephanie's hit without the disqualification time: the placement's last update stands in.
    const stephanie: Fixture = {
      ...STEPHANIE,
      hit: { ...STEPHANIE.hit, placements: [{ ...(STEPHANIE.hit.placements as Json[])[0], disqualified_at: null }] },
    };
    const { ctx, mock, warnings, loaded } = phaseContext({
      ...vendorRoutes([JOHN, JANE, stephanie, ALICE, EXAMPLE]),
      [api('/candidates/28057517')]: notFound, // deleted or merged since the search listed her
      [api('/candidates/1711504')]: forbidden,
    });
    await runPhase(ctx, 'candidates');
    expect(warnings).toEqual([
      'Skipped candidates deleted or merged in Recruitee after the import listed them',
      "Candidate profile: This key doesn't have permission for GET api.recruitee.com/c/49498/candidates/{id}",
    ]);
    expect(idsOf(loaded.application)).toEqual(['1711504:744511', '2266:744511', '27746490:487967', '27746490:744511']);
    expect((loaded.file ?? []).some((f) => f.candidateExternalId === '28057517')).toBe(false);
    expect(mock.calls.filter((c) => c.url.pathname.endsWith('/candidates/28057517'))).toHaveLength(1);
    const refused = recordOf(loaded.application, '1711504:744511')!;
    expect(refused.candidate).toMatchObject({ name: 'Stephanie Wood', emails: ['stephanie.wood@example.com'], phones: ['123456789'] });
    expect((refused.candidate as Json).location).toBeUndefined();
    expect((refused.archivedAt as Date).toISOString()).toBe('2021-11-05T10:12:00.000Z');
  });

  it("keeps reading other candidates' notes after one candidate's are refused", async () => {
    const { ctx, mock, warnings, loaded } = phaseContext(
      { ...vendorRoutes(), [api('/candidates/27746490/notes')]: forbidden },
      { has: isOpportunity },
    );
    await runPhase(ctx, 'notes');
    expect([...new Set(pathsOf(mock.calls, /\/notes$/))].sort()).toEqual([
      '/c/49498/candidates/1711504/notes', '/c/49498/candidates/2266/notes', '/c/49498/candidates/27746490/notes', '/c/49498/candidates/28057517/notes',
    ]);
    expect(idsOf(loaded.note)).toEqual(['150', '96', '97']);
    expect(warnings).toEqual([
      "Notes: This key doesn't have permission for GET api.recruitee.com/c/49498/candidates/{id}/notes",
      RESTRICTED_NOTES,
    ]);
  });

  it('asks for interview links once when events are refused, and not at all for scorecards already imported', async () => {
    const routes = { ...vendorRoutes(), [api('/interview/events')]: forbidden };
    const linkCalls = (mock: ReturnType<typeof mockFetch>) =>
      mock.calls.filter((c) => c.url.pathname.endsWith('/interview/events') && c.url.searchParams.has('candidate_id'));

    const first = phaseContext(routes, { has: isOpportunity });
    await runPhase(first.ctx, 'feedback');
    expect(linkCalls(first.mock)).toHaveLength(1);
    expect(first.warnings).toEqual([
      "Linking evaluations to interviews: This key doesn't have permission for GET api.recruitee.com/c/49498/interview/events — skipped for the remaining candidates",
    ]);
    expect(idsOf(first.loaded.feedback)).toEqual(['252', '287', '290', '291']);
    expect((first.loaded.feedback ?? []).every((f) => f.interviewExternalId == null)).toBe(true);

    const again = phaseContext(routes, { has: (kind) => kind === 'opportunity' || kind === 'feedback' });
    await runPhase(again.ctx, 'feedback');
    expect(linkCalls(again.mock)).toHaveLength(0);
    expect(again.loaded.feedback).toBeUndefined();
    expect(again.warnings).toEqual([]);
  });

  it('keeps a numeric score as a note when no scale can be read', async () => {
    const { ctx, warnings, loaded } = phaseContext(
      { ...vendorRoutes(), [api('/search/new/candidates')]: searchRoute(CANDIDATES, { scale: false }) },
      { has: isOpportunity },
    );
    await runPhase(ctx, 'feedback');
    expect(warnings).toEqual([
      `Evaluation rating scale: This key doesn't have permission for GET ${HOST}/c/${COMPANY}/candidates/settings/rating_scale`,
    ]);
    const scored = recordOf(loaded.feedback, '291')!;
    expect(scored.rating).toBeNull();
    expect(scored.summary).toBe('Overall: 5');
  });

  it("skips one attachment that can't be stored and carries on with the candidate's others", async () => {
    const stored: string[] = [];
    const { ctx, warnings } = phaseContext(
      {
        ...vendorRoutes(),
        [api('/candidates/27746490/attachments')]: () =>
          json({
            references: [MARCELINE],
            attachments: [
              attachment(58, 27746490, 'portfolio.pdf', `https://${S3}/attachments/58/portfolio.pdf`),
              attachment(64, 27746490, 'certificate.pdf', `https://${S3}/attachments/64/certificate.pdf`),
            ],
            hidden_attachments_exist: false,
          }),
      },
      {
        has: isOpportunity,
        loader: {
          file: async (f) => {
            if (f.externalId === '58') throw new Error('The blob store rejected the upload');
            stored.push(f.externalId);
          },
        },
      },
    );
    await runPhase(ctx, 'files');
    expect(stored).toEqual(['64']);
    expect(warnings).toEqual(['Skipped a record that could not be imported: The blob store rejected the upload']);
  });
});
