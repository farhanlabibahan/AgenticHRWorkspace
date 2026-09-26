import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/session', () => ({ isAdmin: () => true }));

import { providerMeta } from '@/lib/import-providers';
import { createHttpClient } from '@/server/imports/http';
import { db, json, mockFetch, runImportForTest, verifyForTest, type RouteHandler } from '@/server/imports/__tests__/harness';
import { hasDb, publicDns } from '@/server/imports/__tests__/harness';
import {
  createPinpointProvider,
  pinpointOfferStatus,
  pinpointProvider,
  pinpointRating,
  pinpointRequisitionSalary,
} from '@/server/imports/providers/pinpoint';

/**
 * Pinpoint adapter against a mock of its Graphiti JSON:API, built from the
 * payloads in Pinpoint's API reference: string ids and string foreign keys,
 * `+00:00`-offset timestamps, relationships that carry ids only when included,
 * sparse fieldsets, extra fields that only appear when requested, page-number
 * paging with no links, confidential jobs hidden unless asked for, and
 * attachment blobs that need the key and redirect to object storage.
 */

const KEY = 'pp_live_8c1f4e2a9b7d4c3e6a5f0b2d7e9c1a43';
const HOST = 'northwind.pinpointhq.com';
const API = `${HOST}/api/v1`;
const S3 = 'pinpoint-production-uploads.s3.eu-west-2.amazonaws.com';
const CAREERS = 'careers.northwind.example';
const credentials = { subdomain: 'northwind', apiKey: KEY };
const brand = providerMeta('pinpoint')?.name ?? 'pinpoint';

// Small pages so a handful of records spans several of them.
const provider = createPinpointProvider({ candidates: 2, applications: 2, scorecards: 2, files: 2 });

// ---------- a tiny Graphiti server ----------

type Json = Record<string, unknown>;
type Link = { type: string; id: string };
type Rec = { type: string; id: string; attributes: Json; rels: Record<string, Link | Link[] | null> };

const store = new Map<string, Rec>();
const to = (type: string, id: string): Link => ({ type, id });

function rec(type: string, id: string, attributes: Json, rels: Rec['rels'] = {}): Rec {
  const r = { type, id, attributes, rels };
  store.set(`${type}:${id}`, r);
  return r;
}

function resolve(link: Link | Link[] | null | undefined): Rec[] {
  return (Array.isArray(link) ? link : link ? [link] : [])
    .map((l) => store.get(`${l.type}:${l.id}`))
    .filter((r): r is Rec => !!r);
}

/** Attributes Pinpoint only renders when asked for with extra_fields[type]. */
const EXTRA: Record<string, string[]> = {
  applications: ['attachments', 'tags', 'average_rating', 'days_in_current_stage'],
  candidates: ['attachments', 'tags'],
  jobs: ['hiring_user_id', 'recruitment_manager_user_id'],
  offers: ['attachments'],
  job_seekers: ['attachments', 'tags', 'average_rating'],
};

/**
 * Graphiti keeps relationships under sparse fieldsets, which the spec can't
 * confirm for Pinpoint. When set, the mock drops them the way plain
 * jsonapi-serializable would.
 */
let stripSparse = false;

const list = (v: string | null) => (v ? v.split(',').filter(Boolean) : []);

function render(r: Rec, url: URL, path: string, includes: string[]): Json {
  const extra = list(url.searchParams.get(`extra_fields[${r.type}]`));
  const fields = url.searchParams.get(`fields[${r.type}]`);
  const sparse = fields ? new Set([...list(fields), ...extra]) : null;
  const attributes = Object.fromEntries(
    Object.entries(r.attributes).filter(
      ([k]) => (!(EXTRA[r.type] ?? []).includes(k) || extra.includes(k)) && (!sparse || sparse.has(k)),
    ),
  );
  const relationships = Object.fromEntries(
    Object.entries(r.rels).map(([name, data]) => [
      name,
      includes.includes(`${path}${name}`) ? { data } : { meta: { included: false } },
    ]),
  );
  const keep = Object.keys(r.rels).length && !(stripSparse && sparse);
  return { id: r.id, type: r.type, attributes, ...(keep ? { relationships } : {}) };
}

/** A JSON:API document with every `include` path sideloaded, the way Graphiti renders it. */
function doc(url: URL, primary: Rec[]) {
  const includes = list(url.searchParams.get('include'));
  const included = new Map<string, { r: Rec; path: string }>();
  for (const include of includes) {
    let frontier = primary;
    let path = '';
    for (const seg of include.split('.')) {
      frontier = frontier.flatMap((r) => resolve(r.rels[seg]));
      path = path ? `${path}.${seg}` : seg;
      for (const r of frontier) if (!included.has(`${r.type}:${r.id}`)) included.set(`${r.type}:${r.id}`, { r, path });
    }
  }
  return json(
    {
      data: primary.map((r) => render(r, url, '', includes)),
      ...(included.size ? { included: [...included.values()].map(({ r, path }) => render(r, url, `${path}.`, includes)) } : {}),
      meta: {},
    },
    { headers: { 'content-type': 'application/vnd.api+json' } },
  );
}

function paged(url: URL, records: Rec[]): Rec[] {
  const size = Number(url.searchParams.get('page[size]') ?? 100);
  const n = Number(url.searchParams.get('page[number]') ?? 1);
  return [...records].sort((a, b) => Number(a.id) - Number(b.id)).slice((n - 1) * size, n * size);
}

const createdAfter = (url: URL, iso: unknown) => {
  const gt = url.searchParams.get('filter[created_at][gt]');
  return !gt || Date.parse(String(iso)) > Date.parse(gt);
};

const apiError = (status: number, code: string, title: string, detail: string) =>
  json({ errors: [{ code, status: String(status), title, detail }] }, { status });
const forbidden = () => apiError(403, 'forbidden', 'Forbidden', "The API key doesn't have permission for this action");

// ---------- the account ----------

const ts = (d: string) => `${d}+00:00`;

rec('companies', '812', {
  created_at: ts('2022-03-01T10:22:05'),
  updated_at: ts('2025-07-19T13:40:51'),
  name: 'Northwind Logistics',
  industry: 'Logistics',
  location: 'London',
  website: 'https://northwind.example',
});

const users = [
  // Same email as the harness admin → matched teammate.
  rec('users', '4812', {
    access_group_id: 3,
    created_at: ts('2023-06-14T09:12:44'),
    email: 'admin@example.test',
    first_name: 'Priya',
    last_name: 'Shah',
    last_sign_in_at: ts('2026-09-21T16:03:10'),
    time_zone: 'Europe/London',
    updated_at: ts('2026-09-21T16:03:10'),
  }),
  rec('users', '4907', {
    access_group_id: 5,
    created_at: ts('2024-01-08T11:00:02'),
    email: 'tom.baker@northwind.example',
    first_name: 'Tom',
    last_name: 'Baker',
    last_sign_in_at: null,
    time_zone: 'America/New_York',
    updated_at: ts('2025-11-02T08:41:19'),
  }),
];

const place = (id: string, name: string, city: string, country: string, province: string | null) =>
  rec(
    'locations',
    id,
    {
      city,
      country_code: country,
      created_at: ts('2022-03-01T10:22:05'),
      name,
      postal_code: 'EC2A 4NE',
      province,
      street_address: '1 Finsbury Avenue',
      updated_at: ts('2024-10-11T09:05:33'),
      external_system_reference: null,
    },
    { equality_monitoring_template: null },
  );
place('5495', 'London HQ', 'London', 'GB', null);
place('5501', 'Austin, TX', 'Austin', 'US', 'TX');

for (const [id, name] of [
  ['191', 'Marketing'],
  ['192', 'Engineering'],
]) {
  rec('departments', id, { created_at: ts('2022-03-01T10:22:05'), name, updated_at: ts('2022-03-01T10:22:05'), external_system_reference: null });
}

/** Every job gets its own copy of the hiring workflow's stages. */
function pipeline(jobId: string, firstId: number, names: [string, string][]) {
  return names.map(([name, basic], position) =>
    rec(
      'stages',
      String(firstId + position),
      {
        created_at: ts('2026-01-12T09:30:00'),
        updated_at: ts('2026-01-12T09:30:00'),
        name,
        external_system_reference: null,
        external_name: basic === 'rejected' ? 'Unsuccessful' : name,
        description: null,
        visible: true,
        position,
        basic_type: basic,
      },
      { stageable: to('jobs', jobId), applications: null },
    ),
  );
}

const designStages = pipeline('130185', 88120, [
  ['Applied', 'applied'],
  ['Phone Screen', 'review'],
  ['Portfolio Review', 'interview'],
  ['Offer', 'offer'],
  ['Hired', 'hired'],
  ['Rejected', 'rejected'],
]);
const engineeringStages = pipeline('130190', 88130, [
  ['Applied', 'applied'],
  ['Phone Screen', 'review'],
  ['Technical Interview', 'interview'],
  ['Offer', 'offer'],
  ['Hired', 'hired'],
  ['Rejected', 'rejected'],
]);

rec(
  'job_postings',
  '88001',
  {
    created_at: ts('2026-01-12T09:30:00'),
    updated_at: ts('2026-09-18T15:12:44'),
    default_for_job: true,
    description: "<div><!--block-->We're a fully remote, UK-based, HR-tech startup…</div>",
    name: 'Default posting',
    status: 'active',
    title: 'Senior Marketing Designer',
    url: 'https://northwind.pinpointhq.com/en/postings/9447bc5f-30f9-4dbe-8531-3d66df1fc1a5',
  },
  { job: null, location: null },
);
rec(
  'job_postings',
  '88002',
  {
    created_at: ts('2026-03-02T09:00:00'),
    updated_at: ts('2026-03-02T09:00:00'),
    default_for_job: true,
    description: '<div><!--block-->Build our APIs.</div>',
    name: 'Default posting',
    status: 'inactive',
    title: 'Backend Engineer',
    url: 'https://northwind.pinpointhq.com/en/postings/1c0a7f52-9d3e-4b6a-8e21-0f5d4c3b2a19',
  },
  { job: null, location: null },
);

