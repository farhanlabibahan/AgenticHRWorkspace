import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/session', () => ({ isAdmin: () => true }));

import { randomUUID } from 'crypto';
import type { Prisma } from '@prisma/client';
import { sealCredentials } from '@/server/imports/crypto';
import { createHttpClient } from '@/server/imports/http';
import { confirmImportMapping, getImportJob } from '@/server/imports/jobs';
import { catalogWriter, emptyCatalog } from '@/server/imports/mapping';
import { registerProviderForTests } from '@/server/imports/providers';
import { normalizeSubdomain, workableProvider, workableRating } from '@/server/imports/providers/workable';
import { runSlice } from '@/server/imports/runner';
import { db, json, mockFetch, runImportForTest, verifyForTest, type RouteHandler } from '@/server/imports/__tests__/harness';
import { hasDb, publicDns } from '@/server/imports/__tests__/harness';
import {
  DEFAULT_IMPORT_OPTIONS,
  type ImportedInterview,
  type ImportOptions,
  type Loader,
  type PhaseContext,
} from '@/server/imports/types';

/**
 * Workable adapter against a mock SPI v3 account. Payloads follow the live
 * shapes recorded in the spec (not the docs where they disagree): bare-array
 * reasons, integer stage ids with 1-based positions, `stage` as the stage
 * NAME, hex string ids, keyset paging with an inclusive `since_id` and
 * `paging` absent on the last page, per-rating {score, scale, grade},
 * `visibility_roles` on the candidate feed, and pre-signed S3 links for files.
 */

const TOKEN = 'wk_test_7d1e0c55a3b94f2e8c1d6b0a9f3e2d1c';
const CREDS = { subdomain: 'acme', apiToken: TOKEN };
const API = 'acme.workable.com/spi/v3';
const RESUMES = 'workable-resumes.s3.amazonaws.com';
const ATTACHMENTS = 'workable-application-attachments.s3.amazonaws.com';
const RESTRICTED =
  'Skipped Workable comments, emails and evaluations that only some roles could see (Orqestra notes have no private setting)';
const signed = (host: string, path: string) =>
  `https://${host}${path}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAEXAMPLE%2F20260923%2Fus-east-1%2Fs3%2Faws4_request` +
  '&X-Amz-Date=20260923T120000Z&X-Amz-Expires=60000&X-Amz-SignedHeaders=host&X-Amz-Signature=5d3a0c9e';

/**
 * A keyset-paged list as the live API serves it: ascending hex ids, `since_id`
 * inclusive, and `paging.next` (the first id of the next page, other filters
 * dropped) only while more remain. `pageSize` stands in for a bigger account.
 */
const hex = (id: string) => parseInt(id, 16);
function keyset<T extends { id: string }>(key: string, all: (url: URL) => T[], pageSize = 100): RouteHandler {
  return ({ url }) => {
    const since = url.searchParams.get('since_id');
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), pageSize);
    const rest = all(url)
      .filter((x) => since === null || hex(x.id) >= hex(since))
      .sort((a, b) => hex(a.id) - hex(b.id));
    const more = rest[limit];
    const next = more ? { next: `https://${url.host}${url.pathname}?limit=${url.searchParams.get('limit') ?? 50}&since_id=${more.id}` } : null;
    return json({ [key]: rest.slice(0, limit), ...(next ? { paging: next } : {}) });
  };
}

// ---------- Fixtures ----------

const account = { id: 'b4e8e', name: 'Acme Robotics', subdomain: 'acme', description: null, summary: null, website_url: 'https://acme.test' };

const member = (id: string, name: string, email: string, role: string, active = true) => ({
  id,
  name,
  headline: null,
  email,
  role,
  type: 'Member',
  hris_role: 'hris_employee',
  roles: [`ats.${role}`],
  active,
  collaboration_rules: [],
  hris_member_scope: null,
});
const members = [
  member('1f395d', 'Test Admin', 'admin@example.test', 'admin'), // the harness org's admin → attribution matches
  member('1f3961', 'Natalie Sung', 'natalie.sung@acme-robotics.test', 'simple'),
  member('1f3999', 'Eduardo Vallente', 'eduardo@acme-robotics.test', 'simple', false),
];
const ADMIN = { id: '1f395d', name: 'Test Admin', type: 'Member' };
const NATALIE = { id: '1f3961', name: 'Natalie Sung', type: 'Member' };

// /jobs/:shortcode/members (live shape): account admins sit on every job as `admin`.
const teamMember = (m: (typeof members)[number], collaboration_role: string) => ({
  id: m.id,
  name: m.name,
  headline: null,
  email: m.email,
  role: m.role,
  type: 'Member',
  collaboration_role,
});
const jobTeams: Record<string, object[]> = {
  '9CD658E13E': [teamMember(members[1], 'hiring_manager'), teamMember(members[0], 'recruiting_admin')],
  ENG0042A1: [teamMember(members[0], 'admin'), teamMember(members[1], 'hiring_manager')],
};

const S = {
  sourced: { id: 5272269, identifier: '50779f', slug: 'sourced', name: 'Sourced', kind: 'sourced', position: 1 },
  applied: { id: 5272270, identifier: '5077a0', slug: 'applied', name: 'Applied', kind: 'applied', position: 2 },
  phone: { id: 5272271, identifier: '5077a1', slug: 'phone-screen', name: 'Phone Screen', kind: 'phone-screen', position: 3 },
  assessment: { id: 5272272, identifier: '5077a2', slug: 'assessment', name: 'Assessment', kind: 'assessment', position: 4 },
  interview: { id: 5272273, identifier: '5077a3', slug: 'interview', name: 'Interview', kind: 'interview', position: 5 },
  offer: { id: 5272274, identifier: '5077a4', slug: 'offer', name: 'Offer', kind: 'offer', position: 6 },
  hired: { id: 5272275, identifier: '5077a5', slug: 'hired', name: 'Hired', kind: 'hired', position: 7 },
  // A custom stage only one job's pipeline has
  tech: { id: 5272280, identifier: '5077b0', slug: 'tech-interview', name: 'Tech Interview', kind: 'interview', position: 4 },
};
type StageFixture = (typeof S)[keyof typeof S];
const orgStages = [S.sourced, S.applied, S.phone, S.assessment, S.interview, S.offer, S.hired];
const stageRef = (s: StageFixture) => ({ id: s.id, identifier: s.identifier, name: s.name, slug: s.slug });

const reasons = [
  { id: 'b29c63', description: "Doesn't have required qualifications", candidate_withdrew: false, position: 1 },
  { id: 'b29c68', description: 'Other candidates are more suitable', candidate_withdrew: false, position: 6 },
  { id: 'b29c6a', description: 'Unsuccessful interview', candidate_withdrew: false, position: 8 },
  { id: 'b29c6d', description: 'Could not be contacted', candidate_withdrew: true, position: 11 },
  { id: 'b29c70', description: 'Rejected offer', candidate_withdrew: true, position: 14 },
  { id: 'b29c71', description: 'Not interested', candidate_withdrew: true, position: 15 },
];

const london = {
  location_str: 'London, United Kingdom',
  country: 'United Kingdom',
  country_code: 'GB',
  region: null,
  region_code: 'England',
  city: 'London',
  zip_code: '2142',
  telecommuting: false,
  workplace_type: 'hybrid',
};
const jobLocation = (shortcode: string, city: string, country_code: string, country_name: string, hidden = false) => ({
  shortcode,
  country_code,
  country_name,
  state_code: null,
  subregion: null,
  zip_code: null,
  city,
  coords: null,
  hidden,
});
const jobs = [
  {
    id: '5b5ce9',
    title: 'Account Executive',
    full_title: 'Account Executive - GB/09/AE',
    shortcode: '9CD658E13E',
    code: 'GB/09/AE',
    state: 'published',
    sample: false,
    confidential: false,
    department: 'Sales',
    department_hierarchy: [{ id: 792289334, name: 'Sales' }],
    url: 'https://acme.workable.com/jobs/5986327',
    application_url: 'https://acme.workable.com/jobs/5986327/candidates/new',
    shortlink: 'https://apply.workable.com/j/9CD658E13E',
    workplace_type: 'hybrid',
    location: london,
    locations: [
      jobLocation('JAD50549AFA', 'London', 'GB', 'United Kingdom'),
      jobLocation('JAD50549AFB', 'Berlin', 'DE', 'Germany'),
      jobLocation('JAD50549AFC', 'Dublin', 'IE', 'Ireland', true), // hidden: not advertised
    ],
    salary: { salary_from: 60000, salary_to: 80000, salary_currency: 'gbp' },
    created_at: '2026-03-25T00:00:00Z',
    updated_at: '2026-07-23T18:58:17Z',
    keywords: null,
  },
  {
    id: '5b5cf1',
    title: 'Staff Engineer',
    full_title: 'Staff Engineer',
    shortcode: 'ENG0042A1',
    code: null,
    state: 'archived',
    sample: false,
    confidential: true, // visible only to its hiring team in Workable
    department: null,
    department_hierarchy: [{ id: 792289400, name: 'Engineering' }],
    workplace_type: 'remote',
    location: { location_str: null, country: null, country_code: null, region: null, city: null, telecommuting: true },
    locations: [],
    created_at: '2026-01-10T09:00:00Z',
    updated_at: '2026-08-02T10:00:00Z',
    keywords: ['platform'],
  },
  {
    id: '5b5d00',
    title: 'Customer Success Manager',
    shortcode: 'D4A1B2C3E5',
    state: 'closed',
    sample: true,
    confidential: false,
    department: null,
    department_hierarchy: [],
    workplace_type: 'on_site',
    location: london,
    created_at: '2026-03-25T00:00:00Z',
    updated_at: '2026-03-25T00:00:00Z',
    keywords: null,
  },
];
const jobDetails: Record<string, object> = {
  '9CD658E13E': {
    ...jobs[0],
    full_description:
      '<p>We are looking for a competent Account Executive to find business opportunities.</p><p><strong>Requirements</strong></p>' +
      '<ul><li>Proven experience as an Account Executive</li></ul><p><strong>Benefits</strong></p><ul> <li>Health Care Plan (Medical, Dental &amp; Vision)</li></ul>',
    description: '<p>We are looking for a competent Account Executive ...</p>',
    requirements: '<ul><li>Proven experience as an Account Executive</li></ul>',
    benefits: '<ul> <li>Health Care Plan (Medical, Dental &amp; Vision)</li></ul>',
    employment_type: 'Full-time',
    industry: 'Staffing and Recruiting',
    function: 'Sales',
    experience: 'Mid-Senior level',
    education: "Bachelor's Degree",
  },
  ENG0042A1: {
    // The detail repeats the list fields except `sample`.
    ...(({ sample: _sample, ...rest }) => rest)(jobs[1]),
    full_description: '<p>Own our robot fleet platform.</p>',
    employment_type: 'Contract',
  },
};
const jobStages: Record<string, StageFixture[]> = {
  '9CD658E13E': orgStages,
  ENG0042A1: [S.sourced, S.applied, S.phone, S.tech, S.offer, S.hired],
};

