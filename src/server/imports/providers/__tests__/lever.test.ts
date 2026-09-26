import { describe, expect, it, vi } from 'vitest';
import { createHttpClient, ImportAuthError } from '@/server/imports/http';
import { catalogWriter, emptyCatalog } from '@/server/imports/mapping';
import { leverProvider } from '@/server/imports/providers/lever';
import { DEFAULT_IMPORT_OPTIONS, type Cursor, type Loader, type Phase, type PhaseContext, type RefKind } from '@/server/imports/types';
import {
  db,
  json,
  mockFetch,
  runImportForTest,
  verifyForTest,
  type RecordedCall,
  type RouteHandler,
} from '@/server/imports/__tests__/harness';
import { hasDb, publicDns } from '@/server/imports/__tests__/harness';

vi.mock('@/lib/session', () => ({ isAdmin: () => true }));

/**
 * Lever adapter against a mock of the Data API built from the payloads in
 * Lever's docs: Basic auth with the key as username, {data, next, hasNext}
 * envelopes with opaque offset tokens, created_at filters (both bounds
 * inclusive) on /opportunities, ms timestamps, slug stage ids in
 * stageChanges, the flat archivedAt/archiveReason variant, a bare-array
 * /files list, a bare-object /forms list, a 403 on /disposition_stages (older
 * keys), the doc's placeholder deletedAt, and a resume that redirects off the
 * API host to signed storage.
 */

const KEY = 'lever-test-key-4b1d9c';
const AUTH = `Basic ${Buffer.from(`${KEY}:`).toString('base64')}`;
const V1 = 'api.lever.co/v1';
const S3 = 'lever-client-files.s3.amazonaws.com';

// ---------- ids ----------

const RACHEL = 'df0adaa6-172c-4cd6-8520-49b203660fe1'; // matches the org admin by email
const CHANDLER = '8d49b010-cc6a-4f40-ace5-e86061c677ed'; // deactivated, no Source account
const JOSH = 'ecdb6670-d9f3-4b87-8267-1cde26d1bc42';
const MONICA = 'a0afa6f7-7bb5-4ff6-93c3-e215fbcf3b2e';

const NEW_APPLICANT = 'fff60592-31dd-4ebe-ba8e-e7a397c30f8e';
const NEW_LEAD = '51adb2bb-1e24-4135-9950-cb96e3886226';
const SCREEN = 'a42482ff-00ac-4cb2-a698-4b4436885b0c';
const PHONE = 'fe763d80-e612-4787-98bc-686679c6ac9b';
const ONSITE = 'fbfb4473-38d2-4acf-943b-28cc0ed7ba87';
const BACKGROUND = 'e7c6f8eb-9239-46b8-8777-ef4215cc8a7d';
const OFFER_STAGE = 'f48aad6f-91f7-4e87-b3f3-5e7a9207e54b';
const DELETED_STAGE = '3c8a1f0e-5b7d-4e2a-9c6f-1d4b8e2a7c90'; // in stageChanges, gone from /stages

const HIRED = '16308515-dc77-4aa7-b3af-96161b2b4e9b';
const UNDERQUALIFIED = '63dd55b2-a99f-4e7b-985f-22c7bf80ab42';
const OFFER_DECLINED = '1fdbfaac-4c73-45f7-af32-369054426364';

const P1 = 'f2f01e16-27f8-4711-a728-7d49499795a0';
const P2 = 'e540e665-06af-4888-a846-89eb36f2097d';
const P3 = '9026d1f1-a03b-49dc-8a17-5f448d1de52b';
const REQ1 = '52881d44-4f95-4fcb-bf28-2b344ea58889';
const REQ2 = 'b7c21c5e-0f3a-4c55-9d1e-6a7f2e3d4c5b';

const O1 = '250d8f03-738a-4bba-a671-8a3d73477145'; // active, 3 stage moves
const O2 = '5c86dcd8-6cf1-40da-9ae3-5e7ea91079f5'; // hired, offers
const O3 = '3410c8b9-5c31-4bab-b7e9-9f710206d647'; // rejected, confidential, flat archive fields, referral
const O4 = '7a1c55e2-2f0e-4c1b-9d3e-0b5a2f6c8d11'; // lead: no application, blank name, snoozed
const O5 = '0e9d8c7b-6a5f-4e3d-8c2b-1a0f9e8d7c6b'; // anonymized
const O6 = 'c2b4d6f8-1a3c-4e5f-9a7b-8c6d4e2f0a13'; // Shane's second candidacy
const C1 = '7f23e772-f2cb-4ebb-b33f-54b872999992';

const USER_TOKEN = '%5B1711931200000%2C%22a3f7%22%5D'; // arrives percent-encoded, like /file_actions

const R1 = '68b3e478-ff21-4529-bd29-23ed016042d7';
const COVER = 'b02a3b97-dc41-48e3-b003-44d211ed2a4c';
const OFFER_A = 'a72d66c0-0fd7-4bf8-99ce-dc5979358862';
const OFFER_B = '63662f8b-4c61-4e7e-afaa-73132a795a68';
const OFFER_C = '5d6e7f80-91a2-4b3c-8d4e-5f60718293a4';

/** The docs print this deletedAt on ordinary notes, feedback and forms. */
const PLACEHOLDER_DELETED_AT = 1526925087354;

// ---------- payloads ----------

const users = {
  page1: [
    { id: CHANDLER, name: 'Chandler Bing', username: 'chandler', email: 'chandler@brickly.io', createdAt: 1407357447018, deactivatedAt: 1409556487918, accessRole: 'super admin', photo: null },
    { id: JOSH, name: 'Josh Eckerman', username: 'josh', email: 'josh@brickly.io', createdAt: 1407357447018, deactivatedAt: null, accessRole: 'team member', photo: null },
  ],
  page2: [
    { id: RACHEL, name: 'Rachel Green', username: 'rachel', email: 'Admin@Example.test', createdAt: 1478035107621, deactivatedAt: null, accessRole: 'admin', photo: null },
    { id: MONICA, name: 'Monica Geller', username: 'monica', email: 'monica@brickly.io', createdAt: 1478035107621, deactivatedAt: null, accessRole: 'team member', photo: null },
  ],
};

const stages = [
  { id: NEW_APPLICANT, text: 'New applicant' },
  { id: NEW_LEAD, text: 'New lead' },
  { id: SCREEN, text: 'Recruiter Screen' },
  { id: PHONE, text: 'Phone Interview' },
  { id: ONSITE, text: 'On-Site Interview' },
  { id: BACKGROUND, text: 'Background Check' },
  { id: OFFER_STAGE, text: 'Offer' },
];

const archiveReasons = [
  { id: UNDERQUALIFIED, text: 'Underqualified', status: 'active', type: 'non-hired' },
  { id: '41f98875-06c7-4cb1-b3d0-07f7ae192c0c', text: 'Culture Fit', status: 'active', type: 'non-hired' },
  { id: '737b8899-7f32-42a5-954f-e199b0306fcb', text: 'Timing', status: 'active', type: 'non-hired' },
  { id: '3274b963-c37c-4465-abeb-1113896e2aa3', text: 'Withdrew', status: 'active', type: 'non-hired' },
  { id: OFFER_DECLINED, text: 'Offer declined', status: 'active', type: 'non-hired' },
  { id: HIRED, text: 'Hired', status: 'active', type: 'hired' },
  { id: '9b6f482e-0399-4ba4-9a2f-1e1d9e3da15b', text: 'Position filled', status: 'inactive', type: 'non-hired' },
];

const requisitions = [
  {
    id: REQ1,
    requisitionCode: 'ENG-145',
    name: 'Senior Software Engineer, Platform',
    backfill: false,
    confidentiality: 'confidential',
    createdAt: 1450296000000,
    headcountHired: 1,
    headcountTotal: 10,
    status: 'open',
    compensationBand: { currency: 'USD', interval: 'per-year-salary', min: 50000, max: 80000 },
    employmentStatus: 'full-time',
    postings: [P1],
    approval: { steps: [] },
    customFields: { target_hire_date: 1453320000000 },
  },
  {
    id: REQ2,
    requisitionCode: 'OPS-7',
    name: 'Office Operations',
    backfill: true,
    confidentiality: 'non-confidential',
    createdAt: 1450296000000,
    headcountHired: 0,
    headcountTotal: 'unlimited',
    status: 'onHold',
    compensationBand: { currency: 'USD', interval: 'per-hour-wage', min: 30, max: 45 },
    postings: [],
  },
];

const p1 = {
  id: P1,
  text: 'Infrastructure Engineer',
  createdAt: 1407779365624,
  updatedAt: 1407779365624,
  user: RACHEL,
  owner: RACHEL,
  hiringManager: RACHEL,
  confidentiality: 'non-confidential',
  categories: {
    team: 'Platform',
    department: 'Engineering',
    location: 'San Francisco',
    allLocations: ['San Francisco', 'New York City'],
    commitment: 'Full-time',
    level: 'Senior',
  },
  content: {
    description: 'The Infrastructure Engineer will act as...\\nSuperman.',
    descriptionHtml: '<div>The <u><b>Infrastructure Engineer</b></u> will act as...</div><div>Superman.</div>',
    lists: [{ text: 'Job requirements', content: '<li>Quick learner</li><li>Ambitious</li>' }],
    closing: 'Our company is proud to be an equal opportunity workplace.',
    closingHtml: '<div>Our company is proud to be an equal opportunity workplace.</div>',
  },
  country: 'US',
  followers: [RACHEL],
  tags: ['Platform'],
  state: 'published',
  distributionChannels: ['internal', 'public'],
  reqCode: 'ENG-145',
  requisitionCodes: ['ENG-145'],
  salaryRange: { max: 60000, min: 40000, currency: 'USD', interval: 'per-year-salary' },
  urls: { list: 'https://jobs.lever.co/brickly', show: `https://jobs.lever.co/brickly/${P1}/` },
  workplaceType: 'remote',
};