rec(
  'custom_attributes',
  '90012',
  { value: 'Backfill', field_name: 'Hire type', option_value: 'backfill', option_label: 'Backfill', created_at: ts('2026-01-12T09:31:10'), updated_at: ts('2026-01-12T09:31:10') },
  { custom_field: to('custom_fields', '301'), custom_attributable: null },
);
rec(
  'custom_attributes',
  '90550',
  { value: '2026-04-01', field_name: 'Earliest start date', option_value: null, option_label: null, created_at: ts('2026-02-19T16:41:00'), updated_at: ts('2026-02-19T16:41:00') },
  { custom_field: to('custom_fields', '305'), custom_attributable: null },
);

const jobAttrs = (overrides: Json): Json => ({
  ask_for_address: false,
  ask_for_date_of_birth: false,
  ask_for_linkedin_profile: true,
  cover_letter_requirement: 'optional',
  resume_requirement: 'required',
  reporting_to: null,
  about_company_theme_section_header: null,
  about_company_theme_section: null,
  compensation_visible: true,
  is_compensation_visible: true,
  country_code: 'GB',
  deadline_on: null,
  deadline_at: null,
  external_system_reference: null,
  closed_at: null,
  filled_at: null,
  on_hold_in_seconds: 0,
  blind_screening: false,
  diversity_monitoring: true,
  headcount_maximum_enabled: false,
  headcount_maximum: null,
  referrals_enabled: true,
  custom_town: null,
  custom_county: null,
  custom_country: null,
  company_name_override: null,
  selected_hiring_workflow_id: '12',
  ...overrides,
});

const jobs = [
  rec(
    'jobs',
    '130185',
    jobAttrs({
      title: 'Senior Marketing Designer',
      description: '<div><!--block-->We&#39;re a fully remote, UK-based, HR-tech startup looking for a Senior Marketing Designer.</div>',
      key_responsibilities: '<ul><li><!--block-->Take ownership of our visual identity</li><li><!--block-->Create templates for recurring needs</li></ul>',
      key_responsibilities_header: 'About the Role:',
      external_key_responsibilities_header: 'About the Role:',
      skills_knowledge_expertise: '<ul><li><!--block-->5+ years designing marketing and digital assets within SaaS.</li></ul>',
      skills_knowledge_expertise_header: 'About You:',
      external_skills_knowledge_expertise_header: 'About You:',
      benefits: '<div><!--block-->We&#39;re committed to being an exceptional workplace.</div><ul><li><!--block--><strong>Pension:</strong> We match 100% of your first 3%</li></ul>',
      benefits_header: 'What We Offer:',
      external_benefits_header: 'What We Offer:',
      compensation: '£55,000 - £65,000 / year',
      compensation_minimum: 55000.0,
      compensation_maximum: 65000.0,
      compensation_currency: 'GBP',
      compensation_frequency: 'year',
      uuid: '3f0e5a0c-7a2b-4e4a-9d0e-6a4f0d1f2c11',
      created_at: ts('2026-01-12T09:30:00'),
      updated_at: ts('2026-09-18T15:12:44'),
      opened_at: ts('2026-01-15T08:00:00'),
      // Free text, not the Pinpoint requisition's identifier: the link is requisitions.job_id.
      requisition_id: 'HRIS-88213',
      employment_type: 'full_time',
      employment_type_text: 'Full Time',
      workplace_type: 'remote',
      workplace_type_text: 'Fully remote',
      remote: true,
      visibility: 'external',
      status: 'open',
      hiring_user_id: '4907',
      recruitment_manager_user_id: '4812',
    }),
    {
      department: to('departments', '191'),
      division: null,
      location: to('locations', '5495'),
      company: to('companies', '812'),
      hiring_manager_user: to('users', '4907'),
      recruitment_manager_user: to('users', '4812'),
      creator_user: to('users', '4907'),
      job_postings: [to('job_postings', '88001')],
      custom_attributes: [to('custom_attributes', '90012')],
      stages: designStages.map((s) => to('stages', s.id)),
    },
  ),
  rec(
    'jobs',
    '130190',
    jobAttrs({
      title: 'Backend Engineer',
      description: null,
      key_responsibilities: null,
      key_responsibilities_header: null,
      external_key_responsibilities_header: null,
      skills_knowledge_expertise: null,
      skills_knowledge_expertise_header: null,
      external_skills_knowledge_expertise_header: null,
      benefits: null,
      benefits_header: null,
      external_benefits_header: null,
      compensation: '£400 / day',
      compensation_minimum: 400.0,
      compensation_maximum: 400.0,
      compensation_currency: 'GBP',
      compensation_frequency: 'day',
      uuid: '5b1d6e8f-0a2c-4d3e-9f1a-7c6b5a4d3e21',
      created_at: ts('2026-03-02T09:00:00'),
      updated_at: ts('2026-07-01T10:00:00'),
      opened_at: ts('2026-03-02T09:00:00'),
      closed_at: ts('2026-07-01T10:00:00'),
      // Names a requisition that has no job_id.
      requisition_id: 'PIN-0200',
      employment_type: 'fixed_term_contract',
      employment_type_text: 'Fixed Term Contract',
      workplace_type: 'hybrid',
      workplace_type_text: 'Hybrid',
      remote: false,
      visibility: 'confidential',
      status: 'closed',
      blind_screening: true,
      hiring_user_id: '4812',
      recruitment_manager_user_id: null,
    }),
    {
      department: to('departments', '192'),
      division: null,
      location: to('locations', '5501'),
      company: to('companies', '812'),
      hiring_manager_user: to('users', '4812'),
      recruitment_manager_user: null,
      creator_user: to('users', '4812'),
      job_postings: [to('job_postings', '88002')],
      custom_attributes: [],
      stages: engineeringStages.map((s) => to('stages', s.id)),
    },
  ),
];

rec('requisition_templates', '14', { name: 'New Role Request', created_at: ts('2023-01-01T00:00:00'), updated_at: ts('2025-03-04T12:00:00') });
const detail = (id: string, requisition: string, label: string, type: string, value: Json) =>
  rec('requisition_details', id, {
    requisition_id: requisition,
    requisition_template_field_id: String(80 + Number(id.slice(-1))),
    varchar_value: null,
    text_value: null,
    boolean_value: null,
    date_value: null,
    decimal_value: null,
    integer_value: null,
    single_select_value: null,
    multi_select_value: [],
    field_type: type,
    label,
    created_at: ts('2025-12-01T10:00:00'),
    updated_at: ts('2025-12-01T10:00:00'),
    ...value,
  });
// The spec's example: typed values, and no currency detail.
detail('51001', '2201', 'Headcount', 'integer', { integer_value: 2 });
detail('51002', '2201', 'Budgeted salary', 'decimal', { decimal_value: '65000.0' });
// A template that asks for free text.
detail('51003', '2202', 'Number of hires', 'varchar', { varchar_value: '2 (1 backfill)' });
detail('51004', '2202', 'Salary range', 'varchar', { varchar_value: '£55,000 - £65,000' });
const requisition = (id: string, a: Json, details: string[]) =>
  rec(
    'requisitions',
    id,
    { requisition_template_id: '14', status: 'approved', updated_at: ts('2026-01-12T09:30:00'), ...a },
    {
      requisition_template: to('requisition_templates', '14'),
      creator: to('users', String(a.creator_id)),
      requisition_details: details.map((d) => to('requisition_details', d)),
    },
  );
const requisitions = [
  requisition(
    '2201',
    { name: 'Senior Marketing Designer', identifier: 'PIN-0179', job_id: '130185', creator_id: '4907', created_at: ts('2025-12-01T10:00:00') },
    ['51001', '51002'],
  ),
  requisition(
    '2202',
    { name: 'Backend Engineer (contract)', identifier: 'PIN-0200', job_id: null, creator_id: '4812', created_at: ts('2026-02-20T10:00:00') },
    ['51003', '51004'],
  ),
];

const blob = (host: string, signed: string, name: string) => `https://${host}/rails/active_storage/blobs/redirect/${signed}/${name}`;
const AMARA_CV = blob(HOST, 'eyJfcmFpbHMiOnsibWVzc2FnZSI6IkJBaHBBOGpVQWc9PSJ9fQ==--4b1c2e', 'Amara_Okafor_CV.pdf');
const AMARA_COVER = blob(HOST, 'eyJfcmFpbHMiOnsibWVzc2FnZSI6IkJBaHBBOGpVQWdrPSJ9fQ==--9ac03d', 'cover_letter.pdf');
const AMARA_FORM = blob(HOST, 'eyJfcmFpbHMiOnsibWVzc2FnZSI6IkJBaHBBOGpVQWdnPSJ9fQ==--0d9e21', 'application.pdf');
// Older links use the apex host; the forum report shows this form.
const BEN_CV = blob('pinpointhq.com', 'eyJfcmFpbHMiOnsibWVzc2FnZSI6IkJBaHBBM0ZBQWc9PSJ9fQ==--77aa01', 'Ben_Carter_CV.docx');
// A custom careers domain is not a Pinpoint host: the key must not go there.
const CHLOE_CV = blob(CAREERS, 'eyJfcmFpbHMiOnsibWVzc2FnZSI6IkJBaHBBNUZBQWc9PSJ9fQ==--c3d4e5', 'Chloe_Dubois_CV.pdf');
// A plain-HTTP link on a Pinpoint host: fetched over HTTPS, so the key never travels in clear.
const CHLOE_PORTFOLIO = blob(HOST, 'eyJfcmFpbHMiOnsibWVzc2FnZSI6IkJBaHBBNUZBQWs9PSJ9fQ==--f6a7b8', 'Chloe_Portfolio.pdf').replace(
  'https://',
  'http://',
);
const DEV_CV = blob(HOST, 'eyJfcmFpbHMiOnsibWVzc2FnZSI6IkJBaHBBN0ZBQWc9PSJ9fQ==--2b3c4d', 'Dev_Patel_CV.pdf');
const OFFER_LETTER = blob(HOST, 'eyJfcmFpbHMiOnsibWVzc2FnZSI6IkJBaHBBMUFBQUE9PSJ9fQ==--1f2e3d', 'Offer_Letter_signed.pdf');
const SAMPLE_CV = blob(HOST, 'eyJfcmFpbHMiOnsibWVzc2FnZSI6IkJBaHBBOUZBQWc9PSJ9fQ==--5e6f7a', 'Sample_CV.pdf');

