import { randomUUID } from 'crypto';
import { describe, expect, it, vi } from 'vitest';
import { createHttpClient, ImportAuthError } from '@/server/imports/http';
import { db, json, mockFetch, runImportForTest, verifyForTest, type RouteHandler } from '@/server/imports/__tests__/harness';
import { hasDb, publicDns } from '@/server/imports/__tests__/harness';
import { jazzhrProvider } from '@/server/imports/providers/jazzhr';
import {
  DEFAULT_IMPORT_OPTIONS,
  type Cursor,
  type DownloadedFile,
  type ImportedApplication,
  type ImportedCandidate,
  type ImportedFeedback,
  type ImportedFile,
  type ImportedNote,
  type ImportOptions,
  type Loader,
  type PhaseContext,
  type RefKind,
} from '@/server/imports/types';

vi.mock('@/lib/session', () => ({ isAdmin: () => true }));
vi.mock('@/lib/import-providers', () => ({
  IMPORT_PROVIDERS: [],
  providerMeta: (id: string) =>
    id === 'jazzhr'
      ? { id: 'jazzhr', name: 'JazzHR', domain: 'jazzhr.com', blurb: '', imports: [], steps: [], docsUrl: '', fields: [{ key: 'apiKey', label: 'API key', kind: 'secret' }] }
      : undefined,
}));

/**
 * JazzHR adapter against a mock of api.resumatorapi.com built from the spec's
 * recorded/reconstructed payloads: string scalars, split date/time fields,
 * bare objects for single results, `/page/n` path paging that ends on `[]`,
 * the key only in `?apikey=`, and resume files on a pre-signed S3 host.
 */

const KEY = 'Qm7Tz2Lp9Xv4Rk8Wn3Hd6Jc1Fb5Gs0Ya';
const API = 'api.resumatorapi.com';
const FILES_HOST = 'jazzhr-candidate-files.s3.amazonaws.com';

const DANA = 'usr_20191016193456_DWYSYV1EX9WMEFZX';
const CHINEDU = 'usr_20211207134708_ZHM0KNCL45WO0X6T';
const PAT = 'usr_20200611102030_PF4RMERUSR8Q2XYZ';
const SAM = 'usr_20220301090000_EXT9RECRUITER0AB';

const JOB_PM = 'job_20220513171511_6LJEKRWOANZGQJVL';
const JOB_CS = 'job_20191016193456_XGSWRU2DDZPU9Y2T';
const JOB_BE = 'job_20230105120000_B4CKENDENGR2023Q';
const JOB_UK = 'job_20191017201346_RS8OXHY7X8MA9GO8';

const MARIA = 'prospect_20230214153012_K3J9QX2LMN8P4RTA';
const PRIYA = 'prospect_20230216091544_Z7Y6X5W4V3U2T1SR';
const JAMES = 'prospect_20221003081522_H7G6F5D4S3A2Q1WE';
const GHOST = 'prospect_20230301101010_GH0STGH0STGH0ST1';
const LENA = 'prospect_20230110140000_L3NAK0VALSK1Y8H2';
const NOAH = 'prospect_20230405111500_N0AHADAMS7Q2W3E4';
const OMAR = 'prospect_20230301090000_0MARFAR0UQ5T6Y7U';

const USERS = [
  { id: DANA, type: 'Super Admin', last_name: 'Whitfield', first_name: 'Dana', date_created: '2019-10-16', email: 'dana.whitfield@acmewidgets.com' },
  { id: CHINEDU, type: 'Recruiting User', last_name: 'Okafor', first_name: 'Chinedu', date_created: '2021-12-07', email: 'chinedu@acmewidgets.com' },
  { id: PAT, type: 'Deactivated', last_name: 'Former', first_name: 'Pat', date_created: '2020-06-11', email: 'pat.former@acmewidgets.com' },
  { id: SAM, type: 'External Recruiter', last_name: 'Reyes', first_name: 'Sam', date_created: '2022-03-01', email: 'sam@talentbridge.io' },
];

const WORKFLOWS = [
  {
    id: 'workflow_20250128193941_YPNPSVBH26PCAXZX',
    name: 'Standard Hiring Workflow',
    is_template: true,
    is_archived: false,
    steps: [
      { id: 4101, name: 'New', category: 'Active', number: 1 },
      { id: 4102, name: 'Reviewed', category: 'Active', number: 2 },
      { id: 4103, name: 'Phone Screen', category: 'Active', number: 3 },
      { id: 4104, name: 'Interview', category: 'Active', number: 4 },
      { id: 4105, name: 'Offer', category: 'Active', number: 5 },
      { id: 4106, name: 'Hired', category: 'Hired', number: 6 },
      { id: 4107, name: 'Not a Fit', category: 'Not Hired', number: -1 },
      { id: 4108, name: 'Declined Offer', category: 'Not Hired', number: -1 },
      { id: 4109, name: 'Hired Elsewhere', category: 'Not Hired', number: -1 },
    ],
  },
  {
    // A job-specific copy unlocked from the template.
    id: 'workflow_20250203101500_ENGWF7Q2M4X8C1VB',
    name: 'Engineering Workflow',
    is_template: false,
    is_archived: false,
    steps: [
      { id: 5201, name: 'New', category: 'Active', number: 1 },
      { id: 5202, name: 'Phone Screen', category: 'Active', number: 2 },
      { id: 5203, name: 'Technical Interview', category: 'Active', number: 3 },
      { id: 5204, name: 'Hired', category: 'Hired', number: 4 },
      { id: 5205, name: 'Not a Fit', category: 'Not Hired', number: -1 },
    ],
  },
];

const JOBS = [
  {
    id: JOB_PM,
    team_id: '',
    title: 'Engineering Project Manager - Payments',
    country_id: 'United States',
    city: 'Seattle',
    state: 'WA',
    zip: '',
    department: 'Payments',
    description:
      '<p style="margin-bottom:11px"><span style="font-size:12pt"><span style="font-family:&quot;Times New Roman&quot;,serif">We are looking for an Engineering Project Manager&nbsp;to lead&hellip;</span></span></p><ul><li>Own delivery</li></ul>',
    minimum_salary: '125000',
    maximum_salary: '175000',
    notes: 'Need two of these...',
    original_open_date: '2022-05-13',
    type: 'Full Time',
    status: 'Open',
    send_to_job_boards: 'Yes',
    hiring_lead: CHINEDU,
    board_code: 'yuuv4TkERK',
    internal_code: 'ENG-104',
    questionnaire: 'questionnaire_20220419200801_EPVAEMM2LIN1W7LR',
  },
  {
    id: JOB_CS,
    team_id: '',
    title: 'Customer Success Associate (Remote)',
    country_id: 'United States',
    city: 'Remote',
    state: '',
    zip: '',
    department: '',
    // Recorded quirk: the closing </p> is missing.
    description: '<p>You can enter a detailed, formatted description of your position.</p><p>We have a fully featured WYSIWYG editor',
    minimum_salary: '0',
    maximum_salary: '0',
    notes: '',
    original_open_date: '2019-10-16',
    type: 'Part Time',
    status: 'Filled',
    send_to_job_boards: 'No answer',
    hiring_lead: DANA,
    board_code: 'X8P7SBPn4N',
    internal_code: '',
    questionnaire: '0',
  },
  {
    id: JOB_BE,
    team_id: '',
    title: 'Senior Backend Engineer',
    country_id: 'United States',
    city: 'Pittsburgh',
    state: 'PA',
    zip: '15212',
    department: 'Engineering',
    description: '<p>Build the ledger.</p>',
    minimum_salary: '150000',
    maximum_salary: '190000',
    notes: '',
    original_open_date: '2023-01-05',
    type: 'Full Time',
    status: 'Open',
    send_to_job_boards: 'Yes',
    hiring_lead: DANA,
    board_code: 'Bk3nDeNg1R',
    internal_code: '',
    questionnaire: '0',
  },
  {
    // The recorded job with a non-empty internal code, outside the US (salaries composited).
    id: JOB_UK,
    team_id: '',
    title: 'Warehouse Associate (Seasonal)',
    country_id: 'United Kingdom',
    city: 'Manchester',
    state: '',
    zip: 'M1 1AE',
    department: 'Operations',
    description: '<p>Pick, pack and ship.</p>',
    minimum_salary: '24000',
    maximum_salary: '27000',
    notes: '',
    original_open_date: '2019-10-17',
    type: 'Seasonal',
    status: 'Drafting',
    send_to_job_boards: 'No answer',
    hiring_lead: '',
    board_code: 'Uk5eAs0nAl',
    internal_code: 'ABC-X1',
    questionnaire: '0',
  },
];