// Listed without `content`, so the adapter fetches the detail.
const p2List = {
  id: P2,
  text: 'Marketing Manager',
  createdAt: 1407779365624,
  updatedAt: 1417600000000,
  categories: { team: 'Growth', location: 'New York City', commitment: 'Part-time', level: null },
  tags: [],
  state: 'closed',
  distributionChannels: [],
  reqCode: null,
  requisitionCodes: [],
  salaryRange: { max: 45, min: 30, currency: 'USD', interval: 'per-hour-wage' },
  workplaceType: 'hybrid',
};
const p2Detail = { ...p2List, content: { description: 'Own our brand.', descriptionHtml: '<p>Own our <b>brand</b>.</p>', lists: [], closing: '', closingHtml: '' } };

// Published only to the internal job site: shows up only in the second pass.
const p3 = {
  id: P3,
  text: 'Office Manager',
  createdAt: 1420000000000,
  categories: { department: 'Operations', location: 'Oakland', commitment: 'Internship' },
  content: { description: 'Keep the office running.', descriptionHtml: '<p>Keep the office running.</p>', lists: [], closing: '', closingHtml: '' },
  tags: [],
  state: 'published',
  distributionChannels: ['internal'],
  requisitionCodes: [],
  workplaceType: 'onsite',
};

const nullHttpMeta = { ipAddress: null, referer: null, userAgent: null, acceptLanguage: null, timezone: null };

/** An opportunity as Lever lists it; the mock only reads these fields. */
type OppFixture = { id: string; createdAt: number; confidentiality?: string; isAnonymized?: boolean; [field: string]: unknown };

const opportunities: OppFixture[] = [
  {
    id: O1,
    name: 'Shane Smith',
    headline: 'Brickly LLC, Vandelay Industries, Inc, Central Perk',
    contact: C1,
    emails: ['shane@exampleq3.com', 'Shane@ExampleQ3.com'],
    phones: [{ value: '(123) 456-7891' }],
    confidentiality: 'non-confidential',
    location: 'Oakland',
    locationDetails: { city: 'Oakland', region: 'CA', country: 'US' },
    links: ['indeed.com/r/Shane-Smith/0b7c87f6b246d2bc', 'https://linkedin.com/in/shanesmith'],
    createdAt: 1407460071043,
    updatedAt: 1417587916150,
    lastInteractionAt: 1417588008760,
    lastAdvancedAt: 1417587916150,
    snoozedUntil: null,
    archived: null,
    stage: { id: ONSITE, text: 'On-Site Interview' },
    stageChanges: [
      { toStageId: 'applicant-new', toStageIndex: 1, userId: null, updatedAt: 1407460071043 },
      { toStageId: PHONE, toStageIndex: 3, userId: CHANDLER, updatedAt: 1410000000000 },
      { toStageId: DELETED_STAGE, toStageIndex: 4, userId: RACHEL, updatedAt: 1415000000000 },
      { toStageId: ONSITE, toStageIndex: 4, userId: RACHEL, updatedAt: 1417587916150 },
    ],
    owner: RACHEL,
    followers: [RACHEL],
    tags: ['San Francisco', 'Full-time'],
    sources: ['LinkedIn'],
    origin: 'sourced',
    sourcedBy: RACHEL,
    applications: [
      {
        id: 'cdb4ff13-f7aa-49b0-b6ec-eb4617009cfa',
        opportunityId: O1,
        candidateId: O1,
        createdAt: 1407460071043,
        type: 'user',
        posting: P1,
        postingOwner: RACHEL,
        postingHiringManager: RACHEL,
        user: RACHEL,
        name: null,
        email: null,
        phone: null,
        company: null,
        links: null,
        comments: null,
        resume: null,
        customQuestions: null,
        archived: null,
        requisitionForHire: null,
        ...nullHttpMeta,
      },
    ],
    resume: null,
    urls: { list: 'https://hire.lever.co/candidates', show: `https://hire.lever.co/candidates/${O1}` },
    dataProtection: { store: { allowed: true, expiresAt: 1522540800000 }, contact: { allowed: false, expiresAt: null } },
    isAnonymized: false,
  },
  {
    id: O2,
    name: 'Chaofan West',
    headline: 'Grunnings, Inc., Coffee Bean, Ltd',
    contact: 'bd4d81c8-7858-4624-be98-552dfb9ca850',
    emails: ['chaofan@example.com'],
    phones: [{ value: '(123) 456-7892' }],
    confidentiality: 'non-confidential',
    location: 'San Francisco',
    locationDetails: {},
    links: [],
    createdAt: 1407778275799,
    updatedAt: 1417600000000,
    lastAdvancedAt: 1417587903121,
    archived: { archivedAt: 1417600000000, reason: HIRED },
    stage: { id: 'offer', text: 'Offer' },
    stageChanges: [
      { toStageId: 'applicant-new', toStageIndex: 1, userId: null, updatedAt: 1407778275799 },
      { toStageId: 'offer', toStageIndex: 6, userId: JOSH, updatedAt: 1417587903121 },
    ],
    owner: JOSH,
    followers: [],
    tags: ['Marketing', 'Full-time'],
    sources: ['Posting'],
    origin: 'applied',
    sourcedBy: null,
    applications: [
      {
        id: 'e326d6e6-e3f6-46eb-9c14-6f90b88aacac',
        opportunityId: O2,
        candidateId: O2,
        createdAt: 1407778275799,
        type: 'posting',
        posting: P2,
        user: null,
        name: 'Chaofan West',
        email: 'chaofan@example.com',
        phone: { type: null, value: '(123) 456-7892' },
        company: 'Grunnings, Inc.',
        links: ['https://chaofan.dev'],
        comments: 'Excited about this role.',
        resume: null,
        customQuestions: [
          {
            type: 'posting',
            text: 'Marketing Manager',
            fields: [{ type: 'text', text: 'What role most interests you?', description: '', required: false, value: 'Brand' }],
          },
        ],
        archived: { archivedAt: 1417600000000, reason: HIRED },
        requisitionForHire: { id: REQ2, requisitionCode: 'OPS-7', hiringManagerOnHire: JOSH },
        ipAddress: '203.0.113.42',
        referer: 'https://boards.lever.co/job',
        userAgent: 'Mozilla/5.0',
        acceptLanguage: 'en-US',
        timezone: 'America/New_York',
      },
    ],
    urls: { show: `https://hire.lever.co/candidates/${O2}` },
    dataProtection: null,
    isAnonymized: false,
  },
  {
    id: O3,
    name: 'Teresa Lisbon',
    headline: 'CBI',
    contact: 'c38e60e9-5992-45e5-8f81-d4b2d65c95b1',
    emails: ['teresa@example.org'],
    phones: [],
    confidentiality: 'confidential',
    location: 'Sacramento',
    links: [],
    createdAt: 1417000000000,
    lastAdvancedAt: 1417500000000,
    // The docs' own opportunity example uses these flat keys instead of `archived`.
    archivedAt: 1418000000000,
    archiveReason: UNDERQUALIFIED,
    stage: { id: PHONE, text: 'Phone Interview' },
    stageChanges: [
      { toStageId: 'applicant-new', toStageIndex: 1, userId: null, updatedAt: 1417000000000 },
      { toStageId: PHONE, toStageIndex: 3, userId: MONICA, updatedAt: 1417500000000 },
    ],
    owner: MONICA,
    tags: [],
    sources: ['Referral', 'Employee Referral Program'],
    origin: 'referred',
    applications: [
      { id: '7988b225-3cc1-44f3-8fcb-bae013cc490d', opportunityId: O3, createdAt: 1417000000000, type: 'referral', posting: P1, user: MONICA, customQuestions: [], archived: null, requisitionForHire: null, ...nullHttpMeta },
    ],
    isAnonymized: false,
  },
  {
    id: O4,
    name: '  ',
    headline: '',
    contact: 'd4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70',
    emails: ['Kristoff@Arendelle.test'],
    phones: [{ type: 'mobile', value: '555-0100' }],
    location: '',
    links: ['github.com/kristoff'],
    createdAt: 1419000000000,
    lastAdvancedAt: 1419000000000,
    snoozedUntil: 1421000000000,
    archived: null,
    stage: { id: NEW_LEAD, text: 'New lead' },
    stageChanges: [{ toStageId: NEW_LEAD, toStageIndex: 0, userId: JOSH, updatedAt: 1419000000000 }],
    owner: JOSH,
    tags: ['Sourcing sprint'],
    sources: ['GitHub'],
    origin: 'sourced',
    applications: [],
    isAnonymized: false,
  },
  {
    id: O5,
    name: '',
    contact: 'e0f1a2b3-c4d5-4e6f-8a9b-0c1d2e3f4a5b',
    emails: [],
    phones: [],
    links: [],
    createdAt: 1419500000000,
    archived: null,
    stage: { id: NEW_APPLICANT, text: 'New applicant' },
    stageChanges: [],
    applications: [],
    isAnonymized: true,
  },
  {
    id: O6,
    name: 'Shane Smith',
    contact: C1,
    emails: ['shane@exampleq3.com'],
    phones: [],
    links: [],
    createdAt: 1420000000000,
    lastAdvancedAt: 1420000000000,
    archived: null,
    stage: { id: NEW_APPLICANT, text: 'New applicant' },
    stageChanges: [],
    owner: null,
    tags: [],
    sources: ['Posting'],
    origin: 'applied',
    applications: [{ id: '9d8c7b6a-5f4e-4d3c-8b2a-190817263544', opportunityId: O6, createdAt: 1420000000000, type: 'posting', posting: P2, archived: null, requisitionForHire: null, ...nullHttpMeta }],
    isAnonymized: false,
  },
];

const scoreOptions = [{ text: '4 - Strong Hire' }, { text: '3 - Hire' }, { text: '2 - No Hire' }, { text: '1 - Strong No Hire' }];