function candidate(id: string, a: Json, apps: string[]) {
  return rec(
    'candidates',
    id,
    {
      date_of_birth: null,
      middle_name: null,
      preferred_name: null,
      blocked: false,
      locale: 'en',
      phone_iso2: 'GB',
      address1: null,
      address2: null,
      postcode: null,
      external_system_reference: null,
      attachments: [],
      tags: [],
      ...a,
    },
    {
      applications: apps.map((x) => to('applications', x)),
      hris_references: null,
      job_seekers: null,
      skills: null,
      custom_attributes: null,
    },
  );
}

const candidates = [
  candidate(
    '771204',
    {
      email: 'amara.okafor@example.com',
      first_name: 'Amara',
      full_name: 'Amara Okafor',
      last_name: 'Okafor',
      phone: '+447700900123',
      address1: '12 Mare Street',
      town: 'London',
      state_province: null,
      postcode: 'E8 4RP',
      country: 'GB',
      created_at: ts('2026-02-03T18:22:41'),
      updated_at: ts('2026-09-10T12:02:13'),
      // As in the spec: the CV on the candidate, the CV and cover letter on the application.
      attachments: [{ context: 'cv', name: 'Amara_Okafor_CV.pdf', url: AMARA_CV }],
      tags: [{ context: 'custom_green', name: 'Portfolio strong' }],
    },
    ['560021'],
  ),
  candidate(
    '771300',
    {
      email: 'Ben.Carter@example.com',
      first_name: 'Ben',
      full_name: 'Ben Carter',
      last_name: 'Carter',
      phone: '+447700900456',
      town: 'Leeds',
      state_province: null,
      country: 'GB',
      created_at: ts('2026-01-20T09:00:00'),
      updated_at: ts('2026-06-12T09:00:00'),
      attachments: [{ context: 'cv', name: 'Ben_Carter_CV.docx', url: BEN_CV }],
    },
    ['561877', '562700', '563000'],
  ),
  candidate(
    '771410',
    {
      email: 'chloe.dubois@example.com',
      first_name: 'Chloe',
      full_name: 'Chloe Dubois',
      last_name: 'Dubois',
      phone: '+15125550143',
      phone_iso2: 'US',
      town: 'Austin',
      state_province: 'TX',
      country: 'US',
      created_at: ts('2026-06-01T12:00:00'),
      updated_at: ts('2026-09-11T08:00:00'),
      attachments: [
        { context: 'cv', name: 'Chloe_Dubois_CV.pdf', url: CHLOE_CV },
        { context: 'portfolio', name: 'Chloe_Portfolio.pdf', url: CHLOE_PORTFOLIO },
      ],
      tags: [{ context: 'custom_blue', name: 'Go' }],
    },
    ['562500', '562600'],
  ),
  // No attachments on the candidate: the CV came with the application.
  candidate(
    '771520',
    {
      email: 'dev.patel@example.com',
      first_name: 'Dev',
      full_name: 'Dev Patel',
      last_name: 'Patel',
      phone: '+447700900789',
      town: 'Manchester',
      state_province: null,
      country: 'GB',
      created_at: ts('2026-03-10T09:00:00'),
      updated_at: ts('2026-08-20T10:00:00'),
    },
    ['562800', '562900'],
  ),
  // Pinpoint's sample candidate: only a demo application.
  candidate(
    '771600',
    {
      email: 'sample.candidate@example.com',
      first_name: 'Sample',
      full_name: 'Sample Candidate',
      last_name: 'Candidate',
      phone: null,
      town: 'London',
      state_province: null,
      country: 'GB',
      created_at: ts('2026-07-02T09:00:00'),
      updated_at: ts('2026-07-02T09:00:00'),
      attachments: [{ context: 'cv', name: 'Sample_CV.pdf', url: SAMPLE_CV }],
    },
    ['563100'],
  ),
];

function application(
  id: string,
  a: Json & { candidate_id: string; job_id: string; stage_id: string },
  rels: { furthest: string; offers?: string[]; scorecards?: string[]; custom?: string[] },
) {
  const person = store.get(`candidates:${a.candidate_id}`)!.attributes;
  return rec(
    'applications',
    id,
    {
      uuid: `b7d5c7a0-1f0e-4c55-9d3f-${id.padStart(12, '0')}`,
      updated_at: ts('2026-09-10T12:02:13'),
      external_system_reference: null,
      hired_at: null,
      rejected_at: null,
      internal_candidate: false,
      job_posting_id: a.job_id === '130185' ? '88001' : '88002',
      locale: 'en',
      phone_iso2: person.phone_iso2,
      start_on: null,
      is_demo: false,
      first_name: person.first_name,
      last_name: person.last_name,
      preferred_name: null,
      email: person.email,
      phone: person.phone,
      date_of_birth: '1990-04-02',
      linkedin_url: null,
      summary: null,
      preferred_pronouns: null,
      address1: person.address1,
      address2: null,
      town: person.town,
      state_province: person.state_province,
      postcode: person.postcode,
      country: person.country,
      country_code: person.country,
      country_code_alpha3: person.country === 'US' ? 'USA' : 'GBR',
      country_name: person.country === 'US' ? 'United States' : 'United Kingdom',
      full_name: person.full_name,
      national_identifier: 'QQ123456C',
      concealed: false,
      ai_score: null,
      attachments: [],
      average_rating: null,
      tags: [],
      days_in_current_stage: 0,
      ...a,
    },
    {
      job: to('jobs', a.job_id),
      job_posting: to('job_postings', a.job_id === '130185' ? '88001' : '88002'),
      stage: to('stages', a.stage_id),
      furthest_stage: to('stages', rels.furthest),
      candidate: to('candidates', a.candidate_id),
      offers: (rels.offers ?? []).map((x) => to('offers', x)),
      custom_attributes: (rels.custom ?? []).map((x) => to('custom_attributes', x)),
      user_scorecards: (rels.scorecards ?? []).map((x) => to('user_scorecards', x)),
    },
  );
}

const applications = [
  // Rejected after the portfolio review, with a rejection-reason tag.
  application(
    '560021',
    {
      candidate_id: '771204',
      job_id: '130185',
      stage_id: '88125',
      created_at: ts('2026-02-03T18:22:41'),
      rejected_at: ts('2026-03-01T10:15:00'),
      linkedin_url: 'https://www.linkedin.com/in/amaraokafor',
      summary: 'Brand designer with 7 years in B2B SaaS.',
      preferred_pronouns: 'she/her',
      channel: 'job_board',
      channel_source: 'LinkedIn',
      average_rating: 4.33,
      days_in_current_stage: 203,
      attachments: [
        { context: 'cv', name: 'Amara_Okafor_CV.pdf', url: AMARA_CV },
        { context: 'cover_letter', name: 'cover_letter.pdf', url: AMARA_COVER },
        { context: 'admin_pdf_application', name: 'application.pdf', url: AMARA_FORM },
      ],
      tags: [
        { context: 'rejection', name: 'Salary expectations' },
        { context: 'custom_green', name: 'Portfolio strong' },
      ],
    },
    { furthest: '88122', scorecards: ['118830', '118831'], custom: ['90550'] },
  ),
  // Hired through a referral, with an accepted offer.
  application(
    '561877',
    {
      candidate_id: '771300',
      job_id: '130185',
      stage_id: '88124',
      created_at: ts('2026-01-20T09:00:00'),
      hired_at: ts('2026-04-05T08:12:44'),
      start_on: '2026-05-04',
      channel: 'employee_referral',
      channel_source: null,
      days_in_current_stage: 171,
    },
    { furthest: '88124', offers: ['19002'] },
  ),
  // Active, sourced, on a confidential job.
  application(
    '562500',
    {
      candidate_id: '771410',
      job_id: '130190',
      stage_id: '88132',
      created_at: ts('2026-06-01T12:00:00'),
      linkedin_url: 'https://www.linkedin.com/in/chloedubois',
      channel: 'manual',
      channel_source: 'Sourced on GitHub',
      days_in_current_stage: 12,
    },
    { furthest: '88132', scorecards: ['118900'] },
  ),
  // Pinpoint's sample data.
  application(
    '562600',
    { candidate_id: '771410', job_id: '130185', stage_id: '88120', created_at: ts('2026-07-01T09:00:00'), is_demo: true, channel: 'careers_site' },
    { furthest: '88120' },
  ),
  // Withdrew before any screen.
  application(
    '562700',
    {
      candidate_id: '771300',
      job_id: '130190',
      stage_id: '88135',
      created_at: ts('2026-06-10T08:00:00'),
      rejected_at: ts('2026-06-12T09:00:00'),
      channel: 'careers_site',
      channel_source: null,
      days_in_current_stage: 103,
      tags: [{ context: 'rejection', name: 'Withdrew application' }],
    },
    { furthest: '88135' },
  ),
  // Hired, but still in the offer stage: the company turned off the automatic move to Hired.
  application(
    '562800',
    {
      candidate_id: '771520',
      job_id: '130185',
      stage_id: '88123',
      created_at: ts('2026-03-10T09:30:00'),
      hired_at: ts('2026-08-20T10:00:00'),
      start_on: '2026-09-01',
      channel: 'careers_site',
      days_in_current_stage: 40,
      attachments: [{ context: 'cv', name: 'Dev_Patel_CV.pdf', url: DEV_CV }],
    },
    { furthest: '88123' },
  ),
  // Rejected after the phone screen with no rejection-reason tag, only a custom one.
  application(
    '562900',
    {
      candidate_id: '771520',
      job_id: '130190',
      stage_id: '88135',
      created_at: ts('2026-06-20T10:00:00'),
      rejected_at: ts('2026-06-25T12:00:00'),
      channel: 'careers_site',
      days_in_current_stage: 90,
      tags: [{ context: 'custom_red', name: 'Culture add' }],
    },
    { furthest: '88131' },
  ),
  // Blind-screened: the snapshot is masked, so the contact must come from the candidate record.
  application(
    '563000',
    {
      candidate_id: '771300',
      job_id: '130190',
      stage_id: '88132',
      created_at: ts('2026-07-15T09:00:00'),
      channel: 'careers_site',
      days_in_current_stage: 20,
      concealed: true,
      first_name: null,
      last_name: null,
      full_name: 'Anonymous candidate',
      email: null,
      phone: null,
      town: null,
      country: null,
      country_name: null,
    },
    { furthest: '88132' },
  ),
  // The sample candidate's demo application, with a rejection tag that must not become a reason.
  application(
    '563100',
    {
      candidate_id: '771600',
      job_id: '130185',
      stage_id: '88125',
      created_at: ts('2026-07-02T09:00:00'),
      rejected_at: ts('2026-07-03T09:00:00'),
      is_demo: true,
      channel: 'careers_site',
      tags: [{ context: 'rejection', name: 'Not a real person' }],
    },
    { furthest: '88121' },
  ),
];