// Requisitions (Hiring Plan): the spec's documented shape.
const requisition = (id: string, code: string, job: { id: string; title: string }, state: string, extra: object) => ({
  id,
  code,
  job,
  department: { id: '1ee2e1d2', name: 'Sales' },
  location: { location_str: 'London, United Kingdom', country: 'United Kingdom', country_code: 'GB', region: null, region_code: 'England', city: 'London', zip_code: null },
  requester: { id: '1f3961', name: 'Natalie Sung' },
  hiring_manager: { id: '1f3961', name: 'Natalie Sung' },
  owner: { id: '1f395d', name: 'Test Admin' },
  plan_date: '2026-06-30',
  start_date: null,
  employment_type: 'Full-time',
  reason: 'new_hire',
  state,
  requisition_attributes: [],
  approval_groups: [],
  ...extra,
});
const requisitions = [
  // `currency_iso` as the docs table describes it: the numeric ISO 4217 code (826 = GBP).
  requisition('16d60890', 'REQ101', { id: '5b5ce9', title: 'Account Executive' }, 'open', {
    reason: 'replacement',
    salary_range: { from: 60000, to: 80000, frequency: 'year', currency_iso: 826 },
  }),
  // The docs example's alphabetic `currency`. Not approved yet.
  requisition('16d60891', 'REQ102', { id: '5b5cf1', title: 'Staff Engineer' }, 'pending', {
    salary_range: { from: 90000, to: 120000, frequency: 'year', currency: 'EUR' },
  }),
  // Cancelled: must not take the job over from REQ101.
  requisition('16d608a0', 'REQ103', { id: '5b5ce9', title: 'Account Executive' }, 'cancelled', {
    salary_range: { from: 55000, to: 70000, frequency: 'year', currency: 'GBP' },
  }),
];

const accountRef = { subdomain: 'acme', name: 'Acme Robotics' };
const aeJob = { shortcode: '9CD658E13E', title: 'Account Executive' };
const engJob = { shortcode: 'ENG0042A1', title: 'Staff Engineer' };
const candidateBase = {
  headline: null,
  account: accountRef,
  disqualified: false,
  anonymized: false,
  disqualification_reason: null,
  hired_at: null,
  moved_to_offer_at: null,
  sourced: false,
  address: null,
  phone: null,
  domain: null,
  outlet: null,
  common_source: 'Unknown',
  common_source_category: 'Other',
};

const elvie = {
  ...candidateBase,
  id: '27270275',
  name: 'Elvie Schmidt',
  firstname: 'Elvie',
  lastname: 'Schmidt',
  headline: 'Account Manager at Globex',
  job: aeJob,
  stage: 'Interview',
  stage_kind: 'interview',
  profile_url: 'https://acme.workable.com/backend/jobs/5986327/candidates/656866720',
  address: '12 Rue de Rivoli, Paris',
  phone: '+33 6 12 34 56 78',
  email: 'Elvie.Schmidt@example.com',
  domain: 'linkedin.com',
  common_source: 'LinkedIn',
  common_source_category: 'Job boards',
  created_at: '2026-04-11T03:36:38Z',
  updated_at: '2026-07-23T18:58:16Z',
  resume_metadata: { filename: 'cv_elvie_schmidt.pdf', filetype: 'pdf', created_at: '2026-04-11T03:36:38Z', updated_at: '2026-04-11T03:36:38Z' },
};
const mark = {
  ...candidateBase,
  id: '27270279',
  name: 'Mark Mohr',
  firstname: 'Mark',
  lastname: 'Mohr',
  headline: 'Regional Sales Manager',
  job: aeJob,
  stage: 'Hired',
  stage_kind: 'hired',
  hired_at: '2026-04-27T12:09:40Z',
  moved_to_offer_at: '2026-04-22T10:00:00Z',
  profile_url: 'https://acme.workable.com/backend/jobs/5986327/candidates/656866727',
  address: '24039 Metz Turnpike, 80205 Klingfurt, UK',
  phone: '+18579909675',
  email: 'mark_mohr@example.net',
  domain: 'workable.com',
  common_source: 'Careers page',
  common_source_category: 'Company marketing',
  created_at: '2026-04-13T03:36:46Z',
  updated_at: '2026-07-23T18:58:16Z',
  resume_metadata: { filename: 'cv_mark_mohr.pdf', filetype: 'pdf', created_at: '2026-04-13T03:36:46Z', updated_at: '2026-04-13T03:36:46Z' },
};
const nango = {
  ...candidateBase,
  id: '2727030b',
  name: 'Nango Testthree',
  firstname: null, // live: first/last can be null while name is set
  lastname: null,
  headline: 'QA Engineer',
  job: engJob,
  stage: 'Tech Interview',
  stage_kind: 'interview',
  disqualified: true,
  disqualification_reason: "Doesn't have required qualifications",
  sourced: true,
  outlet: 'SPI',
  profile_url: 'https://acme.workable.com/backend/jobs/5986400/candidates/656878782',
  email: 'nango.testthree@example.com',
  created_at: '2026-07-23T19:21:42Z',
  updated_at: '2026-07-25T08:00:00Z',
};
const sampleCandidate = {
  ...candidateBase,
  id: '2727ba55',
  name: 'Lennert Rossler',
  firstname: 'Lennert',
  lastname: 'Rossler',
  job: { shortcode: 'D4A1B2C3E5', title: 'Customer Success Manager' },
  stage: 'Applied',
  stage_kind: 'applied',
  email: 'lennert_rossler@samplecandidate.com',
  created_at: '2026-03-26T03:36:46Z',
  updated_at: '2026-03-26T03:36:46Z',
};
const elvieAgain = {
  ...candidateBase,
  id: '2727ba60',
  name: 'Elvie Schmidt',
  firstname: 'Elvie',
  lastname: 'Schmidt',
  job: engJob,
  stage: 'Applied',
  stage_kind: 'applied',
  email: 'elvie.schmidt@example.com',
  common_source: 'Employee referral',
  common_source_category: 'Referrals',
  created_at: '2026-08-01T09:00:00Z',
  updated_at: '2026-08-01T09:00:00Z',
};
const anonymized = {
  ...candidateBase,
  id: '2727ba61',
  name: 'Anonymized candidate',
  firstname: null,
  lastname: null,
  job: aeJob,
  stage: 'Applied',
  stage_kind: 'applied',
  disqualified: true,
  anonymized: true,
  email: null,
  created_at: '2026-02-01T09:00:00Z',
  updated_at: '2026-08-01T09:00:00Z',
};
// Three per page: [Elvie, Mark, Nango], [sample, Elvie again, anonymized].
const candidates = [elvie, mark, nango, sampleCandidate, elvieAgain, anonymized];
type CandidateFixture = { id: string; created_at: string };
const candidateList = (list: () => CandidateFixture[]) =>
  keyset(
    'candidates',
    (url) => list().filter((c) => Date.parse(c.created_at) / 1000 >= Number(url.searchParams.get('created_after') ?? 0)),
    3,
  );

const detailExtras = {
  image_url: null,
  disqualified_at: null,
  withdrew: false,
  outbound_mailbox: 'x1@outbound.workablemail.com',
  uploader_id: null,
  cover_letter: null,
  summary: null,
  education_entries: [],
  experience_entries: [],
  skills: [],
  answers: [],
  resume_url: null,
  tags: [],
  location: { location_str: null, country: null, country_code: null, region: null, region_code: null, city: null, zip_code: null },
  originating_candidate_id: null,
};
const details: Record<string, object> = {
  [elvie.id]: {
    ...elvie,
    ...detailExtras,
    cover_letter: '<p>I have sold industrial robots across the EU for six years.</p>',
    experience_entries: [
      { id: '3fdbfd0e', title: 'Account Manager', summary: '<ul><li>Grew the DACH book.</li></ul>', start_date: '2021-03-01', end_date: null, company: 'Globex', industry: null, current: true },
    ],
    education_entries: [
      { id: '3fcbeee1', degree: 'B.A. Business Studies', school: 'University of Chicago', field_of_study: null, start_date: '2012-09-01', end_date: '2016-06-01' },
    ],
    skills: [{ name: 'Negotiation' }, { name: 'Salesforce' }],
    answers: [
      { question: { body: 'How many years of B2B sales experience do you have?' }, answer: { choices: [{ body: '3-5 years' }] } },
      { question: { body: 'Are you authorized to work in the UK?' }, answer: { checked: true } },
      { question: { body: 'Portfolio' }, answer: { file_url: signed(ATTACHMENTS, '/answers/27270275/elvie-portfolio.pdf') } },
    ],
    resume_url: signed(RESUMES, '/resumes/27270275/cv_elvie_schmidt.pdf'),
    social_profiles: [{ type: 'linkedin', name: 'LinkedIn', url: 'https://www.linkedin.com/in/elvieschmidt' }],
    tags: ['priority', 'eu'],
    location: { location_str: 'Paris, France', country: 'France', country_code: 'FR', region: null, region_code: null, city: 'Paris', zip_code: null },
  },
  [mark.id]: (() => {
    // Live quirk: `social_profiles` is omitted entirely when there are none.
    const { social_profiles: _omit, ...d } = { ...mark, ...detailExtras, social_profiles: [] };
    return { ...d, resume_url: signed(RESUMES, '/resumes/27270279/cv_mark_mohr.pdf'), tags: ['closer'] };
  })(),
  [nango.id]: {
    ...nango,
    ...detailExtras,
    disqualified_at: '2026-07-25T08:00:00Z',
    uploader_id: '1f395d',
    social_profiles: [{ type: 'github', name: 'GitHub', url: 'https://github.com/nango-testthree' }],
    tags: ['nango'],
  },
  [elvieAgain.id]: { ...elvieAgain, ...detailExtras, social_profiles: [] },
};