/** Per-opportunity sub-resources; anything not listed is an empty page. */
const children: Record<string, Record<string, unknown>> = {
  [O1]: {
    interviews: [
      {
        id: '6ff55c8e-fe04-4eb4-835a-630b1c0da421',
        panel: 'fdb313e8-13c5-47de-9e51-6a21a4d76ff6',
        subject: 'On-site interview - Shane Smith - Infrastructure Engineer',
        note: 'SCHEDULE:\n6:00 - 6:30 pm - Rachel Green',
        interviewers: [
          { email: 'admin@example.test', id: RACHEL, name: 'Rachel Green', feedbackTemplate: '7fdd449e-0bb1-4ac8-9b96-9281c1dc2099' },
          { email: 'chandler@brickly.io', id: CHANDLER, name: 'Chandler Bing' },
        ],
        timezone: 'America/Los_Angeles',
        createdAt: 1417000000000,
        date: 1417590000000,
        duration: 30,
        location: 'Room 4',
        feedbackTemplate: '7fdd449e-0bb1-4ac8-9b96-9281c1dc2099',
        feedbackForms: ['c64fb192-d6d8-42dc-ac82-47cb87e9839c'],
        feedbackReminder: 'once',
        user: RACHEL,
        stage: ONSITE,
        canceledAt: null,
        postings: [P1],
        conferences: [{ source: 'Zoom Meeting', entryPoints: [{ type: 'video', uri: 'https://zoom.us/j/1234567890', password: null }] }],
      },
    ],
    feedback: [
      {
        id: 'c64fb192-d6d8-42dc-ac82-47cb87e9839c',
        type: 'interview',
        text: 'On-site interview',
        instructions: 'Ask about goals, fears and hopes.',
        fields: [
          { id: '6ee25ace', type: 'score-system', text: 'Rating', description: '', required: true, prompt: 'Select one', options: scoreOptions, value: '4 - Strong Hire' },
          {
            id: '3d513091',
            type: 'scorecard',
            text: 'Skills assessment',
            description: '',
            required: false,
            scores: [{ text: 'Design Skills', description: '' }, { text: 'Communication', description: '' }],
            value: [{ score: 4, comment: 'Very confident' }, { score: 0, comment: null }],
          },
          { id: 'c7163a77', type: 'score', text: 'Communication', description: '', required: false, value: 3 },
          { id: '142225b2', type: 'textarea', text: 'Notes / Comments', description: '', required: true, value: 'Had a great conversation with Shane.' },
          { id: '639f4227', type: 'yes-no', text: 'Would you work with this person?', description: '', required: false, value: 'yes' },
        ],
        baseTemplateId: 'a12851f5-25cd-495b-9dae-b29b02d0b49d',
        interview: '6ff55c8e-fe04-4eb4-835a-630b1c0da421',
        panel: 'fdb313e8-13c5-47de-9e51-6a21a4d76ff6',
        user: RACHEL,
        createdAt: 1417591000000,
        updatedAt: 1417591000100,
        completedAt: 1417592000000,
        deletedAt: null,
      },
      {
        // A shared-form comment with no overall decision → kept as a note
        id: 'd2f7a1c3-5b6e-4f80-9a1b-2c3d4e5f6a7b',
        type: 'share',
        text: 'Culture add',
        fields: [{ id: 'aa11', type: 'textarea', text: 'Thoughts', description: '', required: false, value: 'Great energy, needs a second look on systems depth.' }],
        interview: null,
        user: CHANDLER,
        createdAt: 1417595000000,
        completedAt: 1417595000000,
        deletedAt: null,
      },
      {
        id: 'e9b8a7c6-d5e4-4f3a-8b2c-1d0e9f8a7b6c',
        type: 'interview',
        text: 'Deleted form',
        fields: [{ id: 'bb22', type: 'score-system', text: 'Rating', options: scoreOptions, value: '1 - Strong No Hire' }],
        user: RACHEL,
        createdAt: 1417596000000,
        completedAt: 1417596000000,
        deletedAt: PLACEHOLDER_DELETED_AT,
      },
    ],
    notes: [
      {
        id: 'b1dbbcfe-281c-46a0-8f51-57049158d3f3',
        text: 'Note',
        fields: [
          { type: 'note', text: 'Comment', value: '@chandler We should move forward with Shane.', createdAt: 1420312438110, user: RACHEL, score: 3, stage: ONSITE },
          { type: 'note', text: 'Comment', value: 'Sounds great! I will send him an email this week.', createdAt: 1421715919765, user: CHANDLER, score: null, stage: ONSITE },
        ],
        user: RACHEL,
        secret: false,
        completedAt: 1420312438111,
        createdAt: 1420312438111,
        deletedAt: null,
      },
      {
        id: '5e6f7a8b-9c0d-4e1f-a2b3-c4d5e6f7a8b9',
        text: 'Note',
        fields: [{ type: 'note', text: 'Comment', value: 'Comp expectations: confidential.', createdAt: 1420400000000, user: RACHEL, score: null }],
        user: RACHEL,
        secret: true,
        createdAt: 1420400000000,
        deletedAt: null,
      },
    ],
    // The docs print the profile-forms list as one bare form, with no {data} envelope.
    forms: {
      id: 'd0cc2b88-ccd4-4947-8f1b-97df6166904b',
      type: 'form',
      text: 'Offer information',
      instructions: 'Please complete all required questions.',
      baseTemplateId: '806ad14a-2fe5-4b42-b2da-3f90dc0a16d9',
      fields: [
        { type: 'date', text: 'Start date', description: '', required: false, id: '1ebc1934-469c-482b-9c84-031fa1e2d6d8', value: 1418716800000 },
        { type: 'currency', text: 'Compensation', description: 'Please enter only whole numbers, no commas or letters', required: false, id: '65bb5ce8-0478-4ed8-8aea-2d8b5f622c58', value: 50000, currency: 'USD' },
        { type: 'yes-no', text: 'Eligible for benefits?', description: '', required: false, id: 'b3d856fa-17f0-4205-a139-ba5cf41061d3', value: 'yes' },
        { type: 'text', text: 'Manager', description: '', required: false, id: 'ad58ff3d-af59-4a36-8560-c93060df14eb', value: 'Jen' },
        { type: 'textarea', text: 'Notes', description: '', required: false, id: '6a9e2b13-26eb-4ff8-b1d5-61ffcc1de8e8', value: null },
      ],
      user: RACHEL,
      stage: ONSITE,
      completedAt: 1417587426973,
      createdAt: 1417587426973,
      deletedAt: null,
    },
    resumes: [
      {
        id: R1,
        createdAt: 1468953420000,
        file: { name: 'ShaneSmithResume.pdf', ext: 'pdf', downloadUrl: `https://hire.lever.co/candidates/${O1}/resumes/${R1}/download`, uploadedAt: 1468953420004, status: 'processed', size: 1000 },
        parsedData: { positions: [{ org: 'Brickly LLC', title: 'SRE' }], schools: [] },
      },
      {
        id: '14408ec1-1a41-48ba-ac76-cb3700c13d89',
        createdAt: 1407460071043,
        file: { name: 'Shane-Corrupted-File.pdf', ext: 'pdf', uploadedAt: 1407460071048, status: 'error', size: 3000 },
      },
      { id: '2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f', createdAt: 1407460071000, parsedData: { positions: [], schools: [] } },
    ],
    // The docs print this list as a bare array with stringly-typed numbers.
    files: [
      {
        id: COVER,
        downloadUrl: `https://hire.lever.co/candidates/${O1}/files/${COVER}/download`,
        ext: '.pdf',
        name: 'ShaneSmithCoverLetter.pdf',
        uploadedAt: '1468953420000',
        status: 'processed',
        size: '1000',
      },
    ],
  },
  [O2]: {
    offers: [
      {
        id: OFFER_A,
        createdAt: 1475540115263,
        status: 'signed',
        creator: RACHEL,
        approvedAt: 1475600000000,
        sentAt: 1475700000000,
        fields: [
          { text: 'Job posting', identifier: 'job_posting', value: '80fd493b-3e01-4e05-82df-464d3ae2a7b8' },
          { text: 'Job title', identifier: 'job_title', value: 'Back End Software Engineer' },
          { text: 'Candidate name', identifier: 'candidate_name', value: 'Chaofan West' },
          { text: 'Offered compensation amount', identifier: 'salary_amount', value: 1319000 },
          { text: 'Compensation currency', identifier: 'compensation_currency', value: 'USD' },
          { text: 'Type of earnings', identifier: 'salary_interval', value: 'per-year-salary' },
          { text: 'Hiring manager', identifier: 'hiring_manager', value: JOSH },
          { text: "Today's date", identifier: 'today_date', value: 1475540150185 },
          { text: 'Anticipated start date', identifier: 'anticipated_start_date', value: 1475540150185 },
          { text: 'equity', identifier: 'custom_equity', value: 12345 },
          { text: 'Signing bonus', identifier: 'custom_signing_bonus', value: '10000' },
        ],
        signatures: {
          candidate: { role: 'candidate', name: 'Chaofan West', email: 'chaofan@example.com', firstOpenedAt: 1475710000000, lastOpenedAt: 1475720000000, signedAt: 1475730000000, signed: true },
          company_1: { role: 'company', name: 'Chandler Bing', email: 'chandler@brickly.io', signedAt: 1475660000000, signed: true },
        },
        sentDocument: { fileName: 'employment-offer-letter.pdf', uploadedAt: 1582910091572, downloadUrl: `https://api.lever.co/v1/opportunities/${O2}/offers/${OFFER_A}/download?status=sent` },
        signedDocument: { fileName: 'employment-offer-letter_signed.pdf', uploadedAt: 1582910097572, downloadUrl: `https://api.lever.co/v1/opportunities/${O2}/offers/${OFFER_A}/download?status=signed` },
      },
      {
        id: OFFER_B,
        createdAt: 1475819157595,
        status: 'draft',
        creator: 'dc15f004-e071-4d21-ba63-a842d4fa3c52',
        fields: [
          { text: 'Job title', identifier: 'job_title', value: 'Front End Software Engineer' },
          { text: 'Offered compensation amount', identifier: 'salary_amount', value: 125000 },
          { text: 'Compensation currency', identifier: 'compensation_currency', value: 'EUR' },
        ],
        sentDocument: null,
        signedDocument: null,
      },
      {
        // Declined, then hired on another offer: the candidacy's archive date is the hire, not this decline.
        id: OFFER_C,
        createdAt: 1475400000000,
        status: 'denied',
        creator: JOSH,
        sentAt: 1475450000000,
        fields: [
          { text: 'Job title', identifier: 'job_title', value: 'Barista' },
          { text: 'Offered compensation amount', identifier: 'salary_amount', value: 45 },
          { text: 'Compensation currency', identifier: 'compensation_currency', value: 'USD' },
          { text: 'Type of earnings', identifier: 'salary_interval', value: 'per-hour-wage' },
        ],
        sentDocument: null,
        signedDocument: null,
      },
    ],
  },
  [O3]: {
    feedback: [
      {
        id: 'f4a5b6c7-d8e9-4f0a-9b1c-2d3e4f5a6b7c',
        type: 'interview',
        text: 'Phone screen',
        fields: [
          // The docs' verbatim variant: the overall rating as a "score" with a string value.
          { id: '6ee25ace', type: 'score', text: 'Rating', description: '', required: true, value: '2 - No Hire', prompt: 'Select one', options: scoreOptions },
          { id: 'cc33', type: 'textarea', text: 'Notes / Comments', description: '', required: true, value: 'Not enough depth in operations.' },
        ],
        interview: null,
        user: JOSH,
        createdAt: 1417400000000,
        completedAt: 1417400500000,
        deletedAt: null,
      },
    ],
    notes: [
      {
        id: '8f9e0d1c-2b3a-4c5d-8e7f-6a5b4c3d2e1f',
        text: 'Note',
        fields: [{ type: 'note', text: 'Comment', value: 'Referred by Monica; strong ops background.', createdAt: 1417100000000, user: MONICA, score: 2 }],
        user: MONICA,
        secret: false,
        createdAt: 1417100000000,
        deletedAt: null,
      },
      {
        id: '9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d',
        text: 'Note',
        fields: [{ type: 'note', text: 'Comment', value: 'Old thought, since deleted.', createdAt: 1417050000000, user: MONICA, score: null }],
        user: MONICA,
        secret: false,
        createdAt: 1417050000000,
        deletedAt: PLACEHOLDER_DELETED_AT,
      },
    ],
    referrals: [
      {
        id: '093e77a4-7424-4420-962a-41b4936630b4',
        type: 'referral',
        text: 'Referral',
        instructions: 'Ask about goals, fears and hopes.',
        fields: [
          { type: 'text', text: 'Name of referrer', description: '', required: true, value: 'Monica Geller' },
          {
            type: 'dropdown',
            text: 'Relationship',
            description: '',
            required: true,
            prompt: 'Select one',
            options: [{ text: 'Former colleague' }, { text: 'Friend' }, { text: 'Reputation' }, { text: 'Other' }, { text: "Don't know this person" }],
            value: 'Reputation',
          },
          { type: 'textarea', text: 'Notes / Comments', description: '', required: true, value: 'Teresa comes recommended by an old coworker of mine.' },
        ],
        baseTemplateId: 'e0257243-fad1-45da-90ef-34b7fc8c699c',
        user: MONICA,
        referrer: MONICA,
        stage: PHONE,
        createdAt: 1417000500000,
        completedAt: 1417000500000,
      },
    ],
  },
};