// Scorecards: one rated, one with no scores or sentiment, one still pending.
rec(
  'user_scorecards',
  '118830',
  {
    completed_at: ts('2026-02-19T16:40:12'),
    locked: true,
    name: 'Portfolio Review Scorecard',
    sentiment: 'positive',
    status: 'completed',
    summary: 'Strong visual craft and systems thinking; limited motion experience.',
    created_at: ts('2026-02-19T15:02:55'),
    updated_at: ts('2026-02-19T16:40:12'),
  },
  {
    scorecard: to('scorecards', '77'),
    user: to('users', '4812'),
    scorecard_note: to('scorecard_notes', '64001'),
    scorecard_answers: [to('scorecard_answers', '65010')],
    scorecard_ratings: ['66100', '66101', '66102'].map((x) => to('scorecard_ratings', x)),
  },
);
rec(
  'user_scorecards',
  '118831',
  {
    completed_at: ts('2026-02-20T09:00:00'),
    locked: true,
    name: 'Portfolio Review Scorecard',
    sentiment: null,
    status: 'completed',
    summary: 'Needs a second look at motion work.',
    created_at: ts('2026-02-20T08:30:00'),
    updated_at: ts('2026-02-20T09:00:00'),
  },
  { scorecard: to('scorecards', '77'), user: to('users', '4907'), scorecard_note: null, scorecard_answers: [], scorecard_ratings: [] },
);
rec(
  'user_scorecards',
  '118900',
  { completed_at: null, locked: false, name: 'Technical Interview Scorecard', sentiment: null, status: 'pending', summary: null, created_at: ts('2026-06-12T10:00:00'), updated_at: ts('2026-06-12T10:00:00') },
  { scorecard: to('scorecards', '78'), user: to('users', '4907'), scorecard_note: null, scorecard_answers: [], scorecard_ratings: [] },
);
rec(
  'scorecard_notes',
  '64001',
  { body: 'Would be a great fit if we can close the comp gap.', created_at: ts('2026-02-19T16:40:12'), updated_at: ts('2026-02-19T16:40:12'), user_id: '4812' },
  { user: null, user_scorecard: null },
);
rec(
  'scorecard_answers',
  '65010',
  { question_id: '9120', boolean_answer: null, text_answer: 'Led the rebrand at a Series B startup; owned the design system.', user_id: '4812', created_at: ts('2026-02-19T16:40:12'), updated_at: ts('2026-02-19T16:40:12') },
  { question: to('questions', '9120'), user: null, user_scorecard: null },
);
rec('questions', '9120', { banked: false, question_type: 'long_text', required: false, title: 'Most relevant project?', multiple_choice_options: [] }, { scorecard_section: null, conditional_questions: null });
// scorecard_options attributes are undocumented: one names itself, one titles itself, one says nothing.
(
  [
    ['66100', 5, '7701', { name: 'Visual craft' }],
    ['66101', 4, '7702', { title: 'Design systems' }],
    ['66102', 3, '7703', {}],
  ] as const
).forEach(([id, score, option, label]) => {
  rec('scorecard_options', option, { ...label });
  rec(
    'scorecard_ratings',
    id,
    { created_at: ts('2026-02-19T16:40:12'), score, updated_at: ts('2026-02-19T16:40:12'), user_id: '4812' },
    { user: null, scorecard_option: to('scorecard_options', option), user_scorecard: null },
  );
});

rec(
  'offers',
  '19002',
  {
    application_id: '561877',
    comment: 'Includes relocation support.',
    created_at: ts('2026-04-02T10:00:00'),
    creator_id: '4907',
    // Sent by Tom in New York: 23:59 on the 9th there is the 10th in UTC.
    expires_at: '2026-04-09T23:59:00-04:00',
    job_title: 'Senior Marketing Designer',
    manager_id: '4812',
    paid_days_off: '25 days',
    result: 'accepted',
    result_at: ts('2026-04-05T08:12:44'),
    salary_amount: 62000.0,
    salary_currency: 'GBP',
    salary_period: 'year',
    sent_at: ts('2026-04-02T12:30:00'),
    signature_type: 'e_signature',
    stage_id: '88123',
    start_on: '2026-05-04',
    status: 'accepted',
    updated_at: ts('2026-04-05T08:12:44'),
    work_address: '1 Finsbury Avenue, London EC2A 4NE',
    attachments: [{ context: 'signed_offer_letter', name: 'Offer_Letter_signed.pdf', url: OFFER_LETTER }],
  },
  { creator: to('users', '4907'), manager: to('users', '4812'), stage: null, custom_attributes: null },
);

function interview(id: string, a: Json, stage: string, parts: [string, string[], string | null][]) {
  for (const [partId, people, join] of parts) {
    rec(
      'interview_parts',
      partId,
      {
        created_at: ts('2026-02-12T11:04:33'),
        company_id: '812',
        conferencing_join_url: join,
        conferencing_provider_name: join ? 'Google Meet' : null,
        interview_id: id,
        position: 0,
        updated_at: ts('2026-02-12T11:04:33'),
      },
      { interview: null, interviewing_users: people.map((u) => to('users', u)) },
    );
  }
  return rec('interviews', id, { created_at: ts('2026-02-12T11:04:33'), updated_at: ts('2026-02-19T16:05:01'), ...a }, {
    stage: to('stages', stage),
    interview_parts: parts.map(([p]) => to('interview_parts', p)),
    interviewable: null,
  });
}

const interviews = [
  interview(
    '240511',
    {
      start_at: ts('2026-02-19T15:00:00'),
      end_at: ts('2026-02-19T16:00:00'),
      interviewable_id: '560021',
      interviewable_type: 'Application',
      status: 'completed',
      summary: '<p>Walked through the Acme rebrand. <b>Strong</b> systems thinking.</p>',
      presence: 'attended',
    },
    '88122',
    [['301177', ['4812', '4907'], 'https://meet.google.com/abc-defg-hij']],
  ),
  interview(
    '240600',
    {
      start_at: ts('2030-10-05T14:00:00'),
      end_at: ts('2030-10-05T14:45:00'),
      interviewable_id: '562500',
      interviewable_type: 'Application',
      status: 'scheduled',
      summary: null,
      presence: null,
    },
    '88132',
    [['301200', ['4907'], null]],
  ),
  interview(
    '240700',
    {
      start_at: ts('2026-05-01T10:00:00'),
      end_at: ts('2026-05-01T10:30:00'),
      interviewable_id: '99120',
      interviewable_type: 'JobSeeker',
      status: 'completed',
      summary: null,
      presence: 'attended',
    },
    '88121',
    [['301300', ['4812'], null]],
  ),
];

// Ben is also in the talent pipeline.
const jobSeekers = [
  rec(
    'job_seekers',
    '99120',
    {
      candidate_id: '771300',
      first_name: 'Ben',
      last_name: 'Carter',
      full_name: 'Ben Carter',
      email: 'Ben.Carter@example.com',
      created_at: ts('2026-04-28T09:00:00'),
      updated_at: ts('2026-05-02T08:00:00'),
      channel: 'invited',
      pipeline_source: 'London meetup',
    },
    { candidate: to('candidates', '771300') },
  ),
];

const comment = (id: string, a: Json) =>
  rec(
    'comments',
    id,
    { private_comment: false, updated_at: a.created_at, ...a },
    { user: to('users', String(a.user_id)), commentable: null },
  );
const comments = [
  comment('3309817', {
    body_text: 'Great portfolio, but salary expectation is ~20% above band. Suggest we keep warm for the Lead role.',
    commentable_id: '560021',
    commentable_type: 'Application',
    created_at: ts('2026-02-20T14:31:07'),
    user_id: '4812',
  }),
  comment('3309820', {
    body_text: 'Referred by Sam in Design.',
    commentable_id: '771204',
    commentable_type: 'Candidate',
    created_at: ts('2026-02-04T09:00:00'),
    private_comment: true,
    user_id: '4907',
  }),
  // Written through the API: owned by the company's system user, which /users doesn't list.
  comment('3309830', {
    body_text: 'Candidate asked to move the technical interview to next week.',
    commentable_id: '562500',
    commentable_type: 'Application',
    created_at: ts('2026-06-14T08:00:00'),
    user_id: '1',
  }),
  comment('3309840', {
    body_text: 'Talent pipeline lead from the London meetup.',
    commentable_id: '99120',
    commentable_type: 'JobSeeker',
    created_at: ts('2026-05-02T08:00:00'),
    user_id: '4812',
  }),
];

// ---------- routes ----------

let denied = new Set<string>();

