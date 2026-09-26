import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/session', () => ({ isAdmin: () => true }));

import { providerMeta } from '@/lib/import-providers';
import { createHttpClient, ImportAuthError } from '@/server/imports/http';
import { db, json, mockFetch, runImportForTest, verifyForTest, type RouteHandler } from '@/server/imports/__tests__/harness';
import { hasDb, publicDns } from '@/server/imports/__tests__/harness';
import { parseSalary, teamtailorProvider, toRating } from '@/server/imports/providers/teamtailor';

/**
 * Teamtailor adapter against a mock of its JSON:API, built from the payloads
 * in Teamtailor's API reference: kebab-case attributes, string ids with
 * integer foreign keys on notes and movements, `+01:00`-offset timestamps,
 * relationships that only carry ids (linkage) when the request included them,
 * offset and cursor paging, and pre-signed S3 file links that expire.
 */

const KEY = 'tt_live_Qm9vZ2xlZm9vYmFy0123456789abcdef';
const HOST = 'api.teamtailor.com';
const API = `https://${HOST}/v1`;
const S3 = 'tt-prod-uploads.s3.eu-west-1.amazonaws.com';
const brand = providerMeta('teamtailor')?.name ?? 'teamtailor';

type Json = Record<string, unknown>;
type Link = { type: string; id: string };
type PageDoc = { data: Json[]; included?: Json[] };

const to = (type: string, id: string): Link => ({ type, id });

/** A JSON:API resource; relationships get links, plus `data` when the request included them. */
function res(type: string, id: string, attributes: Json, rels: Record<string, Link | Link[] | null | undefined> = {}): Json {
  return {
    id,
    type,
    links: { self: `${API}/${type}/${id}` },
    attributes,
    relationships: Object.fromEntries(
      Object.entries(rels).map(([name, data]) => [
        name,
        {
          links: { self: `${API}/${type}/${id}/relationships/${name}`, related: `${API}/${type}/${id}/${name}` },
          ...(data === undefined ? {} : { data }),
        },
      ]),
    ),
  };
}

/** The same resource with linkage on one relationship, as an `include` of it adds. */
function withData(resource: Json, rel: string, data: Link | Link[] | null): Json {
  const rels = resource.relationships as Record<string, Json>;
  return { ...resource, relationships: { ...rels, [rel]: { ...(rels[rel] ?? {}), data } } };
}

const linkOf = (r: Json): Link => to(r.type as string, r.id as string);
const relOf = (r: Json, name: string) => ((r.relationships as Record<string, { data?: Link | null }>)[name]?.data ?? null) as Link | null;
const includesOf = (url: URL) => new Set((url.searchParams.get('include') ?? '').split(',').filter(Boolean));

/** `included` without duplicates, the way JSON:API compound documents list each resource once. */
function unique(resources: (Json | undefined)[]): Json[] {
  const seen = new Map<string, Json>();
  for (const r of resources) if (r) seen.set(`${r.type}:${r.id}`, r);
  return [...seen.values()];
}

const empty401 = () => new Response('', { status: 401, headers: { 'content-type': 'text/html' } });
const jsonApiError = (status: number, title: string) =>
  json({ errors: [{ status: String(status), title, detail: title }] }, { status, headers: { 'content-type': 'application/vnd.api+json' } });

// ---------- the account ----------

const user = (id: string, name: string, loginEmail: string | null, role: string, email = loginEmail) =>
  res('users', id, {
    description: null,
    'external-id': null,
    'hide-email': null,
    'login-email': loginEmail,
    name,
    phone: null,
    picture: null,
    role,
    title: null,
    username: name.split(' ')[0].toLowerCase(),
    visible: true,
    signature: `<p>-- <br>${name}</p>`,
    email,
  }, { department: undefined, teams: undefined });

const users = [
  user('1', 'Erik Erikson', 'admin@example.test', 'admin'), // the harness org's admin
  user('4', 'Former Recruiter', 'former.recruiter@acme-farming.test', 'recruiter'),
  user('5', 'Hanna Hiring', null, 'hiring_manager', 'hanna@acme-farming.test'),
];
const userById = Object.fromEntries(users.map((u) => [u.id as string, u]));

const stageType = (id: string, category: string) => res('stage-types', id, { category });
const stageTypes = [stageType('1', 'inbox'), stageType('2', 'screening'), stageType('3', 'interview'), stageType('4', 'offer'), stageType('5', 'hired')];
const stageTypeById = Object.fromEntries(stageTypes.map((t) => [t.id as string, t]));

const stage = (id: string, jobId: string, name: string, typeId: string, rowOrder: number) =>
  res(
    'stages',
    id,
    {
      'created-at': '2024-11-04T10:32:37.660+01:00',
      'updated-at': '2024-11-04T10:32:37.660+01:00',
      name,
      'legacy-stage-type-name': typeId === '1' ? 'Inbox' : typeId === '5' ? 'Hired' : 'In process',
      'row-order': rowOrder,
      'active-job-applications-count': 1,
      'rejected-job-applications-count': 0,
    },
    { 'job-applications': undefined, triggers: undefined, job: to('jobs', jobId), 'stage-type': to('stage-types', typeId) },
  );

// Stages are per job: both jobs have their own Inbox and Hired.
const stages = [
  stage('1', '23', 'Inbox', '1', 0),
  stage('2', '23', 'Reviewing', '2', 1073741824),
  stage('3', '23', 'Interview', '3', 1610612736),
  stage('4', '23', 'Offer', '4', 1879048192),
  stage('5', '23', 'Hired', '5', 2013265920),
  stage('6', '24', 'Inbox', '1', 0),
  stage('7', '24', 'Phone screen', '2', 1073741824),
  stage('8', '24', 'Hired', '5', 1610612736),
];
const stageById = Object.fromEntries(stages.map((s) => [s.id as string, s]));

const reasons = [
  res('reject-reasons', '1', { reason: 'Not qualified', 'rejected-by-company': true }, { 'job-applications': undefined }),
  res('reject-reasons', '2', { reason: 'Took another job', 'rejected-by-company': false }, { 'job-applications': undefined }),
];
const reasonById = Object.fromEntries(reasons.map((r) => [r.id as string, r]));

const departments = [res('departments', '1', { name: 'Product Development' }), res('departments', '2', { name: 'Sales' })];
const stockholm = res('locations', '1', {
  address: 'Sankt Paulsgatan 7B',
  city: 'Stockholm',
  country: 'Sweden',
  email: 'stockholm@company.com',
  headquarters: true,
  lat: null,
  long: null,
  name: null,
  phone: '070-453 21 23',
  zip: '118 46',
});

const requisition = res(
  'requisitions',
  '1',
  {
    'job-title': 'Farming Designer',
    'job-description': 'Second designer for the growing team',
    country: 'Sweden',
    'min-salary': 40000,
    'max-salary': 50000,
    currency: 'SEK',
    'salary-time-unit': 'monthly',
    'number-of-openings': 2,
    'custom-form-answers': { division: 'Nordics' },
    status: 'approved',
    'hired-count': 0,
    'created-at': '2024-12-17T14:46:32.841+01:00',
  },
  { location: undefined, department: undefined, recruiter: undefined, user: undefined, jobs: undefined },
);

function job(id: string, attrs: Json, rels: { department?: string; locations?: string[]; requisition?: string | null }) {
  return res(
    'jobs',
    id,
    {
      'apply-button-text': '',
      body: '',
      'end-date': null,
      'human-status': 'published',
      internal: false,
      picture: null,
      pinned: false,
      'start-date': null,
      status: 'open',
      'language-code': 'en',
      tags: [],
      title: 'Untitled',
      'internal-name': null,
      pitch: '',
      'external-application-url': '',
      'created-at': '2024-10-30T10:39:13.772+01:00',
      'updated-at': '2024-11-01T10:39:13.772+01:00',
      mailbox: `job-${id}@inbound.teamtailor.com`,
      'remote-status': 'none',
      'template-name': null,
      ...attrs,
    },
    {
      department: rels.department ? to('departments', rels.department) : null,
      locations: (rels.locations ?? []).map((l) => to('locations', l)),
      requisition: rels.requisition ? to('requisitions', rels.requisition) : null,
      user: undefined, // the recruiter; linkage only when included
      stages: undefined,
      location: undefined,
    },
  );
}

const farmingDesigner = job(
  '23',
  {
    title: 'Farming Designer',
    'internal-name': 'Farming Designer in Stockholm',
    pitch: 'Design the tools farmers use every day.',
    body: '<p> </p><h2>About the role</h2><p>You will own our field apps.</p><ul><li>Figma</li><li>Research</li></ul>',
    tags: ['design', 'product'],
    'remote-status': 'hybrid',
    'employment-type': 'fully',
    'employment-level': 'mid',
    currency: 'SEK',
    'salary-time-unit': 'monthly',
    'min-salary': 45000,
    'max-salary': 55000,
  },
  { department: '1', locations: ['1'], requisition: '1' },
);
const salesLead = job(
  '24',
  { title: 'Sales Lead', 'human-status': 'archived', status: 'archived', 'remote-status': 'fully', 'employment-type': 'part', 'created-at': '2024-09-02T08:00:00.000+02:00' },
  { department: '2' },
);
// Templates come back with status "unlisted"; only human-status gives them away.
const template = job('25', { title: 'Designer (template)', 'human-status': 'template', status: 'unlisted', 'template-name': 'Designer' }, {});
const internalOps = job('26', { title: 'Internal Ops Coordinator', internal: true, 'employment-type': 'contract' }, { department: '1' });