const row = (id: string, first: string, last: string, phone: string, applied: string, jobId: string, jobTitle: string) => ({
  id,
  first_name: first,
  last_name: last,
  prospect_phone: phone,
  apply_date: applied,
  job_id: jobId,
  job_title: jobTitle,
});

const MARIA_ROW = row(MARIA, 'Maria', 'Gonzalez', '(412) 555-0199', '2023-02-14', JOB_PM, 'Engineering Project Manager - Payments');
const PRIYA_ROW = row(PRIYA, 'Priya', 'Nair', '(206) 555-0142', '2023-02-16', JOB_BE, 'Senior Backend Engineer');
const JAMES_ROW = row(JAMES, 'James', 'Carter', '(503) 555-0110', '2022-10-03', JOB_PM, 'Engineering Project Manager - Payments');
const GHOST_ROW = row(GHOST, 'Deleted', 'Person', '', '2023-03-01', JOB_PM, 'Engineering Project Manager - Payments');

const detail = (base: ReturnType<typeof row>, extra: Record<string, unknown>) => ({
  id: base.id,
  first_name: base.first_name,
  last_name: base.last_name,
  email: '',
  address: '',
  location: '',
  phone: base.prospect_phone,
  linkedin_url: '',
  eeo_gender: null,
  eeo_race: null,
  eeo_disability: null,
  website: '',
  desired_salary: '0',
  desired_start_date: '',
  referrer: '',
  languages: '',
  wmyu: '',
  has_driver_license: 'No answer',
  willing_to_relocate: 'No answer',
  citizenship_status: 'No answer',
  education_level: '',
  has_cdl: 'No answer',
  over_18: 'No answer',
  can_work_weekends: 'No answer',
  can_work_evenings: 'No answer',
  can_work_overtime: 'No answer',
  has_felony: 'No answer',
  felony_explanation: '',
  twitter_username: '',
  college_gpa: '',
  college: '',
  references: '',
  notes: '',
  apply_date: base.apply_date,
  comments_count: '0',
  source: '',
  recruiter_id: '',
  eeoc_veteran: null,
  eeoc_disability: null,
  eeoc_disability_signature: null,
  eeoc_disability_date: null,
  rating: false,
  resume_body: '',
  resume_link: '',
  jobs: [],
  comments: [],
  feedback: [],
  activities: [],
  messages: [],
  questionnaire: [],
  evaluation: [],
  categories: [],
  ...extra,
});

const MARIA_DETAIL = detail(MARIA_ROW, {
  email: 'maria.gonzalez@example.com',
  address: '1200 Liberty Ave Apt 4',
  location: 'Pittsburgh, PA 15222',
  linkedin_url: 'https://www.linkedin.com/in/mariagonzalez',
  website: 'https://mariag.dev',
  desired_salary: '140000',
  desired_start_date: '2023-04-01',
  languages: 'English, Spanish',
  wmyu: 'I shipped a payments platform migration with zero downtime.',
  has_driver_license: 'Yes',
  citizenship_status: 'U.S. Citizen/Permanent Resident',
  education_level: 'College - Bachelor of Science',
  over_18: 'Yes',
  has_felony: 'Yes',
  twitter_username: 'mgonzalez',
  college_gpa: '3.7',
  college: 'University of Pittsburgh',
  comments_count: '2',
  source: 'LinkedIn',
  resume_body: 'MARIA GONZALEZ\r\nPittsburgh, PA\r\n\r\nEXPERIENCE\r\nSenior Project Manager, Payments (2019-present)',
  resume_link: 'https://app.jazz.co/app/v2/candidate/K3J9QX2LMN8P4RTA/resume',
  jobs: [
    {
      job_id: JOB_PM,
      hiring_lead_rating: '5',
      average_rating: '4.5',
      workflow_step_id: '4104',
      job_title: 'Engineering Project Manager - Payments',
      applicant_progress: 'Interview',
    },
  ],
  comments: [
    { id: '8812734', author_id: CHINEDU, author_name: 'Chinedu Okafor', text: 'Strong payments background. Moving to onsite.', date: '2023-02-20', time: '14:03:11' },
    { id: '8812799', author_id: PAT, author_name: 'Pat Former', text: '<p>Please loop me in before we extend an offer.</p>', date: '2023-02-22', time: '08:30:00' },
  ],
  feedback: [
    { id: '5520193', author_id: DANA, text: 'Great communicator, a bit light on team leadership.', date: '2023-02-22', time: '10:41:55', privacy: '0', is_external: '0' },
    { id: '5520194', author_id: PAT, text: 'Confidential comp concerns; do not share.', date: '2023-02-23', time: '09:12:00', privacy: '30', is_external: '0' },
  ],
  activities: [
    { id: 'activity_20230214153012_1AB2C3D4E5F6G7H8', activity: 'Maria Gonzalez applied to Engineering Project Manager - Payments', date: '2023-02-14', time: '15:30:12' },
    { id: 'activity_20230215101500_2BC3D4E5F6G7H8J9', activity: 'Chinedu Okafor emailed Maria Gonzalez', date: '2023-02-15', time: '10:15:00' },
    { id: 'activity_20230221090102_9ZY8X7W6V5U4T3S2', activity: 'Chinedu Okafor changed the status of Maria Gonzalez to Interview', date: '2023-02-21', time: '09:01:02' },
    { id: 'activity_20230216100000_3CD4E5F6G7H8J9K1', activity: 'Chinedu Okafor changed the status of Maria Gonzalez to Phone Screen', date: '2023-02-16', time: '10:00:00' },
  ],
  messages: [
    {
      comm_id: 'comm_20230215101500_QWERTYUIOPASDFGH',
      comm_subject: 'Next steps: Engineering Project Manager',
      comm_text: '<p>Hi Maria, thanks for applying. Are you free Thursday?</p>',
      comm_author_email: 'chinedu@acmewidgets.com',
      comm_to: 'maria.gonzalez@example.com',
      comm_cc: '',
      comm_bcc: '',
      comm_datetime_sent: '2023-02-15 10:15:00',
    },
  ],
  questionnaire: [
    { question: 'How many years of payments experience do you have?', answer: '7' },
    { question: 'Are you authorized to work in the US?', answer: 'Yes' },
  ],
  evaluation: [{ id: 'eval_20230223111111_ABCDEFGHJKLMNPQR', name: 'Technical depth', category: 'Skills', rating: '4', comment: 'Solid on ledger design.' }],
  categories: [
    { category_id: 'category_20220301120000_MNBVCXZLKJHGFDSA', name: 'Payments', date_created: '2022-03-01', status: '1' },
    { category_id: 'category_20210101120000_QAZWSXEDCRFVTGBY', name: 'Retired tag', date_created: '2021-01-01', status: '0' },
  ],
});

const PRIYA_DETAIL = detail(PRIYA_ROW, {
  email: 'Priya.Nair@Example.org',
  location: 'Seattle, WA',
  source: 'TalentBridge Agency',
  recruiter_id: SAM,
  jobs: [{ job_id: JOB_BE, hiring_lead_rating: '0', average_rating: '3.5', workflow_step_id: '5205', job_title: 'Senior Backend Engineer', applicant_progress: 'Not a Fit' }],
  // A single comment arrives as a bare object, not an array.
  comments: { id: '8813002', author_id: DANA, author_name: 'Dana Whitfield', text: 'Salary expectations well above band.', date: '2023-02-27', time: '10:58:00' },
  activities: [
    { id: 'activity_20230220134500_4DE5F6G7H8J9K1L2', activity: 'Dana Whitfield changed the status of Priya Nair to Phone Screen', date: '2023-02-20', time: '13:45:00' },
    { id: 'activity_20230227110000_5EF6G7H8J9K1L2M3', activity: 'Dana Whitfield changed the status of Priya Nair to Not a Fit.', date: '2023-02-27', time: '11:00:00' },
  ],
  feedback: null,
  evaluation: '',
});