const SUBS = ['interviews', 'feedback', 'notes', 'forms', 'referrals', 'offers', 'resumes', 'files'];

// ---------- the mock API ----------

const NOT_AUTHORIZED = {
  code: 'NotAuthorized',
  message: 'Authentication incorrect. The key you provided appears to be invalid. You may want to double-check you typed it correctly.',
};
const NO_ACCESS = { code: 'NotAuthorized', message: 'The key you provided does not have access to this endpoint' };
const INVALID_OFFSET = { code: 'BadRequestError', message: 'Invalid offset' };

const page = (data: unknown[], next?: string) => json(next ? { data, next, hasNext: true } : { data, hasNext: false });

/**
 * GET /opportunities as Lever pages it: created_at bounds (both inclusive),
 * confidentiality, and opaque offset tokens that only work for the query
 * that issued them. `pageSize` stands in for a full page of 100.
 */
function opportunityList(all: OppFixture[], url: URL, pageSize: number): Response {
  const start = url.searchParams.get('created_at_start');
  const end = url.searchParams.get('created_at_end');
  const conf = url.searchParams.get('confidentiality') === 'all';
  const list = all.filter(
    (o) =>
      (conf || o.confidentiality !== 'confidential') &&
      (start === null || o.createdAt >= Number(start)) &&
      (end === null || o.createdAt <= Number(end)),
  );
  const range = `${start ?? '-'}~${end ?? '-'}~${conf}`;
  let pos = 0;
  const offset = url.searchParams.get('offset');
  if (offset) {
    const m = /^0\.(\d+)\.(.+)$/.exec(offset);
    if (!m || m[2] !== range) return json(INVALID_OFFSET, { status: 400 });
    pos = Number(m[1]);
  }
  const data = list.slice(pos, pos + pageSize);
  return pos + pageSize < list.length ? page(data, `0.${pos + pageSize}.${range}`) : page(data);
}

function lever(handler: (url: URL) => Response | Promise<Response>): RouteHandler {
  return ({ url, headers }) => (headers.authorization === AUTH ? handler(url) : json(NOT_AUTHORIZED, { status: 403 }));
}

type ApiOptions = {
  confidentialAccess?: boolean;
  /** Stands in for Lever's page size of 100, so a handful of fixtures spans several pages. */
  oppPageSize?: number;
  /** A key without users:read. */
  usersDenied?: boolean;
  /** Downloads this key may list but not fetch. */
  deniedDownloads?: ('offer' | 'resume')[];
};