const act = (id: string, action: string, at: string, extra: object = {}) => ({
  id,
  action,
  stage_name: null,
  action_stage: null,
  target_stage: null,
  created_at: at,
  updated_at: at,
  body: null,
  ...extra,
});
const everyone = ['simple', 'hiring_manager', 'admin', 'reviewer', 'recruiting_admin'];
const timelines: Record<string, { id: string }[]> = {
  // Nine activities: two pages of five.
  [elvie.id]: [
    act('90746972', 'applied', '2026-04-11T03:36:46.560Z', { stage_name: 'Applied', action_stage: stageRef(S.applied) }),
    act('90746976', 'comment', '2026-04-12T03:36:54.562Z', {
      stage_name: 'Applied',
      action_stage: stageRef(S.applied),
      member: NATALIE,
      body: "Application is promising, let's schedule a call @eduardo_vallente.",
      visibility_roles: everyone,
    }),
    act('90746985', 'phone-screen', '2026-04-15T03:37:24.560Z', {
      stage_name: 'Applied',
      action_stage: stageRef(S.applied),
      target_stage: stageRef(S.phone),
      member: ADMIN,
    }),
    act('90746990', 'rating', '2026-04-16T03:37:14.575Z', {
      stage_name: 'Phone Screen',
      action_stage: stageRef(S.phone),
      member: ADMIN,
      body: 'Good',
      rating: { score: 'positive', scale: 'thumbs', grade: 1 },
      visibility_roles: [...everyone, 'recruiter'],
    }),
    act('90746995', 'message', '2026-04-16T09:00:00.000Z', {
      stage_name: 'Phone Screen',
      action_stage: stageRef(S.phone),
      member: ADMIN,
      body: '<p>Hi Elvie,</p><p>Thanks for your time today &amp; see you on Friday.</p>',
    }),
    act('907469a1', 'interview', '2026-04-17T10:00:00.000Z', {
      stage_name: 'Phone Screen',
      action_stage: stageRef(S.phone),
      target_stage: stageRef(S.interview),
      member: ADMIN,
    }),
    act('907469a2', 'assessment-requested', '2026-04-17T10:05:00.000Z', { stage_name: 'Interview', action_stage: stageRef(S.interview) }),
    // Evaluations can be restricted too: only admins could see this one.
    act('907469a3', 'rating', '2026-04-18T15:00:00.000Z', {
      stage_name: 'Interview',
      action_stage: stageRef(S.interview),
      member: ADMIN,
      body: 'Flight risk; see references.',
      rating: { score: 'negative', scale: 'thumbs', grade: 0 },
      visibility_roles: ['admin', 'recruiting_admin'],
    }),
    act('907469a4', 'comment', '2026-04-19T10:00:00.000Z', {
      stage_name: 'Interview',
      action_stage: stageRef(S.interview),
      member: ADMIN,
      body: 'Compensation expectations are above band.',
      visibility_roles: ['admin'],
    }),
  ],
  // The feed never shows the move to Hired (seed data does this); `hired_at` dates it.
  [mark.id]: [
    act('90746a01', 'applied', '2026-04-13T03:36:46.560Z', { stage_name: 'Applied', action_stage: stageRef(S.applied) }),
    act('90746a10', 'offer', '2026-04-22T10:00:00.000Z', { action_stage: stageRef(S.applied), target_stage: stageRef(S.offer), member: ADMIN }),
    act('90746a12', 'rating', '2026-04-22T11:00:00.000Z', {
      stage_name: 'Offer',
      action_stage: stageRef(S.offer),
      member: NATALIE,
      body: 'Exceptional closer',
      rating: { score: 'positive', scale: 'stars', grade: 4 },
    }),
  ],
  [nango.id]: [
    act('9075283b', 'uploaded', '2026-07-23T19:21:46.175Z', { stage_name: 'Sourced', action_stage: stageRef(S.sourced), member: ADMIN }),
    act('907533be', 'tech-interview', '2026-07-24T09:00:00.000Z', {
      stage_name: 'Sourced',
      action_stage: stageRef(S.sourced),
      target_stage: stageRef(S.tech),
      member: NATALIE,
    }),
    // An evaluation with no overall decision → kept as a note
    act('90753400', 'rating', '2026-07-24T12:00:00.000Z', {
      stage_name: 'Tech Interview',
      action_stage: stageRef(S.tech),
      member: NATALIE,
      body: 'Solid system design, weak on testing. Holding my vote until the pairing session.',
      rating: null,
    }),
    act('90753410', 'offer', '2026-07-24T15:00:00.000Z', {
      stage_name: 'Tech Interview',
      action_stage: stageRef(S.tech),
      target_stage: stageRef(S.offer),
      member: NATALIE,
    }),
    // Undoes the move above; live `reverted` activities carry no target stage.
    act('90753420', 'reverted', '2026-07-24T16:00:00.000Z', { stage_name: 'Offer', action_stage: stageRef(S.offer), member: NATALIE }),
    // Not a comment, but its report lands in the Files tab.
    act('90753430', 'assessment-completed', '2026-07-24T17:00:00.000Z', { stage_name: 'Tech Interview', action_stage: stageRef(S.tech) }),
    act('90753500', 'disqualified', '2026-07-25T08:00:00.000Z', {
      stage_name: 'Tech Interview',
      action_stage: stageRef(S.tech),
      member: ADMIN,
      body: "Doesn't have required qualifications",
    }),
  ],
  [elvieAgain.id]: [
    act('90760001', 'referral', '2026-08-01T09:00:01.000Z', { stage_name: 'Applied', action_stage: stageRef(S.applied), member: NATALIE }),
  ],
};

const offer = {
  candidate: { id: mark.id, location: 'London, United Kingdom', name: 'Mark Mohr' },
  created_at: '2026-04-21T13:43:40.442Z',
  state: 'accepted',
  document_variables: [
    { document_variable: { name: 'Job', slug: 'job' }, value: { body: 'Senior Account Executive' } },
    { document_variable: { name: 'Start Date', slug: 'start_date' }, value: { body: '2026-05-18' } },
    { document_variable: { name: 'Direct Manager', slug: 'direct_manager' }, value: { body: 'John Johnson' } },
    {
      document_variable: { name: 'Salary', slug: 'salary' },
      value: { data: { amount: 85000, frequency: 'year', cached_value: '£85,000.00 per year', currency_iso: 'GBP' } },
    },
    { document_variable: { name: 'Bonus', slug: 'bonus' }, value: { body: 5000 } },
    { document_variable: { name: 'Expiration Date', slug: 'offer_expiration_date' }, value: { body: '2026-04-28' } },
    { document_variable: { name: 'Job Responsibilities', slug: 'job_responsibilities' }, value: { body: ['Own the UK pipeline', 'Mentor SDRs'] } },
  ],
  documents: [{ name: 'signed-offer.pdf', preview_url: signed(ATTACHMENTS, '/offers/signed-offer.pdf'), kind: 'offer' }],
};

const candidateFiles: Record<string, object[]> = {
  [elvie.id]: [{ name: 'references.pdf', preview_url: signed(ATTACHMENTS, '/comments/references.pdf'), source: 'Comment' }],
  [mark.id]: [{ name: 'signed-offer.pdf', preview_url: signed(ATTACHMENTS, '/offers/signed-offer.pdf'), source: 'Offer', kind: 'offer' }],
  [nango.id]: [{ name: 'assessment-report.pdf', preview_url: signed(ATTACHMENTS, '/timeline/assessment-report.pdf'), source: 'Comment' }],
  [elvieAgain.id]: [], // live: {"files": []}
};