const JAMES_DETAIL = detail(JAMES_ROW, {
  email: 'JCarter@Example.net',
  referrer: 'Dana Whitfield',
  source: 'Employee Referral',
  jobs: [
    { job_id: JOB_PM, hiring_lead_rating: '4', average_rating: '4', workflow_step_id: '4106', job_title: 'Engineering Project Manager - Payments', applicant_progress: 'Hired' },
    { job_id: JOB_BE, hiring_lead_rating: '3', average_rating: '3', workflow_step_id: '5201', job_title: 'Senior Backend Engineer', applicant_progress: 'New' },
  ],
  activities: [
    // With two jobs the log can't say which application moved, so it isn't used for history.
    { id: 'activity_20221010090000_6FG7H8J9K1L2M3N4', activity: 'Dana Whitfield changed the status of James Carter to Interview', date: '2022-10-10', time: '09:00:00' },
  ],
});

const APP_JOBS_JAMES = [
  { id: '21984457', applicant_id: JAMES, job_id: JOB_PM, rating: '4', workflow_step_id: '4106', date: '2022-10-03' },
  { id: '22410931', applicant_id: JAMES, job_id: JOB_BE, rating: '0', workflow_step_id: '5201', date: '2023-05-02' },
];
/** The org-wide application list: one row per applicant and job. */
const APP_JOBS = [
  { id: '21980001', applicant_id: MARIA, job_id: JOB_PM, rating: '5', workflow_step_id: '4104', date: '2023-02-14' },
  { id: '21980002', applicant_id: PRIYA, job_id: JOB_BE, rating: '0', workflow_step_id: '5205', date: '2023-02-16' },
  ...APP_JOBS_JAMES,
];

// Exactly one hire → a bare object.
const HIRES = { id: '9983211', applicant_id: JAMES, job_id: JOB_PM, workflow_step_id: '4106', workflow_step_name: 'Hired', hired_date: '2023-03-30', hired_time: '16:22:05' };

const s3 = (key: string, query = 'X-Amz-Expires=3600&X-Amz-Signature=5f1c0e') => `https://${FILES_HOST}/acme/${key}?${query}`;
const JAMES_FILE = {
  id: 'file_20221003081530_J4M3SC4RT3RCVD0C',
  applicant_id: JAMES,
  filename: 'James_Carter_CV.docx',
  mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  user_id: null,
  file_privacy: '0',
  file_size: '48211',
  date_loaded: '2022-10-03',
  time_loaded: '08:15:30',
  file_url: s3('james-cv-old.docx', 'X-Amz-Expires=3600&X-Amz-Signature=expired'),
};
const FILES = [
  {
    id: 'file_20230214153013_P0O9I8U7Y6T5R4E3',
    applicant_id: MARIA,
    filename: 'Maria_Gonzalez_Resume.pdf',
    mime_type: 'application/pdf',
    user_id: null,
    file_privacy: '0',
    file_size: '184233',
    date_loaded: '2023-02-14',
    time_loaded: '15:30:13',
    file_url: s3('maria-resume.pdf'),
  },
  {
    id: 'file_20230214153014_C0V3RL3TT3RM4R1A',
    applicant_id: MARIA,
    filename: 'Maria_Gonzalez_Cover_Letter.pdf',
    mime_type: 'application/pdf',
    user_id: null,
    file_privacy: '0',
    file_size: '52011',
    date_loaded: '2023-02-14',
    time_loaded: '15:30:14',
    file_url: s3('maria-cover.pdf'),
  },
  {
    id: 'file_20230227110500_PR1VAT3N0T3SPR1Y',
    applicant_id: PRIYA,
    filename: 'Priya_Nair_Comp_Notes.pdf',
    mime_type: 'application/pdf',
    user_id: DANA,
    file_privacy: '30',
    file_size: '10022',
    date_loaded: '2023-02-27',
    time_loaded: '11:05:00',
    file_url: s3('priya-notes.pdf'),
  },
  JAMES_FILE,
  {
    id: 'file_20230301101011_GH0STF1L3GH0STF1',
    applicant_id: GHOST,
    filename: 'resume.pdf',
    mime_type: 'application/pdf',
    user_id: null,
    file_privacy: '0',
    file_size: '1000',
    date_loaded: '2023-03-01',
    time_loaded: '10:10:11',
    file_url: s3('ghost.pdf'),
  },
];

const PDF = Buffer.from('%PDF-1.4\n% Maria Gonzalez resume\n');
const DOCX = Buffer.from('PK\u0003\u0004 James Carter CV');

/** Every API route checks the key the way JazzHR does: `?apikey=` or 401 (JSON body, text/html). */
const api = (body: unknown): RouteHandler => ({ url }) => {
  const key = url.searchParams.get('apikey');
  if (key !== KEY) {
    return json({ error: key ? 'invalid api key' : 'apikey not set' }, { status: 401, headers: { 'content-type': 'text/html;charset=UTF-8' } });
  }
  return json(body, { headers: { 'content-type': 'text/html;charset=UTF-8', 'x-ratelimit-limit': '240', 'x-ratelimit-remaining': '239' } });
};

const file = (data: Buffer, type: string, name: string): RouteHandler => () =>
  new Response(new Uint8Array(data), { headers: { 'content-type': type, 'content-disposition': `attachment; filename="${name}"` } });

function vendor(overrides: Record<string, RouteHandler> = {}) {
  const routes: Record<string, RouteHandler> = {
    [`GET ${API}/v1/users/page/1`]: api(USERS),
    [`GET ${API}/v1/users/page/2`]: api([]),
    [`GET ${API}/v1/workflows/page/1`]: api(WORKFLOWS),
    [`GET ${API}/v1/workflows/page/2`]: api([]),
    [`GET ${API}/v1/jobs/page/1`]: api(JOBS),
    [`GET ${API}/v1/jobs/page/2`]: api([]),
    // Two pages of applicants (with a duplicate row), then the empty terminal page.
    [`GET ${API}/v1/applicants/page/1`]: api([MARIA_ROW, PRIYA_ROW, MARIA_ROW, GHOST_ROW]),
    [`GET ${API}/v1/applicants/page/2`]: api(JAMES_ROW), // exactly one → bare object
    [`GET ${API}/v1/applicants/page/3`]: api([]),
    [`GET ${API}/v1/applicants/${MARIA}`]: api(MARIA_DETAIL),
    [`GET ${API}/v1/applicants/${PRIYA}`]: api(PRIYA_DETAIL),
    [`GET ${API}/v1/applicants/${JAMES}`]: api(JAMES_DETAIL),
    [`GET ${API}/v1/applicants/${GHOST}`]: api({}), // unknown id: 200 with no record
    [`GET ${API}/v1/applicants2jobs/applicant_id/${JAMES}/page/1`]: api(APP_JOBS_JAMES),
    [`GET ${API}/v1/applicants2jobs/page/1`]: api(APP_JOBS),
    [`GET ${API}/v1/applicants2jobs/page/2`]: api([]),
    [`GET ${API}/v1/hires/page/1`]: api(HIRES),
    [`GET ${API}/v1/hires/page/2`]: api([]),
    [`GET ${API}/v1/files/from_creation_date/2000-01-01/page/1`]: api(FILES),
    [`GET ${API}/v1/files/from_creation_date/2000-01-01/page/2`]: api([]),
    // Re-listing one file hands out a fresh link.
    [`GET ${API}/v1/files/${JAMES_FILE.id}`]: api({ ...JAMES_FILE, file_url: s3('james-cv.docx', 'X-Amz-Expires=3600&X-Amz-Signature=fresh') }),
    [`GET ${FILES_HOST}/acme/maria-resume.pdf`]: file(PDF, 'application/pdf', 'Maria_Gonzalez_Resume.pdf'),
    [`GET ${FILES_HOST}/acme/maria-cover.pdf`]: file(PDF, 'application/pdf', 'Maria_Gonzalez_Cover_Letter.pdf'),
    [`GET ${FILES_HOST}/acme/james-cv-old.docx`]: () =>
      new Response('<Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>', { status: 403, headers: { 'content-type': 'application/xml' } }),
    [`GET ${FILES_HOST}/acme/james-cv.docx`]: file(
      DOCX,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'James_Carter_CV.docx',
    ),
    ...overrides,
  };
  return mockFetch(routes);
}