const jobById: Record<string, Json> = { '23': farmingDesigner, '24': salesLead };
/** Each job's `user` (the recruiter): Erik matches the harness admin, the Former Recruiter matches nobody. */
const recruiterOf: Record<string, string> = { '23': '1', '24': '4', '26': '5' };

const signed = (path: string, signature: string, expires = 30) =>
  `https://${S3}/uploads/${path}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAEXAMPLE%2F20250301%2Feu-west-1%2Fs3%2Faws4_request&X-Amz-Date=20250301T100000Z&X-Amz-Expires=${expires}&X-Amz-SignedHeaders=host&X-Amz-Signature=${signature}`;

function candidate(id: string, attrs: Json) {
  return res(
    'candidates',
    id,
    {
      address: null,
      'administrative-area': null,
      city: null,
      country: null,
      'country-code': null,
      'display-address': [],
      lat: null,
      long: null,
      state: null,
      zip: null,
      connected: false,
      'consent-future-jobs-at': null,
      'facebook-id': null,
      internal: false,
      'linkedin-uid': null,
      'linkedin-url': null,
      'original-resume': null,
      phone: null,
      picture: null,
      pitch: null,
      'referring-site': null,
      'referring-url': null,
      referred: false,
      resume: null,
      'resume-summary': null,
      'resume-updated-at': null,
      sourced: false,
      unsubscribed: false,
      'updated-at': '2025-08-18T15:26:04.453+02:00',
      'restricted-at': null,
      'profile-url': `https://app.teamtailor.com/companies/ZPXFT2VMtr8/candidates/segment/all/candidate/${id}`,
      'facebook-profile': null,
      'linkedin-profile': null,
      tags: [],
      ...attrs,
    },
    { activities: undefined, 'job-applications': undefined, uploads: undefined, 'custom-field-values': undefined, interviews: undefined },
  );
}

const candidates = [
  candidate('1', {
    address: '1600 Amphitheatre Parkway',
    'administrative-area': 'California',
    city: 'Mountain View',
    country: 'United States',
    'country-code': 'US',
    'display-address': ['1600 Amphitheatre Parkway', 'Mountain View CA 94043', 'United States'],
    state: 'CA',
    zip: '94043',
    'created-at': '2025-03-03T08:54:04.573+01:00',
    email: 'Applicant1@Example.test',
    'first-name': 'Mariann',
    'last-name': 'Koch',
    pitch: 'Product designer who grew up on a farm',
    // Where she first came from; this application was sourced by a recruiter.
    'referring-site': 'LinkedIn',
    sourced: true,
    tags: ['Principal'],
  }),
  candidate('2', {
    'created-at': '2025-02-03T09:12:07.000+01:00',
    email: 'applicant2@example.test',
    'first-name': 'Karima',
    'last-name': 'Mann',
    phone: '+46701234567',
    'linkedin-url': 'https://www.linkedin.com/in/karima-mann',
    'referring-site': 'LinkedIn',
    city: 'Stockholm',
    country: 'Sweden',
    // Signed when this page was served, already expired by the time we download it.
    resume: signed('7c1e0a/resume.pdf', 'stale'),
    'resume-updated-at': '2025-02-03T09:12:07.000+01:00',
  }),
  candidate('3', {
    'created-at': '2025-01-10T08:00:00.000+01:00',
    email: 'oskar.berg@example.test',
    'first-name': 'Oskar',
    'last-name': 'Berg',
    referred: true,
    resume: signed('9a2b44/oskar-berg-cv.pdf', 'pdf1'),
    'original-resume': signed('9a2b44/oskar-berg-cv.docx', 'orig1'),
  }),
  candidate('446', {
    'created-at': '2025-03-20T12:00:00.000+01:00',
    email: 'lina.holm@acme-farming.test',
    'first-name': 'Lina',
    'last-name': 'Holm',
    'referring-site': 'Intranet',
    internal: true,
  }),
  // A Connect sign-up with no application at all, whose processing is restricted.
  candidate('500', {
    'created-at': '2025-03-25T09:00:00.000+01:00',
    email: 'sofia.lind@example.test',
    'first-name': 'Sofia',
    'last-name': 'Lind',
    connected: true,
    'restricted-at': '2025-04-01T10:00:00.000+02:00',
  }),
];
const candidateById = Object.fromEntries(candidates.map((c) => [c.id as string, c]));

// ---------- custom fields: definitions, options, and the candidates' values ----------

const customField = (type: string, id: string, name: string, fieldType: string) =>
  res(type, id, { 'api-name': name.toLowerCase().replace(/ /g, '-'), name, 'field-type': fieldType, 'created-at': '2024-11-04T10:16:06.960+01:00', 'updated-at': '2024-11-04T10:16:06.960+01:00' }, {
    'custom-field-values': undefined,
    ...(type === 'custom-field-selects' ? { 'custom-field-options': undefined } : {}),
  });
const customFields = [
  customField('custom-fields', '1', 'Notice period', 'CustomField::Text'),
  customField('custom-field-selects', '2', 'Languages', 'CustomField::MultiSelect'),
  customField('custom-field-selects', '3', 'Preferred office', 'CustomField::Select'),
  customField('custom-fields', '4', 'Work permit', 'CustomField::Checkbox'),
];
const customFieldById = Object.fromEntries(customFields.map((f) => [f.id as string, f]));
const option = (id: string, fieldId: string, value: string) => res('custom-field-options', id, { value }, { 'custom-field': to('custom-field-selects', fieldId) });
const optionsByField: Record<string, Json[]> = {
  '2': [option('6', '2', 'Swedish'), option('7', '2', 'English')],
  '3': [option('8', '3', 'Stockholm'), option('9', '3', 'Gothenburg')],
};
const fieldValue = (id: string, fieldId: string, value: unknown, ownerId: string) =>
  res('custom-field-values', id, { 'field-type': (customFieldById[fieldId].attributes as Json)['field-type'], value }, {
    'custom-field': linkOf(customFieldById[fieldId]),
    owner: to('candidates', ownerId),
  });
const valuesByCandidate: Record<string, Json[]> = {
  '1': [fieldValue('1', '1', '3 months', '1'), fieldValue('2', '2', ['6', '7'], '1'), fieldValue('3', '4', true, '1')],
  '500': [fieldValue('4', '3', '8', '500')], // Select: the value is the option id
};
const fieldOf = (v: Json) => customFieldById[relOf(v, 'custom-field')!.id];

function application(id: string, candidateId: string, jobId: string, stageId: string, attrs: Json, reasonId: string | null = null) {
  return res(
    'job-applications',
    id,
    {
      'cover-letter': null,
      'referring-site': null,
      'referring-url': null,
      'rejected-at': null,
      sourced: false,
      'row-order': 0,
      ...attrs,
    },
    {
      candidate: to('candidates', candidateId),
      job: to('jobs', jobId),
      stage: to('stages', stageId),
      'reject-reason': reasonId ? to('reject-reasons', reasonId) : null,
    },
  );
}

const applications = [
  application('1', '1', '23', '3', {
    'created-at': '2025-03-03T09:00:00.000+01:00',
    'updated-at': '2025-03-12T14:30:00.000+01:00',
    'changed-stage-at': '2025-03-12T14:30:00.000+01:00',
    sourced: true,
  }),
  application(
    '2',
    '2',
    '23',
    '2',
    {
      'cover-letter': 'I have been following your team for years…',
      'created-at': '2025-02-03T09:12:08.120+01:00',
      'referring-site': 'LinkedIn',
      'referring-url': 'https://www.linkedin.com/',
      'rejected-at': '2025-02-20T16:40:11.902+01:00',
      'updated-at': '2025-02-20T16:40:11.902+01:00',
      'changed-stage-at': '2025-02-10T11:03:44.310+01:00',
    },
    '2',
  ),
  application('3', '3', '24', '8', {
    'created-at': '2025-01-10T08:00:00.000+01:00',
    'updated-at': '2025-02-01T09:00:00.000+01:00',
    'changed-stage-at': '2025-02-01T09:00:00.000+01:00',
  }),
  application('4', '446', '23', '1', {
    'created-at': '2025-03-20T12:05:00.000+01:00',
    'updated-at': '2025-03-20T12:05:00.000+01:00',
    'changed-stage-at': '2025-03-20T12:05:00.000+01:00',
  }),
  // Mariann again, twelve days after she arrived, for the Sales Lead job: still in its Inbox.
  application('5', '1', '24', '6', {
    'created-at': '2025-03-15T10:00:00.000+01:00',
    'updated-at': '2025-03-15T10:00:00.000+01:00',
    'changed-stage-at': '2025-03-15T10:00:00.000+01:00',
  }),
];