const events = [
  {
    id: '10e0d9a',
    title: 'Skype call with Lennert Rossler',
    description: 'We will call you on your cell',
    type: 'CallEvent',
    starts_at: '2026-04-17T03:36:46.000Z',
    ends_at: '2026-04-17T04:06:46.000Z',
    cancelled: false,
    job: { shortcode: 'D4A1B2C3E5', title: 'Customer Success Manager' },
    members: [{ ...NATALIE, status: 'accepted' }],
    candidate: { id: sampleCandidate.id, name: 'Lennert Rossler' },
  },
  {
    id: '47fdddd',
    title: 'Interview with Elvie Schmidt',
    description: '',
    type: 'InterviewEvent',
    starts_at: '2026-04-18T14:00:00.000Z',
    ends_at: '2026-04-18T14:45:00.000Z',
    cancelled: false,
    job: aeJob,
    members: [
      { ...ADMIN, status: 'accepted' },
      { ...NATALIE, status: 'needs-action' },
    ],
    candidate: { id: elvie.id, name: 'Elvie Schmidt' },
    conference: { type: 'zoom_meeting', id: 1100001, url: 'https://zoom.us/j/1100001' },
  },
  {
    id: '47fde10',
    title: 'Pairing session',
    description: null,
    type: 'InterviewEvent',
    starts_at: '2026-07-26T10:00:00.000Z',
    ends_at: '2026-07-26T11:00:00.000Z',
    cancelled: true,
    job: engJob,
    members: [{ ...NATALIE, status: 'accepted' }],
    candidate: { id: nango.id, name: 'Nango Testthree' },
  },
  {
    id: '47fde20',
    title: 'Hiring sync',
    description: null,
    type: 'MeetingEvent',
    starts_at: '2026-07-27T10:00:00.000Z',
    ends_at: '2026-07-27T10:30:00.000Z',
    cancelled: false,
    members: [{ ...ADMIN, status: 'accepted' }],
  },
];
// `include_cancelled` defaults to false: cancelled events only come back when asked for.
const eventList = keyset('events', (url) => (url.searchParams.get('include_cancelled') === 'true' ? events : events.filter((e) => !e.cancelled)), 2);

// ---------- The mock API ----------

/** S3 rejects a request carrying both a signature and an Authorization header. */
const s3 = (body: string, type = 'application/pdf'): RouteHandler => ({ headers }) =>
  headers.authorization
    ? new Response('<Error><Code>InvalidArgument</Code><Message>Only one auth mechanism allowed</Message></Error>', { status: 400 })
    : new Response(Buffer.from(body), { headers: { 'content-type': type } });

function workable(override: Record<string, RouteHandler> = {}) {
  const routes: Record<string, RouteHandler> = {
    'GET workable.com/spi/v3/accounts': () => json({ accounts: [account] }),
    [`GET ${API}/members`]: keyset('members', () => members, 2),
    [`GET ${API}/recruiters`]: () => json({ recruiters: [{ id: '19782abc', name: 'Nadia Sawahla', email: 'nadia.sawahla@agency.test' }] }),
    [`GET ${API}/stages`]: () => json({ stages: orgStages }),
    [`GET ${API}/disqualification_reasons`]: () => json(reasons), // bare array (live), not the docs' object
    [`GET ${API}/requisitions`]: keyset('requisitions', () => requisitions, 2),
    [`GET ${API}/jobs`]: keyset('jobs', () => jobs, 2),
    [`GET ${API}/candidates`]: candidateList(() => candidates),
    [`GET ${API}/candidates/${mark.id}/offer`]: () => json(offer),
    [`GET ${API}/events`]: eventList,
    [`GET ${RESUMES}/resumes/27270275/cv_elvie_schmidt.pdf`]: s3('%PDF-1.4\n% Elvie Schmidt resume\n'),
    [`GET ${RESUMES}/resumes/27270279/cv_mark_mohr.pdf`]: s3('%PDF-1.4\n% Mark Mohr resume\n'),
    [`GET ${ATTACHMENTS}/answers/27270275/elvie-portfolio.pdf`]: s3('%PDF-1.4\n% portfolio\n'),
    [`GET ${ATTACHMENTS}/comments/references.pdf`]: s3('%PDF-1.4\n% references\n'),
    [`GET ${ATTACHMENTS}/offers/signed-offer.pdf`]: s3('%PDF-1.4\n% signed offer\n'),
    [`GET ${ATTACHMENTS}/timeline/assessment-report.pdf`]: s3('%PDF-1.4\n% assessment report\n'),
  };
  for (const [sc, d] of Object.entries(jobDetails)) routes[`GET ${API}/jobs/${sc}`] = () => json(d);
  for (const [sc, st] of Object.entries(jobStages)) routes[`GET ${API}/jobs/${sc}/stages`] = () => json({ stages: st });
  for (const [sc, team] of Object.entries(jobTeams)) routes[`GET ${API}/jobs/${sc}/members`] = () => json({ members: team });
  for (const [id, d] of Object.entries(details)) routes[`GET ${API}/candidates/${id}`] = () => json({ candidate: d });
  for (const [id, t] of Object.entries(timelines)) routes[`GET ${API}/candidates/${id}/activities`] = keyset('activities', () => t, 5);
  for (const [id, f] of Object.entries(candidateFiles)) routes[`GET ${API}/candidates/${id}/files`] = () => json({ files: f });
  return mockFetch({ ...routes, ...override });
}

const isWorkable = (host: string) => host === 'workable.com' || host.endsWith('.workable.com');
const imported = (o: { customFields: unknown }) => (o.customFields as { imported: { id: string; fields?: Record<string, string> } }).imported;

/** Drive an import slice by slice on a caller-controlled clock (runImportForTest uses real time). */
async function runSliced(fetchImpl: typeof fetch, now: () => number, budgetMs: number, options: Partial<ImportOptions> = {}) {
  process.env.AUTH_SECRET ||= 'test-secret';
  registerProviderForTests({ ...workableProvider, minIntervalMs: 0 });
  const org = await db.organization.create({
    data: { slug: `workable-sliced-${randomUUID().slice(0, 8)}`, name: 'Sliced Test', onboardedAt: new Date() },
  });
  const admin = await db.user.create({ data: { orgId: org.id, email: 'admin@example.test', name: 'Test Admin', accessRole: 'ADMIN' } });
  const ctx = { userId: admin.id, orgId: org.id, accessRole: 'ADMIN' };
  const job = await db.importJob.create({
    data: {
      orgId: org.id,
      provider: 'workable',
      credentials: sealCredentials(CREDS),
      options: { ...DEFAULT_IMPORT_OPTIONS, ...options } as Prisma.InputJsonValue,
      createdById: admin.id,
    },
  });
  let slices = 0;
  for (; slices < 1000; slices++) {
    const state = await db.importJob.findUniqueOrThrow({ where: { id: job.id } });
    if (state.status === 'REVIEW') {
      const review = (await getImportJob(ctx, job.id))!.review!;
      await confirmImportMapping(ctx, job.id, {
        stages: Object.fromEntries(review.stages.map((s) => [s.key, s.target])),
        reasons: Object.fromEntries(review.reasons.map((r) => [r.key, r.target])),
      });
      continue;
    }
    if (state.status !== 'DISCOVERING' && state.status !== 'RUNNING') break;
    // 'waiting' = a throttle wait that would outlast the slice; 'failed' = a server error whose retry
    // won't fit. Either way the slice ends and the next one replays; time is fake here, so release the hold.
    const result = await runSlice(job.id, budgetMs, { fetchImpl, now, resolveHost: publicDns });
    expect(['worked', 'waiting', 'failed']).toContain(result);
    if (result !== 'worked') await db.importJob.update({ where: { id: job.id }, data: { leaseUntil: null } });
  }
  return { view: (await getImportJob(ctx, job.id))!, slices, orgId: org.id };
}

const FULL_IMPORT = { posting: 2, requisition: 3, contact: 3, opportunity: 4, note: 3, feedback: 3, interview: 2, offer: 1, file: 6 };

// ---------- Tests ----------