function leverApi(opts: ApiOptions = {}) {
  const downloads = { resume: 0, s3: 0, cover: 0, offer: 0 };
  const confidential = opts.confidentialAccess ?? true;
  const needsConfidential = (url: URL) => url.searchParams.get('confidentiality') === 'all' && !confidential;
  const deniedDownload = (kind: 'offer' | 'resume') => opts.deniedDownloads?.includes(kind);

  const routes: Record<string, RouteHandler> = {
    [`GET ${V1}/users`]: lever((url) => {
      if (opts.usersDenied) return json(NO_ACCESS, { status: 403 });
      return url.searchParams.get('offset') === decodeURIComponent(USER_TOKEN) ? page(users.page2) : page(users.page1, USER_TOKEN);
    }),
    [`GET ${V1}/stages`]: lever(() => json({ data: stages })), // no hasNext, like the docs
    [`GET ${V1}/disposition_stages`]: lever(() => json(NO_ACCESS, { status: 403 })),
    [`GET ${V1}/archive_reasons`]: lever(() => json({ data: archiveReasons })),
    [`GET ${V1}/requisitions`]: lever((url) =>
      needsConfidential(url) ? json(NO_ACCESS, { status: 403 }) : page(requisitions.filter((r) => confidential || r.confidentiality !== 'confidential')),
    ),
    [`GET ${V1}/postings`]: lever((url) => {
      if (needsConfidential(url)) return json(NO_ACCESS, { status: 403 });
      // Lever leaves internal-only published postings out unless both distribution channels are asked for.
      if (url.searchParams.get('state') === 'published') {
        return page(url.searchParams.getAll('distributionChannel').includes('internal') ? [p1, p3] : [p1]);
      }
      return page([p1, p2List]);
    }),
    [`GET ${V1}/postings/${P2}`]: lever(() => json({ data: p2Detail })),
    [`GET ${V1}/opportunities`]: lever((url) =>
      needsConfidential(url) ? json(NO_ACCESS, { status: 403 }) : opportunityList(opportunities, url, opts.oppPageSize ?? 2),
    ),
    [`GET ${V1}/opportunities/${O1}/resumes/${R1}/download`]: lever(() => {
      if (deniedDownload('resume')) return json(NO_ACCESS, { status: 403 });
      downloads.resume++;
      return new Response(null, { status: 302, headers: { location: `https://${S3}/resumes/${R1}.pdf?X-Amz-Expires=300&X-Amz-Signature=abc123` } });
    }),
    [`GET ${S3}/resumes/${R1}.pdf`]: () => {
      downloads.s3++;
      return new Response('%PDF-1.4\n% Shane Smith resume\n%%EOF', { headers: { 'content-type': 'application/pdf' } });
    },
    [`GET ${V1}/opportunities/${O1}/files/${COVER}/download`]: lever(() => {
      downloads.cover++;
      return new Response('%PDF-1.4\n% cover letter\n%%EOF', { headers: { 'content-type': 'application/pdf' } });
    }),
    [`GET ${V1}/opportunities/${O2}/offers/${OFFER_A}/download`]: lever((url) => {
      if (deniedDownload('offer')) return json(NO_ACCESS, { status: 403 });
      if (url.searchParams.get('status') !== 'signed') return json({ code: 'BadRequest', message: 'wrong document' }, { status: 400 });
      downloads.offer++;
      return new Response('%PDF-1.4\n% signed offer\n%%EOF', {
        headers: { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="employment-offer-letter_signed.pdf"' },
      });
    }),
  };
  // Every imported opportunity gets all sub-resource routes; the anonymized one gets none.
  for (const opp of opportunities) {
    if (opp.isAnonymized) continue;
    for (const sub of SUBS) {
      routes[`GET ${V1}/opportunities/${opp.id}/${sub}`] = lever(() => {
        const data = children[opp.id]?.[sub] ?? [];
        return !Array.isArray(data) || sub === 'files' ? json(data) : page(data);
      });
    }
  }
  return { ...mockFetch(routes), downloads };
}

function ms(n: number) {
  return new Date(n).toISOString();
}

/**
 * The created_at windows each crawl of /opportunities read, one entry per
 * phase in call order: first-page requests only, the leading whole-range
 * probe left out, a window read twice (after a rejected offset) kept once.
 */
function crawls(calls: RecordedCall[], lo: number | null) {
  const out: { expand: boolean; windows: [number, number][] }[] = [];
  for (const c of calls) {
    if (c.url.pathname !== '/v1/opportunities' || c.url.searchParams.get('offset')) continue;
    const s = c.url.searchParams.get('created_at_start');
    const e = c.url.searchParams.get('created_at_end');
    if (e === null && (s === null ? lo === null : Number(s) === lo)) {
      out.push({ expand: c.url.searchParams.has('expand'), windows: [] });
      continue;
    }
    const windows = out[out.length - 1].windows;
    const w: [number, number] = [s === null ? -Infinity : Number(s), e === null ? Infinity : Number(e)];
    const last = windows[windows.length - 1];
    if (!last || last[0] !== w[0] || last[1] !== w[1]) windows.push(w);
  }
  return out;
}

/** Windows cover [lo, ∞) exactly once: no gap, no overlap. */
function expectTiled(windows: [number, number][], lo: number | null) {
  const sorted = [...windows].sort((a, b) => a[0] - b[0]);
  expect(sorted[0][0]).toBe(lo ?? -Infinity);
  for (let i = 1; i < sorted.length; i++) expect(sorted[i][0]).toBe(sorted[i - 1][1] + 1);
  expect(sorted[sorted.length - 1][1]).toBe(Infinity);
}

// ---------- no-DB helpers for phase-level checks ----------

function phaseContext(fetchImpl: typeof fetch, has: (kind: RefKind, id: string) => boolean = () => false) {
  const http = createHttpClient({ resolveHost: publicDns, auth: leverProvider.auth({ apiKey: KEY }), minIntervalMs: 0, fetchImpl });
  const catalog = emptyCatalog();
  const warnings: string[] = [];
  const loaded: Record<string, unknown[]> = {};
  const load = new Proxy({} as Loader, {
    get: (_target, kind: string) =>
      kind === 'has'
        ? async (k: RefKind, id: string) => has(k, id)
        : async (record: unknown) => {
            (loaded[kind] ??= []).push(record);
          },
  });
  const ctx: PhaseContext = {
    http,
    catalog: catalogWriter(catalog),
    load,
    options: DEFAULT_IMPORT_OPTIONS,
    since: null,
    outOfTime: () => false,
    warn: (message) => warnings.push(message),
  };
  return { ctx, http, catalog, warnings, loaded };
}

async function runPhase(phase: Phase, ctx: PhaseContext, roundTrip = false) {
  let cursor: Cursor | null = null;
  for (let i = 0; i < 1_000; i++) {
    cursor = await phase.run(ctx, cursor);
    if (cursor === null) return i + 1;
    if (roundTrip) cursor = JSON.parse(JSON.stringify(cursor)) as Cursor; // as the runner stores it
  }
  throw new Error(`${phase.id} did not finish`);
}

function loadPhase(ctx: PhaseContext, id: string): Phase {
  return leverProvider.create({ apiKey: KEY }, ctx.http).load.find((p) => p.id === id)!;
}

// ---------- tests ----------

describe.skipIf(!hasDb)('Lever adapter', () => {
  it('builds without credentials and lists its phases', () => {
    const http = createHttpClient({ resolveHost: publicDns, auth: { hosts: [] }, minIntervalMs: 0 });
    const adapter = leverProvider.create({}, http);
    expect(adapter.discover.map((p) => p.id)).toEqual(['users', 'stages', 'reasons']);
    expect(adapter.load.map((p) => p.id)).toEqual([
      'requisitions',
      'postings',
      'candidates',
      'interviews',
      'feedback',
      'notes',
      'offers',
      'files',
    ]);
    expect(leverProvider.auth({}).headers).toEqual({});
    expect(leverProvider.auth({ apiKey: KEY }).hosts).toEqual(['api.lever.co', 'api.eu.lever.co', 'api.sandbox.lever.co']);
  });

  it('verify() sends Basic auth with the key as username and names the account by email domain', async () => {
    const api = leverApi();
    await expect(verifyForTest(leverProvider, { apiKey: KEY }, api.impl)).resolves.toEqual({ accountName: 'brickly.io' });
    expect(api.calls).toHaveLength(1);
    const [call] = api.calls;
    expect(`${call.url.host}${call.url.pathname}`).toBe(`${V1}/users`);
    expect(call.headers.authorization).toBe(AUTH);
    expect(call.url.searchParams.get('limit')).toBe('100');
    expect(call.url.toString()).not.toContain(KEY);

    // Lever answers a wrong key with 403 everywhere; the adapter reports it as rejected credentials.
    const bad = leverApi();
    const err = await verifyForTest(leverProvider, { apiKey: 'not-the-key' }, bad.impl).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImportAuthError);
    expect((err as ImportAuthError).status).toBe(401);
    expect(bad.calls.map((c) => c.url.pathname)).toEqual(['/v1/users', '/v1/postings']);
  });

  it('verify() accepts a valid key that only lacks users:read, and names the account from the job site', async () => {
    const api = leverApi({ usersDenied: true });
    await expect(verifyForTest(leverProvider, { apiKey: KEY }, api.impl)).resolves.toEqual({ accountName: 'Brickly' });
    expect(api.calls.map((c) => `${c.url.pathname}?limit=${c.url.searchParams.get('limit')}`)).toEqual([
      '/v1/users?limit=100',
      '/v1/postings?limit=1',
    ]);
  });

  it('discovery groups built-in slug stages with their UUID twins, takes order and type from disposition stages, and adds a Hired stage', async () => {
    const dispositionFetch = mockFetch({
      [`GET ${V1}/disposition_stages`]: () =>
        json({
          data: {
            stages: [
              { id: 'lead-new', text: 'New lead', pipeline: 'lead', rank: 0, hasInterview: false },
              { id: 'applicant-new', text: 'New applicant', pipeline: 'applicant', rank: 100, hasInterview: false },
              { id: SCREEN, text: 'Recruiter screen', pipeline: 'screen', rank: 200, hasInterview: true },
              { id: ONSITE, text: 'On-site interview', pipeline: 'onsite', rank: 300, hasInterview: true },
              { id: 'offer', text: 'Offer', pipeline: 'offer', rank: 400, hasInterview: false },
            ],
            archiveReasons: [{ id: HIRED, text: 'Hired', type: 'hired', status: 'active' }],
          },
        }),
      [`GET ${V1}/stages`]: () => json({ data: stages }),
      [`GET ${V1}/users`]: ({ url }) => (url.searchParams.get('offset') ? page(users.page2) : page(users.page1, USER_TOKEN)),
    });
    const { ctx, catalog, warnings } = phaseContext(dispositionFetch.impl);
    const adapter = leverProvider.create({ apiKey: KEY }, ctx.http);
    for (const phase of adapter.discover.slice(0, 2)) await runPhase(phase, ctx);

    expect(catalog.users.map((u) => u.email).sort()).toEqual([
      'admin@example.test',
      'chandler@brickly.io',
      'josh@brickly.io',
      'monica@brickly.io',
    ]);
    const group = (key: string) => catalog.stages.find((g) => g.key === key)!;
    expect(group('new applicant').externalIds.sort()).toEqual(['applicant-new', NEW_APPLICANT].sort());
    expect(group('new applicant').typeHint).toBe('APPLICANT');
    expect(group('offer').externalIds.sort()).toEqual(['offer', OFFER_STAGE].sort());
    expect(group('offer').typeHint).toBe('OFFER');
    expect(group('on-site interview')).toMatchObject({ externalIds: [ONSITE], typeHint: 'ONSITE', position: 300 });
    expect(group('recruiter screen').typeHint).toBe('SCREEN');
    expect(group('background check')).toMatchObject({ typeHint: null, position: 5 }); // not in disposition: list order
    expect(group('hired')).toMatchObject({ externalIds: ['lever:hired'], typeHint: 'HIRED' });
    expect(warnings).toEqual([]);
    expect(dispositionFetch.unmatched).toEqual([]);
  });

  it('retries without confidentiality=all when the key lacks confidential access, and says so', async () => {
    const api = leverApi({ confidentialAccess: false });
    const { ctx, warnings, loaded } = phaseContext(api.impl);
    await runPhase(loadPhase(ctx, 'requisitions'), ctx);
    expect((loaded.requisition as { code: string }[]).map((r) => r.code)).toEqual(['OPS-7']);
    expect(warnings).toEqual([expect.stringContaining('Allow access to confidential data'), expect.stringContaining('unlimited headcount')]);
    expect(api.calls.map((c) => c.url.searchParams.get('confidentiality'))).toEqual(['all', null]);
  });

  it('resumes mid-page from a JSON cursor, oldest first, and re-reads only the current window when Lever rejects a saved offset', async () => {
    const api = leverApi();
    const rejected = new Set<string>();
    const flaky = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const offset = url.searchParams.get('offset');
      if (url.pathname === '/v1/opportunities' && offset && !rejected.has(offset)) {
        rejected.add(offset); // every saved position is refused once
        return json(INVALID_OFFSET, { status: 400 });
      }
      return api.impl(input, init);
    }) as typeof fetch;
    const { ctx, warnings, loaded } = phaseContext(flaky);
    ctx.outOfTime = () => true; // every step stops after one record
    await runPhase(loadPhase(ctx, 'candidates'), ctx, true);

    const ids = (loaded.application as { externalId: string }[]).map((a) => a.externalId);
    expect([...new Set(ids)].sort()).toEqual([O1, O2, O3, O4, O6].sort());
    expect(ids.slice(0, 2)).toEqual([O1, O2]); // oldest first, one per step, resumed mid-page
    expect(rejected.size).toBeGreaterThan(0);
    // Only the window that lost its position was read again; earlier ones were not.
    const times = (id: string) => ids.filter((x) => x === id).length;
    expect([times(O1), times(O2)]).toEqual([1, 1]);
    expect(Math.max(...[O3, O4, O6].map(times))).toBe(2);
    expect(warnings).toContainEqual(expect.stringContaining('read again from its start'));
    expect(api.unmatched).toEqual([]);
  });

  it('gives each created_at window its own restart budget, so fan-out work is repeated for one window at most', async () => {
    // Pairs of candidacies years apart: each pair is one window of two pages, so one saved offset each.
    const spread: OppFixture[] = [Date.UTC(2013, 5, 1), Date.UTC(2013, 5, 2), Date.UTC(2016, 5, 1), Date.UTC(2016, 5, 2), Date.UTC(2020, 5, 1), Date.UTC(2020, 5, 2)].map(
      (createdAt, i) => ({ id: `00000000-0000-4000-8000-00000000000${i}`, createdAt, confidentiality: 'non-confidential' }),
    );
    const notesCalls = new Map<string, number>();
    const refused = new Map<string, number>();
    const routes: Record<string, RouteHandler> = {
      [`GET ${V1}/opportunities`]: lever((url) => {
        const offset = url.searchParams.get('offset');
        if (offset && (refused.get(offset) ?? 0) < 2) {
          refused.set(offset, (refused.get(offset) ?? 0) + 1); // refused twice, then accepted
          return json(INVALID_OFFSET, { status: 400 });
        }
        return opportunityList(spread, url, 1);
      }),
    };
    for (const o of spread) {
      routes[`GET ${V1}/opportunities/${o.id}/notes`] = lever(() => {
        notesCalls.set(o.id, (notesCalls.get(o.id) ?? 0) + 1);
        return page([]);
      });
      routes[`GET ${V1}/opportunities/${o.id}/forms`] = lever(() => page([]));
    }
    const api = mockFetch(routes);
    const { ctx, warnings } = phaseContext(api.impl, (kind) => kind === 'opportunity');
    await runPhase(loadPhase(ctx, 'notes'), ctx, true);

    // Six refusals in all: a list-wide budget of two would have failed the job.
    expect([...refused.values()].reduce((a, b) => a + b, 0)).toBe(6);
    expect(spread.map((o) => notesCalls.get(o.id))).toEqual([3, 1, 3, 1, 3, 1]);
    expect(warnings.every((w) => w.includes('read again from its start'))).toBe(true);
    expect(api.unmatched).toEqual([]);
  });

  it('dates a declined offer only when the candidacy was archived as a declined offer', async () => {
    const DECLINED_OPP = '11111111-2222-4333-8444-555555555555';
    const HIRED_OPP = '66666666-7777-4888-8999-aaaaaaaaaaaa';
    const list: OppFixture[] = [
      { id: DECLINED_OPP, createdAt: 1417000000000, archived: { archivedAt: 1418000000000, reason: OFFER_DECLINED } },
      { id: HIRED_OPP, createdAt: 1417100000000, archived: { archivedAt: 1419000000000, reason: HIRED } },
    ];
    const denied = (id: string) => ({
      id,
      createdAt: 1417500000000,
      status: 'denied',
      creator: RACHEL,
      fields: [{ text: 'Job title', identifier: 'job_title', value: 'Office Manager' }],
      sentDocument: null,
      signedDocument: null,
    });
    const api = mockFetch({
      [`GET ${V1}/opportunities`]: lever((url) => opportunityList(list, url, 100)),
      [`GET ${V1}/archive_reasons`]: lever(() => json({ data: archiveReasons })),
      [`GET ${V1}/opportunities/${DECLINED_OPP}/offers`]: lever(() => page([denied('a1')])),
      [`GET ${V1}/opportunities/${HIRED_OPP}/offers`]: lever(() => page([denied('b1')])),
    });
    const { ctx, loaded } = phaseContext(api.impl, (kind) => kind === 'opportunity');
    await runPhase(loadPhase(ctx, 'offers'), ctx);

    const offers = Object.fromEntries((loaded.offer as { externalId: string; status: string; respondedAt: Date | null }[]).map((o) => [o.externalId, o]));
    expect(offers.a1).toMatchObject({ status: 'DECLINED', respondedAt: new Date(1418000000000) });
    expect(offers.b1).toMatchObject({ status: 'DECLINED', respondedAt: null });
    expect(api.unmatched).toEqual([]);
  });

  it('counts skipped deleted notes, and says so loudly when every one is marked deleted', async () => {
    const OPP = '12121212-3434-4565-8787-909090909090';
    const deleted = Array.from({ length: 20 }, (_, i) => ({
      id: `${i}`.padStart(8, '0') + '-aaaa-4bbb-8ccc-dddddddddddd',
      text: 'Note',
      fields: [{ type: 'note', text: 'Comment', value: `Comment ${i}`, createdAt: 1420312438110 + i, user: RACHEL, score: null }],
      user: RACHEL,
      secret: false,
      createdAt: 1420312438110 + i,
      deletedAt: PLACEHOLDER_DELETED_AT,
    }));
    const api = mockFetch({
      [`GET ${V1}/opportunities`]: lever((url) => opportunityList([{ id: OPP, createdAt: 1420000000000 }], url, 100)),
      [`GET ${V1}/opportunities/${OPP}/notes`]: lever(() => page(deleted)),
      [`GET ${V1}/opportunities/${OPP}/forms`]: lever(() => page([])),
      [`GET ${V1}/users`]: lever(() => page([...users.page1, ...users.page2])),
    });
    const { ctx, warnings, loaded } = phaseContext(api.impl, (kind) => kind === 'opportunity');
    await runPhase(loadPhase(ctx, 'notes'), ctx);

    expect(loaded.note).toBeUndefined();
    expect(warnings.filter((w) => w === 'Skipped Lever notes marked as deleted')).toHaveLength(20);
    expect(warnings).toContainEqual(expect.stringMatching(/^The first 20 Lever notes read were all marked as deleted/));
  });

  it('imports a full account, degrades on a 403, and re-runs without duplicating anything', async () => {
    const api = leverApi();
    const first = await runImportForTest({ module: leverProvider, credentials: { apiKey: KEY }, fetchImpl: api.impl });
    expect(first.error).toBeNull();
    expect(first.status).toBe('SUCCEEDED');
    expect(api.unmatched).toEqual([]);
    const firstCalls = [...api.calls];
    const { orgId, adminId } = first;

    // ----- review -----
    const review = first.review!;
    const stageRows = Object.fromEntries(review.stages.map((s) => [s.key, s]));
    expect(Object.keys(stageRows).sort()).toEqual([
      'background check',
      'hired',
      'new applicant',
      'new lead',
      'offer',
      'on-site interview',
      'phone interview',
      'recruiter screen',
    ]);
    expect(review.stages.every((s) => s.count === 1)).toBe(true);
    expect(stageRows['new applicant'].target).toHaveProperty('stageId');
    expect(stageRows['offer'].target).toHaveProperty('stageId');
    expect(stageRows['hired'].target).toHaveProperty('stageId');
    expect(stageRows['on-site interview'].target).toEqual({ create: { name: 'On-Site Interview', type: 'ONSITE' } });
    expect(stageRows['phone interview'].target).toEqual({ create: { name: 'Phone Interview', type: 'SCREEN' } });
    expect(stageRows['new lead'].target).toEqual({ create: { name: 'New lead', type: 'LEAD' } });
    const reasonRows = Object.fromEntries(review.reasons.map((r) => [r.name, r]));
    expect(reasonRows['Hired']).toMatchObject({ kind: 'hired', target: { create: { name: 'Hired', countsAsRejection: false } } });
    expect(reasonRows['Underqualified']).toMatchObject({ kind: 'rejection', target: { create: { countsAsRejection: true } } });
    expect(reasonRows['Withdrew'].kind).toBe('withdrawn');
    expect(reasonRows['Offer declined'].kind).toBe('withdrawn');
    // Company-side, no-fault reasons don't count as rejections, as in Source's own defaults.
    expect(reasonRows['Timing'].target).toEqual({ create: { name: 'Timing', countsAsRejection: false } });
    expect(reasonRows['Position filled'].target).toEqual({ create: { name: 'Position filled', countsAsRejection: false } });
    expect(review.users).toMatchObject({ total: 4, matched: 1 });

    // ----- counts -----
    expect(first.view.created).toEqual({
      requisition: 2,
      posting: 3,
      contact: 4,
      opportunity: 5,
      interview: 1,
      feedback: 3,
      note: 5,
      offer: 3,
      file: 3,
    });

    // ----- warnings: the 403, the anonymized candidate, the secret note, deleted records, and the rest -----
    const issues = first.view.issues.map((i) => i.message);
    expect(issues).toContainEqual(expect.stringMatching(/^Stage order \(disposition stages\): .*disposition_stages/));
    expect(issues).toContain('Skipped candidates that were anonymized in Lever');
    expect(issues).toContainEqual(expect.stringContaining('Skipped secret Lever notes'));
    expect(issues).toContain('Skipped Lever scorecards marked as deleted');
    expect(issues).toContain('Skipped Lever notes marked as deleted');
    expect(issues).toContainEqual(expect.stringContaining('unlimited headcount were imported with 9,999 openings'));
    expect(issues).toContainEqual(expect.stringContaining('consent to store their data was declined or has expired'));
    expect(issues.join('\n')).not.toContain('read again');
    expect(issues.join('\n')).not.toContain(KEY);

    // ----- pagination: created_at windows, each phase covering the whole timeline once -----
    const oppCalls = firstCalls.filter((c) => c.url.pathname === '/v1/opportunities');
    expect(oppCalls.every((c) => c.url.searchParams.get('confidentiality') === 'all' && c.url.searchParams.get('limit') === '100')).toBe(true);
    expect(oppCalls[0].url.searchParams.getAll('expand')).toEqual(['applications', 'stage']);
    const phases = crawls(firstCalls, null);
    expect(phases.map((p) => p.expand)).toEqual([true, false, false, false, false, false]); // candidates, then 5 fan-outs
    for (const p of phases) expectTiled(p.windows, null);
    const starts = (i: number) => phases[i].windows.map((w) => w[0]);
    expect(starts(0)).toEqual([...starts(0)].sort((a, b) => a - b)); // candidates: oldest first
    expect(starts(5)).toEqual([...starts(5)].sort((a, b) => b - a)); // files: newest first
    const userCalls = firstCalls.filter((c) => c.url.pathname === '/v1/users' && c.url.searchParams.get('includeDeactivated') === 'true');
    expect(userCalls.map((c) => c.url.searchParams.get('offset'))).toContain('[1711931200000,"a3f7"]');
    // The anonymized opportunity was never fanned out to; referral forms only for the referral.
    expect(firstCalls.some((c) => c.url.pathname.includes(O5))).toBe(false);
    expect(firstCalls.filter((c) => c.url.pathname.endsWith('/referrals')).map((c) => c.url.pathname)).toEqual([`/v1/opportunities/${O3}/referrals`]);
    // The second postings pass asks for both job sites, or Lever hides internal-only postings.
    const published = firstCalls.find((c) => c.url.pathname === '/v1/postings' && c.url.searchParams.get('state') === 'published')!;
    expect(published.url.searchParams.getAll('distributionChannel')).toEqual(['public', 'internal']);

    // ----- credentials only ever go to Lever -----
    for (const c of firstCalls) {
      expect(c.url.toString()).not.toContain(KEY);
      if (c.url.host === 'api.lever.co') expect(c.headers.authorization).toBe(AUTH);
      else expect(c.headers.authorization).toBeUndefined();
    }
    expect(firstCalls.filter((c) => c.url.host === S3)).toHaveLength(1);

    // ----- jobs & requisitions -----
    const postings = await db.posting.findMany({ where: { orgId }, include: { department: true, requisition: true } });
    const byTitle = Object.fromEntries(postings.map((p) => [p.title, p]));
    expect(Object.keys(byTitle).sort()).toEqual(['Infrastructure Engineer', 'Marketing Manager', 'Office Manager']);
    const infra = byTitle['Infrastructure Engineer'];
    expect(infra).toMatchObject({
      state: 'DRAFT',
      workplaceType: 'REMOTE',
      commitment: 'FULL_TIME',
      salaryMin: 40000,
      salaryMax: 60000,
      salaryCurrency: 'USD',
      location: 'San Francisco · New York City',
      tags: ['Platform'],
    });
    expect(infra.department?.name).toBe('Engineering');
    expect(infra.requisition?.code).toBe('ENG-145');
    expect(infra.createdAt.toISOString()).toBe(ms(1407779365624));
    const description = (infra.content as { description: string }).description;
    expect(description).toContain('The Infrastructure Engineer will act as...');
    expect(description).toContain('Job requirements\n• Quick learner\n• Ambitious');
    const marketing = byTitle['Marketing Manager'];
    expect(marketing).toMatchObject({ state: 'CLOSED', commitment: 'PART_TIME', workplaceType: 'HYBRID', salaryMin: null, salaryMax: null, tags: ['Growth'] });
    // Hourly pay can't go in Source's yearly salary fields, so it stays in the description.
    expect((marketing.content as { description: string }).description).toBe('Own our brand.\n\nPay: 30–45 USD per hour');
    expect(byTitle['Office Manager']).toMatchObject({ commitment: 'INTERNSHIP', workplaceType: 'ONSITE' });

    const reqs = Object.fromEntries((await db.requisition.findMany({ where: { orgId } })).map((r) => [r.code, r]));
    expect(reqs['ENG-145']).toMatchObject({ state: 'OPEN', openings: 10, filled: 1, salaryMin: 50000, salaryMax: 80000 });
    // "unlimited": enough openings that a hire in Source never auto-closes it.
    expect(reqs['OPS-7']).toMatchObject({ state: 'ON_HOLD', openings: 9999, filled: 0, salaryMin: null, backfill: true });

    // ----- candidates -----
    const contacts = await db.contact.findMany({ where: { orgId } });
    const shane = contacts.find((c) => c.name === 'Shane Smith')!;
    expect(shane.emails).toEqual(['shane@exampleq3.com']);
    expect(shane.links).toEqual(['https://indeed.com/r/Shane-Smith/0b7c87f6b246d2bc', 'https://linkedin.com/in/shanesmith']);
    expect(shane.phones).toEqual(['(123) 456-7891']);
    expect(shane.headline).toBe('Brickly LLC, Vandelay Industries, Inc, Central Perk');
    expect(shane.createdAt.toISOString()).toBe(ms(1407460071043)); // his earlier candidacy
    expect(shane.resumeFileId).not.toBeNull();
    const kristoff = contacts.find((c) => c.emails.includes('kristoff@arendelle.test'))!;
    expect(kristoff.name).toBe('kristoff'); // blank lead name falls back to the email
    expect(kristoff.links).toEqual(['https://github.com/kristoff']);

    // ----- applications -----
    const opps = await db.opportunity.findMany({
      where: { orgId },
      include: {
        stage: true,
        posting: true,
        archiveReason: true,
        stageTransitions: { orderBy: { occurredAt: 'asc' }, include: { toStage: true } },
      },
    });
    const opp = (id: string) => opps.find((o) => (o.customFields as { imported: { id: string } }).imported.id === id)!;
    const fieldsOf = (id: string) => (opp(id).customFields as { imported: { fields: Record<string, string> } }).imported.fields;

    const o1 = opp(O1);
    expect(o1).toMatchObject({ status: 'ACTIVE', origin: 'SOURCED', source: 'LinkedIn', ownerId: adminId, contactId: shane.id, confidential: false });
    expect(o1.stage.name).toBe('On-Site Interview');
    expect(o1.posting?.title).toBe('Infrastructure Engineer');
    expect(o1.createdAt.toISOString()).toBe(ms(1407460071043));
    // The move into a stage Lever no longer lists is dropped, not filed under "New applicant".
    expect(o1.stageTransitions.map((t) => t.toStage.name)).toEqual(['New applicant', 'Phone Interview', 'On-Site Interview']);
    expect(o1.stageTransitions.map((t) => t.actorId)).toEqual([null, null, adminId]); // Chandler has no Source account
    expect(o1.stageTransitions[2].occurredAt.toISOString()).toBe(ms(1417587916150));
    expect(o1.stageChangedAt.toISOString()).toBe(ms(1417587916150));
    expect(fieldsOf(O1)).toMatchObject({
      'Lever tags': 'San Francisco, Full-time',
      'Sourced by': 'Rachel Green',
      'Consent to store data': 'Yes, until 2018-04-01',
      'Consent to contact': 'No',
    });

    // Hired: Lever leaves them in Offer; Source moves them to Hired when they were archived as hired.
    const o2 = opp(O2);
    expect(o2).toMatchObject({ status: 'HIRED', origin: 'APPLIED', source: 'Posting' });
    // A hire looks like one made in Source: Hired stage, no archive reason or date; entering Hired is the hire date.
    expect(o2.archiveReason).toBeNull();
    expect(o2.archivedAt).toBeNull();
    expect(o2.stageChangedAt.toISOString()).toBe(ms(1417600000000));
    expect(o2.stage).toMatchObject({ name: 'Hired', type: 'HIRED' });
    expect(o2.posting).toMatchObject({ title: 'Marketing Manager', state: 'CLOSED' });
    expect(o2.stageTransitions.map((t) => t.toStage.name)).toEqual(['New applicant', 'Offer', 'Hired']);
    expect(o2.stageTransitions[2].occurredAt.toISOString()).toBe(ms(1417600000000));
    expect(o2.stageChangedAt.toISOString()).toBe(ms(1417600000000));
    expect(fieldsOf(O2)).toMatchObject({
      'Current company': 'Grunnings, Inc.',
      'Cover letter': 'Excited about this role.',
      'What role most interests you?': 'Brand',
      'Hired against requisition': 'OPS-7',
      'Lever tags': 'Marketing, Full-time',
    });

    const o3 = opp(O3);
    expect(o3).toMatchObject({ status: 'ARCHIVED', origin: 'REFERRED', source: 'Referral', confidential: true });
    expect(o3.archiveReason).toMatchObject({ name: 'Underqualified', countsAsRejection: true });
    expect(o3.archivedAt?.toISOString()).toBe(ms(1418000000000));
    expect(fieldsOf(O3)).toMatchObject({ 'Lever sources': 'Referral, Employee Referral Program', 'Referred by': 'Monica Geller' });

    const o4 = opp(O4);
    expect(o4).toMatchObject({ status: 'ACTIVE', postingId: null, origin: 'SOURCED', contactId: kristoff.id });
    expect(o4.stage).toMatchObject({ name: 'New lead', type: 'LEAD' });
    expect(fieldsOf(O4)).toMatchObject({ 'Snoozed until': '2015-01-11', 'Lever tags': 'Sourcing sprint' });

    const o6 = opp(O6);
    expect(o6.contactId).toBe(shane.id); // same Lever contact, second candidacy
    expect(o6.stageTransitions.map((t) => [t.toStage.name, t.occurredAt.toISOString()])).toEqual([['New applicant', ms(1420000000000)]]);

    // ----- interviews & scorecards -----
    const interview = await db.interview.findFirstOrThrow({ where: { orgId }, include: { panelists: true } });
    expect(interview).toMatchObject({
      opportunityId: o1.id,
      title: 'On-site interview - Shane Smith - Infrastructure Engineer',
      durationMins: 30,
      state: 'COMPLETED',
      location: 'Room 4 · https://zoom.us/j/1234567890',
    });
    expect(interview.startAt.toISOString()).toBe(ms(1417590000000));
    expect(interview.panelists.map((p) => p.id)).toEqual([adminId]);

    const scorecards = await db.feedbackSubmission.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' } });
    expect(scorecards.map((f) => f.overallRating)).toEqual([2, 4]);
    const [noHire, strongHire] = scorecards;
    expect(noHire).toMatchObject({ opportunityId: o3.id, interviewId: null, authorId: adminId });
    expect(noHire.summary).toMatch(/^\[lever · Josh Eckerman\] Phone screen\nNot enough depth in operations\.$/i);
    expect(strongHire).toMatchObject({ opportunityId: o1.id, interviewId: interview.id, authorId: adminId });
    expect(strongHire.summary).toBe('On-site interview\nHad a great conversation with Shane.');
    expect(strongHire.createdAt.toISOString()).toBe(ms(1417592000000));
    expect(Object.values(strongHire.answers as Record<string, { label: string; value: string }>)).toEqual([
      { label: 'Skills assessment', kind: 'TEXT', value: 'Design Skills: 4 - Strong yes, Very confident; Communication: N/A' },
      { label: 'Communication', kind: 'TEXT', value: '3 - Yes' },
      { label: 'Would you work with this person?', kind: 'TEXT', value: 'Yes' },
    ]);

    // ----- notes (incl. the scorecard without a decision, forms, and attachment notes) -----
    const notes = await db.note.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' } });
    const bodies = notes.map((n) => n.body.replace(/^\[Lever/i, '[lever'));
    expect(bodies).toEqual(
      expect.arrayContaining([
        '[lever · Monica Geller] Referred by Monica; strong ops background.\n\nRating: 2 - No',
        '[lever · Chandler Bing] Culture add\nGreat energy, needs a second look on systems depth.',
        '@chandler We should move forward with Shane.\n\nRating: 3 - Yes',
        '[lever · Chandler Bing] Sounds great! I will send him an email this week.',
        // A profile form (listed as one bare form), by Rachel
        'Offer information\nStart date: 2014-12-16\nCompensation: 50000 USD\nEligible for benefits?: Yes\nManager: Jen',
        // A referral form, by Monica
        '[lever · Monica Geller] Referral\nName of referrer: Monica Geller\nRelationship: Reputation\nNotes / Comments: Teresa comes recommended by an old coworker of mine.',
      ]),
    );
    const form = notes.find((n) => n.body.startsWith('Offer information'))!;
    expect(form).toMatchObject({ authorId: adminId, opportunityId: o1.id });
    expect(form.createdAt.toISOString()).toBe(ms(1417587426973));
    expect(notes.find((n) => n.body.startsWith('@chandler'))).toMatchObject({ authorId: adminId, opportunityId: o1.id });
    expect(notes.find((n) => n.body.startsWith('@chandler'))!.createdAt.toISOString()).toBe(ms(1420312438110));
    expect(notes.some((n) => n.body.includes('Comp expectations'))).toBe(false); // secret
    expect(notes.some((n) => n.body.includes('since deleted'))).toBe(false);
    expect(notes.filter((n) => /Attachment: /.test(n.body)).map((n) => n.body.split('Attachment: ')[1].split(' — ')[0]).sort()).toEqual([
      'ShaneSmithCoverLetter.pdf',
      'employment-offer-letter_signed.pdf',
    ]);
    expect(notes).toHaveLength(8);

    // ----- offers -----
    const offers = Object.fromEntries((await db.offer.findMany({ where: { orgId } })).map((o) => [o.status, o]));
    expect(offers.ACCEPTED).toMatchObject({
      opportunityId: o2.id,
      jobTitle: 'Back End Software Engineer',
      salaryAmount: 1319000,
      salaryCurrency: 'USD',
      equity: '12345',
    });
    expect(offers.ACCEPTED.startDate?.toISOString()).toBe(ms(1475540150185));
    expect(offers.ACCEPTED.sentAt?.toISOString()).toBe(ms(1475700000000));
    expect(offers.ACCEPTED.respondedAt?.toISOString()).toBe(ms(1475730000000));
    expect(offers.ACCEPTED.notes).toBe('Type of earnings: per-year-salary\nSigning bonus: 10000');
    expect(offers.DRAFT).toMatchObject({ jobTitle: 'Front End Software Engineer', salaryAmount: 125000, salaryCurrency: 'EUR', sentAt: null });
    // Hourly pay isn't shown as a yearly salary; the candidacy was archived as Hired, so the decline has no date.
    expect(offers.DECLINED).toMatchObject({ jobTitle: 'Barista', salaryAmount: null, salaryCurrency: 'USD', notes: 'Pay: 45 USD per hour', respondedAt: null });

    // ----- files -----
    const resume = await db.storedFile.findUniqueOrThrow({ where: { id: shane.resumeFileId! } });
    expect(resume).toMatchObject({ filename: 'ShaneSmithResume.pdf', mime: 'application/pdf' });
    expect(api.downloads).toEqual({ resume: 1, s3: 1, cover: 1, offer: 1 });

    // ----- re-run into the same org: nothing new, nothing re-downloaded -----
    const second = await runImportForTest({ module: leverProvider, credentials: { apiKey: KEY }, fetchImpl: api.impl, orgId });
    expect(second.status).toBe('SUCCEEDED');
    expect(second.view.created).toEqual({});
    expect(api.downloads).toEqual({ resume: 1, s3: 1, cover: 1, offer: 1 });
    expect(await db.opportunity.count({ where: { orgId } })).toBe(5);
    expect(await db.contact.count({ where: { orgId } })).toBe(4);
    expect(await db.note.count({ where: { orgId } })).toBe(8);
    expect(api.unmatched).toEqual([]);
  });

  it('a second import follows what changed in Lever and keeps what the team changed in Source', async () => {
    const api = leverApi();
    const first = await runImportForTest({ module: leverProvider, credentials: { apiKey: KEY }, fetchImpl: api.impl });
    expect(first.status).toBe('SUCCEEDED');
    const { orgId } = first;
    const ref = await db.importRef.findFirstOrThrow({ where: { orgId, kind: 'opportunity', externalId: O1 } });
    const shane = await db.opportunity.findUniqueOrThrow({ where: { id: ref.internalId } });
    // The team moves Shane's location in Source…
    await db.contact.update({ where: { id: shane.contactId }, data: { location: 'Remote' } });

    // …while in Lever he moves to Offer, gets a new headline and location, and a comment is edited.
    const o1 = opportunities.find((o) => o.id === O1)!;
    const savedOpp = structuredClone(o1);
    const notes = children[O1].notes as { fields: { value: string }[] }[];
    const savedNotes = structuredClone(notes);
    Object.assign(o1, {
      headline: 'Staff Engineer at Vandelay',
      location: 'Berkeley',
      stage: { id: OFFER_STAGE, text: 'Offer' },
      stageChanges: [...(o1.stageChanges as unknown[]), { toStageId: OFFER_STAGE, toStageIndex: 6, userId: RACHEL, updatedAt: 1418000000000 }],
      updatedAt: 1418000000000,
    });
    notes[0].fields[0].value = '@chandler Offer approved, sending it today.';
    try {
      const second = await runImportForTest({ module: leverProvider, credentials: { apiKey: KEY }, fetchImpl: api.impl, orgId });
      expect(second.status).toBe('SUCCEEDED');
      expect(second.view.created).toEqual({});

      const after = await db.opportunity.findUniqueOrThrow({
        where: { id: ref.internalId },
        include: { contact: true, stage: true, stageTransitions: { orderBy: { occurredAt: 'asc' }, include: { toStage: true } } },
      });
      expect(after.stage.type).toBe('OFFER');
      expect(after.stageTransitions.at(-1)).toMatchObject({ occurredAt: new Date(1418000000000) });
      expect(after.contact).toMatchObject({ headline: 'Staff Engineer at Vandelay', location: 'Remote' });
      expect(await db.note.count({ where: { opportunityId: ref.internalId, body: { contains: 'Offer approved, sending it today.' } } })).toBe(1);
      expect(await db.note.count({ where: { opportunityId: ref.internalId, body: { contains: 'We should move forward with Shane.' } } })).toBe(0);
      expect(second.view.stats).toMatchObject({ 'updated.opportunity': 1, 'updated.contact': 1, 'kept.contact': 1 });
      // Nothing downloaded again.
      expect(api.downloads).toEqual({ resume: 1, s3: 1, cover: 1, offer: 1 });
      expect(api.unmatched).toEqual([]);
    } finally {
      Object.keys(o1).forEach((k) => delete (o1 as Record<string, unknown>)[k]);
      Object.assign(o1, savedOpp);
      notes.splice(0, notes.length, ...savedNotes);
    }
  });

  it('finishes the import when the key may list offer letters and resumes but not download them', async () => {
    const api = leverApi({ deniedDownloads: ['offer', 'resume'] });
    const res = await runImportForTest({ module: leverProvider, credentials: { apiKey: KEY }, fetchImpl: api.impl });
    expect(res.error).toBeNull();
    expect(res.status).toBe('SUCCEEDED');
    const issues = res.view.issues.map((i) => i.message);
    expect(issues).toContainEqual(expect.stringMatching(/^Offer letters were not downloaded: this Lever key has no permission/));
    expect(issues).toContainEqual(expect.stringMatching(/^Resumes were not downloaded: this Lever key has no permission/));
    expect(issues.join('\n')).not.toContain(KEY);
    // The attachment still came across, and everything else did too.
    expect(api.downloads).toEqual({ resume: 0, s3: 0, cover: 1, offer: 0 });
    expect(res.view.created).toMatchObject({ opportunity: 5, offer: 3, file: 1 });
    expect(api.unmatched).toEqual([]);
  });

  it('filters archived and old candidates server-side when asked', async () => {
    const api = leverApi();
    const since = '2014-12-01T00:00:00.000Z';
    const res = await runImportForTest({
      module: leverProvider,
      credentials: { apiKey: KEY },
      fetchImpl: api.impl,
      options: { archived: false, since, activity: false, offers: false, files: false },
    });
    expect(res.status).toBe('SUCCEEDED');
    const oppCalls = api.calls.filter((c) => c.url.pathname === '/v1/opportunities');
    for (const c of oppCalls) {
      expect(c.url.searchParams.get('archived')).toBe('false');
      expect(Number(c.url.searchParams.get('created_at_start'))).toBeGreaterThanOrEqual(Date.parse(since));
    }
    const phases = crawls(api.calls, Date.parse(since));
    expect(phases).toHaveLength(1); // candidates phase only
    expectTiled(phases[0].windows, Date.parse(since));
    // The mock ignores archived=false; the adapter and loader still drop archived records.
    expect(res.view.created.opportunity).toBe(2); // O4 (lead) and O6
    expect(api.unmatched).toEqual([]);
  });
});