/** A page of candidates as `include=job-applications,custom-field-values,custom-field-values.custom-field` returns it. */
function candidatesPage(list: Json[], includes: Set<string>): PageDoc {
  const included: Json[] = [];
  const data = list.map((c) => {
    let out = c;
    if (includes.has('job-applications')) {
      const apps = applications.filter((a) => relOf(a, 'candidate')!.id === c.id);
      out = withData(out, 'job-applications', apps.map(linkOf));
      included.push(...apps);
    }
    if (includes.has('custom-field-values')) {
      const values = valuesByCandidate[c.id as string] ?? [];
      out = withData(out, 'custom-field-values', values.map(linkOf));
      included.push(...values);
      if (includes.has('custom-field-values.custom-field')) included.push(...values.map(fieldOf));
    }
    return out;
  });
  return { data, included: unique(included) };
}

/** A page of applications with whatever `include` asked for, nested paths included. */
function applicationsPage(apps: Json[], includes: Set<string>): PageDoc {
  const included: Json[] = [];
  for (const app of apps) {
    if (includes.has('candidate')) {
      let c = candidateById[relOf(app, 'candidate')!.id];
      if (includes.has('candidate.custom-field-values')) {
        const values = valuesByCandidate[c.id as string] ?? [];
        c = withData(c, 'custom-field-values', values.map(linkOf));
        included.push(...values);
        if (includes.has('candidate.custom-field-values.custom-field')) included.push(...values.map(fieldOf));
      }
      included.push(c);
    }
    if (includes.has('job')) {
      const jobId = relOf(app, 'job')!.id;
      let j = jobById[jobId];
      if (includes.has('job.user')) {
        j = withData(j, 'user', to('users', recruiterOf[jobId]));
        included.push(userById[recruiterOf[jobId]]);
      }
      included.push(j);
    }
    if (includes.has('stage')) {
      const s = stageById[relOf(app, 'stage')!.id];
      included.push(s);
      if (includes.has('stage.stage-type')) included.push(stageTypeById[relOf(s, 'stage-type')!.id]);
    }
    const reason = relOf(app, 'reject-reason');
    if (includes.has('reject-reason') && reason) included.push(reasonById[reason.id]);
  }
  return { data: apps, included: unique(included) };
}

const movement = (id: string, appId: string, from: number | null, to_: number, at: string, rejected = false) =>
  res(
    'movements',
    id,
    { 'created-at': at, 'updated-at': at, 'from-stage-id': from, 'to-stage-id': to_, 'is-rejected': rejected },
    { 'job-application': to('job-applications', appId), 'from-stage': undefined, 'to-stage': undefined },
  );

const movements: Record<string, Json[]> = {
  '1': [
    movement('9002', '1', 2, 3, '2025-03-12T14:30:00.000+01:00'),
    movement('9001', '1', 1, 2, '2025-03-05T10:00:00.000+01:00'),
  ],
  '2': [
    movement('9003', '2', 1, 2, '2025-02-10T11:03:44.310+01:00'),
    movement('9004', '2', 2, 2, '2025-02-20T16:40:11.902+01:00', true), // the rejection keeps the stage
  ],
  '3': [movement('9005', '3', 6, 7, '2025-01-15T10:00:00.000+01:00'), movement('9006', '3', 7, 8, '2025-02-01T09:00:00.000+01:00')],
  '4': [],
  '5': [],
};

const interview = (id: string, candidateId: string, userId: string, note: string | null, status: string, at: string) =>
  res('interviews', id, { 'created-at': at, note, status }, {
    candidate: to('candidates', candidateId),
    job: to('jobs', '23'),
    user: to('users', userId),
    'scorecard-scores': undefined,
    answers: undefined,
  });

const interviews = [
  interview('1', '1', '1', 'Strong systems thinking; would hire.', 'published', '2025-03-12T16:00:00.000+01:00'),
  interview('2', '2', '4', 'Needs a second conversation about salary expectations.', 'published', '2025-02-12T10:00:00.000+01:00'),
  interview('3', '1', '5', 'Half-written thoughts', 'draft', '2025-03-13T09:00:00.000+01:00'),
];

const score = (id: string, value: number, criterion: string) =>
  res('scorecard-scores', id, { 'created-at': '2025-03-12T16:00:00.000+01:00', score: value }, {
    user: to('users', '1'),
    candidate: to('candidates', '1'),
    'scorecard-pick': undefined,
    'scorecard-criterium': to('scorecard-criteria', criterion),
    interview: to('interviews', '1'),
  });
const criteria = [res('scorecard-criteria', '1', { name: 'Communicative' }), res('scorecard-criteria', '3', { name: 'Tech-savvy' })];
const scoresByInterview: Record<string, Json[]> = { '1': [score('1', 4, '1'), score('2', 5, '3')] };

const question = res('questions', '5', { 'question-type': 'Text', title: 'What did you like about the candidate?' });
const answersByInterview: Record<string, Json[]> = {
  '1': [
    res(
      'answers',
      '10',
      { answer: 'Clear, structured answers.', boolean: null, choices: [], 'created-at': '2025-03-12T16:00:00.000+01:00', 'question-type': 'text', text: 'Clear, structured answers.' },
      { question: to('questions', '5'), candidate: undefined },
    ),
  ],
};

/** Interviews as `include=candidate,job,user,scorecard-scores.scorecard-criterium,answers.question` returns them. */
function interviewsPage(includes: Set<string>): PageDoc {
  const included: Json[] = [candidates[0], candidates[1], farmingDesigner, ...users];
  const data = interviews.map((iv) => {
    let out = iv;
    const id = iv.id as string;
    if (includes.has('scorecard-scores')) {
      const scores = scoresByInterview[id] ?? [];
      out = withData(out, 'scorecard-scores', scores.map(linkOf));
      included.push(...scores);
      if (includes.has('scorecard-scores.scorecard-criterium')) included.push(...criteria);
    }
    if (includes.has('answers')) {
      const answers = answersByInterview[id] ?? [];
      out = withData(out, 'answers', answers.map(linkOf));
      included.push(...answers);
      if (includes.has('answers.question') && answers.length) included.push(question);
    }
    return out;
  });
  return { data, included: unique(included) };
}

/** Notes use the post-20240904 `data` envelope, relative links, and integer foreign keys. */
const note = (id: string, attrs: Json) => ({
  id,
  type: 'notes',
  links: { self: `/v1/notes/${id}` },
  attributes: {
    'created-at': '2025-03-10T10:32:41.110+01:00',
    'created-by-trigger': false,
    'mentioned-user-ids': [],
    'private-note': false,
    'updated-at': '2025-03-10T10:32:41.110+01:00',
    ...attrs,
  },
  relationships: {
    candidate: { links: { self: `/v1/notes/${id}/relationships/candidate`, related: `/v1/notes/${id}/candidate` } },
    user: { links: { self: `/v1/notes/${id}/relationships/user`, related: `/v1/notes/${id}/user` } },
  },
});

const notes = [
  note('74', { note: 'Great culture add — keep warm for ops roles.', 'candidate-id': 446, 'user-id': 4 }),
  note('78', { note: 'Excellent portfolio review.', rating: 5, 'candidate-id': 1, 'user-id': 1, 'job-application-id': 1 }),
  note('79', { note: 'Portfolio lacks depth.', rating: 2, 'candidate-id': 2, 'user-id': 5, 'job-application-id': 2 }),
  note('80', { note: 'Salary history (private)', 'private-note': true, 'candidate-id': 1, 'user-id': 1, 'job-application-id': 1 }),
  note('81', { note: '<p>Signed the contract &amp; starts in May.</p>', 'candidate-id': 3, 'user-id': 1, 'job-application-id': 3 }),
  note('82', { note: 'Asked for a relocation package.', 'candidate-id': 1, 'user-id': 99, 'job-application-id': 1 }),
  note('83', { note: 'Solid references.', rating: 4, 'candidate-id': 3, 'user-id': 1 }), // candidate review
  note('84', { note: 'Met at the Farming Expo; keen on design roles.', 'candidate-id': 500, 'user-id': 5 }),
  note('85', { note: 'Brilliant case study.', rating: 5, 'candidate-id': 500, 'user-id': 1 }),
];

const referral = res(
  'referrals',
  '1',
  {
    comment: 'A promising candidate we should give a call!',
    'created-at': '2025-01-09T10:39:11.769+01:00',
    email: 'oskar.berg@example.test',
    name: 'Oskar Berg',
    phone: '+4670123123',
  },
  { candidate: to('candidates', '3'), department: undefined, job: to('jobs', '24'), role: undefined, user: to('users', '4') },
);

const offers = [
  res(
    'job-offers',
    '0ff40f56-09c1-459a-9dd0-b0146890f5a0',
    {
      'created-at': '2025-01-27T17:51:19.901+01:00',
      'sent-at': '2025-01-28T09:52:34.575+01:00',
      'answered-at': '2025-01-30T11:00:00.000+01:00',
      response: 'Happy to accept!',
      status: 'accepted',
      details: {
        'acceptance-message': '<p>We are excited to work with you! We will contact you soon.</p>',
        'rejection-message': '<p>Sorry for rejecting the offer. We will contact you soon.</p>',
        salary: '62 000 $ / year',
        'start-date': '2025-04-01',
      },
    },
    { user: undefined, 'job-application': to('job-applications', '3') },
  ),
  res(
    'job-offers',
    '1c434431-86b3-4f10-a1d1-192d7fb8cdf4',
    {
      'created-at': '2025-03-13T10:46:54.601+01:00',
      'sent-at': null,
      'answered-at': null,
      response: null,
      status: 'pending',
      'approval-status': 'pending',
      details: {
        acceptance_message: '<p>We are excited to work with you! We will contact you soon.</p>',
        rejection_message: '<p>Sorry for rejecting the offer. We will contact you soon.</p>',
        salary: '50 000 $/mo',
        start_date: '2025-05-01',
      },
    },
    { user: undefined, 'job-application': to('job-applications', '1') },
  ),
];