/** An org whose admin and one recruiter share email addresses with JazzHR users. */
async function makeOrg() {
  const org = await db.organization.create({
    data: { slug: `jazzhr-test-${randomUUID().slice(0, 8)}`, name: 'Acme Widgets', kind: 'COMPANY', onboardedAt: new Date() },
  });
  const admin = await db.user.create({
    data: { orgId: org.id, email: 'dana.whitfield@acmewidgets.com', name: 'Dana Whitfield', accessRole: 'ADMIN', createdAt: new Date('2020-01-01T00:00:00Z') },
  });
  const recruiter = await db.user.create({
    data: { orgId: org.id, email: 'chinedu@acmewidgets.com', name: 'Chinedu Okafor', accessRole: 'TEAM_MEMBER', createdAt: new Date('2021-01-01T00:00:00Z') },
  });
  await db.stage.createMany({
    data: [
      { orgId: org.id, name: 'New applicant', type: 'APPLICANT', order: 0 },
      { orgId: org.id, name: 'Phone screen', type: 'SCREEN', order: 1 },
      { orgId: org.id, name: 'On-site', type: 'ONSITE', order: 2 },
      { orgId: org.id, name: 'Offer', type: 'OFFER', order: 3 },
      { orgId: org.id, name: 'Hired', type: 'HIRED', order: 4 },
    ],
  });
  return { orgId: org.id, adminId: admin.id, recruiterId: recruiter.id };
}

const importedId = (o: { customFields: unknown }) => (o.customFields as { imported: { id: string } }).imported.id;

// ---------- one load phase, driven the way the runner drives it ----------

const TEXT_HTML = { 'content-type': 'text/html;charset=UTF-8' };

type Loaded = {
  candidates: ImportedCandidate[];
  applications: ImportedApplication[];
  notes: ImportedNote[];
  feedback: ImportedFeedback[];
  files: { file: ImportedFile; data: DownloadedFile }[];
  warnings: string[];
  cursors: string[];
};

/**
 * Run one load phase against the mock with a recording loader. Every step gets
 * a fresh adapter (the runner builds one per slice) and a cursor that went
 * through JSON (the job row), so nothing can survive between steps in memory.
 */
async function runPhase(
  phase: 'candidates' | 'files',
  opts: { routes?: Record<string, RouteHandler>; options?: Partial<ImportOptions>; oneItemPerStep?: boolean; known?: RefKind[] } = {},
) {
  const mock = vendor(opts.routes);
  const http = createHttpClient({ resolveHost: publicDns,
    auth: jazzhrProvider.auth({ apiKey: KEY }),
    minIntervalMs: 0,
    fetchImpl: mock.impl,
  });
  const options: ImportOptions = { ...DEFAULT_IMPORT_OPTIONS, ...opts.options };
  const got: Loaded = { candidates: [], applications: [], notes: [], feedback: [], files: [], warnings: [], cursors: [] };
  const push =
    <T>(list: T[]) =>
    async (record: T) => {
      list.push(record);
    };
  const load: Loader = {
    posting: async () => undefined,
    requisition: async () => undefined,
    interview: async () => undefined,
    offer: async () => undefined,
    candidate: push(got.candidates),
    application: push(got.applications),
    note: push(got.notes),
    feedback: push(got.feedback),
    file: async (file) => {
      got.files.push({ file, data: await file.download() });
    },
    has: async (kind) => (opts.known ?? []).includes(kind),
    handled: async () => false,
  };
  const ctx: PhaseContext = {
    http,
    catalog: { stage: () => undefined, reason: () => undefined, user: () => undefined },
    load,
    options,
    since: options.since ? new Date(options.since) : null,
    outOfTime: () => !!opts.oneItemPerStep,
    warn: (message) => got.warnings.push(message),
  };
  let cursor: Cursor | null = null;
  let steps = 0;
  do {
    const step = jazzhrProvider.create({ apiKey: KEY }, http).load.find((p) => p.id === phase)!;
    const saved = JSON.stringify(await step.run(ctx, cursor));
    got.cursors.push(saved);
    cursor = JSON.parse(saved) as Cursor | null;
    if (++steps > 200) throw new Error(`${phase} did not finish`);
  } while (cursor !== null);
  return { ...got, mock, steps };
}

const appOf = (apps: ImportedApplication[], id: string) => apps.find((a) => a.externalId === id)!;
const moves = (a: ImportedApplication) => (a.history ?? []).map((h) => [h.stage.name, h.at.toISOString()]);
/** Replace the applicant list with these rows (one page, then the empty terminal page). */
const onlyApplicants = (...rows: ReturnType<typeof row>[]): Record<string, RouteHandler> => ({
  [`GET ${API}/v1/applicants/page/1`]: api(rows.length === 1 ? rows[0] : rows),
  [`GET ${API}/v1/applicants/page/2`]: api([]),
});

// Applicants for the edge cases below.
const LENA_ROW = row(LENA, 'Lena', 'Kowalski', '(206) 555-0177', '2023-01-10', JOB_BE, 'Senior Backend Engineer');
const lenaOn = (step: string) =>
  detail(LENA_ROW, {
    email: 'lena.k@example.com',
    jobs: [{ job_id: JOB_BE, hiring_lead_rating: '0', average_rating: '0', workflow_step_id: '9901', job_title: 'Senior Backend Engineer', applicant_progress: step }],
  });
const lenaHired = (step: string) => ({
  id: '9983377',
  applicant_id: LENA,
  job_id: JOB_BE,
  workflow_step_id: '9901',
  workflow_step_name: step,
  hired_date: '2023-02-28',
  hired_time: '09:30:00',
});

const NOAH_ROW = row(NOAH, 'Noah', 'Adams', '(412) 555-0123', '2023-04-05', JOB_PM, 'Engineering Project Manager - Payments');
const NOAH_DETAIL = detail(NOAH_ROW, {
  email: 'noah.adams@example.com',
  jobs: [{ job_id: JOB_PM, hiring_lead_rating: '0', average_rating: '0', workflow_step_id: '4107', job_title: 'Engineering Project Manager - Payments', applicant_progress: 'Not a Fit' }],
  activities: [
    { id: 'activity_20230405111500_7GH8J9K1L2M3N4P5', activity: 'Noah Adams applied to Engineering Project Manager - Payments', date: '2023-04-05', time: '11:15:00' },
    // Not the "changed the status" wording the move parser accepts.
    { id: 'activity_20230420100000_8HJ9K1L2M3N4P5Q6', activity: "Chinedu Okafor moved Noah Adams's status from Phone Screen to Not a Fit", date: '2023-04-20', time: '10:00:00' },
    { id: 'activity_20230421090000_9JK1L2M3N4P5Q6R7', activity: 'Chinedu Okafor emailed Noah Adams', date: '2023-04-21', time: '09:00:00' },
  ],
});

const OMAR_ROW = row(OMAR, 'Omar', 'Farouk', '+44 20 7946 0958', '2023-03-01', JOB_UK, 'Warehouse Associate (Seasonal)');
const OMAR_DETAIL = detail(OMAR_ROW, {
  email: 'omar.farouk@example.co.uk',
  address: '221B Baker Street, London',
  recruiter_id: CHINEDU,
  jobs: '', // a nested list can come back as ""
  activities: [
    { id: 'activity_20230302090000_AK1L2M3N4P5Q6R7S', activity: 'Chinedu Okafor changed the status of Omar Farouk to Phone Screen', date: '2023-03-02', time: '09:00:00' },
    { id: 'activity_20230309164500_BL2M3N4P5Q6R7S8T', activity: 'Chinedu Okafor changed the status of Omar Farouk to Offer', date: '2023-03-09', time: '16:45:00' },
  ],
});

const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;