describe.skipIf(!hasDb)('workable adapter', () => {
  it('verifies with a Bearer token and returns the account name', async () => {
    const api = workable();
    await expect(verifyForTest(workableProvider, CREDS, api.impl)).resolves.toEqual({ accountName: 'Acme Robotics' });

    expect(api.calls.map((c) => `${c.url.host}${c.url.pathname}`)).toEqual(['workable.com/spi/v3/accounts', `${API}/candidates`]);
    for (const call of api.calls) {
      expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(call.headers.accept).toBe('application/json');
      expect(call.url.toString()).not.toContain(TOKEN);
    }
    expect(api.calls[1].url.searchParams.get('limit')).toBe('1'); // r_candidates probe
    expect(api.unmatched).toEqual([]);

    // Pasted URLs and a "Bearer " prefix are tolerated.
    const pasted = workable();
    await expect(
      verifyForTest(workableProvider, { subdomain: 'https://ACME.workable.com/backend', apiToken: `Bearer ${TOKEN}` }, pasted.impl),
    ).resolves.toEqual({ accountName: 'Acme Robotics' });
    expect(pasted.calls[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('explains a wrong or missing subdomain without calling a foreign host', async () => {
    const api = workable();
    await expect(verifyForTest(workableProvider, { ...CREDS, subdomain: 'globex' }, api.impl)).rejects.toThrow(
      /acme\.workable\.com, not globex\.workable\.com/,
    );
    await expect(verifyForTest(workableProvider, { apiToken: TOKEN }, api.impl)).rejects.toThrow(/subdomain/);
    await expect(verifyForTest(workableProvider, { ...CREDS, subdomain: 'evil.test/x?' }, api.impl)).rejects.toThrow(/subdomain/);
    expect(api.calls.every((c) => isWorkable(c.url.host))).toBe(true);

    expect(normalizeSubdomain('acme')).toBe('acme');
    expect(normalizeSubdomain('https://apply.workable.com/acme/')).toBe('acme');
    expect(normalizeSubdomain('acme.workable.com.evil.test')).toBeNull();
    expect(normalizeSubdomain('www')).toBeNull();
  });

  it('builds without credentials (the engine lists phases with {})', () => {
    const http = createHttpClient({ resolveHost: publicDns, auth: { hosts: [] }, minIntervalMs: 0 });
    const adapter = workableProvider.create({}, http);
    expect(adapter.discover.map((p) => p.id)).toEqual(['users', 'stages', 'reasons']);
    expect(adapter.load.map((p) => p.id)).toEqual(['postings', 'candidates', 'interviews']);
    expect(workableProvider.auth({}).hosts).toEqual(['workable.com', 'www.workable.com']);
    expect(workableProvider.auth(CREDS).hosts).toContain('acme.workable.com');
    expect(workableProvider.minIntervalMs).toBeGreaterThanOrEqual(1000);
  });

  it('maps every rating scale to Source’s 1–4 and leaves unparseable ones undecided', () => {
    expect(workableRating({ score: 'negative', scale: 'thumbs', grade: 0 }).value).toBe(2);
    expect(workableRating({ score: 'positive', scale: 'thumbs', grade: 1 })).toEqual({ value: 3, label: 'Thumbs up' });
    expect(workableRating({ score: 'definite', scale: 'thumbs', grade: 2 }).value).toBe(4);
    expect([0, 1, 2, 3, 4].map((grade) => workableRating({ score: 'positive', scale: 'stars', grade }).value)).toEqual([1, 2, 3, 3, 4]);
    expect([0, 1, 2, 4, 5, 7, 8, 9].map((grade) => workableRating({ scale: 'numbers', grade }).value)).toEqual([1, 1, 2, 2, 3, 3, 4, 4]);
    expect(workableRating({ score: 'definite' })).toEqual({ value: 4, label: 'Definitely' }); // job feed: score only
    expect(workableRating({ scale: 'stars', grade: 9 }).value).toBeNull();
    expect(workableRating(null).value).toBeNull();
  });

  it('follows paging.next only on Workable hosts and rebuilds foreign ones from since_id', async () => {
    const calls: { url: URL; authorization?: string }[] = [];
    const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      calls.push({ url, authorization: (init.headers as Record<string, string>).authorization });
      if (url.host !== 'acme.workable.com') return json({ error: 'wrong host' }, { status: 404 });
      return url.searchParams.get('since_id')
        ? json({ members: members.slice(1) })
        : json({ members: members.slice(0, 1), paging: { next: 'https://evil.test/spi/v3/members?limit=100&since_id=1f3961' } });
    }) as typeof fetch;
    const http = createHttpClient({ resolveHost: publicDns, auth: workableProvider.auth(CREDS), minIntervalMs: 0, fetchImpl });
    const catalog = emptyCatalog();
    const ctx: PhaseContext = {
      http,
      catalog: catalogWriter(catalog),
      load: {} as Loader,
      options: DEFAULT_IMPORT_OPTIONS,
      since: null,
      outOfTime: () => false,
      warn: () => undefined,
    };
    const users = workableProvider.create(CREDS, http).discover[0];
    let cursor = await users.run(ctx, null);
    cursor = await users.run(ctx, cursor);
    expect(calls.map((c) => c.url.host)).toEqual(['acme.workable.com', 'acme.workable.com']);
    expect(calls.every((c) => c.authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect(calls[1].url.searchParams.get('since_id')).toBe('1f3961');
    expect(calls[1].url.searchParams.get('status')).toBe('all'); // filters survive the rebuild
    expect(catalog.users.map((u) => u.externalId)).toEqual(['1f395d', '1f3961', '1f3999']);
    expect(cursor).toEqual({ recruiters: true });
  });

  it('retries a transient 404 once, and only a missing first page ends a list early', async () => {
    let firstPage404s = 1;
    let laterPageCalls = 0;
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.searchParams.get('since_id')) {
        laterPageCalls++;
        return json({ error: 'Not found' }, { status: 404 }); // page 2 keeps failing
      }
      if (firstPage404s-- > 0) return json({ error: 'Not found' }, { status: 404 });
      return eventList({ url, method: 'GET', headers: {}, body: null });
    }) as typeof fetch;
    const loaded: string[] = [];
    const warnings: string[] = [];
    const ctxFor = (http: PhaseContext['http']): PhaseContext => ({
      http,
      catalog: catalogWriter(emptyCatalog()),
      load: {
        interview: async (i: ImportedInterview) => {
          loaded.push(i.externalId);
        },
      } as unknown as Loader,
      options: DEFAULT_IMPORT_OPTIONS,
      since: null,
      outOfTime: () => false,
      warn: (m) => {
        warnings.push(m);
      },
    });
    const http = createHttpClient({ resolveHost: publicDns, auth: workableProvider.auth(CREDS), minIntervalMs: 0, fetchImpl });
    const interviews = workableProvider.create(CREDS, http).load.find((p) => p.id === 'interviews')!;

    const cursor = await interviews.run(ctxFor(http), null);
    expect(loaded).toEqual(['10e0d9a', '47fdddd']); // the first page, on its second try
    expect(cursor).not.toBeNull();
    // A later page that keeps failing is retried once, then the slice fails (and the runner retries
    // it later) instead of quietly dropping the rest of the list.
    await expect(interviews.run(ctxFor(http), cursor)).rejects.toThrow(/HTTP 404/);
    expect(laterPageCalls).toBe(2);
    expect(warnings).toEqual([]);

    // No access to the list at all: a warning, and the phase is done.
    const denied = createHttpClient({ resolveHost: publicDns,
      auth: workableProvider.auth(CREDS),
      minIntervalMs: 0,
      fetchImpl: (async () => json({ error: 'Forbidden' }, { status: 403 })) as typeof fetch,
    });
    const phase = workableProvider.create(CREDS, denied).load.find((p) => p.id === 'interviews')!;
    await expect(phase.run(ctxFor(denied), null)).resolves.toBeNull();
    expect(warnings).toEqual([expect.stringMatching(/^Interviews skipped: This key doesn't have permission/)]);
  });

  it('imports a full account end to end, and a re-run adds nothing', async () => {
    const api = workable();
    const res = await runImportForTest({ module: workableProvider, credentials: CREDS, fetchImpl: api.impl });
    expect(res.error).toBeNull();
    expect(res.status).toBe('SUCCEEDED');
    expect(api.unmatched).toEqual([]);
    const { orgId, adminId } = res;

    // ----- Review: vendor stages grouped by name, org and per-job pipelines unioned by id -----
    const stages = Object.fromEntries(res.review!.stages.map((s) => [s.key, s]));
    expect(Object.keys(stages).sort()).toEqual(
      ['applied', 'assessment', 'hired', 'interview', 'offer', 'phone screen', 'sourced', 'tech interview'].sort(),
    );
    expect(stages['phone screen'].count).toBe(1); // same id on the org list and both jobs
    for (const key of ['phone screen', 'offer', 'hired']) expect(stages[key].target).toHaveProperty('stageId');
    expect(stages.sourced.target).toEqual({ create: { name: 'Sourced', type: 'LEAD' } });
    expect(stages.applied.target).toEqual({ create: { name: 'Applied', type: 'APPLICANT' } });
    expect(stages.interview.target).toEqual({ create: { name: 'Interview', type: 'ONSITE' } });
    expect(stages['tech interview'].target).toEqual({ create: { name: 'Tech Interview', type: 'ONSITE' } });
    const reasonKinds = Object.fromEntries(res.review!.reasons.map((r) => [r.name, r.kind]));
    expect(reasonKinds).toEqual({
      "Doesn't have required qualifications": 'rejection',
      'Other candidates are more suitable': 'rejection',
      'Unsuccessful interview': 'rejection',
      'Could not be contacted': 'withdrawn',
      'Rejected offer': 'withdrawn',
      'Not interested': 'withdrawn',
      Hired: 'hired',
    });
    expect(res.review!.users).toMatchObject({ total: 4, matched: 1 }); // 3 members (incl. deactivated) + 1 agency recruiter

    // ----- What was created -----
    expect(res.view.created).toEqual(FULL_IMPORT);
    expect(res.view.linked.contact).toBe(1); // Elvie's second job merged by email
    const issues = res.view.issues.map((i) => i.message);
    expect(issues).toContain("Skipped Workable's sample (demo) jobs");
    expect(issues).toContain("Skipped candidates of Workable's sample (demo) jobs");
    expect(issues).toContain('Skipped candidates that Workable has anonymized');
    expect(res.view.issues.find((i) => i.message === RESTRICTED)?.count).toBe(2); // an admin-only comment and evaluation
    expect(issues.some((m) => /^Requisitions skipped/.test(m))).toBe(false);

    // ----- Credentials never leave Workable -----
    const foreign = api.calls.filter((c) => !isWorkable(c.url.host));
    expect(foreign.length).toBe(6); // 2 resumes + 4 attachments, all pre-signed S3
    for (const call of foreign) {
      expect(call.headers.authorization).toBeUndefined();
      expect(JSON.stringify(call.headers)).not.toContain(TOKEN);
      expect(call.url.toString()).not.toContain(TOKEN);
    }
    for (const call of api.calls.filter((c) => isWorkable(c.url.host))) expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`);
    // Fan-out is skipped for demo and anonymized records. Every imported candidate's Files tab is read.
    const paths = api.calls.map((c) => c.url.pathname);
    expect(paths.some((p) => p.includes(sampleCandidate.id) || p.includes(anonymized.id))).toBe(false);
    expect(paths.filter((p) => p.endsWith('/files'))).toEqual([elvie.id, mark.id, nango.id, elvieAgain.id].map((id) => `/spi/v3/candidates/${id}/files`));
    expect(paths.filter((p) => p.endsWith('/offer'))).toEqual([`/spi/v3/candidates/${mark.id}/offer`]);
    expect(paths.filter((p) => p.endsWith('/members') && p.includes('/jobs/'))).toEqual([
      '/spi/v3/jobs/9CD658E13E/members',
      '/spi/v3/jobs/ENG0042A1/members',
    ]);
    const since = (path: string) => api.calls.filter((c) => c.url.pathname === path).map((c) => c.url.searchParams.get('since_id'));
    expect(since('/spi/v3/candidates')).toEqual(expect.arrayContaining([null, sampleCandidate.id]));
    expect(since(`/spi/v3/candidates/${elvie.id}/activities`)).toEqual([null, '907469a1']); // a two-page timeline
    // Cancelled events were asked for on every page, the second included (its next URL drops the filter).
    const eventCalls = api.calls.filter((c) => c.url.pathname === '/spi/v3/events');
    expect(eventCalls.map((c) => [c.url.searchParams.get('since_id'), c.url.searchParams.get('include_cancelled')])).toEqual([
      [null, 'true'],
      ['47fde10', 'true'],
    ]);

    // ----- Requisitions (Hiring Plan) -----
    const reqs = Object.fromEntries(
      (await db.requisition.findMany({ where: { orgId }, include: { postings: true } })).map((r) => [r.code, r]),
    );
    expect(reqs.REQ101).toMatchObject({
      title: 'Account Executive',
      state: 'OPEN',
      openings: 1,
      filled: 0,
      backfill: true,
      salaryMin: 60000,
      salaryMax: 80000,
      salaryCurrency: 'GBP', // numeric currency_iso 826
    });
    expect(reqs.REQ102).toMatchObject({ title: 'Staff Engineer', state: 'ON_HOLD', backfill: false, salaryMin: 90000, salaryCurrency: 'EUR' });
    expect(reqs.REQ103).toMatchObject({ state: 'CLOSED', salaryCurrency: 'GBP' });
    expect(reqs.REQ101.postings.map((p) => p.title)).toEqual(['Account Executive']);
    expect(reqs.REQ102.postings.map((p) => p.title)).toEqual(['Staff Engineer']);
    expect(reqs.REQ103.postings).toEqual([]);

    // ----- Postings -----
    const postings = await db.posting.findMany({ where: { orgId }, include: { department: true } });
    expect(postings.map((p) => p.title).sort()).toEqual(['Account Executive', 'Staff Engineer']);
    const ae = postings.find((p) => p.title === 'Account Executive')!;
    expect(ae).toMatchObject({
      state: 'DRAFT',
      location: 'London, United Kingdom; Berlin, Germany', // every advertised location, not the hidden one
      workplaceType: 'HYBRID',
      commitment: 'FULL_TIME',
      salaryMin: 60000,
      salaryMax: 80000,
      salaryCurrency: 'GBP',
    });
    expect(ae.department?.name).toBe('Sales');
    expect(ae.createdAt.toISOString()).toBe('2026-03-25T00:00:00.000Z');
    const description = (ae.content as { description: string }).description;
    expect(description).toContain('• Proven experience as an Account Executive');
    expect(description).toContain('Dental & Vision');
    expect(description).not.toContain('<');
    const eng = postings.find((p) => p.title === 'Staff Engineer')!;
    expect(eng).toMatchObject({ state: 'CLOSED', workplaceType: 'REMOTE', commitment: 'CONTRACT', location: 'Remote', tags: ['platform'] });
    expect(eng.department?.name).toBe('Engineering');

    // ----- Contacts (one per person, merged by email) -----
    const contacts = await db.contact.findMany({ where: { orgId } });
    expect(contacts.map((c) => c.name).sort()).toEqual(['Elvie Schmidt', 'Mark Mohr', 'Nango Testthree']);
    const elvieContact = contacts.find((c) => c.name === 'Elvie Schmidt')!;
    expect(elvieContact).toMatchObject({
      emails: ['elvie.schmidt@example.com'],
      phones: ['+33 6 12 34 56 78'],
      links: ['https://www.linkedin.com/in/elvieschmidt'],
      headline: 'Account Manager at Globex',
      location: 'Paris, France',
    });
    expect(elvieContact.tags.sort()).toEqual(['eu', 'priority']);
    expect(elvieContact.createdAt.toISOString()).toBe('2026-04-11T03:36:38.000Z');
    expect(elvieContact.resumeFileId).not.toBeNull();
    const resume = await db.storedFile.findUniqueOrThrow({ where: { id: elvieContact.resumeFileId! } });
    expect(resume).toMatchObject({ filename: 'cv_elvie_schmidt.pdf', mime: 'application/pdf' });
    expect(contacts.find((c) => c.name === 'Mark Mohr')!.resumeFileId).not.toBeNull();
    expect(contacts.find((c) => c.name === 'Nango Testthree')!.links).toEqual(['https://github.com/nango-testthree']);
    expect(await db.contact.count({ where: { orgId, name: { in: ['Lennert Rossler', 'Anonymized candidate'] } } })).toBe(0);

    // ----- Applications -----
    const opps = await db.opportunity.findMany({
      where: { orgId },
      include: {
        stage: true,
        posting: true,
        archiveReason: true,
        stageTransitions: { orderBy: { occurredAt: 'asc' }, include: { toStage: true } },
      },
    });
    const byId = Object.fromEntries(opps.map((o) => [imported(o).id, o]));
    expect(Object.keys(byId).sort()).toEqual([elvie.id, mark.id, nango.id, elvieAgain.id].sort());

    const e = byId[elvie.id];
    // Owner: the job's recruiting admin, ahead of its hiring manager
    expect(e).toMatchObject({ status: 'ACTIVE', origin: 'APPLIED', source: 'LinkedIn', archivedAt: null, ownerId: adminId, confidential: false });
    expect(e.stage.name).toBe('Interview');
    expect(e.posting!.title).toBe('Account Executive');
    expect(e.createdAt.toISOString()).toBe('2026-04-11T03:36:38.000Z');
    expect(e.stageTransitions.map((t) => t.toStage.name)).toEqual(['Applied', 'Phone screen', 'Interview']);
    expect(e.stageTransitions.map((t) => t.occurredAt.toISOString())).toEqual([
      '2026-04-11T03:36:38.000Z',
      '2026-04-15T03:37:24.560Z',
      '2026-04-17T10:00:00.000Z',
    ]);
    expect(e.stageTransitions[0].fromStageId).toBeNull();
    expect(e.stageTransitions[1].actorId).toBe(adminId);
    expect(e.stageChangedAt.toISOString()).toBe('2026-04-17T10:00:00.000Z');
    expect(imported(e).fields).toEqual({
      'How many years of B2B sales experience do you have?': '3-5 years',
      'Are you authorized to work in the UK?': 'Yes',
      Portfolio: 'File (imported as an attachment)',
      'Workable profile URL': elvie.profile_url,
    });

    const m = byId[mark.id];
    expect(m).toMatchObject({ status: 'HIRED', origin: 'APPLIED', source: 'Careers page', ownerId: adminId, confidential: false });
    expect(m.stage.name).toBe('Hired');
    // A hire looks like one made in Source: Hired stage, no archive reason or date; entering Hired is the hire date.
    expect(m.archiveReason).toBeNull();
    expect(m.archivedAt).toBeNull();
    expect(m.stageChangedAt.toISOString()).toBe('2026-04-27T12:09:40.000Z');
    // The feed has no move to Hired, so it's dated by hired_at rather than the previous move.
    expect(m.stageTransitions.map((t) => [t.toStage.name, t.occurredAt.toISOString()])).toEqual([
      ['Applied', '2026-04-13T03:36:46.000Z'],
      ['Offer', '2026-04-22T10:00:00.000Z'],
      ['Hired', '2026-04-27T12:09:40.000Z'],
    ]);
    expect(m.stageChangedAt.toISOString()).toBe('2026-04-27T12:09:40.000Z');

    const n = byId[nango.id];
    // Uploaded by the admin, so theirs; on a confidential job, so confidential.
    expect(n).toMatchObject({ status: 'ARCHIVED', origin: 'SOURCED', source: null, ownerId: adminId, confidential: true });
    expect(n.stage.name).toBe('Tech Interview');
    expect(n.posting!.title).toBe('Staff Engineer');
    expect(n.archiveReason!.name).toBe("Doesn't have required qualifications");
    expect(n.archiveReason!.countsAsRejection).toBe(true);
    expect(n.archivedAt!.toISOString()).toBe('2026-07-25T08:00:00.000Z');
    // Moved to Offer, then reverted: back in Tech Interview from the time of the revert.
    expect(n.stageTransitions.map((t) => [t.toStage.name, t.occurredAt.toISOString()])).toEqual([
      ['Sourced', '2026-07-23T19:21:42.000Z'],
      ['Tech Interview', '2026-07-24T09:00:00.000Z'],
      ['Offer', '2026-07-24T15:00:00.000Z'],
      ['Tech Interview', '2026-07-24T16:00:00.000Z'],
    ]);

    const r = byId[elvieAgain.id];
    // The ENG job's `admin` is on every job, so its hiring manager (not a Source user) is the owner.
    expect(r).toMatchObject({ status: 'ACTIVE', origin: 'REFERRED', source: 'Employee referral', contactId: e.contactId, ownerId: null, confidential: true });
    expect(r.stage.name).toBe('Applied');

    // ----- Notes: matched authors plain, unmatched keep their name in a byline -----
    const notes = await db.note.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' } });
    const eNotes = notes.filter((x) => x.opportunityId === e.id).map((x) => x.body);
    expect(eNotes).toContainEqual(
      expect.stringMatching(/^\[workable · Natalie Sung\] Application is promising, let's schedule a call @eduardo_vallente\.$/i),
    );
    expect(eNotes).toContain('Email\nHi Elvie,\n\nThanks for your time today & see you on Friday.');
    // Admin-only in Workable: not turned into a note everyone can read.
    expect(eNotes.some((b) => b.includes('Compensation expectations') || b.includes('Flight risk'))).toBe(false);
    const profile = eNotes.find((b) => b.includes('Workable profile'))!;
    expect(profile).toContain('Cover letter\nI have sold industrial robots across the EU for six years.');
    expect(profile).toContain('• Account Manager, Globex (2021-03 – present)');
    expect(profile).toContain('• B.A. Business Studies, University of Chicago (2012-09 – 2016-06)');
    expect(profile).toContain('Skills: Negotiation, Salesforce');
    expect(eNotes.filter((b) => /Attachment: (references|elvie-portfolio)\.pdf/.test(b))).toHaveLength(2);
    const byAuthor = notes.find((x) => x.body.startsWith('Email'))!;
    expect(byAuthor.authorId).toBe(adminId);
    expect(byAuthor.createdAt.toISOString()).toBe('2026-04-16T09:00:00.000Z');

    // ----- Scorecards -----
    const feedback = await db.feedbackSubmission.findMany({ where: { orgId } });
    expect(feedback).toHaveLength(2);
    const eFb = feedback.find((f) => f.opportunityId === e.id)!;
    expect(eFb).toMatchObject({ overallRating: 3, authorId: adminId, summary: 'Phone Screen evaluation\nGood' });
    expect(eFb.answers).toEqual({ 'imported-0': { label: 'Workable rating', kind: 'TEXT', value: 'Thumbs up' } });
    expect(eFb.createdAt.toISOString()).toBe('2026-04-16T03:37:14.575Z');
    const mFb = feedback.find((f) => f.opportunityId === m.id)!;
    expect(mFb.overallRating).toBe(4); // 5★
    expect(mFb.summary).toMatch(/^\[workable · Natalie Sung\] Offer evaluation\nExceptional closer$/i);
    expect(mFb.answers).toEqual({ 'imported-0': { label: 'Workable rating', kind: 'TEXT', value: '5 of 5 stars' } });
    // No overall decision → kept as a note; the assessment report from the Files tab is attached.
    expect(notes.filter((x) => x.opportunityId === n.id).map((x) => x.body)).toEqual([
      expect.stringMatching(/^\[workable · Natalie Sung\] Tech Interview evaluation\nSolid system design/i),
      expect.stringMatching(/^\[workable\] Attachment: assessment-report\.pdf/i),
    ]);

    // ----- Interviews -----
    const interviews = await db.interview.findMany({ where: { orgId }, include: { panelists: true } });
    expect(interviews).toHaveLength(2);
    const eInt = interviews.find((i) => i.opportunityId === e.id)!;
    expect(eInt).toMatchObject({ title: 'Interview with Elvie Schmidt', state: 'COMPLETED', durationMins: 45, location: 'https://zoom.us/j/1100001' });
    expect(eInt.startAt.toISOString()).toBe('2026-04-18T14:00:00.000Z');
    expect(eInt.panelists.map((p) => p.id)).toEqual([adminId]); // Natalie isn't a Source user
    expect(interviews.find((i) => i.opportunityId === n.id)!.state).toBe('CANCELED');

    // ----- Offer -----
    const offers = await db.offer.findMany({ where: { orgId } });
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({
      opportunityId: m.id,
      status: 'ACCEPTED',
      jobTitle: 'Senior Account Executive',
      salaryAmount: 85000,
      salaryCurrency: 'GBP',
      sentAt: null,
    });
    expect(offers[0].startDate!.toISOString()).toBe('2026-05-18T00:00:00.000Z');
    expect(offers[0].createdAt.toISOString()).toBe('2026-04-21T13:43:40.442Z');
    expect(offers[0].notes).toBe(
      [
        'Workable offer status: accepted',
        'Direct Manager: John Johnson',
        'Bonus: 5000',
        'Expiration Date: 2026-04-28',
        'Job Responsibilities: Own the UK pipeline, Mentor SDRs',
      ].join('\n'),
    );

    // ----- Re-running into the same org creates nothing and downloads nothing -----
    const counts = async () => ({
      postings: await db.posting.count({ where: { orgId } }),
      requisitions: await db.requisition.count({ where: { orgId } }),
      contacts: await db.contact.count({ where: { orgId } }),
      opportunities: await db.opportunity.count({ where: { orgId } }),
      notes: await db.note.count({ where: { orgId } }),
      feedback: await db.feedbackSubmission.count({ where: { orgId } }),
      interviews: await db.interview.count({ where: { orgId } }),
      offers: await db.offer.count({ where: { orgId } }),
      files: await db.storedFile.count({ where: { orgId } }),
      stages: await db.stage.count({ where: { orgId } }),
      reasons: await db.archiveReason.count({ where: { orgId } }),
    });
    const before = await counts();
    const again = workable();
    const rerun = await runImportForTest({ module: workableProvider, credentials: CREDS, fetchImpl: again.impl, orgId });
    expect(rerun.status).toBe('SUCCEEDED');
    expect(rerun.view.created).toEqual({});
    expect(rerun.review!.stages.every((s) => 'stageId' in s.target)).toBe(true); // remembers the first run's mapping
    expect(await counts()).toEqual(before);
    expect(again.calls.filter((c) => !isWorkable(c.url.host))).toHaveLength(0);
    expect(again.unmatched).toEqual([]);
    // Nor does it re-read what's done: no job details, and of the imported candidates only the last
    // on each page (which a dead run could have cut off) gets its detail, feed and files again.
    const againPaths = again.calls.map((c) => c.url.pathname);
    expect(againPaths.filter((p) => /^\/spi\/v3\/jobs\/[^/]+$/.test(p))).toEqual([]);
    expect(againPaths.filter((p) => /^\/spi\/v3\/candidates\/[^/]+$/.test(p))).toEqual([
      `/spi/v3/candidates/${nango.id}`,
      `/spi/v3/candidates/${elvieAgain.id}`,
    ]);
  });

  it('resumes across tiny slices, replaying an interrupted candidate without duplicates', async () => {
    // Elvie's Files tab fails once, after her resume and portfolio are stored: the retry
    // backoff can't fit the slice, so the slice ends mid-candidate and the next one replays her.
    let failed = false;
    const api = workable({
      [`GET ${API}/candidates/${elvie.id}/files`]: () => {
        if (!failed) {
          failed = true;
          return json({ error: 'Service Unavailable' }, { status: 503 });
        }
        return json({ files: candidateFiles[elvie.id] });
      },
    });
    // A clock that jumps 2 s per read: every slice runs out of time after its first step.
    let t = Date.now();
    const { view, slices } = await runSliced(api.impl, () => (t += 2_000), 4_000);
    expect(view.status).toBe('SUCCEEDED');
    expect(slices).toBeGreaterThan(15); // really did run in small pieces
    expect(failed).toBe(true);
    expect(api.unmatched).toEqual([]);
    expect(view.created).toEqual(FULL_IMPORT);
    // Every file was downloaded exactly once despite the replay.
    const downloads = api.calls.filter((c) => !isWorkable(c.url.host)).map((c) => c.url.pathname);
    expect(downloads).toHaveLength(6);
    expect(new Set(downloads).size).toBe(6);
    expect(api.calls.filter((c) => c.url.pathname === `/spi/v3/candidates/${elvie.id}`).length).toBe(2); // replayed once
  });

  it('skips candidates a replayed step already finished, redoing only the one cut off', async () => {
    // Each request costs the real throttle (1.1 s). Mark's offer stalls past the slice deadline,
    // so the step dies mid-Mark and the next slice replays it from Elvie.
    let t = Date.now();
    let stalled = false;
    const api = workable({
      [`GET ${API}/candidates/${mark.id}/offer`]: () => {
        if (stalled) return json(offer);
        stalled = true;
        t += 120_000;
        return json({ error: 'Service Unavailable' }, { status: 503 });
      },
    });
    const throttled = (async (input: string | URL | Request, init?: RequestInit) => {
      t += 1_100;
      return api.impl(input, init);
    }) as typeof fetch;
    const { view } = await runSliced(throttled, () => t, 60_000);
    expect(view.status).toBe('SUCCEEDED');
    expect(stalled).toBe(true);
    expect(view.created).toEqual(FULL_IMPORT);
    const details = (id: string) => api.calls.filter((c) => c.url.pathname === `/spi/v3/candidates/${id}`).length;
    expect(details(elvie.id)).toBe(1); // finished before the stall: not fetched again
    expect(details(mark.id)).toBe(2); // cut off mid-way: redone
    const downloads = api.calls.filter((c) => !isWorkable(c.url.host)).map((c) => c.url.pathname);
    expect(downloads).toHaveLength(6);
    expect(new Set(downloads).size).toBe(6);
  });

  it('resumes a page by record id, so a candidate deleted between slices cannot skip a live one', async () => {
    // One candidate per step. Elvie is erased in Workable right after her detail is read, so the
    // first page shrinks under the saved cursor.
    const live: CandidateFixture[] = [...candidates];
    const api = workable({
      [`GET ${API}/candidates`]: candidateList(() => live),
      [`GET ${API}/candidates/${elvie.id}`]: () => {
        live.splice(live.indexOf(elvie), 1);
        return json({ candidate: details[elvie.id] });
      },
    });
    let t = Date.now();
    const { view, orgId } = await runSliced(api.impl, () => (t += 2_000), 4_000, { activity: false, offers: false, files: false });
    expect(view.status).toBe('SUCCEEDED');
    const ids = (await db.opportunity.findMany({ where: { orgId } })).map((o) => imported(o).id).sort();
    expect(ids).toEqual([elvie.id, mark.id, nango.id, elvieAgain.id].sort());
    expect(view.issues.map((i) => i.message).filter((m) => m.startsWith('Skipped a record'))).toEqual([]);
  });

  it('treats any 4xx from /requisitions as "no Hiring Plan", not a failed import', async () => {
    const answers: [number, object, RegExp][] = [
      [400, {}, /HTTP 400/], // what the sibling feature-gated /departments documents
      [403, { error: 'Forbidden' }, /permission/],
      [422, { error: 'Hiring Plan is not enabled' }, /HTTP 422/],
    ];
    for (const [status, body, detail] of answers) {
      const api = workable({ [`GET ${API}/requisitions`]: () => json(body, { status }) });
      const res = await runImportForTest({
        module: workableProvider,
        credentials: CREDS,
        fetchImpl: api.impl,
        options: { activity: false, offers: false, files: false },
      });
      expect(res.status).toBe('SUCCEEDED');
      expect(res.view.created).toMatchObject({ posting: 2, opportunity: 4 });
      expect(res.view.created.requisition).toBeUndefined();
      const skipped = res.view.issues.map((i) => i.message).filter((m) => m.startsWith('Requisitions skipped'));
      expect(skipped).toEqual([expect.stringMatching(detail)]);
    }
  });

  it('keeps candidates of a job added mid-import or whose page is broken, and retries a transient 404', async () => {
    let elvieMissing = true;
    const api = workable({
      // Staff Engineer was created after both reads of the job list.
      [`GET ${API}/jobs`]: keyset('jobs', () => jobs.filter((j) => j.shortcode !== engJob.shortcode), 2),
      [`GET ${API}/jobs/${aeJob.shortcode}`]: () =>
        new Response('<html><body>Down for maintenance</body></html>', { headers: { 'content-type': 'text/html' } }),
      [`GET ${API}/candidates/${elvie.id}`]: () => {
        if (!elvieMissing) return json({ candidate: details[elvie.id] });
        elvieMissing = false;
        return json({ error: 'Not found' }, { status: 404 });
      },
    });
    const res = await runImportForTest({
      module: workableProvider,
      credentials: CREDS,
      fetchImpl: api.impl,
      options: { activity: false, offers: false, files: false },
    });
    expect(res.status).toBe('SUCCEEDED');
    expect(api.unmatched).toEqual([]);
    expect(res.view.created).toMatchObject({ posting: 2, contact: 3, opportunity: 4 });
    // Nothing about candidates skipped or kept without a posting; the transient 404 left no trace.
    expect(res.view.issues.map((i) => i.message).sort()).toEqual(
      [
        `Job details unavailable: GET ${API}/jobs/${aeJob.shortcode} → HTTP 200: response was not JSON`,
        "Skipped Workable's sample (demo) jobs",
        "Skipped candidates of Workable's sample (demo) jobs",
        'Skipped candidates that Workable has anonymized',
      ].sort(),
    );

    const opps = await db.opportunity.findMany({ where: { orgId: res.orgId }, include: { posting: true } });
    const byId = Object.fromEntries(opps.map((o) => [imported(o).id, o]));
    // The late job is loaded from its own detail, confidential flag included.
    expect(byId[nango.id].posting).toMatchObject({ title: 'Staff Engineer', commitment: 'CONTRACT' });
    expect(byId[nango.id].confidential).toBe(true);
    expect(byId[elvieAgain.id].postingId).toBe(byId[nango.id].postingId);
    expect(api.calls.filter((c) => c.url.pathname === `/spi/v3/jobs/${engJob.shortcode}`)).toHaveLength(1);
    // The broken page still leaves a posting built from the list.
    expect(byId[elvie.id].posting).toMatchObject({ title: 'Account Executive', location: 'London, United Kingdom; Berlin, Germany', content: null });
    expect(api.calls.filter((c) => c.url.pathname === `/spi/v3/candidates/${elvie.id}`)).toHaveLength(2);
  });

  it('ranks a hire above a later disqualification and keeps free-text withdrawals out of rejections', async () => {
    const person = (id: string, name: string, stage: string, stage_kind: string, extra: object) => ({
      ...candidateBase,
      id,
      name,
      firstname: name.split(' ')[0],
      lastname: name.split(' ')[1],
      job: aeJob,
      stage,
      stage_kind,
      email: `${name.split(' ')[0].toLowerCase()}@example.com`,
      profile_url: `https://acme.workable.com/backend/jobs/5986327/candidates/${id}`,
      created_at: '2026-04-20T09:00:00Z',
      updated_at: '2026-05-05T09:00:00Z',
      ...extra,
    });
    // Hired, then disqualified (a no-show): still a hire, per the spec's status precedence.
    const priya = person('2727bb01', 'Priya Raman', 'Hired', 'hired', {
      hired_at: '2026-05-02T09:00:00Z',
      moved_to_offer_at: '2026-04-28T09:00:00Z',
      disqualified: true,
      disqualification_reason: 'No-show on first day',
    });
    // Withdrew with a free-text reason that isn't in /disqualification_reasons.
    const omar = person('2727bb02', 'Omar Haddad', 'Interview', 'interview', { disqualified: true, disqualification_reason: 'Accepted a counter-offer' });
    // Withdrew with a listed reason: that reason is used as mapped.
    const lena = person('2727bb03', 'Lena Park', 'Applied', 'applied', { disqualified: true, disqualification_reason: 'Not interested' });
    const detail = (c: typeof priya, withdrew: boolean, disqualified_at: string) =>
      json({ candidate: { ...c, ...detailExtras, withdrew, disqualified_at, social_profiles: [] } });
    const applied = (id: string) => ({
      activities: [act(id, 'applied', '2026-04-20T09:00:01.000Z', { stage_name: 'Applied', action_stage: stageRef(S.applied) })],
    });
    const api = workable({
      [`GET ${API}/candidates`]: candidateList(() => [priya, omar, lena]),
      [`GET ${API}/candidates/${priya.id}`]: () => detail(priya, false, '2026-05-04T09:00:00Z'),
      [`GET ${API}/candidates/${omar.id}`]: () => detail(omar, true, '2026-04-25T09:00:00Z'),
      [`GET ${API}/candidates/${lena.id}`]: () => detail(lena, true, '2026-04-22T09:00:00Z'),
      [`GET ${API}/candidates/${priya.id}/activities`]: () => json(applied('90800001')),
      [`GET ${API}/candidates/${omar.id}/activities`]: () => json(applied('90800002')),
      [`GET ${API}/candidates/${lena.id}/activities`]: () => json(applied('90800003')),
    });
    const res = await runImportForTest({
      module: workableProvider,
      credentials: CREDS,
      fetchImpl: api.impl,
      options: { activity: false, offers: false, files: false },
    });
    expect(res.status).toBe('SUCCEEDED');
    expect(api.unmatched).toEqual([]);
    const opps = await db.opportunity.findMany({ where: { orgId: res.orgId }, include: { archiveReason: true } });
    const byId = Object.fromEntries(opps.map((o) => [imported(o).id, o]));

    expect(byId[priya.id]).toMatchObject({ status: 'HIRED' });
    expect(byId[priya.id].archiveReason).toBeNull();
    expect(byId[priya.id].archivedAt).toBeNull();
    expect(byId[priya.id].stageChangedAt.toISOString()).toBe('2026-05-02T09:00:00.000Z');
    expect(imported(byId[priya.id]).fields!['Workable disqualification reason']).toBe('No-show on first day');

    expect(byId[omar.id]).toMatchObject({ status: 'ARCHIVED' });
    expect(byId[omar.id].archiveReason).toMatchObject({ name: 'Withdrew', countsAsRejection: false });
    expect(byId[omar.id].archivedAt!.toISOString()).toBe('2026-04-25T09:00:00.000Z');
    expect(imported(byId[omar.id]).fields!['Workable disqualification reason']).toBe('Accepted a counter-offer');

    expect(byId[lena.id].archiveReason).toMatchObject({ name: 'Not interested', countsAsRejection: false });
    expect(imported(byId[lena.id]).fields!['Workable disqualification reason']).toBeUndefined();
  });

  it('honors options: no archived, no activity/offers/files means no fan-out for them', async () => {
    const api = workable();
    const res = await runImportForTest({
      module: workableProvider,
      credentials: CREDS,
      fetchImpl: api.impl,
      options: { archived: false, activity: false, offers: false, files: false },
    });
    expect(res.status).toBe('SUCCEEDED');
    expect(api.unmatched).toEqual([]);
    expect(res.view.created).toEqual({ posting: 2, requisition: 3, contact: 1, opportunity: 2 });
    const paths = api.calls.map((c) => c.url.pathname);
    for (const skipped of [mark.id, nango.id]) expect(paths.some((p) => p.includes(skipped))).toBe(false); // hired / disqualified
    expect(paths.some((p) => /\/(offer|files)$/.test(p) || p.endsWith('/events'))).toBe(false);
    expect(api.calls.some((c) => !isWorkable(c.url.host))).toBe(false);
    // History still comes across: it lives on the same timeline the application needs.
    const e = await db.opportunity.findFirstOrThrow({
      where: { orgId: res.orgId, contact: { name: 'Elvie Schmidt' }, posting: { title: 'Account Executive' } },
      include: { stageTransitions: true },
    });
    expect(e.stageTransitions).toHaveLength(3);
  });

  it('filters server-side by created date when `since` is set', async () => {
    const api = workable();
    const res = await runImportForTest({
      module: workableProvider,
      credentials: CREDS,
      fetchImpl: api.impl,
      options: { since: '2026-07-01T00:00:00.000Z', activity: false, offers: false, files: false },
    });
    expect(res.status).toBe('SUCCEEDED');
    const lists = api.calls.filter((c) => c.url.pathname === '/spi/v3/candidates' && c.url.searchParams.get('limit') === '100');
    expect(lists.length).toBe(1); // the server filtered: one short page
    for (const call of lists) expect(call.url.searchParams.get('created_after')).toBe(String(Date.parse('2026-07-01T00:00:00Z') / 1000));
    expect(res.view.created).toMatchObject({ opportunity: 2 }); // Nango (Jul 23) and Elvie's referral (Aug 1)
  });
});