const uploads = [
  // Uploaded for the Sales Lead application.
  res(
    'uploads',
    '1',
    { url: signed('5d50ed1119b303291941e65fb3de88df31a02581', 'up1', 60), 'file-name': 'portfolio.pdf', internal: false },
    { candidate: to('candidates', '3'), job: to('jobs', '24'), answer: undefined },
  ),
  // The resume Karima applied with, listed again among her uploads (the docs' only sample upload is a resume.pdf).
  res(
    'uploads',
    '2',
    { url: signed('e0a17c2b9d', 'up2', 60), 'file-name': 'resume.pdf', internal: false },
    { candidate: to('candidates', '2'), job: to('jobs', '23'), answer: undefined },
  ),
  // Uploaded for Mariann's Farming Designer application, though she has applied again since.
  res(
    'uploads',
    '4',
    { url: signed('c7d2e1f0', 'up4', 60), 'file-name': 'portfolio-mariann.pdf', internal: false },
    { candidate: to('candidates', '1'), job: to('jobs', '23'), answer: undefined },
  ),
  // A recruiter's upload on the Connect candidate, who has no application.
  res(
    'uploads',
    '3',
    { url: signed('b41c09e2', 'up3', 60), 'file-name': 'case-study.pdf', internal: true },
    { candidate: to('candidates', '500'), job: null, answer: undefined },
  ),
];

// ---------- the mock API ----------