function routes(): Record<string, RouteHandler> {
  const api = (handler: (url: URL) => Response): RouteHandler => ({ url, headers }) =>
    headers['x-api-key'] === KEY
      ? handler(url)
      : apiError(401, 'unauthorized', 'Unauthorized', headers['x-api-key'] ? 'Invalid API key' : 'X-API-KEY header not provided');
  const only = (name: string, handler: (url: URL) => Response) => api((url) => (denied.has(name) ? forbidden() : handler(url)));
  const visible = (url: URL, param: string) => list(url.searchParams.get(param)).length ? list(url.searchParams.get(param)) : ['internal', 'external'];
  const inJob = (url: URL, jobId: unknown) => visible(url, 'filter[job_visibility]').includes(String(store.get(`jobs:${jobId}`)!.attributes.visibility));
  const pdf = (body: string, name: string) =>
    new Response(Buffer.from(`%PDF-1.4 ${body}`), {
      headers: { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="${name}"` },
    });
  const path = (u: string) => new URL(u).pathname;

  return {
    [`GET ${API}/users`]: only('users', (url) => doc(url, paged(url, users))),
    [`GET ${API}/jobs`]: only('jobs', (url) => {
      const statuses = list(url.searchParams.get('filter[status]'));
      const shown = jobs.filter(
        (j) =>
          visible(url, 'filter[visibility]').includes(String(j.attributes.visibility)) &&
          (!statuses.length || statuses.includes(String(j.attributes.status))),
      );
      return doc(url, paged(url, shown));
    }),
    [`GET ${API}/requisitions`]: only('requisitions', (url) => doc(url, paged(url, requisitions))),
    [`GET ${API}/candidates`]: only('candidates', (url) =>
      doc(url, paged(url, candidates.filter((c) => createdAfter(url, c.attributes.created_at)))),
    ),
    [`GET ${API}/applications`]: only('applications', (url) => {
      const includes = list(url.searchParams.get('include'));
      if (denied.has('offers') && includes.includes('offers')) return forbidden();
      // Question titles need the Questions category.
      if (denied.has('questions') && includes.some((i) => i.endsWith('.question'))) return forbidden();
      const stageTypes = list(url.searchParams.get('filter[stage_basic_type]'));
      const shown = applications.filter(
        (a) =>
          inJob(url, a.attributes.job_id) &&
          (!stageTypes.length || stageTypes.includes(String(store.get(`stages:${a.attributes.stage_id}`)!.attributes.basic_type))) &&
          createdAfter(url, a.attributes.created_at),
      );
      return doc(url, paged(url, shown));
    }),
    [`GET ${API}/interviews`]: only('interviews', (url) => {
      const type = url.searchParams.get('filter[interviewable_type]');
      const shown = interviews.filter(
        (i) =>
          (!type || i.attributes.interviewable_type === type) &&
          (i.attributes.interviewable_type !== 'Application' ||
            inJob(url, store.get(`applications:${i.attributes.interviewable_id}`)!.attributes.job_id)) &&
          createdAfter(url, i.attributes.created_at),
      );
      return doc(url, paged(url, shown));
    }),
    [`GET ${API}/comments`]: only('comments', (url) => {
      const types = list(url.searchParams.get('filter[commentable_type]'));
      const shown = comments.filter(
        (c) => (!types.length || types.includes(String(c.attributes.commentable_type))) && createdAfter(url, c.attributes.created_at),
      );
      return doc(url, paged(url, shown));
    }),
    [`GET ${API}/job_seekers`]: only('job_seekers', (url) => doc(url, paged(url, jobSeekers))),

    // Blobs on Pinpoint hosts need the key, then redirect to a short-lived storage URL.
    [`GET ${HOST}${path(AMARA_CV)}`]: api(
      () => new Response(null, { status: 302, headers: { location: `https://${S3}/uploads/k7x2m9q4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=300&X-Amz-Signature=5d1c` } }),
    ),
    [`GET ${HOST}${path(AMARA_COVER)}`]: api(
      () => new Response(null, { status: 302, headers: { location: `https://${S3}/uploads/c0v3r1et?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=300&X-Amz-Signature=9e2f` } }),
    ),
    [`GET ${S3}/uploads/k7x2m9q4`]: () => pdf('Amara Okafor, brand designer', 'Amara_Okafor_CV.pdf'),
    [`GET ${S3}/uploads/c0v3r1et`]: () => pdf('Dear Northwind', 'cover_letter.pdf'),
    [`GET pinpointhq.com${path(BEN_CV)}`]: api(
      () =>
        new Response(Buffer.from('PK\u0003\u0004 Ben Carter'), {
          headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
        }),
    ),
    [`GET ${CAREERS}${path(CHLOE_CV)}`]: () => new Response('Unauthorized', { status: 401 }),
    [`GET ${HOST}${path(CHLOE_PORTFOLIO)}`]: api(() => pdf('Chloe Dubois, selected work', 'Chloe_Portfolio.pdf')),
    [`GET ${HOST}${path(DEV_CV)}`]: api(() => pdf('Dev Patel, product designer', 'Dev_Patel_CV.pdf')),
    [`GET ${HOST}${path(OFFER_LETTER)}`]: api(() => pdf('Signed offer', 'Offer_Letter_signed.pdf')),
  };
}

const opportunityRows = (orgId: string) =>
  db.opportunity.findMany({
    where: { orgId },
    include: {
      stage: true,
      archiveReason: true,
      posting: true,
      contact: true,
      stageTransitions: { orderBy: { occurredAt: 'asc' }, include: { toStage: true } },
    },
  });

const importedId = (o: { customFields: unknown }) => (o.customFields as { imported: { id: string } }).imported.id;
const DAY = 86_400_000;

// ---------- tests ----------

describe.skipIf(!hasDb)('pinpoint adapter', () => {
  it('verifies with the company sideloaded on a job, sending the key only as X-API-KEY', async () => {
    const { impl, calls, unmatched } = mockFetch(routes());
    // Admins often paste their Pinpoint URL instead of the subdomain.
    const result = await verifyForTest(pinpointProvider, { subdomain: 'https://Northwind.pinpointhq.com/admin/jobs', apiKey: KEY }, impl);
    expect(result).toEqual({ accountName: 'Northwind Logistics' });
    expect(unmatched).toEqual([]);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(`${call.url.host}${call.url.pathname}`).toBe(`${API}/jobs`);
    expect(call.headers['x-api-key']).toBe(KEY);
    expect(call.headers['x-vendor-name']).toBe('source-ats');
    expect(call.headers.accept).toBe('application/vnd.api+json');
    expect(call.headers.authorization).toBeUndefined();
    expect(call.url.toString()).not.toContain(KEY);
    expect(call.url.searchParams.get('include')).toBe('company');
    expect(call.url.searchParams.get('page[size]')).toBe('1');
    // Without `confidential`, an account whose only jobs are confidential looks empty.
    expect(call.url.searchParams.get('filter[visibility]')).toBe('internal,external,confidential,private_job');

    await expect(verifyForTest(pinpointProvider, { subdomain: 'northwind', apiKey: 'wrong' }, impl)).rejects.toMatchObject({
      name: 'ImportAuthError',
      status: 401,
    });
    await expect(verifyForTest(pinpointProvider, { subdomain: 'not a subdomain', apiKey: KEY }, impl)).rejects.toThrow(/subdomain/);
  });

  it('builds its phase list from empty credentials', () => {
    const http = createHttpClient({ resolveHost: publicDns, auth: { hosts: [] }, minIntervalMs: 0 });
    const adapter = pinpointProvider.create({}, http);
    expect(adapter.discover.map((p) => p.id)).toEqual(['users', 'stages', 'reasons']);
    expect(adapter.load.map((p) => p.id)).toEqual([
      'requisitions',
      'jobs',
      'candidates',
      'applications',
      'interviews',
      'scorecards',
      'notes',
      'files',
    ]);
    // Any Pinpoint host may serve a blob; anything else (storage, careers domains) never gets the key.
    expect(pinpointProvider.auth({ subdomain: 'northwind', apiKey: KEY })).toEqual({
      hosts: ['pinpointhq.com', '.pinpointhq.com'],
      headers: { 'X-API-KEY': KEY, 'x-vendor-name': 'source-ats' },
    });
    expect(pinpointProvider.auth({}).headers).toEqual({ 'x-vendor-name': 'source-ats' });
    expect(pinpointProvider.minIntervalMs).toBeGreaterThanOrEqual(2000);
  });

  it('maps scorecard scores, sentiments, offer states and requisition budgets', () => {
    expect(pinpointRating([5, 5, 4])).toBe(4);
    expect(pinpointRating([5, 4, 3])).toBe(3);
    expect(pinpointRating([3, 3])).toBe(2);
    expect(pinpointRating([2, 1])).toBe(1);
    expect(pinpointRating([], 'very_positive')).toBe(4);
    expect(pinpointRating([], 'strong')).toBe(4);
    expect(pinpointRating([], 'positive')).toBe(3);
    expect(pinpointRating([], 'neutral')).toBe(2);
    expect(pinpointRating([], 'negative')).toBe(2);
    expect(pinpointRating([], 'very_negative')).toBe(1);
    // "strong" on its own is positive, but never when the wording is negative.
    expect(pinpointRating([], 'strong_negative')).toBe(1);
    expect(pinpointRating([], 'strongly-negative')).toBe(1);
    expect(pinpointRating([], 'strong_no')).toBe(1);
    expect(pinpointRating([], 'no_data')).toBeNull();
    expect(pinpointRating([], null)).toBeNull();

    expect(pinpointOfferStatus({ result: 'accepted', status: 'sent', sent_at: ts('2026-04-02T12:30:00') })).toBe('ACCEPTED');
    expect(pinpointOfferStatus({ result: 'declined', status: 'sent', sent_at: ts('2026-04-02T12:30:00') })).toBe('DECLINED');
    expect(pinpointOfferStatus({ result: null, status: 'retracted', sent_at: ts('2026-04-02T12:30:00') })).toBe('WITHDRAWN');
    expect(pinpointOfferStatus({ result: null, status: 'pending_approval', sent_at: null })).toBe('PENDING_APPROVAL');
    expect(pinpointOfferStatus({ result: null, status: 'sent', sent_at: ts('2026-04-02T12:30:00') })).toBe('SENT');
    expect(pinpointOfferStatus({ result: null, status: 'draft', sent_at: null })).toBe('DRAFT');

    // No currency anywhere: the amount is left out rather than stored as dollars.
    expect(pinpointRequisitionSalary([{ label: 'Budgeted salary', decimal_value: '65000.0' }])).toEqual({ min: null, max: null, currency: null });
    expect(pinpointRequisitionSalary([{ label: 'Budgeted salary', decimal_value: '65000.0' }], 'GBP')).toEqual({ min: null, max: 65000, currency: 'GBP' });
    // A range in free text is two numbers, not one run of digits.
    expect(pinpointRequisitionSalary([{ label: 'Salary range', varchar_value: '£55,000 - £65,000' }])).toEqual({ min: 55000, max: 65000, currency: 'GBP' });
    expect(pinpointRequisitionSalary([{ label: 'Budget', varchar_value: '€40k–€50k' }], 'GBP')).toEqual({ min: 40000, max: 50000, currency: 'EUR' });
    expect(
      pinpointRequisitionSalary([{ label: 'Salary', integer_value: 70000 }, { label: 'Salary currency', single_select_value: 'usd' }], 'GBP'),
    ).toEqual({ min: null, max: 70000, currency: 'USD' });
    // Nothing that overflows Source's integer columns.
    expect(pinpointRequisitionSalary([{ label: 'Budget', varchar_value: '55000065000000' }], 'GBP')).toEqual({ min: null, max: null, currency: 'GBP' });
  });

  it('imports a whole account, and a re-run adds nothing', async () => {
    denied = new Set();
    const { impl, calls, unmatched } = mockFetch(routes());
    const run = await runImportForTest({ module: provider, credentials, fetchImpl: impl });

    expect(run.error).toBeNull();
    expect(run.status).toBe('SUCCEEDED');
    expect(unmatched).toEqual([]);
    expect(run.view.created).toEqual({
      requisition: 2,
      posting: 2,
      contact: 4, // the sample candidate is skipped
      opportunity: 7, // the demo applications are skipped
      interview: 2, // the talent-pipeline interview has no opportunity
      feedback: 2, // the pending scorecard is skipped
      offer: 1,
      note: 5, // four comments (one on a job seeker) + one interview summary
      file: 6, // Amara's CV (once) and cover letter, Ben's CV and offer letter, Chloe's portfolio, Dev's CV
    });
    const issues = run.view.issues.map((i) => i.message);
    expect(issues).toHaveLength(2);
    expect(issues).toEqual(
      expect.arrayContaining([
        // Chloe's CV is on a custom careers domain, which never gets the key.
        expect.stringContaining("Couldn't download Chloe_Dubois_CV.pdf"),
        // A tenant may file rejection reasons under its own tag category.
        'Some rejected applications have no rejection-reason tag but do have "custom_red" tags. Only tags in Pinpoint\'s "rejection" category become rejection reasons.',
      ]),
    );

    // Review: per-job stages grouped by name, "Rejected" left out, types from basic_type.
    const stages = Object.fromEntries(run.review!.stages.map((s) => [s.key, s]));
    expect(Object.keys(stages).sort()).toEqual(['applied', 'hired', 'offer', 'phone screen', 'portfolio review', 'technical interview']);
    expect(stages['phone screen'].count).toBe(2);
    expect(stages['phone screen'].target).toHaveProperty('stageId');
    expect(stages['hired'].target).toHaveProperty('stageId');
    expect(stages['applied'].target).toEqual({ create: { name: 'Applied', type: 'APPLICANT' } });
    expect(stages['portfolio review'].target).toEqual({ create: { name: 'Portfolio Review', type: 'ONSITE' } });
    expect(stages['technical interview'].suggestedType).toBe('ONSITE');
    // The demo application's reason is left out; an untagged rejection gets a reason of its own.
    expect(run.review!.reasons.map((r) => [r.name, r.kind, r.target])).toEqual(
      expect.arrayContaining([
        ['Salary expectations', 'rejection', { create: { name: 'Salary expectations', countsAsRejection: true } }],
        ['Withdrew application', 'withdrawn', { create: { name: 'Withdrew application', countsAsRejection: false } }],
        ['Rejected (no reason recorded)', 'rejection', { create: { name: 'Rejected (no reason recorded)', countsAsRejection: true } }],
      ]),
    );
    expect(run.review!.reasons).toHaveLength(3);
    expect(run.review!.users).toMatchObject({ total: 2, matched: 1, unmatchedNames: ['Tom Baker'] });

    // Jobs and requisitions.
    const postings = await db.posting.findMany({ where: { orgId: run.orgId }, include: { department: true, requisition: true } });
    const design = postings.find((p) => p.title === 'Senior Marketing Designer')!;
    expect(design).toMatchObject({
      state: 'DRAFT',
      location: 'London HQ',
      workplaceType: 'REMOTE',
      commitment: 'FULL_TIME',
      salaryMin: 55000,
      salaryMax: 65000,
      salaryCurrency: 'GBP',
    });
    expect(design.department!.name).toBe('Marketing');
    // Linked through requisitions.job_id although the job's own requisition_id says something else;
    // the budget states no currency, so it takes the job's.
    expect(design.requisition).toMatchObject({ code: 'PIN-0179', openings: 2, salaryMin: null, salaryMax: 65000, salaryCurrency: 'GBP', state: 'OPEN' });
    expect(design.createdAt.toISOString()).toBe('2026-01-12T09:30:00.000Z');
    const designText = (design.content as { description: string }).description;
    expect(designText).toContain("We're a fully remote, UK-based, HR-tech startup");
    expect(designText).toContain('About the Role:\n• Take ownership of our visual identity');
    expect(designText).toContain('What We Offer:');
    expect(designText).not.toContain('<!--block-->');
    const backend = postings.find((p) => p.title === 'Backend Engineer')!;
    expect(backend).toMatchObject({ state: 'CLOSED', commitment: 'CONTRACT', workplaceType: 'HYBRID', salaryMin: null, salaryCurrency: null, location: 'Austin, TX' });
    // Empty job description → the default posting's; day rates stay as text.
    expect((backend.content as { description: string }).description).toBe('Build our APIs.\n\nCompensation: £400 / day');
    // A requisition with no job is found by the job's free-text reference; its details are free text too.
    expect(backend.requisition).toMatchObject({ code: 'PIN-0200', openings: 2, salaryMin: 55000, salaryMax: 65000, salaryCurrency: 'GBP', backfill: true });
    // Only one requisition had a budget with no currency: one light pass over /jobs found it.
    const currencyLookups = calls.filter((c) => c.url.searchParams.get('fields[jobs]') === 'compensation_currency');
    expect(currencyLookups).toHaveLength(1);

    // Contacts.
    const contacts = await db.contact.findMany({ where: { orgId: run.orgId } });
    expect(contacts.map((c) => c.name).sort()).toEqual(['Amara Okafor', 'Ben Carter', 'Chloe Dubois', 'Dev Patel']);
    const amara = contacts.find((c) => c.name === 'Amara Okafor')!;
    expect(amara).toMatchObject({
      emails: ['amara.okafor@example.com'],
      phones: ['+447700900123'],
      links: ['https://www.linkedin.com/in/amaraokafor'],
      location: 'London, GB',
      tags: ['Portfolio strong'],
    });
    expect(amara.createdAt.toISOString()).toBe('2026-02-03T18:22:41.000Z');
    const ben = contacts.find((c) => c.name === 'Ben Carter')!;
    expect(ben.emails).toEqual(['ben.carter@example.com']);
    const chloe = contacts.find((c) => c.name === 'Chloe Dubois')!;
    expect(chloe.location).toBe('Austin, TX');

    // Applications.
    const opps = await opportunityRows(run.orgId);
    expect(opps.map(importedId).sort()).toEqual(['560021', '561877', '562500', '562700', '562800', '562900', '563000']);
    const byId = (id: string) => opps.find((o) => importedId(o) === id)!;

    const rejected = byId('560021');
    expect(rejected).toMatchObject({ status: 'ARCHIVED', origin: 'APPLIED', source: 'LinkedIn', ownerId: run.adminId, confidential: false });
    expect(rejected.contactId).toBe(amara.id);
    expect(rejected.archiveReason).toMatchObject({ name: 'Salary expectations', countsAsRejection: true });
    expect(rejected.archivedAt!.toISOString()).toBe('2026-03-01T10:15:00.000Z');
    expect(rejected.createdAt.toISOString()).toBe('2026-02-03T18:22:41.000Z');
    // It sits at the furthest stage it reached, not in "Rejected".
    expect(rejected.stage.name).toBe('Portfolio Review');
    expect(rejected.stageTransitions.map((t) => [t.toStage.name, t.occurredAt.toISOString()])).toEqual([
      ['Applied', '2026-02-03T18:22:41.000Z'],
      ['Portfolio Review', '2026-03-01T10:15:00.000Z'],
    ]);
    expect(rejected.posting!.title).toBe('Senior Marketing Designer');
    expect((rejected.customFields as { imported: { fields: Record<string, string> } }).imported.fields).toEqual({
      'Earliest start date': '2026-04-01',
      'Pinpoint average rating': '4.33',
      Summary: 'Brand designer with 7 years in B2B SaaS.',
      Pronouns: 'she/her',
      Tags: 'Portfolio strong',
    });

    const hired = byId('561877');
    expect(hired).toMatchObject({ status: 'HIRED', origin: 'REFERRED', source: 'Employee referral', archiveReasonId: null });
    expect(hired.stage.name).toBe('Hired');
    expect(hired.stageTransitions.map((t) => [t.toStage.name, t.occurredAt.toISOString()])).toEqual([
      ['Applied', '2026-01-20T09:00:00.000Z'],
      ['Hired', '2026-04-05T08:12:44.000Z'],
    ]);

    // hired_at makes a hire even in the offer stage; the stage itself was entered 40 days ago.
    const hiredAtOffer = byId('562800');
    expect(hiredAtOffer).toMatchObject({ status: 'HIRED', archiveReasonId: null });
    // …and so it moves on into Hired, entered at hired_at.
    expect(hiredAtOffer.stage.name).toBe('Hired');
    expect(hiredAtOffer.archivedAt).toBeNull();
    expect(hiredAtOffer.stageChangedAt.toISOString()).toBe('2026-08-20T10:00:00.000Z');
    expect(hiredAtOffer.stageTransitions.map((t) => t.toStage.name)).toEqual(['Applied', 'Offer', 'Hired']);
    expect(Math.abs(hiredAtOffer.stageTransitions[1].occurredAt.getTime() - (Date.now() - 40 * DAY))).toBeLessThan(60 * 60_000);

    const active = byId('562500');
    expect(active).toMatchObject({ status: 'ACTIVE', origin: 'SOURCED', source: 'Sourced on GitHub', confidential: true, ownerId: run.adminId });
    expect(active.stage.name).toBe('Technical Interview');
    expect(active.stageTransitions.map((t) => t.toStage.name)).toEqual(['Applied', 'Technical Interview']);
    expect(active.stageTransitions[0].occurredAt.toISOString()).toBe('2026-06-01T12:00:00.000Z');
    // Entered the current stage days_in_current_stage (12) days ago.
    expect(Math.abs(active.stageTransitions[1].occurredAt.getTime() - (Date.now() - 12 * DAY))).toBeLessThan(60 * 60_000);
    expect(active.stageChangedAt.getTime()).toBe(active.stageTransitions[1].occurredAt.getTime());

    const withdrew = byId('562700');
    expect(withdrew).toMatchObject({ status: 'ARCHIVED', origin: 'APPLIED', source: 'Careers site' });
    expect(withdrew.contactId).toBe(ben.id);
    expect(withdrew.archiveReason).toMatchObject({ name: 'Withdrew application', countsAsRejection: false });
    expect(withdrew.stage.name).toBe('Applied');
    expect(withdrew.stageTransitions.map((t) => t.toStage.name)).toEqual(['Applied']);

    const untagged = byId('562900');
    expect(untagged).toMatchObject({ status: 'ARCHIVED' });
    expect(untagged.archiveReason).toMatchObject({ name: 'Rejected (no reason recorded)', countsAsRejection: true });
    expect(untagged.stage.name).toBe('Phone screen');
    expect((untagged.customFields as { imported: { fields: Record<string, string> } }).imported.fields.Tags).toBe('Culture add');

    // The blind-screened application joins Ben's contact; nothing masked was stored.
    const blind = byId('563000');
    expect(blind).toMatchObject({ status: 'ACTIVE', confidential: true, contactId: ben.id });
    expect(contacts.some((c) => c.name === 'Anonymous candidate')).toBe(false);

    // Interviews: title from the stage, panel from the parts, state from status/presence.
    const ivs = await db.interview.findMany({ where: { orgId: run.orgId }, include: { panelists: true }, orderBy: { startAt: 'asc' } });
    expect(ivs.map((i) => [i.title, i.state, i.durationMins])).toEqual([
      ['Portfolio Review', 'COMPLETED', 60],
      ['Technical Interview', 'SCHEDULED', 45],
    ]);
    expect(ivs[0].location).toBe('https://meet.google.com/abc-defg-hij');
    expect(ivs[0].panelists.map((p) => p.id)).toEqual([run.adminId]);
    expect(ivs[1].startAt.toISOString()).toBe('2030-10-05T14:00:00.000Z');
    // interviewable_type values are undocumented, so interviews aren't filtered on it server-side.
    expect(calls.some((c) => c.url.searchParams.has('filter[interviewable_type]'))).toBe(false);

    // Scorecard: mean of 5, 4, 3 = 4 → "yes". Metric labels are undocumented: name, title, else the id.
    const fb = await db.feedbackSubmission.findFirstOrThrow({ where: { orgId: run.orgId } });
    expect(fb).toMatchObject({ overallRating: 3, authorId: run.adminId, interviewId: null, opportunityId: rejected.id });
    expect(fb.summary).toBe('Portfolio Review Scorecard\nWould be a great fit if we can close the comp gap.');
    expect(fb.createdAt.toISOString()).toBe('2026-02-19T16:40:12.000Z');
    expect(Object.values(fb.answers as Record<string, { label: string; value: string }>).map((a) => [a.label, a.value])).toEqual([
      ['Visual craft', '5/5'],
      ['Design systems', '4/5'],
      ['Metric 7703', '3/5'],
      ['Most relevant project?', 'Led the rebrand at a Series B startup; owned the design system.'],
    ]);

    // Notes: matched author without a byline; everyone else credited by name.
    const notes = await db.note.findMany({ where: { orgId: run.orgId } });
    const bodies = notes.map((n) => n.body);
    expect(bodies).toHaveLength(9);
    const attachmentNote = (name: string) => expect.stringMatching(new RegExp(`^\\[${brand}\\] Attachment: ${name.replace('.', '\\.')} — /api/files/`));
    expect(bodies).toEqual(
      expect.arrayContaining([
        'Great portfolio, but salary expectation is ~20% above band. Suggest we keep warm for the Lead role.',
        `[${brand} · Tom Baker] [Private] Referred by Sam in Design.`,
        `[${brand}] Candidate asked to move the technical interview to next week.`,
        'Talent pipeline lead from the London meetup.',
        `[${brand}] Interview summary (Portfolio Review)\nWalked through the Acme rebrand. Strong systems thinking.`,
        `[${brand} · Tom Baker] Portfolio Review Scorecard\nNeeds a second look at motion work.`,
        attachmentNote('cover_letter.pdf'),
        attachmentNote('Offer_Letter_signed.pdf'),
        attachmentNote('Chloe_Portfolio.pdf'),
      ]),
    );
    const byTeammate = notes.find((n) => n.body.startsWith('Great portfolio'))!;
    expect(byTeammate.authorId).toBe(run.adminId);
    expect(byTeammate.createdAt.toISOString()).toBe('2026-02-20T14:31:07.000Z');
    // The candidate-level comment lands on Amara's (only) application.
    expect(notes.find((n) => n.body.includes('Referred by Sam'))!.opportunityId).toBe(rejected.id);
    // The talent-pipeline comment reaches Ben through his job seeker record, on his latest application.
    expect(notes.find((n) => n.body.startsWith('Talent pipeline lead'))!.opportunityId).toBe(blind.id);
    // Application and offer attachments land on their own application.
    expect(notes.find((n) => n.body.includes('cover_letter.pdf'))!.opportunityId).toBe(rejected.id);
    expect(notes.find((n) => n.body.includes('Offer_Letter_signed.pdf'))!.opportunityId).toBe(hired.id);

    // Offer.
    const offer = await db.offer.findFirstOrThrow({ where: { orgId: run.orgId } });
    expect(offer).toMatchObject({
      opportunityId: hired.id,
      status: 'ACCEPTED',
      jobTitle: 'Senior Marketing Designer',
      salaryAmount: 62000,
      salaryCurrency: 'GBP',
    });
    expect(offer.startDate!.toISOString()).toBe('2026-05-04T00:00:00.000Z');
    expect(offer.sentAt!.toISOString()).toBe('2026-04-02T12:30:00.000Z');
    expect(offer.respondedAt!.toISOString()).toBe('2026-04-05T08:12:44.000Z');
    // The expiry date as the sender wrote it, not the UTC date.
    expect(offer.notes).toBe(
      'Includes relocation support.\nPaid time off: 25 days\nWork address: 1 Finsbury Avenue, London EC2A 4NE\nExpires: 2026-04-09',
    );

    // Files: from candidates, applications and offers, each once, via storage redirects that never saw the key.
    const files = await db.storedFile.findMany({ where: { orgId: run.orgId } });
    expect(files.map((f) => [f.filename, f.mime]).sort()).toEqual([
      ['Amara_Okafor_CV.pdf', 'application/pdf'],
      ['Ben_Carter_CV.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      ['Chloe_Portfolio.pdf', 'application/pdf'],
      ['Dev_Patel_CV.pdf', 'application/pdf'],
      ['Offer_Letter_signed.pdf', 'application/pdf'],
      ['cover_letter.pdf', 'application/pdf'],
    ]);
    const withResumes = await db.contact.findMany({ where: { orgId: run.orgId }, include: { resumeFile: true } });
    expect(withResumes.find((c) => c.name === 'Amara Okafor')!.resumeFile!.filename).toBe('Amara_Okafor_CV.pdf');
    expect(withResumes.find((c) => c.name === 'Ben Carter')!.resumeFile!.filename).toBe('Ben_Carter_CV.docx');
    // Dev's CV was only on his application.
    expect(withResumes.find((c) => c.name === 'Dev Patel')!.resumeFile!.filename).toBe('Dev_Patel_CV.pdf');
    expect(withResumes.find((c) => c.name === 'Chloe Dubois')!.resumeFileId).toBeNull();
    // Amara's CV is on her candidate record and her application: downloaded once.
    expect(calls.filter((c) => c.url.pathname === new URL(AMARA_CV).pathname)).toHaveLength(1);
    expect(calls.some((c) => c.url.pathname.endsWith('/application.pdf'))).toBe(false);
    expect(calls.some((c) => c.url.pathname.endsWith('/Sample_CV.pdf'))).toBe(false);
    expect(calls.some((c) => c.url.searchParams.get('extra_fields[applications]') === 'attachments')).toBe(true);

    // Credentials: only Pinpoint hosts get the key, only over HTTPS, and never in a URL.
    const pinpointHosts = new Set([HOST, 'pinpointhq.com']);
    for (const c of calls) {
      expect(c.url.toString()).not.toContain(KEY);
      if (pinpointHosts.has(c.url.host)) expect(c.headers['x-api-key']).toBe(KEY);
      else expect(JSON.stringify(c.headers)).not.toContain(KEY);
      if (c.headers['x-api-key']) expect(c.url.protocol).toBe('https:');
    }
    expect(calls.find((c) => c.url.pathname.endsWith('/Chloe_Portfolio.pdf'))!.url.protocol).toBe('https:');
    expect(calls.filter((c) => c.url.host === S3)).toHaveLength(2);
    expect(calls.filter((c) => c.url.host === CAREERS)).toHaveLength(1);

    // Paging: explicit sort, every visibility, and a short page ends the list.
    const pages = (resource: string, match: (u: URL) => boolean = () => true) =>
      calls
        .filter((c) => c.url.host === HOST && c.url.pathname === `/api/v1/${resource}` && match(c.url))
        .map((c) => c.url.searchParams.get('page[number]'));
    expect(pages('candidates', (u) => u.searchParams.get('extra_fields[candidates]') === 'tags')).toEqual(['1', '2', '3']);
    expect(pages('candidates', (u) => u.searchParams.get('extra_fields[candidates]') === 'attachments')).toEqual(['1', '2', '3']);
    expect(pages('applications', (u) => u.searchParams.get('include')?.startsWith('stage,') ?? false)).toEqual(['1', '2', '3', '4', '5']);
    expect(pages('applications', (u) => u.searchParams.get('fields[applications]') === 'id,candidate_id')).toEqual(['1', '2', '3', '4', '5']);
    expect(pages('applications', (u) => u.searchParams.get('extra_fields[applications]') === 'attachments')).toEqual(['1', '2', '3', '4', '5']);
    for (const c of calls.filter((x) => x.url.searchParams.has('page[number]'))) {
      expect(c.url.searchParams.get('sort')).toBe('id');
      if (c.url.pathname.endsWith('/applications') || c.url.pathname.endsWith('/interviews')) {
        expect(c.url.searchParams.get('filter[job_visibility]')).toBe('internal,external,confidential,private_job');
      }
      if (c.url.pathname.endsWith('/jobs')) expect(c.url.searchParams.get('filter[visibility]')).toBe('internal,external,confidential,private_job');
    }
    // Scorecards and offers share one pass, with the offers' attachments.
    const passB = calls.filter((c) => c.url.searchParams.get('fields[applications]') === 'id,candidate_id');
    expect(passB.every((c) => /(^|,)offers(,|$)/.test(c.url.searchParams.get('include') ?? ''))).toBe(true);
    expect(passB.every((c) => (c.url.searchParams.get('include') ?? '').includes('user_scorecards.scorecard_ratings'))).toBe(true);
    expect(passB.every((c) => c.url.searchParams.get('extra_fields[offers]') === 'attachments')).toBe(true);

    // Re-running into the same org creates nothing and downloads nothing again.
    const before = {
      contacts: await db.contact.count({ where: { orgId: run.orgId } }),
      notes: await db.note.count({ where: { orgId: run.orgId } }),
      stages: await db.stage.count({ where: { orgId: run.orgId } }),
      files: await db.storedFile.count({ where: { orgId: run.orgId } }),
      requisitions: await db.requisition.count({ where: { orgId: run.orgId } }),
    };
    const again = await runImportForTest({ module: provider, credentials, fetchImpl: impl, orgId: run.orgId });
    expect(again.status).toBe('SUCCEEDED');
    expect(again.view.created).toEqual({});
    expect(again.review!.stages.every((s) => 'stageId' in s.target)).toBe(true);
    expect(await db.opportunity.count({ where: { orgId: run.orgId } })).toBe(7);
    expect({
      contacts: await db.contact.count({ where: { orgId: run.orgId } }),
      notes: await db.note.count({ where: { orgId: run.orgId } }),
      stages: await db.stage.count({ where: { orgId: run.orgId } }),
      files: await db.storedFile.count({ where: { orgId: run.orgId } }),
      requisitions: await db.requisition.count({ where: { orgId: run.orgId } }),
    }).toEqual(before);
    expect(calls.filter((c) => c.url.host === S3)).toHaveLength(2);
    expect(unmatched).toEqual([]);
  });

  it('copes with a server that drops relationships under sparse fieldsets', async () => {
    denied = new Set();
    stripSparse = true;
    const { impl, calls, unmatched } = mockFetch(routes());
    const run = await runImportForTest({ module: provider, credentials, fetchImpl: impl, options: { files: false } });
    stripSparse = false;

    expect(run.error).toBeNull();
    expect(run.status).toBe('SUCCEEDED');
    expect(unmatched).toEqual([]);
    expect(run.view.created).toMatchObject({ opportunity: 7, feedback: 2, offer: 1 });
    const opps = await opportunityRows(run.orgId);
    // The applied stage still comes from the job's pipeline.
    const rejected = opps.find((o) => importedId(o) === '560021')!;
    expect(rejected.stageTransitions.map((t) => t.toStage.name)).toEqual(['Applied', 'Portfolio Review']);
    const untagged = opps.find((o) => importedId(o) === '562900')!;
    expect(untagged.stage.name).toBe('Phone screen');

    // Each pass noticed on its first page and asked the rest without the sparse fieldset.
    const passA = calls.filter((c) => c.url.pathname === '/api/v1/applications' && c.url.searchParams.get('include')?.startsWith('stage,'));
    expect(passA.filter((c) => c.url.searchParams.has('fields[jobs]'))).toHaveLength(1);
    expect(passA.filter((c) => !c.url.searchParams.has('fields[jobs]')).map((c) => c.url.searchParams.get('page[number]'))).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
    ]);
    const passB = calls.filter((c) => (c.url.searchParams.get('include') ?? '').startsWith('user_scorecards'));
    expect(passB.filter((c) => c.url.searchParams.has('fields[applications]'))).toHaveLength(1);
  });

  it('turns missing read permissions on optional data into warnings', async () => {
    denied = new Set(['requisitions', 'comments', 'offers', 'questions']);
    const { impl, calls, unmatched } = mockFetch(routes());
    const run = await runImportForTest({ module: provider, credentials, fetchImpl: impl, options: { files: false } });
    denied = new Set();

    expect(run.error).toBeNull();
    expect(run.status).toBe('SUCCEEDED');
    expect(unmatched).toEqual([]);
    const messages = run.view.issues.map((i) => i.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^Requisitions: This key doesn't have permission for GET northwind\.pinpointhq\.com\/api\/v1\/requisitions/),
        expect.stringMatching(/^Notes: This key doesn't have permission for GET northwind\.pinpointhq\.com\/api\/v1\/comments/),
        expect.stringMatching(/^Offers: This key doesn't have permission for GET northwind\.pinpointhq\.com\/api\/v1\/applications/),
        expect.stringMatching(/^Scorecards: This key doesn't have permission .*Imported without the related records it can't read\.$/),
      ]),
    );
    expect(messages.join('\n')).not.toContain(KEY);
    // Everything the key can read still came across; scorecards survived the refused offers and question includes.
    expect(run.view.created).toEqual({ posting: 2, contact: 4, opportunity: 7, interview: 2, feedback: 2, note: 1 });
    const scorecardOnly = calls.filter(
      (c) => c.url.searchParams.get('fields[applications]') === 'id,candidate_id' && !list(c.url.searchParams.get('include')).includes('offers'),
    );
    expect(scorecardOnly.length).toBeGreaterThan(0);
    // The leaner scorecard query goes without metric names and question titles, but keeps the scores and the author.
    const fb = await db.feedbackSubmission.findFirstOrThrow({ where: { orgId: run.orgId } });
    expect(fb).toMatchObject({ overallRating: 3, authorId: run.adminId });
    expect(Object.values(fb.answers as Record<string, { label: string; value: string }>).map((a) => a.label)).toEqual([
      'Rating 1',
      'Rating 2',
      'Rating 3',
      'Answer',
    ]);
  });

  it('filters server-side for an active-only import since a date', async () => {
    denied = new Set();
    const { impl, calls, unmatched } = mockFetch(routes());
    const run = await runImportForTest({
      module: provider,
      credentials,
      fetchImpl: impl,
      options: { archived: false, since: '2026-05-01T00:00:00.000Z', activity: false, offers: false, files: false },
    });

    expect(run.error).toBeNull();
    expect(run.status).toBe('SUCCEEDED');
    expect(unmatched).toEqual([]);
    // Ben was created before the cutoff; his blind-screened application after it brings him in from his candidate record.
    // The sample candidate (created after the cutoff) stays out.
    expect(run.view.created).toEqual({ requisition: 2, posting: 2, contact: 2, opportunity: 2 });
    expect(run.review!.reasons).toEqual([]);

    const appCalls = calls.filter((c) => c.url.pathname === '/api/v1/applications');
    expect(appCalls.length).toBeGreaterThan(0);
    for (const c of appCalls) {
      expect(c.url.searchParams.get('filter[stage_basic_type]')).toBe('applied,review,interview,offer');
      expect(c.url.searchParams.get('filter[created_at][gt]')).toBe('2026-04-30T23:59:59+00:00');
      // A raw "+" would reach Rails as a space.
      expect(c.url.search).toContain('%2B00%3A00');
    }
    const candidateCalls = calls.filter((c) => c.url.pathname === '/api/v1/candidates');
    expect(candidateCalls.every((c) => c.url.searchParams.get('filter[created_at][gt]') === '2026-04-30T23:59:59+00:00')).toBe(true);
    expect(calls.some((c) => ['/api/v1/interviews', '/api/v1/comments'].includes(c.url.pathname))).toBe(false);
    expect(calls.some((c) => c.url.searchParams.get('fields[applications]') === 'id,candidate_id')).toBe(false);

    const opps = await opportunityRows(run.orgId);
    expect(opps.map((o) => [importedId(o), o.status, o.contact.name]).sort()).toEqual([
      ['562500', 'ACTIVE', 'Chloe Dubois'],
      ['563000', 'ACTIVE', 'Ben Carter'],
    ]);
    const ben = opps.find((o) => importedId(o) === '563000')!.contact;
    expect(ben).toMatchObject({ emails: ['ben.carter@example.com'], phones: ['+447700900456'], location: 'Leeds, GB' });
  });
});