describe.skipIf(!hasDb)('JazzHR adapter', () => {
  it('builds with empty credentials and lists its phases', () => {
    const http = createHttpClient({ resolveHost: publicDns, auth: { hosts: [] }, minIntervalMs: 0 });
    const adapter = jazzhrProvider.create({}, http);
    expect(adapter.discover.map((p) => p.id)).toEqual(['users', 'stages']);
    expect(adapter.load.map((p) => p.id)).toEqual(['jobs', 'candidates', 'files']);
    expect(adapter.load.find((p) => p.id === 'files')!.enabled!({ archived: true, activity: true, offers: true, files: false, since: null })).toBe(false);
  });

  it('verifies with ?apikey= only and names the account after its email domain', async () => {
    const mock = vendor();
    await expect(verifyForTest(jazzhrProvider, { apiKey: KEY }, mock.impl)).resolves.toEqual({ accountName: 'acmewidgets.com' });
    expect(mock.calls).toHaveLength(1);
    const [call] = mock.calls;
    expect(`${call.method} ${call.url.host}${call.url.pathname}`).toBe(`GET ${API}/v1/users/page/1`);
    expect(call.url.protocol).toBe('https:');
    expect([...call.url.searchParams.keys()]).toEqual(['apikey']);
    expect(call.url.searchParams.get('apikey')).toBe(KEY);
    expect(call.headers.authorization).toBeUndefined();
    expect(JSON.stringify(call.headers)).not.toContain(KEY);

    const bad = vendor();
    const err = await verifyForTest(jazzhrProvider, { apiKey: 'WrongKeyWrongKeyWrongKeyWrongKey' }, bad.impl).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImportAuthError);
    expect((err as ImportAuthError).status).toBe(401);
    expect((err as Error).message).not.toContain('WrongKey');
  });

  it('imports the whole account, then re-runs without creating anything', async () => {
    const { orgId, adminId, recruiterId } = await makeOrg();
    const mock = vendor();
    const res = await runImportForTest({ module: jazzhrProvider, credentials: { apiKey: KEY }, fetchImpl: mock.impl, orgId });

    expect(res.error).toBeNull();
    expect(res.status).toBe('SUCCEEDED');
    expect(mock.unmatched).toEqual([]);
    expect(mock.calls.every((c) => c.method === 'GET')).toBe(true);

    // ---- review: workflow steps grouped by name across both workflows ----
    const stages = Object.fromEntries(res.review!.stages.map((st) => [st.key, st]));
    expect(Object.keys(stages).sort()).toEqual(['hired', 'interview', 'new', 'offer', 'phone screen', 'reviewed', 'technical interview']);
    expect(stages['new']).toMatchObject({ count: 2, suggestedType: 'APPLICANT', target: { create: { name: 'New', type: 'APPLICANT' } } });
    expect(stages['phone screen'].count).toBe(2);
    expect(stages['phone screen'].target).toHaveProperty('stageId'); // same name as the org's "Phone screen"
    expect(stages['hired']).toMatchObject({ count: 2, suggestedType: 'HIRED' });
    expect(stages['hired'].target).toHaveProperty('stageId');
    expect(stages['technical interview'].target).toEqual({ create: { name: 'Technical Interview', type: 'SCREEN' } });
    const reasons = Object.fromEntries(res.review!.reasons.map((r) => [r.key, r.kind]));
    expect(reasons).toEqual({ 'not a fit': 'rejection', 'declined offer': 'withdrawn', 'hired elsewhere': 'withdrawn' });
    expect(res.review!.users).toMatchObject({ total: 4, matched: 2 });
    expect(res.review!.users.unmatchedNames.sort()).toEqual(['Pat Former', 'Sam Reyes']);

    expect(res.view.created).toEqual({ posting: 4, requisition: 2, contact: 3, opportunity: 4, note: 6, feedback: 5, file: 3 });

    // ---- jobs ----
    const postings = await db.posting.findMany({ where: { orgId }, include: { department: true, requisition: true } });
    const pm = postings.find((p) => p.title === 'Engineering Project Manager - Payments')!;
    expect(pm).toMatchObject({
      state: 'DRAFT',
      location: 'Seattle, WA, United States',
      commitment: 'FULL_TIME',
      workplaceType: 'ONSITE',
      salaryMin: 125000,
      salaryMax: 175000,
      salaryCurrency: 'USD',
    });
    expect(pm.department!.name).toBe('Payments');
    expect(pm.requisition).toMatchObject({ code: 'ENG-104', title: 'Engineering Project Manager - Payments', state: 'OPEN' });
    expect(iso(pm.createdAt)).toBe('2022-05-13T17:15:11.000Z');
    const description = (pm.content as { description: string }).description;
    expect(description).toMatch(/^We are looking for an Engineering Project Manager\s+to lead…\n\n• Own delivery$/);
    const cs = postings.find((p) => p.title.startsWith('Customer Success'))!;
    expect(cs).toMatchObject({ state: 'CLOSED', workplaceType: 'REMOTE', commitment: 'PART_TIME', salaryMin: null, salaryCurrency: null, departmentId: null });
    expect((cs.content as { description: string }).description).toContain('WYSIWYG editor');
    expect(postings.find((p) => p.title === 'Senior Backend Engineer')!.location).toBe('Pittsburgh, PA 15212, United States');
    // No currency field: a UK job's pay isn't dollars, and the requisition would otherwise default to USD.
    const uk = postings.find((p) => p.title.startsWith('Warehouse'))!;
    expect(uk).toMatchObject({ state: 'DRAFT', commitment: 'PART_TIME', location: 'Manchester, M1 1AE, United Kingdom', salaryMin: 24000, salaryCurrency: null });
    expect(uk.requisition).toMatchObject({ code: 'ABC-X1', state: 'OPEN', salaryMin: null, salaryMax: null });

    // ---- candidates ----
    const contacts = await db.contact.findMany({ where: { orgId }, include: { resumeFile: true } });
    expect(contacts.map((c) => c.name).sort()).toEqual(['James Carter', 'Maria Gonzalez', 'Priya Nair']);
    const maria = contacts.find((c) => c.name === 'Maria Gonzalez')!;
    expect(maria).toMatchObject({
      emails: ['maria.gonzalez@example.com'],
      phones: ['(412) 555-0199'],
      links: ['https://www.linkedin.com/in/mariagonzalez', 'https://mariag.dev', 'https://twitter.com/mgonzalez'],
      location: 'Pittsburgh, PA 15222',
      tags: ['Payments'],
    });
    expect(iso(maria.createdAt)).toBe('2023-02-14T15:30:12.000Z'); // from the prospect id
    expect(maria.resumeFile).toMatchObject({ filename: 'Maria_Gonzalez_Resume.pdf', mime: 'application/pdf' });
    const james = contacts.find((c) => c.name === 'James Carter')!;
    expect(james.emails).toEqual(['jcarter@example.net']);
    expect(james.resumeFile).toMatchObject({ filename: 'James_Carter_CV.docx' }); // after re-fetching an expired link
    expect(contacts.find((c) => c.name === 'Priya Nair')!.resumeFileId).toBeNull(); // private file skipped

    // ---- applications ----
    const opps = await db.opportunity.findMany({
      where: { orgId },
      include: {
        stage: true,
        archiveReason: true,
        posting: true,
        stageTransitions: { orderBy: { occurredAt: 'asc' }, include: { toStage: true } },
      },
    });
    const opp = (id: string) => opps.find((o) => importedId(o) === id)!;
    expect(opps.map(importedId).sort()).toEqual([`${JAMES}:${JOB_BE}`, `${JAMES}:${JOB_PM}`, `${MARIA}:${JOB_PM}`, `${PRIYA}:${JOB_BE}`].sort());

    const mariaApp = opp(`${MARIA}:${JOB_PM}`);
    expect(mariaApp).toMatchObject({ status: 'ACTIVE', origin: 'APPLIED', source: 'LinkedIn', ownerId: recruiterId, archivedAt: null });
    expect(mariaApp.stage.name).toBe('Interview');
    expect(mariaApp.posting!.title).toBe('Engineering Project Manager - Payments');
    expect(iso(mariaApp.createdAt)).toBe('2023-02-14T15:30:12.000Z');
    expect(mariaApp.stageTransitions.map((t) => [t.toStage.name, iso(t.occurredAt), t.actorId])).toEqual([
      ['New', '2023-02-14T15:30:12.000Z', null],
      ['Phone screen', '2023-02-16T10:00:00.000Z', recruiterId],
      ['Interview', '2023-02-21T09:01:02.000Z', recruiterId],
    ]);
    expect(iso(mariaApp.stageChangedAt)).toBe('2023-02-21T09:01:02.000Z');
    const mariaFields = (mariaApp.customFields as { imported: { fields: Record<string, string> } }).imported.fields;
    expect(mariaFields).toMatchObject({
      'Average rating': '4.5 of 5',
      'Desired salary': '140000',
      Languages: 'English, Spanish',
      'Work authorization': 'U.S. Citizen/Permanent Resident',
      "Driver's license": 'Yes',
    });
    expect(Object.keys(mariaFields)).not.toContain('Willing to relocate'); // "No answer" dropped
    expect(JSON.stringify(mariaFields)).not.toMatch(/felony/i);

    const priyaApp = opp(`${PRIYA}:${JOB_BE}`);
    expect(priyaApp).toMatchObject({ status: 'ARCHIVED', origin: 'AGENCY', source: 'TalentBridge Agency', ownerId: adminId });
    expect(priyaApp.archiveReason).toMatchObject({ name: 'Not a Fit', countsAsRejection: true });
    expect(iso(priyaApp.archivedAt)).toBe('2023-02-27T11:00:00.000Z');
    expect(priyaApp.stage.name).toBe('Phone screen'); // the last stage before the rejection
    expect(priyaApp.stageTransitions.map((t) => [t.toStage.name, iso(t.occurredAt), t.actorId])).toEqual([
      ['New', '2023-02-16T09:15:44.000Z', null],
      ['Phone screen', '2023-02-20T13:45:00.000Z', adminId],
    ]);
    // The hiring lead never rated Priya, but the team's average survives.
    expect((priyaApp.customFields as { imported: { fields: Record<string, string> } }).imported.fields).toMatchObject({ 'Average rating': '3.5 of 5' });

    const jamesHired = opp(`${JAMES}:${JOB_PM}`);
    expect(jamesHired).toMatchObject({ status: 'HIRED', origin: 'REFERRED', source: 'Employee Referral', archiveReasonId: null, ownerId: recruiterId });
    expect(jamesHired.stage.name).toBe('Hired');
    expect(jamesHired.archivedAt).toBeNull();
    expect(iso(jamesHired.stageChangedAt)).toBe('2023-03-30T16:22:05.000Z');
    expect(iso(jamesHired.createdAt)).toBe('2022-10-03T08:15:22.000Z');
    expect(jamesHired.stageTransitions.map((t) => [t.toStage.name, iso(t.occurredAt)])).toEqual([
      ['New', '2022-10-03T08:15:22.000Z'],
      ['Hired', '2023-03-30T16:22:05.000Z'],
    ]);
    expect((jamesHired.customFields as { imported: { fields: Record<string, string> } }).imported.fields).toMatchObject({ 'Referred by': 'Dana Whitfield' });

    const jamesActive = opp(`${JAMES}:${JOB_BE}`);
    expect(jamesActive).toMatchObject({ status: 'ACTIVE', ownerId: adminId });
    expect(jamesActive.stage.name).toBe('New');
    expect(iso(jamesActive.createdAt)).toBe('2023-05-02T12:00:00.000Z'); // per-job date from /applicants2jobs
    expect(jamesActive.stageTransitions.map((t) => t.toStage.name)).toEqual(['New']);

    // ---- notes, feedback, ratings ----
    const notes = await db.note.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' } });
    const noteBy = (start: string) => notes.find((n) => n.body.startsWith(start))!;
    expect(noteBy('Strong payments background')).toMatchObject({ authorId: recruiterId, opportunityId: mariaApp.id });
    expect(iso(noteBy('Strong payments background').createdAt)).toBe('2023-02-20T14:03:11.000Z');
    expect(noteBy('[JazzHR · Pat Former]')).toMatchObject({
      body: '[JazzHR · Pat Former] Please loop me in before we extend an offer.',
      authorId: adminId,
    });
    expect(noteBy('Feedback\n')).toMatchObject({ body: 'Feedback\nGreat communicator, a bit light on team leadership.', authorId: adminId });
    expect(noteBy('Email to ')).toMatchObject({
      body: 'Email to maria.gonzalez@example.com: Next steps: Engineering Project Manager\n\nHi Maria, thanks for applying. Are you free Thursday?',
      authorId: recruiterId,
    });
    expect(iso(noteBy('Email to ').createdAt)).toBe('2023-02-15T10:15:00.000Z');
    expect(noteBy('[JazzHR] Application answers').body).toBe(
      '[JazzHR] Application answers\n\nQ: How many years of payments experience do you have?\nA: 7\n\nQ: Are you authorized to work in the US?\nA: Yes',
    );
    expect(noteBy('[JazzHR] Resume (text from JazzHR)').body).toBe(
      '[JazzHR] Resume (text from JazzHR)\n\nMARIA GONZALEZ\nPittsburgh, PA\n\nEXPERIENCE\nSenior Project Manager, Payments (2019-present)',
    );
    expect(noteBy('Salary expectations')).toMatchObject({ authorId: adminId, opportunityId: priyaApp.id });
    expect(noteBy('[JazzHR] Attachment: Maria_Gonzalez_Cover_Letter.pdf').opportunityId).toBe(mariaApp.id);

    // Feedback JazzHR marks private stays in JazzHR.
    expect(notes.some((n) => n.body.includes('Confidential comp'))).toBe(false);

    const scorecards = await db.feedbackSubmission.findMany({ where: { orgId } });
    expect(scorecards).toHaveLength(4);
    const stars = scorecards.find((f) => f.opportunityId === mariaApp.id && f.authorId === recruiterId)!;
    expect(stars).toMatchObject({ overallRating: 4, summary: 'Hiring lead star rating\n5 of 5 stars in JazzHR' }); // 5 stars → strong yes
    expect(Object.values(stars.answers as Record<string, { label: string; value: string }>)).toEqual([
      { label: 'Stars', kind: 'TEXT', value: '5/5' },
      { label: 'Average rating', kind: 'TEXT', value: '4.5' },
    ]);
    const evaluation = scorecards.find((f) => f.summary.includes('Technical depth'))!;
    expect(evaluation).toMatchObject({ overallRating: 3, authorId: adminId, summary: '[JazzHR] Technical depth\nSolid on ledger design.' }); // 4 stars → yes
    expect(iso(evaluation.createdAt)).toBe('2023-02-23T11:11:11.000Z');
    const jamesStars = scorecards.find((f) => f.opportunityId === jamesHired.id)!;
    expect(jamesStars).toMatchObject({ overallRating: 3, authorId: recruiterId }); // 4 stars → yes
    const jamesAverage = scorecards.find((f) => f.opportunityId === jamesActive.id)!;
    expect(jamesAverage).toMatchObject({ overallRating: 2, authorId: adminId }); // 3 stars is "average" → no

    // ---- warnings, credentials, call budget ----
    const issues = res.view.issues.map((i) => i.message);
    expect(issues).toContain('Skipped files marked private in JazzHR (admins only, or only the uploader)');
    expect(issues).toContain('Skipped comments and feedback marked private in JazzHR (visible only to some users there)');
    expect(issues).toContain('Skipped candidates JazzHR listed but no longer returns (deleted during the import?)');
    expect(JSON.stringify(res.view)).not.toContain(KEY);

    for (const call of mock.calls) {
      if (call.url.host === API) {
        expect(call.url.searchParams.get('apikey')).toBe(KEY);
        expect(call.headers.authorization).toBeUndefined();
      } else {
        expect(call.url.searchParams.has('apikey')).toBe(false);
        expect(call.url.href).not.toContain(KEY);
        expect(JSON.stringify(call.headers)).not.toContain(KEY);
      }
    }
    const fileCalls = mock.calls.filter((c) => c.url.host === FILES_HOST).map((c) => c.url.pathname);
    expect(fileCalls).toEqual(['/acme/maria-resume.pdf', '/acme/maria-cover.pdf', '/acme/james-cv-old.docx', '/acme/james-cv.docx']);
    // The duplicate list row did not cost a second detail call.
    expect(mock.calls.filter((c) => c.url.pathname === `/v1/applicants/${MARIA}`)).toHaveLength(1);

    // ---- re-run into the same org: nothing new, no downloads ----
    const counts = async () => ({
      contacts: await db.contact.count({ where: { orgId } }),
      opps: await db.opportunity.count({ where: { orgId } }),
      notes: await db.note.count({ where: { orgId } }),
      feedback: await db.feedbackSubmission.count({ where: { orgId } }),
      postings: await db.posting.count({ where: { orgId } }),
      stages: await db.stage.count({ where: { orgId } }),
      files: await db.storedFile.count({ where: { orgId } }),
      transitions: await db.stageTransition.count({ where: { opportunity: { orgId } } }),
    });
    const before = await counts();
    const again = vendor();
    const rerun = await runImportForTest({ module: jazzhrProvider, credentials: { apiKey: KEY }, fetchImpl: again.impl, orgId });
    expect(rerun.status).toBe('SUCCEEDED');
    expect(rerun.review!.stages.every((st) => 'stageId' in st.target)).toBe(true);
    expect(rerun.view.created).toEqual({});
    expect(await counts()).toEqual(before);
    expect(again.calls.filter((c) => c.url.host === FILES_HOST)).toHaveLength(0);
    expect(again.unmatched).toEqual([]);
  });

  it('keeps going with a warning when JazzHR refuses the file list', async () => {
    const { orgId } = await makeOrg();
    const mock = vendor({
      [`GET ${API}/v1/files/from_creation_date/2000-01-01/page/1`]: () => json({ error: 'Forbidden' }, { status: 403, headers: TEXT_HTML }),
      // A server that ignores /page/n and repeats the last page must not loop forever.
      [`GET ${API}/v1/users/page/2`]: api(USERS),
      [`GET ${API}/v1/hires/page/1`]: () => json({ error: 'Not found' }, { status: 404, headers: TEXT_HTML }),
      // An error page that echoes the request URL, key included.
      [`GET ${API}/v1/applicants2jobs/applicant_id/${JAMES}/page/1`]: ({ url }) =>
        new Response(`Not found: ${url.pathname}${url.search}`, { status: 404, headers: { 'content-type': 'text/html' } }),
    });
    const res = await runImportForTest({ module: jazzhrProvider, credentials: { apiKey: KEY }, fetchImpl: mock.impl, orgId });

    expect(res.status).toBe('SUCCEEDED');
    expect(res.error).toBeNull();
    expect(mock.unmatched).toEqual([]);
    const warning = res.view.issues.find((i) => i.message.startsWith('Resume files were skipped'))!;
    expect(warning.message).toBe('Resume files were skipped because JazzHR refused the file list: HTTP 403');
    expect(res.view.created.file).toBeUndefined();
    expect(res.view.created).toMatchObject({ contact: 3, opportunity: 4 });
    expect(res.review!.users.total).toBe(4);
    expect(res.view.issues.map((i) => i.message)).toContain('JazzHR hire dates were unavailable, so hires are dated from the activity log: HTTP 404');
    const dates = res.view.issues.find((i) => i.message.startsWith('JazzHR application dates'))!;
    expect(dates.message).toContain('HTTP 404: response withheld');
    expect(JSON.stringify(res.view)).not.toContain(KEY);
    expect(mock.calls.filter((c) => c.url.host === FILES_HOST)).toHaveLength(0);
    // The parsed resume text still made it across.
    expect(await db.note.count({ where: { orgId, body: { startsWith: '[JazzHR] Resume (text from JazzHR)' } } })).toBe(1);
  });

  // The spec: on a 401/403/empty list, files are unavailable and the import carries on.
  it.each<[string, RouteHandler, string]>([
    ['a 401', () => json({ error: 'invalid api key' }, { status: 401, headers: TEXT_HTML }), 'HTTP 401'],
    ['a 200 error naming the key', api({ error: 'apikey does not have access to files' }), 'HTTP 401'],
    ['a 200 error', api({ error: 'Files API is disabled for this account' }), '"Files API is disabled for this account"'],
    ['a 400', () => json({ error: 'Bad request' }, { status: 400, headers: TEXT_HTML }), 'HTTP 400'],
  ])('finishes the import when the file list answers with %s', async (_, refusal, detail) => {
    const { orgId } = await makeOrg();
    const mock = vendor({ [`GET ${API}/v1/files/from_creation_date/2000-01-01/page/1`]: refusal });
    const res = await runImportForTest({ module: jazzhrProvider, credentials: { apiKey: KEY }, fetchImpl: mock.impl, orgId });

    expect(res.error).toBeNull();
    expect(res.status).toBe('SUCCEEDED');
    expect(res.view.issues.map((i) => i.message)).toContain(`Resume files were skipped because JazzHR refused the file list: ${detail}`);
    expect(res.view.created).toMatchObject({ contact: 3, opportunity: 4 });
    expect(res.view.created.file).toBeUndefined();
    expect(await db.note.count({ where: { orgId, body: { startsWith: '[JazzHR] Resume (text from JazzHR)' } } })).toBe(1);
    expect(JSON.stringify(res.view)).not.toContain(KEY);
  });

  it('never sends the key over plain http, even when a file link points at the API host', async () => {
    const res = await runPhase('files', {
      known: ['contact'],
      routes: {
        [`GET ${API}/v1/files/from_creation_date/2000-01-01/page/1`]: api({ ...FILES[0], file_url: `http://${API}/v1/files/download/abc` }),
        [`GET ${API}/v1/files/download/abc`]: ({ url }) =>
          url.searchParams.get('apikey') === KEY
            ? new Response(new Uint8Array(PDF), { headers: { 'content-type': 'application/pdf' } })
            : json({ error: 'apikey not set' }, { status: 401, headers: TEXT_HTML }),
      },
    });

    expect(res.mock.unmatched).toEqual([]);
    expect(res.files.map((f) => f.data.data.equals(PDF))).toEqual([true]);
    expect(res.mock.calls.every((c) => c.url.protocol === 'https:')).toBe(true);
    const download = res.mock.calls.find((c) => c.url.pathname === '/v1/files/download/abc')!;
    expect(download.url.searchParams.get('apikey')).toBe(KEY);
  });

  it('warns when JazzHR lists no files at all', async () => {
    const res = await runPhase('files', { known: ['contact'], routes: { [`GET ${API}/v1/files/from_creation_date/2000-01-01/page/1`]: api([]) } });
    expect(res.files).toEqual([]);
    expect(res.warnings).toEqual(['JazzHR listed no files, so resumes are limited to the text JazzHR parsed']);
  });

  it('lists workflows, users, jobs and hires once per phase, not once per slice', async () => {
    const res = await runPhase('candidates', { oneItemPerStep: true });

    expect(res.mock.unmatched).toEqual([]);
    expect(res.steps).toBeGreaterThan(10); // many slices' worth of steps, each with a fresh adapter
    const count = (path: string) => res.mock.calls.filter((c) => c.url.pathname === path).length;
    for (const list of ['workflows', 'users', 'jobs', 'hires']) {
      expect([list, count(`/v1/${list}/page/1`), count(`/v1/${list}/page/2`)]).toEqual([list, 1, 1]);
    }
    expect(res.cursors.join('\n')).not.toContain(KEY);

    // The carried reference data still does its job on every applicant.
    const apps = res.applications;
    expect(appOf(apps, `${MARIA}:${JOB_PM}`)).toMatchObject({ status: 'active', ownerExternalUserId: CHINEDU, stage: { externalId: '4104' } });
    expect(appOf(apps, `${PRIYA}:${JOB_BE}`)).toMatchObject({ status: 'archived', origin: 'AGENCY', archiveReason: { externalId: '5205', name: 'Not a Fit' } });
    expect(appOf(apps, `${JAMES}:${JOB_PM}`)).toMatchObject({ status: 'hired', archivedAt: new Date('2023-03-30T16:22:05Z') });
    expect(moves(appOf(apps, `${MARIA}:${JOB_PM}`))).toEqual([
      ['New', '2023-02-14T15:30:12.000Z'],
      ['Phone Screen', '2023-02-16T10:00:00.000Z'],
      ['Interview', '2023-02-21T09:01:02.000Z'],
    ]);
  });

  it.each<[string, string, Record<string, RouteHandler>]>([
    ['a legacy step /workflows leaves out', 'Hired - Full Time', {}],
    ['a step when /workflows is refused', 'Placed', { [`GET ${API}/v1/workflows/page/1`]: () => json({ error: 'Forbidden' }, { status: 403, headers: TEXT_HTML }) }],
  ])('takes a hire from /hires on %s', async (_, step, routes) => {
    const res = await runPhase('candidates', {
      routes: {
        ...onlyApplicants(LENA_ROW),
        [`GET ${API}/v1/applicants/${LENA}`]: api(lenaOn(step)),
        [`GET ${API}/v1/hires/page/1`]: api([HIRES, lenaHired(step)]),
        ...routes,
      },
    });

    expect(res.mock.unmatched).toEqual([]);
    expect(appOf(res.applications, `${LENA}:${JOB_BE}`)).toMatchObject({
      status: 'hired',
      stage: { externalId: '9901', name: step },
      archivedAt: new Date('2023-02-28T09:30:00Z'),
      archiveReason: null,
    });
  });

  it('counts a hire when the candidate has since moved to a step nobody lists', async () => {
    const res = await runPhase('candidates', {
      routes: {
        ...onlyApplicants(LENA_ROW),
        [`GET ${API}/v1/applicants/${LENA}`]: api({
          ...lenaOn('Onboarding'),
          jobs: [{ job_id: JOB_BE, hiring_lead_rating: '0', average_rating: '0', workflow_step_id: '9902', job_title: 'Senior Backend Engineer', applicant_progress: 'Onboarding' }],
        }),
        [`GET ${API}/v1/hires/page/1`]: api([HIRES, lenaHired('Hired - Full Time')]),
      },
    });

    expect(appOf(res.applications, `${LENA}:${JOB_BE}`)).toMatchObject({
      status: 'hired',
      stage: { externalId: '9902', name: 'Onboarding' },
      archivedAt: new Date('2023-02-28T09:30:00Z'),
    });
  });

  it('keeps an application re-opened after a hire active, without dating it by the old hire', async () => {
    const res = await runPhase('candidates', {
      routes: {
        ...onlyApplicants(JAMES_ROW),
        [`GET ${API}/v1/applicants/${JAMES}`]: api({
          ...JAMES_DETAIL,
          jobs: [
            { job_id: JOB_PM, hiring_lead_rating: '0', average_rating: '0', workflow_step_id: '4105', job_title: 'Engineering Project Manager - Payments', applicant_progress: 'Offer' },
            { job_id: JOB_BE, hiring_lead_rating: '0', average_rating: '0', workflow_step_id: '5204', job_title: 'Senior Backend Engineer', applicant_progress: 'Hired' },
          ],
        }),
        [`GET ${API}/v1/hires/page/1`]: api([
          HIRES,
          { id: '9983400', applicant_id: JAMES, job_id: JOB_BE, workflow_step_id: '5204', workflow_step_name: 'Hired', hired_date: '2023-06-01', hired_time: '10:00:00' },
        ]),
      },
    });

    const reopened = appOf(res.applications, `${JAMES}:${JOB_PM}`);
    expect(reopened).toMatchObject({ status: 'active', archivedAt: null, stage: { externalId: '4105', name: 'Offer' } });
    expect(moves(reopened).map(([name]) => name)).toEqual(['Offer']);
    expect(moves(reopened).some(([, when]) => when === '2023-03-30T16:22:05.000Z')).toBe(false);
    expect(appOf(res.applications, `${JAMES}:${JOB_BE}`)).toMatchObject({ status: 'hired', archivedAt: new Date('2023-06-01T10:00:00Z') });
  });

  it('dates a rejection by the log line naming it, whatever the wording and however many jobs', async () => {
    const res = await runPhase('candidates', {
      routes: {
        ...onlyApplicants(NOAH_ROW, JAMES_ROW),
        [`GET ${API}/v1/applicants/${NOAH}`]: api(NOAH_DETAIL),
        [`GET ${API}/v1/applicants/${JAMES}`]: api({
          ...JAMES_DETAIL,
          jobs: [
            { job_id: JOB_PM, hiring_lead_rating: '0', average_rating: '0', workflow_step_id: '4107', job_title: 'Engineering Project Manager - Payments', applicant_progress: 'Not a Fit' },
            { job_id: JOB_BE, hiring_lead_rating: '0', average_rating: '0', workflow_step_id: '5201', job_title: 'Senior Backend Engineer', applicant_progress: 'New' },
          ],
          activities: [
            { id: 'activity_20230420123000_CM3N4P5Q6R7S8T9U', activity: 'Dana Whitfield changed the status of James Carter to Not a Fit', date: '2023-04-20', time: '12:30:00' },
            { id: 'activity_20230510090000_DN4P5Q6R7S8T9U1V', activity: 'Dana Whitfield emailed James Carter', date: '2023-05-10', time: '09:00:00' },
          ],
        }),
        [`GET ${API}/v1/hires/page/1`]: api([]),
      },
    });

    expect(appOf(res.applications, `${NOAH}:${JOB_PM}`)).toMatchObject({
      status: 'archived',
      archiveReason: { externalId: '4107', name: 'Not a Fit' },
      archivedAt: new Date('2023-04-20T10:00:00Z'),
    });
    // Two jobs, but only one sits in "Not a Fit", so the line can only be about that one.
    expect(appOf(res.applications, `${JAMES}:${JOB_PM}`)).toMatchObject({
      status: 'archived',
      archivedAt: new Date('2023-04-20T12:30:00Z'),
      stage: { externalId: '4101', name: 'New' },
    });
    expect(appOf(res.applications, `${JAMES}:${JOB_BE}`)).toMatchObject({ status: 'active' });
  });

  it('places an application the detail gives no step by its last logged move, with fallbacks for owner and location', async () => {
    const res = await runPhase('candidates', {
      routes: { ...onlyApplicants(OMAR_ROW), [`GET ${API}/v1/applicants/${OMAR}`]: api(OMAR_DETAIL) },
    });

    const app = appOf(res.applications, `${OMAR}:${JOB_UK}`);
    expect(app).toMatchObject({ status: 'active', stage: { externalId: '4105', name: 'Offer' }, ownerExternalUserId: CHINEDU });
    expect(moves(app)).toEqual([
      ['New', '2023-03-01T09:00:00.000Z'],
      ['Phone Screen', '2023-03-02T09:00:00.000Z'],
      ['Offer', '2023-03-09T16:45:00.000Z'],
    ]);
    expect(res.candidates[0].location).toBe('221B Baker Street, London');
  });

  it('says so when resume text is on but notes are off', async () => {
    const res = await runPhase('candidates', { options: { activity: false } });
    expect(res.notes).toEqual([]);
    expect(res.warnings).toContain('The resume text JazzHR parsed was not kept because notes are turned off for this import');
  });

  it('filters by apply date on the server, catches earlier candidates who applied again, and skips closed-out ones when archived data is off', async () => {
    const { orgId } = await makeOrg();
    const mock = vendor({
      [`GET ${API}/v1/applicants/from_apply_date/2023-02-01/page/1`]: api([MARIA_ROW, PRIYA_ROW]),
      [`GET ${API}/v1/applicants/from_apply_date/2023-02-01/page/2`]: api([]),
    });
    const res = await runImportForTest({
      module: jazzhrProvider,
      credentials: { apiKey: KEY },
      fetchImpl: mock.impl,
      orgId,
      options: { archived: false, files: false, since: '2023-02-01' },
    });

    expect(res.status).toBe('SUCCEEDED');
    expect(mock.unmatched).toEqual([]);
    const paths = mock.calls.map((c) => c.url.pathname);
    expect(paths).not.toContain('/v1/applicants/page/1');
    expect(paths.some((p) => p.startsWith('/v1/files'))).toBe(false);
    expect(paths).toContain('/v1/applicants2jobs/page/2'); // the whole application list, to its end
    // Priya's only application is rejected: no contact, no opportunity, and no second detail call.
    expect(paths.filter((p) => p === `/v1/applicants/${PRIYA}`)).toHaveLength(1);
    // James first applied in 2022, before the start date, and again to the backend role after it.
    expect((await db.contact.findMany({ where: { orgId } })).map((c) => c.name).sort()).toEqual(['James Carter', 'Maria Gonzalez']);
    const opps = await db.opportunity.findMany({ where: { orgId } });
    expect(opps.map(importedId).sort()).toEqual([`${JAMES}:${JOB_BE}`, `${MARIA}:${JOB_PM}`].sort());
    expect(iso(opps.find((o) => importedId(o) === `${JAMES}:${JOB_BE}`)!.createdAt)).toBe('2023-05-02T12:00:00.000Z');
    expect(await db.note.count({ where: { orgId, body: { contains: 'Resume (text' } } })).toBe(0);
  });
});