function vendor(overrides: Record<string, RouteHandler> = {}) {
  /** Every links.next we hand out, to prove the adapter follows them verbatim. */
  const emitted: string[] = [];

  /**
   * Serve `pages` with offset links, cursor links, only `meta` counts, or no
   * meta/links at all. `serveAs` rewrites the links in the body (relative, or
   * another host) while `emitted` keeps the URL the adapter should end up requesting.
   */
  function list(pages: PageDoc[], style: 'offset' | 'cursor' | 'meta' | 'bare', serveAs: (href: string) => string = (h) => h): RouteHandler {
    const tokens = pages.map((_, i) => Buffer.from(String((i + 1) * 30)).toString('base64url'));
    return ({ url }) => {
      const index =
        style === 'offset' || style === 'meta'
          ? Number(url.searchParams.get('page[number]') ?? '1') - 1
          : style === 'cursor' && url.searchParams.get('page[after]')
            ? tokens.indexOf(url.searchParams.get('page[after]')!) + 1
            : 0;
      const page = pages[index] ?? { data: [] };
      const body: Json = { data: page.data, ...(page.included ? { included: page.included } : {}) };
      const total = pages.reduce((n, p) => n + p.data.length, 0);
      const meta = { 'record-count': total, 'page-count': pages.length };
      if (style === 'bare') return json(body, { headers: { 'content-type': 'application/vnd.api+json' } });
      if (style === 'meta') return json({ ...body, meta }, { headers: { 'content-type': 'application/vnd.api+json' } });
      const link = (param: string, value: string) => {
        const u = new URL(url.href);
        u.searchParams.set(param, value);
        return u.href;
      };
      const links: Record<string, string> = {};
      const hasNext = index + 1 < pages.length;
      if (style === 'offset') {
        links.first = link('page[number]', '1');
        if (hasNext) links.next = link('page[number]', String(index + 2));
        links.last = link('page[number]', String(pages.length));
      } else if (hasNext) {
        links.next = link('page[after]', tokens[index]);
      }
      if (links.next) emitted.push(links.next);
      for (const k of Object.keys(links)) links[k] = serveAs(links[k]);
      return json(
        { ...body, meta, ...(Object.keys(links).length ? { links } : {}) },
        { headers: { 'content-type': 'application/vnd.api+json', 'x-rate-limit-limit': '50', 'x-rate-limit-remaining': '49', 'x-rate-limit-reset': '7' } },
      );
    };
  }

  const one = (data: Json | null, included?: Json[]) => () => json({ data, ...(included ? { included } : {}) });
  const bytes = (body: string, contentType: string) => () =>
    new Response(body, { status: 200, headers: { 'content-type': contentType, 'content-length': String(body.length) } });

  const routes: Record<string, RouteHandler> = {
    [`GET ${HOST}/v1/company`]: one(
      res('companies', 'ZPXFT2VMtr8', { locale: 'en', website: 'https://acme-farming.test', name: 'Acme Farming AB' }, { manager: undefined }),
    ),
    [`GET ${HOST}/v1/users`]: list([{ data: users.slice(0, 2) }, { data: users.slice(2) }], 'offset'),
    [`GET ${HOST}/v1/stages`]: list(
      [
        { data: stages.slice(0, 5), included: stageTypes },
        { data: stages.slice(5), included: [stageTypes[0], stageTypes[1], stageTypes[4]] },
      ],
      'offset',
    ),
    // The API reference's own examples link to its dev host; paging must stay on ours.
    [`GET ${HOST}/v1/reject-reasons`]: list([{ data: [reasons[0]] }, { data: [reasons[1]] }], 'offset', (h) =>
      h.replace(`https://${HOST}`, 'http://api.teamtailor.localhost'),
    ),
    [`GET ${HOST}/v1/requisitions`]: list([{ data: [requisition] }], 'offset'),
    [`GET ${HOST}/v1/jobs`]: (req) =>
      list(
        req.url.searchParams.get('filter[feed]') === 'internal'
          ? [{ data: [internalOps, farmingDesigner], included: [departments[0], stockholm, requisition] }]
          : [{ data: [farmingDesigner, salesLead, template], included: [...departments, stockholm, requisition] }],
        'offset',
      )(req),
    [`GET ${HOST}/v1/candidates`]: (req) => {
      const includes = includesOf(req.url);
      return list([candidatesPage(candidates.slice(0, 2), includes), candidatesPage(candidates.slice(2), includes)], 'cursor')(req);
    },
    // Re-signing Karima's resume: the detail route hands out a fresh link.
    [`GET ${HOST}/v1/candidates/2`]: one(
      candidate('2', { ...(candidates[1].attributes as Json), resume: signed('7c1e0a/resume.pdf', 'fresh') }),
    ),
    [`GET ${HOST}/v1/job-applications`]: (req) => {
      const includes = includesOf(req.url);
      return list([applicationsPage(applications.slice(0, 2), includes), applicationsPage(applications.slice(2), includes)], 'offset')(req);
    },
    // jsonapi-resources reads a comma-separated filter as "any of".
    [`GET ${HOST}/v1/movements`]: ({ url }) => {
      const ids = (url.searchParams.get('filter[job-application]') ?? '').split(',').filter(Boolean);
      const data = ids.flatMap((id) => movements[id] ?? []);
      return json({
        data,
        included: ids.filter((id) => movements[id]?.length).map((id) => res('job-applications', id, { 'created-at': null })),
        meta: { 'record-count': data.length, 'page-count': 1 },
      });
    },
    [`GET ${HOST}/v1/interviews`]: (req) => list([interviewsPage(includesOf(req.url))], 'cursor')(req),
    // Per-interview routes: the fallback when the interviews list refuses the richer include.
    [`GET ${HOST}/v1/interviews/1/scorecard-scores`]: list([{ data: scoresByInterview['1'], included: criteria }], 'cursor'),
    [`GET ${HOST}/v1/interviews/2/scorecard-scores`]: list([{ data: [] }], 'cursor'),
    [`GET ${HOST}/v1/interviews/1/answers`]: list([{ data: answersByInterview['1'], included: [question] }], 'bare'),
    [`GET ${HOST}/v1/interviews/2/answers`]: list([{ data: [] }], 'bare'),
    // Notes links are relative (`/v1/notes/74`), paging links included.
    [`GET ${HOST}/v1/notes`]: list([{ data: notes.slice(0, 4) }, { data: notes.slice(4) }], 'offset', (h) => h.replace(`https://${HOST}`, '')),
    [`GET ${HOST}/v1/users/4`]: one(users[1]),
    [`GET ${HOST}/v1/users/5`]: one(users[2]),
    [`GET ${HOST}/v1/users/99`]: () => jsonApiError(404, 'Record not found'),
    [`GET ${HOST}/v1/referrals`]: list([{ data: [referral], included: [candidates[2], salesLead, users[1]] }], 'offset'),
    [`GET ${HOST}/v1/custom-field-options`]: (req) =>
      list([{ data: optionsByField[req.url.searchParams.get('filter[custom-field]') ?? ''] ?? [] }], 'offset')(req),
    [`GET ${HOST}/v1/job-offers`]: list([{ data: offers, included: [applications[2], applications[0]] }], 'offset'),
    [`GET ${HOST}/v1/uploads`]: list(
      [{ data: uploads, included: [candidates[2], candidates[1], candidates[0], candidates[4], salesLead, farmingDesigner] }],
      'offset',
    ),

    // Pre-signed S3 objects. An expired signature gets S3's 403.
    [`GET ${S3}/uploads/7c1e0a/resume.pdf`]: ({ url }) =>
      url.searchParams.get('X-Amz-Signature') === 'stale'
        ? new Response('<Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>', {
            status: 403,
            headers: { 'content-type': 'application/xml' },
          })
        : bytes('%PDF-1.4 Karima Mann resume', 'application/pdf')(),
    [`GET ${S3}/uploads/9a2b44/oskar-berg-cv.docx`]: bytes(
      'PK fake docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ),
    [`GET ${S3}/uploads/5d50ed1119b303291941e65fb3de88df31a02581`]: bytes('%PDF-1.4 portfolio', 'application/pdf'),
    [`GET ${S3}/uploads/b41c09e2`]: bytes('%PDF-1.4 case study', 'application/pdf'),
    [`GET ${S3}/uploads/c7d2e1f0`]: bytes('%PDF-1.4 Mariann portfolio', 'application/pdf'),
  };

  // Each candidate's own lists: applications (to place interviews, reviews, referrals and
  // uploads) and custom-field values (when the applications list refuses to include them).
  for (const c of candidates) {
    const id = c.id as string;
    const apps = applications.filter((a) => relOf(a, 'candidate')!.id === id);
    routes[`GET ${HOST}/v1/candidates/${id}/job-applications`] = list(
      [{ data: apps, included: unique(apps.map((a) => jobById[relOf(a, 'job')!.id])) }],
      'offset',
    );
    const values = valuesByCandidate[id] ?? [];
    routes[`GET ${HOST}/v1/candidates/${id}/custom-field-values`] = list([{ data: values, included: unique(values.map(fieldOf)) }], 'offset');
  }

  return { routes: { ...routes, ...overrides }, emitted };
}

const credentials = { apiKey: KEY, region: 'eu' };

/** An opportunity by its Teamtailor application id (or `lead:<candidate>`). */
async function opportunities(orgId: string) {
  const opps = await db.opportunity.findMany({
    where: { orgId },
    include: { stage: true, posting: true, archiveReason: true, stageTransitions: { orderBy: { occurredAt: 'asc' }, include: { toStage: true } } },
  });
  return (id: string) => opps.find((o) => (o.customFields as { imported: { id: string } }).imported.id === id)!;
}

const fieldsOf = (o: { customFields: unknown }) => (o.customFields as { imported: { fields?: Record<string, string> } }).imported.fields ?? {};
const transitions = (o: { stageTransitions: { toStage: { name: string }; occurredAt: Date }[] }) =>
  o.stageTransitions.map((t) => [t.toStage.name, t.occurredAt.toISOString()]);

// ---------- tests ----------

describe.skipIf(!hasDb)('teamtailor mapping helpers', () => {
  it('maps 1–5 scores and stars onto the 1–4 scale', () => {
    expect([1, 2, 3, 4, 5].map((n) => toRating(n))).toEqual([1, 2, 3, 3, 4]);
    expect(toRating(4.5)).toBe(4);
    expect(toRating(null)).toBeNull();
  });

  it('parses free-text offer salaries only when amount, currency and period are clear', () => {
    expect(parseSalary('62 000 $ / year')).toEqual({ amount: 62000, currency: 'USD' });
    expect(parseSalary('50 000 $/mo')).toEqual({ amount: 600000, currency: 'USD' });
    expect(parseSalary('SEK 45,000 per month')).toEqual({ amount: 540000, currency: 'SEK' });
    expect(parseSalary('€ 75.000')).toEqual({ amount: 75000, currency: 'EUR' });
    expect(parseSalary('45 000 kr/mån')).toBeNull(); // kr is SEK, NOK or DKK
    expect(parseSalary('$40/hour')).toBeNull();
  });

  it('never takes an abbreviation for a currency', () => {
    expect(parseSalary('DOE, around 60 000 EUR')).toEqual({ amount: 60000, currency: 'EUR' });
    expect(parseSalary('OTE 80,000 USD')).toEqual({ amount: 80000, currency: 'USD' });
    expect(parseSalary('CTC 12,00,000 INR')).toEqual({ amount: 1200000, currency: 'INR' });
    expect(parseSalary('TBD')).toBeNull();
    expect(parseSalary('CA$90,000')).toEqual({ amount: 90000, currency: 'CAD' });
  });

  it('annualizes monthly salaries written in European languages', () => {
    expect(parseSalary('4.500 € brutto/Monat')).toEqual({ amount: 54000, currency: 'EUR' });
    expect(parseSalary('EUR 4.500 pro Monat')).toEqual({ amount: 54000, currency: 'EUR' });
    expect(parseSalary('45 000 NOK/mnd')).toEqual({ amount: 540000, currency: 'NOK' });
    expect(parseSalary('3 500 €/kk')).toEqual({ amount: 42000, currency: 'EUR' });
    expect(parseSalary('€ 3.800 per maand')).toEqual({ amount: 45600, currency: 'EUR' });
    expect(parseSalary('5 000 EUR a month')).toEqual({ amount: 60000, currency: 'EUR' });
    expect(parseSalary('€4,500 pm')).toEqual({ amount: 54000, currency: 'EUR' });
  });

  it('gives up on hourly, weekly and unrecognized periods, and scales k/M amounts', () => {
    expect(parseSalary('40 USD an hour')).toBeNull();
    expect(parseSalary('USD 40 per hr')).toBeNull();
    expect(parseSalary('60 000 EUR per week')).toBeNull();
    expect(parseSalary('60 000 EUR pro rata')).toBeNull();
    expect(parseSalary('1.5M SEK')).toEqual({ amount: 1500000, currency: 'SEK' });
    expect(parseSalary('60k EUR')).toEqual({ amount: 60000, currency: 'EUR' });
  });
});

describe.skipIf(!hasDb)('teamtailor verify', () => {
  it('returns the company name, checks candidate access, and sends the documented auth headers', async () => {
    const { routes } = vendor();
    const api = mockFetch(routes);
    await expect(verifyForTest(teamtailorProvider, credentials, api.impl)).resolves.toEqual({ accountName: 'Acme Farming AB' });
    expect(api.calls.map((c) => c.url.href)).toEqual([
      'https://api.teamtailor.com/v1/company',
      'https://api.teamtailor.com/v1/candidates?page%5Bsize%5D=1',
    ]);
    for (const call of api.calls) {
      expect(call.headers.authorization).toBe(`Token token=${KEY}`);
      expect(call.headers['x-api-version']).toBe('20240904');
      expect(call.headers.accept).toBe('application/vnd.api+json');
    }
  });

  it('uses the regional host', async () => {
    const api = mockFetch({
      'GET api.na.teamtailor.com/v1/company': () => json({ data: res('companies', 'x1', { name: 'Maple Farms' }) }),
      'GET api.na.teamtailor.com/v1/candidates': () => json({ data: [], meta: { 'record-count': 0, 'page-count': 0 } }),
    });
    await expect(verifyForTest(teamtailorProvider, { apiKey: KEY, region: 'na' }, api.impl)).resolves.toEqual({ accountName: 'Maple Farms' });
    expect(api.unmatched).toEqual([]);
  });

  it('names the right region when the key belongs to another one', async () => {
    const api = mockFetch({
      'GET api.teamtailor.com/v1/company': empty401,
      'GET api.na.teamtailor.com/v1/company': () => json({ data: res('companies', 'x1', { name: 'Maple Farms' }) }),
    });
    await expect(verifyForTest(teamtailorProvider, credentials, api.impl)).rejects.toThrow(/North America/);
  });

  it('rejects a bad key', async () => {
    const api = mockFetch({
      'GET api.teamtailor.com/v1/company': empty401,
      'GET api.na.teamtailor.com/v1/company': empty401,
      'GET api.au.teamtailor.com/v1/company': empty401,
    });
    await expect(verifyForTest(teamtailorProvider, credentials, api.impl)).rejects.toBeInstanceOf(ImportAuthError);
  });

  it('asks for an Admin key when the key reads the company but not candidates', async () => {
    const { routes } = vendor({ [`GET ${HOST}/v1/candidates`]: () => new Response('', { status: 403 }) });
    const api = mockFetch(routes);
    await expect(verifyForTest(teamtailorProvider, credentials, api.impl)).rejects.toThrow(/cannot read candidates.*"Admin"/);
  });

  it('builds phases without credentials', () => {
    const adapter = teamtailorProvider.create({}, createHttpClient({ resolveHost: publicDns, auth: { hosts: [] }, minIntervalMs: 0 }));
    expect(adapter.discover.map((p) => p.id)).toEqual(['users', 'stages', 'reasons']);
    expect(adapter.load.map((p) => p.id)).toEqual([
      'requisitions',
      'postings',
      'candidates',
      'applications',
      'feedback',
      'notes',
      'referrals',
      'offers',
      'files',
    ]);
  });
});

describe.skipIf(!hasDb)('teamtailor import', () => {
  let orgId = '';

  it('imports the whole account', async () => {
    const { routes, emitted } = vendor();
    const api = mockFetch(routes);
    const result = await runImportForTest({ module: teamtailorProvider, credentials, fetchImpl: api.impl });
    orgId = result.orgId;

    expect(result.error).toBeNull();
    expect(result.status).toBe('SUCCEEDED');
    expect(api.unmatched).toEqual([]);
    expect(result.view.issues).toEqual([]);
    expect(result.view.created).toEqual({
      requisition: 1,
      posting: 3, // the template is skipped; the internal pass re-lists job 23 without duplicating it
      contact: 5,
      opportunity: 6, // five applications and one lead
      feedback: 6, // two interview write-ups (one without scores → note), four reviews (two of them candidate reviews)
      note: 5, // the private note is skipped; one is a referral
      offer: 2,
      file: 5, // two resumes and three attachments; the re-listed resume is not imported twice
    });

    // ---- requests ----
    const apiCalls = api.calls.filter((c) => c.url.host === HOST);
    expect(apiCalls.every((c) => c.headers.authorization === `Token token=${KEY}` && c.headers['x-api-version'] === '20240904')).toBe(true);
    const s3Calls = api.calls.filter((c) => c.url.host === S3);
    expect(s3Calls.length).toBeGreaterThan(0);
    for (const c of api.calls.filter((c) => c.url.host !== HOST)) {
      expect(c.headers.authorization).toBeUndefined();
      expect(Object.values(c.headers).join(' ')).not.toContain(KEY);
      expect(c.url.href).not.toContain(KEY);
    }
    // Explicit sort + max page size on every list we start; jobs override the published-only default.
    const firstJobs = apiCalls.find((c) => c.url.pathname === '/v1/jobs')!;
    expect(firstJobs.url.searchParams.get('sort')).toBe('id');
    expect(firstJobs.url.searchParams.get('page[size]')).toBe('30');
    expect(firstJobs.url.searchParams.get('filter[status]')).toBe('all');
    expect(apiCalls.some((c) => c.url.pathname === '/v1/jobs' && c.url.searchParams.get('filter[feed]') === 'internal')).toBe(true);
    // links.next is followed exactly as served (already percent-encoded, never re-encoded).
    expect(emitted.length).toBeGreaterThanOrEqual(4);
    for (const next of emitted) expect(api.calls.some((c) => c.url.href === next)).toBe(true);
    expect(emitted.some((n) => n.includes('/v1/candidates?') && n.includes('page%5Bafter%5D='))).toBe(true);
    expect(apiCalls.filter((c) => c.url.pathname === '/v1/candidates')).toHaveLength(2);
    expect(apiCalls.filter((c) => c.url.pathname === '/v1/job-applications')).toHaveLength(2);
    const firstApps = apiCalls.find((c) => c.url.pathname === '/v1/job-applications')!;
    expect(firstApps.url.searchParams.get('include')).toContain('job.user');
    // Stage history: one movements call per page of applications, not one per application.
    expect(apiCalls.filter((c) => c.url.pathname === '/v1/movements').map((c) => c.url.searchParams.get('filter[job-application]'))).toEqual([
      '1,2',
      '3,4,5',
    ]);
    // Scores and kit answers came included with the interviews: no per-interview calls.
    expect(apiCalls.filter((c) => c.url.pathname.startsWith('/v1/interviews/'))).toEqual([]);

    // ---- review ----
    const review = result.review!;
    const byKey = Object.fromEntries(review.stages.map((s) => [s.key, s]));
    expect(byKey['inbox']).toMatchObject({ count: 2, target: { create: { name: 'Inbox', type: 'APPLICANT' } } });
    expect(byKey['hired']).toMatchObject({ count: 2, target: { stageId: expect.any(String) } });
    expect(byKey['reviewing'].target).toEqual({ create: { name: 'Reviewing', type: 'SCREEN' } });
    expect(byKey['interview'].target).toEqual({ create: { name: 'Interview', type: 'ONSITE' } });
    expect(byKey['phone screen'].target).toHaveProperty('stageId');
    expect(byKey['offer'].target).toHaveProperty('stageId');
    expect(byKey['lead (imported)'].target).toEqual({ create: { name: 'Lead (imported)', type: 'LEAD' } });
    expect(review.reasons.map((r) => [r.name, r.kind])).toEqual([
      ['Not qualified', 'rejection'],
      ['Took another job', 'withdrawn'],
    ]);
    expect(review.users).toMatchObject({ total: 3, matched: 1 });
    const newStages = await db.stage.findMany({ where: { orgId, name: { in: ['Inbox', 'Reviewing', 'Interview'] } }, orderBy: { order: 'asc' } });
    expect(newStages.map((s) => s.name)).toEqual(['Inbox', 'Reviewing', 'Interview']);

    // ---- postings & requisitions ----
    const postings = await db.posting.findMany({ where: { orgId }, include: { department: true, requisition: true } });
    expect(postings.map((p) => p.title).sort()).toEqual(['Farming Designer', 'Internal Ops Coordinator', 'Sales Lead']);
    const designer = postings.find((p) => p.title === 'Farming Designer')!;
    expect(designer).toMatchObject({
      state: 'DRAFT',
      location: 'Stockholm, Sweden',
      workplaceType: 'HYBRID',
      commitment: 'FULL_TIME',
      salaryMin: 540000, // 45 000 SEK a month, annualized
      salaryMax: 660000,
      salaryCurrency: 'SEK',
      tags: ['design', 'product'],
    });
    expect(designer.department!.name).toBe('Product Development');
    expect(designer.requisition).toMatchObject({ code: 'TT-1', state: 'OPEN', openings: 2, salaryMin: 480000, salaryCurrency: 'SEK' });
    expect((designer.content as { description: string }).description).toBe(
      'Design the tools farmers use every day.\n\nAbout the role\n\nYou will own our field apps.\n\n• Figma\n• Research',
    );
    expect(designer.createdAt.toISOString()).toBe('2024-10-30T09:39:13.772Z');
    expect(postings.find((p) => p.title === 'Sales Lead')).toMatchObject({ state: 'CLOSED', workplaceType: 'REMOTE', commitment: 'PART_TIME' });
    expect(postings.find((p) => p.title === 'Internal Ops Coordinator')).toMatchObject({ state: 'DRAFT', commitment: 'CONTRACT' });

    // ---- candidates ----
    const contacts = await db.contact.findMany({ where: { orgId } });
    const contact = (name: string) => contacts.find((c) => c.name === name)!;
    expect(contact('Mariann Koch')).toMatchObject({
      emails: ['applicant1@example.test'],
      location: 'Mountain View, CA, United States',
      headline: 'Product designer who grew up on a farm',
      tags: ['Principal'],
    });
    expect(contact('Mariann Koch').createdAt.toISOString()).toBe('2025-03-03T07:54:04.573Z');
    expect(contact('Karima Mann')).toMatchObject({ phones: ['+46701234567'], links: ['https://www.linkedin.com/in/karima-mann'] });
    expect(contact('Sofia Lind').tags).toEqual(['Teamtailor: processing restricted']);

    // ---- applications ----
    const opp = await opportunities(orgId);

    const active = opp('1');
    // Sourced by a recruiter: the candidate's old referring site doesn't get the credit.
    expect(active).toMatchObject({ status: 'ACTIVE', origin: 'SOURCED', source: 'Sourced', archivedAt: null, ownerId: result.adminId });
    expect(active.stage.name).toBe('Interview');
    expect(active.posting!.title).toBe('Farming Designer');
    expect(active.createdAt.toISOString()).toBe('2025-03-03T08:00:00.000Z');
    expect(transitions(active)).toEqual([
      ['Inbox', '2025-03-03T08:00:00.000Z'],
      ['Reviewing', '2025-03-05T09:00:00.000Z'],
      ['Interview', '2025-03-12T13:30:00.000Z'],
    ]);
    expect(active.stageTransitions[0].fromStageId).toBeNull();
    expect(active.stageChangedAt.toISOString()).toBe('2025-03-12T13:30:00.000Z');
    expect(fieldsOf(active)).toEqual({ 'Notice period': '3 months', Languages: 'Swedish, English', 'Work permit': 'Yes' });

    const rejected = opp('2');
    expect(rejected).toMatchObject({ status: 'ARCHIVED', origin: 'APPLIED', source: 'LinkedIn', ownerId: result.adminId });
    expect(rejected.archivedAt!.toISOString()).toBe('2025-02-20T15:40:11.902Z');
    expect(rejected.archiveReason).toMatchObject({ name: 'Took another job', countsAsRejection: false });
    expect(rejected.stage.name).toBe('Reviewing'); // rejection keeps the stage
    expect(rejected.stageTransitions.map((t) => t.toStage.name)).toEqual(['Inbox', 'Reviewing']);
    expect(fieldsOf(rejected)).toEqual({ 'Cover letter': 'I have been following your team for years…', 'Referring URL': 'https://www.linkedin.com/' });

    const hired = opp('3');
    // The Sales Lead recruiter isn't a teammate in Source, so no owner.
    expect(hired).toMatchObject({ status: 'HIRED', origin: 'REFERRED', archiveReasonId: null, ownerId: null });
    expect(hired.stage.name).toBe('Hired');
    expect(hired.archivedAt).toBeNull();
    expect(hired.stageChangedAt.toISOString()).toBe('2025-02-01T08:00:00.000Z');
    expect(hired.stageTransitions.map((t) => t.toStage.name)).toEqual(['Inbox', 'Phone screen', 'Hired']);
    expect(hired.posting!.state).toBe('CLOSED');

    const inbox = opp('4');
    // No referring site of its own: the candidate's, since she arrived with this application.
    expect(inbox).toMatchObject({ status: 'ACTIVE', origin: 'INTERNAL', source: 'Intranet' });
    expect(inbox.stageTransitions.map((t) => t.toStage.name)).toEqual(['Inbox']);

    // Mariann's later application: her custom fields again, but not the referring site she arrived by.
    const second = opp('5');
    expect(second).toMatchObject({ status: 'ACTIVE', origin: 'SOURCED', source: null, ownerId: null });
    expect(second.stage.name).toBe('Inbox');
    expect(fieldsOf(second)).toEqual({ 'Notice period': '3 months', Languages: 'Swedish, English', 'Work permit': 'Yes' });

    // The Connect candidate, who never applied, gets a lead to hold her notes, review and files.
    const lead = opp('lead:500');
    expect(lead).toMatchObject({ status: 'ACTIVE', origin: 'APPLIED', postingId: null, ownerId: null });
    expect(lead.stage).toMatchObject({ name: 'Lead (imported)', type: 'LEAD' });
    expect(lead.contactId).toBe(contact('Sofia Lind').id);
    expect(transitions(lead)).toEqual([['Lead (imported)', '2025-03-25T08:00:00.000Z']]);
    expect(fieldsOf(lead)).toEqual({ 'Preferred office': 'Stockholm' });

    // ---- notes & feedback ----
    const allNotes = await db.note.findMany({ where: { orgId } });
    const bodies = allNotes.map((n) => n.body);
    expect(bodies).toEqual(
      expect.arrayContaining([
        `[${brand} · Former Recruiter] Great culture add — keep warm for ops roles.`, // unmatched author keeps a byline
        'Signed the contract & starts in May.', // HTML note, matched author
        `[${brand} · Former user] Asked for a relocation package.`, // author deleted in Teamtailor
        `[${brand} · Former Recruiter] Interview feedback\nNeeds a second conversation about salary expectations.`, // no scores → note
        `[${brand} · Former Recruiter] Referred for Sales Lead\nA promising candidate we should give a call!`,
      ]),
    );
    expect(bodies.some((b) => b.includes('private'))).toBe(false);
    // A candidate-level note lands on the candidate's latest application.
    const cultureNote = allNotes.find((n) => n.body.includes('Great culture'))!;
    expect(cultureNote.opportunityId).toBe(inbox.id);
    expect(cultureNote.createdAt.toISOString()).toBe('2025-03-10T09:32:41.110Z');
    expect(allNotes.find((n) => n.body.startsWith('Signed'))!.authorId).toBe(result.adminId);
    // …and for someone with no application, on their lead.
    expect(allNotes.find((n) => n.body.includes('Farming Expo'))).toMatchObject({
      opportunityId: lead.id,
      body: `[${brand} · Hanna Hiring] Met at the Farming Expo; keen on design roles.`,
    });
    expect(allNotes.find((n) => n.body.includes('Referred for'))!.opportunityId).toBe(hired.id);

    const feedback = await db.feedbackSubmission.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' } });
    expect(feedback).toHaveLength(5);
    const kit = feedback.find((f) => f.summary.includes('Strong systems thinking'))!;
    expect(kit).toMatchObject({ overallRating: 4, authorId: result.adminId, opportunityId: active.id, interviewId: null });
    expect(kit.summary).toBe('Interview feedback\nStrong systems thinking; would hire.');
    expect(Object.values(kit.answers as Record<string, { label: string; value: string }>).map((a) => [a.label, a.value])).toEqual([
      ['Communicative', '4/5'],
      ['Tech-savvy', '5/5'],
      ['What did you like about the candidate?', 'Clear, structured answers.'],
    ]);
    expect(feedback.find((f) => f.summary.includes('Excellent portfolio'))).toMatchObject({ overallRating: 4, opportunityId: active.id });
    const low = feedback.find((f) => f.summary.includes('Portfolio lacks depth'))!;
    expect(low).toMatchObject({ overallRating: 2, opportunityId: rejected.id });
    expect(low.summary).toBe(`[${brand} · Hanna Hiring] Review (2/5 stars)\nPortfolio lacks depth.`);
    // Candidate reviews are rated feedback too: on the latest application, or the lead.
    expect(feedback.find((f) => f.summary.includes('Solid references'))).toMatchObject({
      overallRating: 3,
      opportunityId: hired.id,
      summary: 'Review (4/5 stars)\nSolid references.',
    });
    expect(feedback.find((f) => f.summary.includes('Brilliant case study'))).toMatchObject({ overallRating: 4, opportunityId: lead.id });

    // ---- offers ----
    const allOffers = await db.offer.findMany({ where: { orgId } });
    const accepted = allOffers.find((o) => o.status === 'ACCEPTED')!;
    expect(accepted).toMatchObject({ opportunityId: hired.id, salaryAmount: 62000, salaryCurrency: 'USD', jobTitle: 'Sales Lead' });
    expect(accepted.startDate!.toISOString()).toBe('2025-04-01T00:00:00.000Z');
    expect(accepted.sentAt!.toISOString()).toBe('2025-01-28T08:52:34.575Z');
    expect(accepted.respondedAt!.toISOString()).toBe('2025-01-30T10:00:00.000Z');
    expect(accepted.notes).toBe('Salary: 62 000 $ / year\nCandidate response: Happy to accept!');
    // Awaiting approval in Teamtailor → a draft here (there's no approval request to act on).
    const pending = allOffers.find((o) => o.status === 'DRAFT')!;
    expect(pending).toMatchObject({ opportunityId: active.id, salaryAmount: 600000, jobTitle: 'Farming Designer', sentAt: null });
    expect(pending.startDate!.toISOString()).toBe('2025-05-01T00:00:00.000Z'); // snake_case details key

    // ---- files ----
    const karima = contact('Karima Mann');
    expect(karima.resumeFileId).not.toBeNull();
    const karimaResume = await db.storedFile.findUniqueOrThrow({ where: { id: karima.resumeFileId! } });
    expect(karimaResume).toMatchObject({ filename: 'resume.pdf', mime: 'application/pdf' });
    // The first link had expired: the adapter re-signed it through the candidate and retried.
    expect(api.calls.filter((c) => c.url.pathname === '/uploads/7c1e0a/resume.pdf').map((c) => c.url.searchParams.get('X-Amz-Signature'))).toEqual([
      'stale',
      'fresh',
    ]);
    expect(apiCalls.some((c) => c.url.pathname === '/v1/candidates/2')).toBe(true);
    const oskar = contact('Oskar Berg');
    const oskarResume = await db.storedFile.findUniqueOrThrow({ where: { id: oskar.resumeFileId! } });
    expect(oskarResume.filename).toBe('oskar-berg-cv.docx'); // the original upload beats the PDF rendition
    // Attachments hang off the application they were uploaded for, or the lead.
    const attachment = (name: string) => allNotes.find((n) => n.body.startsWith(`[${brand}] Attachment: ${name}`));
    expect(attachment('portfolio.pdf')?.opportunityId).toBe(hired.id);
    expect(attachment('portfolio-mariann.pdf')?.opportunityId).toBe(active.id); // not her newer application
    expect(attachment('case-study.pdf')?.opportunityId).toBe(lead.id);
    // Karima's resume, listed again among her uploads, is not stored a second time.
    expect(attachment('resume.pdf')).toBeUndefined();
    expect(s3Calls.some((c) => c.url.pathname.includes('e0a17c2b9d'))).toBe(false);
  });

  it('re-running into the same org creates nothing new', async () => {
    expect(orgId).not.toBe('');
    const { routes } = vendor();
    const api = mockFetch(routes);
    const result = await runImportForTest({ module: teamtailorProvider, credentials, fetchImpl: api.impl, orgId });
    expect(result.status).toBe('SUCCEEDED');
    expect(result.view.created).toEqual({});
    expect(api.unmatched).toEqual([]);
    // Already-imported records skip their fan-out: no history, scorecards, custom fields, lookups or downloads.
    const paths = api.calls.map((c) => c.url.pathname);
    expect(
      paths.filter(
        (p) =>
          p === '/v1/movements' ||
          p === '/v1/custom-field-options' ||
          p.startsWith('/v1/interviews/') ||
          p.startsWith('/v1/users/') ||
          /^\/v1\/candidates\/[^/]+\//.test(p),
      ),
    ).toEqual([]);
    expect(api.calls.filter((c) => c.url.host === S3)).toEqual([]);
    expect(await db.opportunity.count({ where: { orgId } })).toBe(6);
    expect(await db.contact.count({ where: { orgId } })).toBe(5);
  });

  it('degrades optional endpoints to warnings and filters by date server-side', async () => {
    const forbidden = () => new Response('', { status: 403 });
    const { routes } = vendor({
      [`GET ${HOST}/v1/requisitions`]: forbidden,
      [`GET ${HOST}/v1/job-offers`]: forbidden,
      [`GET ${HOST}/v1/interviews/1/scorecard-scores`]: forbidden,
    });
    // Interviews that refuse the nested include fall back to per-interview scores and answers.
    const interviewsRoute = routes[`GET ${HOST}/v1/interviews`];
    routes[`GET ${HOST}/v1/interviews`] = (req) =>
      includesOf(req.url).has('scorecard-scores') ? jsonApiError(400, 'scorecard-scores is not a valid includable relationship of interviews') : interviewsRoute(req);
    const api = mockFetch(routes);
    const result = await runImportForTest({
      module: teamtailorProvider,
      credentials,
      fetchImpl: api.impl,
      options: { since: '2025-02-01T00:00:00.000Z' },
    });
    expect(result.error).toBeNull();
    expect(result.status).toBe('SUCCEEDED');
    expect(api.unmatched).toEqual([]);

    const messages = result.view.issues.map((i) => i.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^Requisitions: .*permission.*\/v1\/requisitions/),
        expect.stringMatching(/^Offers: .*\/v1\/job-offers/),
        expect.stringMatching(/^Interview scorecards: /),
      ]),
    );
    for (const m of messages) expect(m).not.toContain(KEY);
    expect(result.view.created.requisition).toBeUndefined();
    expect(result.view.created.offer).toBeUndefined();
    expect(result.view.created.posting).toBe(3);

    for (const path of ['/v1/candidates', '/v1/job-applications']) {
      const first = api.calls.find((c) => c.url.pathname === path)!;
      expect(first.url.searchParams.get('filter[created-at][from]')).toBe('2025-02-01T00:00:00Z');
    }
    // Oskar (created 2025-01-10) and his hire predate `since`; Mariann's interview still imports, unrated.
    expect(await db.contact.count({ where: { orgId: result.orgId, name: 'Oskar Berg' } })).toBe(0);
    const kit = await db.note.findFirst({ where: { orgId: result.orgId, body: { contains: 'Strong systems thinking' } } });
    expect(kit?.body).toContain('What did you like about the candidate?: Clear, structured answers.');
  });

  it('imports only the active pipeline when archived applications are left out', async () => {
    const { routes } = vendor();
    const api = mockFetch(routes);
    const result = await runImportForTest({ module: teamtailorProvider, credentials, fetchImpl: api.impl, options: { archived: false } });
    expect(result.status).toBe('SUCCEEDED');
    expect(api.unmatched).toEqual([]);

    // Karima (rejected) and Oskar (hired) have no active application: no contact, no resume, no attachment.
    const contacts = await db.contact.findMany({ where: { orgId: result.orgId }, orderBy: { name: 'asc' } });
    expect(contacts.map((c) => c.name)).toEqual(['Lina Holm', 'Mariann Koch', 'Sofia Lind']);
    expect(result.view.created).toMatchObject({ contact: 3, opportunity: 4, file: 2 });
    const s3Paths = api.calls.filter((c) => c.url.host === S3).map((c) => c.url.pathname);
    expect(s3Paths.sort()).toEqual(['/uploads/b41c09e2', '/uploads/c7d2e1f0']);
    const opp = await opportunities(result.orgId);
    expect(opp('lead:500').stage.type).toBe('LEAD');
  });

  it('keeps applications and feedback when Teamtailor refuses what only enriches them', async () => {
    const { routes } = vendor({
      [`GET ${HOST}/v1/movements`]: () => jsonApiError(400, 'filter not allowed'),
      [`GET ${HOST}/v1/interviews/1/answers`]: () => jsonApiError(422, 'Unprocessable'),
    });
    const refuseNested = (key: string, nested: string) => {
      const route = routes[key];
      routes[key] = (req) => (includesOf(req.url).has(nested) ? jsonApiError(400, `${nested} is not a valid includable relationship`) : route(req));
    };
    refuseNested(`GET ${HOST}/v1/job-applications`, 'job.user');
    refuseNested(`GET ${HOST}/v1/interviews`, 'answers');
    const api = mockFetch(routes);
    const result = await runImportForTest({ module: teamtailorProvider, credentials, fetchImpl: api.impl });
    expect(result.status).toBe('SUCCEEDED');
    expect(api.unmatched).toEqual([]);
    expect(result.view.created).toMatchObject({ opportunity: 6, feedback: 6 });

    const messages = result.view.issues.map((i) => i.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^Stage history \(applications were imported without it\): .*\/v1\/movements → HTTP 400/),
        expect.stringMatching(/nested includes, so applications were imported without an owner/),
        expect.stringMatching(/^Interview kit answers: .*HTTP 422/),
      ]),
    );
    expect(messages.some((m) => m.startsWith('Skipped a record'))).toBe(false);

    const opp = await opportunities(result.orgId);
    // No movements: the current stage since it was entered. No owner without the job's recruiter.
    expect(transitions(opp('1'))).toEqual([['Interview', '2025-03-12T13:30:00.000Z']]);
    expect(opp('1').ownerId).toBeNull();
    expect(opp('3').status).toBe('HIRED'); // from the stage's legacy type when stage types aren't included
    // Custom fields came from the candidate's own list instead.
    expect(fieldsOf(opp('1'))).toMatchObject({ 'Notice period': '3 months', Languages: 'Swedish, English' });
    expect(api.calls.some((c) => c.url.pathname === '/v1/candidates/1/custom-field-values')).toBe(true);
    // The scorecard still rates the write-up; only the kit answers are missing.
    const kit = await db.feedbackSubmission.findFirstOrThrow({ where: { orgId: result.orgId, summary: { contains: 'Strong systems thinking' } } });
    expect(kit.overallRating).toBe(4);
    expect(Object.values(kit.answers as Record<string, { label: string }>).map((a) => a.label)).toEqual(['Communicative', 'Tech-savvy']);
  });

  it('checks a batched movements answer and asks again when the list filter kept only one id', async () => {
    const { routes } = vendor();
    const movementsRoute = routes[`GET ${HOST}/v1/movements`];
    routes[`GET ${HOST}/v1/movements`] = (req) => {
      const url = new URL(req.url.href);
      url.searchParams.set('filter[job-application]', (url.searchParams.get('filter[job-application]') ?? '').split(',')[0]);
      return movementsRoute({ ...req, url });
    };
    const api = mockFetch(routes);
    const result = await runImportForTest({ module: teamtailorProvider, credentials, fetchImpl: api.impl });
    expect(result.status).toBe('SUCCEEDED');

    // Application 2 moved but got no rows from the batch, so it was asked about on its own;
    // application 4 never left its Inbox, so its empty answer stands.
    expect(api.calls.filter((c) => c.url.pathname === '/v1/movements').map((c) => c.url.searchParams.get('filter[job-application]'))).toEqual([
      '1,2',
      '2',
      '3,4,5',
    ]);
    const opp = await opportunities(result.orgId);
    expect(opp('2').stageTransitions.map((t) => t.toStage.name)).toEqual(['Inbox', 'Reviewing']);
    expect(opp('3').stageTransitions.map((t) => t.toStage.name)).toEqual(['Inbox', 'Phone screen', 'Hired']);
  });

  it('tells a hire by its stage type when the stage has no legacy type name', async () => {
    const { routes } = vendor();
    const appsRoute = routes[`GET ${HOST}/v1/job-applications`];
    routes[`GET ${HOST}/v1/job-applications`] = async (req) => {
      const body = (await (await appsRoute(req)).json()) as { included?: Json[] };
      for (const r of body.included ?? []) if (r.type === 'stages') (r.attributes as Json)['legacy-stage-type-name'] = null;
      return json(body);
    };
    const api = mockFetch(routes);
    const result = await runImportForTest({ module: teamtailorProvider, credentials, fetchImpl: api.impl });
    expect(result.status).toBe('SUCCEEDED');
    const opp = await opportunities(result.orgId);
    expect(opp('3')).toMatchObject({ status: 'HIRED' });
    expect(opp('3').stageChangedAt.toISOString()).toBe('2025-02-01T08:00:00.000Z');
    expect(opp('1').status).toBe('ACTIVE');
  });

  it('keeps paging a list that counts more pages in meta but sends no links', async () => {
    const { routes } = vendor();
    // Notes' paging style is undocumented; the docs' own list example has neither meta nor links.
    const pages = [{ data: notes.slice(0, 4) }, { data: notes.slice(4) }];
    routes[`GET ${HOST}/v1/notes`] = ({ url }) => {
      const index = Number(url.searchParams.get('page[number]') ?? '1') - 1;
      return json({ data: pages[index]?.data ?? [], meta: { 'record-count': notes.length, 'page-count': pages.length } });
    };
    const api = mockFetch(routes);
    const result = await runImportForTest({ module: teamtailorProvider, credentials, fetchImpl: api.impl });
    expect(result.status).toBe('SUCCEEDED');
    expect(result.view.created).toMatchObject({ note: 5, feedback: 6 });
    const noteCalls = api.calls.filter((c) => c.url.pathname === '/v1/notes');
    expect(noteCalls.map((c) => c.url.searchParams.get('page[number]'))).toEqual([null, '2']);
  });
});
