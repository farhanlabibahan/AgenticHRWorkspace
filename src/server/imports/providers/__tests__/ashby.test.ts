import { randomUUID } from 'crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/session', () => ({ isAdmin: () => true }));

import { db, json, mockFetch, runImportForTest, verifyForTest, type RouteHandler } from '@/server/imports/__tests__/harness';
import { hasDb, publicDns } from '@/server/imports/__tests__/harness';
import { createHttpClient, ImportAuthError, ImportHttpError } from '@/server/imports/http';
import { ashbyProvider } from '@/server/imports/providers/ashby';
import {
  DEFAULT_IMPORT_OPTIONS,
  type CatalogReason,
  type CatalogStage,
  type CatalogUser,
  type Cursor,
  type ImportedApplication,
  type ImportedCandidate,
  type ImportedFeedback,
  type ImportedFile,
  type ImportedInterview,
  type ImportedNote,
  type ImportedOffer,
  type ImportedPosting,
  type ImportedRequisition,
  type ImportOptions,
  type Loader,
  type PhaseContext,
  type RefKind,
} from '@/server/imports/types';

/**
 * Ashby adapter, end to end through the real engine. The mock API serves the
 * spec's "Acme Robotics" payloads with Ashby's exact field names, UUID ids,
 * ISO timestamps and `{success, results, moreDataAvailable, nextCursor}`
 * envelopes. Like the real schemas (`additionalProperties: false`), it refuses
 * any request param an endpoint doesn't document.
 */

const KEY = 'ashby-test-key-6f1d09';
const BASIC = `Basic ${Buffer.from(`${KEY}:`).toString('base64')}`;
const API = 'api.ashbyhq.com';
const S3 = 's3.amazonaws.com';
const BUCKET = 'ashby-prod-candidate-files';

type Body = Record<string, unknown>;

// ---------- Acme Robotics ----------

const jane = { id: '04070b43-312e-4d32-954e-1ec80a9c51e3', firstName: 'Jane', lastName: 'Smith', email: 'jane.smith@acmerobotics.com', globalRole: 'Organization Admin', isEnabled: true, updatedAt: '2026-01-05T17:42:10.221Z' };
const maya = { id: '073768e4-e693-4064-b283-d32e920cae40', firstName: 'Maya', lastName: 'Patel', email: 'maya.patel@acmerobotics.com', globalRole: 'Elevated Access', isEnabled: true, updatedAt: '2026-08-30T09:15:47.006Z' };
const priya = { id: '72f9fcbe-7654-45a3-af64-c799d5c02ef1', firstName: 'Priya', lastName: 'Raman', email: 'priya.raman@acmerobotics.com', globalRole: 'Limited Access', isEnabled: true, updatedAt: '2026-07-01T12:00:03.410Z' };
const tom = { id: '00e63c05-ffaa-4f32-9f62-c3df8d3bf908', firstName: 'Tom', lastName: 'Nguyen', email: 'tom.nguyen@acmerobotics.com', globalRole: 'Limited Access', isEnabled: false, updatedAt: '2026-04-18T22:31:55.874Z' };
const users = [jane, { ...maya, managerId: jane.id }, { ...priya, managerId: jane.id }, tom];
const author = (u: typeof jane) => ({ id: u.id, firstName: u.firstName, lastName: u.lastName, email: u.email });

const ENG_PLAN = '0027aaad-5677-4354-a44b-c0c9f299da4f';
// A legacy plan interviewPlan.list no longer returns (changelog 2026-09-23); only job.list names it.
const SALES_PLAN = '5f1c2a9e-3b7d-4c8e-a1f0-9d2b3c4e5f60';
const ST = {
  eLead: '2b029fea-15cb-44e9-bd3b-38dae0d38b1a',
  eReview: '9c9a27c5-c7e3-4aa9-bc47-6cb86d6b1536',
  eScreen: '88c3304b-6f8b-4e6d-9e8d-d8097f9e78ea',
  eTech: '44ac7942-e43e-47f8-bb70-8c0d2db27ea3',
  eOnsite: 'e97ad4e4-4f6b-474e-a9a2-e4b07b716632',
  eOffer: '1ebf41d7-d2e3-4715-9eab-1d58058a690b',
  eHired: '094a990e-87b4-40c3-8476-9ba4541069fb',
  eArchived: 'f3fbc7c1-9835-43a8-9d3a-7eae085f4a3f',
  sLead: 'b8d1f0a2-4c3e-4f5a-9b6c-7d8e9f0a1b2c',
  sReview: 'c9e2a1b3-5d4f-4a6b-8c7d-8e9f0a1b2c3d',
  sScreen: 'd0f3b2c4-6e5a-4b7c-9d8e-9f0a1b2c3d4e',
  sHm: 'e1a4c3d5-7f6b-4c8d-8e9f-0a1b2c3d4e5f',
  sOffer: 'f2b5d4e6-8a7c-4d9e-9f0a-1b2c3d4e5f60',
  sHired: 'a3c6e5f7-9b8d-4e0f-8a1b-2c3d4e5f6071',
  sArchived: 'b4d7f6a8-0c9e-4f1a-9b2c-3d4e5f607182',
};
// A plan that interviewPlan.list omits and no job names any more, though an application still sits in it.
const LEGACY_PLAN = '6a7b8c9d-0e1f-4a2b-9c3d-4e5f6a7b8c9d';
// A plan nothing reaches at all; only a stage-history entry still points into it.
const RETIRED_PLAN = '7b8c9d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e';
const LEGACY = {
  review: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e51',
  portfolio: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e52',
  techLead: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e53',
  hmReview: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e54',
  archived: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e55',
  retiredArchived: '2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f61',
};
const TECH_GROUP = '250d738a-ef42-4b40-ae63-3b5788ff0939';
const stage = (id: string, title: string, type: string, interviewPlanId: string, orderInInterviewPlan: number, interviewStageGroupId: string | null = null) => ({
  id,
  title,
  type,
  interviewPlanId,
  orderInInterviewPlan,
  interviewStageGroupId,
});
const planStages: Record<string, ReturnType<typeof stage>[]> = {
  [ENG_PLAN]: [
    stage(ST.eLead, 'Lead', 'Lead', ENG_PLAN, 0),
    stage(ST.eReview, 'Application Review', 'PreInterviewScreen', ENG_PLAN, 1),
    stage(ST.eScreen, 'Recruiter Screen', 'Active', ENG_PLAN, 2),
    stage(ST.eTech, 'Technical Interview', 'Active', ENG_PLAN, 3, TECH_GROUP),
    stage(ST.eOnsite, 'Onsite', 'Active', ENG_PLAN, 4, TECH_GROUP),
    stage(ST.eOffer, 'Offer', 'Offer', ENG_PLAN, 5),
    stage(ST.eHired, 'Hired', 'Hired', ENG_PLAN, 6),
    stage(ST.eArchived, 'Archived', 'Archived', ENG_PLAN, 7),
  ],
  [SALES_PLAN]: [
    stage(ST.sLead, 'Lead', 'Lead', SALES_PLAN, 0),
    stage(ST.sReview, 'Application Review', 'PreInterviewScreen', SALES_PLAN, 1),
    stage(ST.sScreen, 'Recruiter Screen', 'Active', SALES_PLAN, 2),
    stage(ST.sHm, 'Hiring Manager Screen', 'Active', SALES_PLAN, 3),
    stage(ST.sOffer, 'Offer', 'Offer', SALES_PLAN, 4),
    stage(ST.sHired, 'Hired', 'Hired', SALES_PLAN, 5),
    stage(ST.sArchived, 'Archived', 'Archived', SALES_PLAN, 6),
  ],
  [LEGACY_PLAN]: [
    stage(LEGACY.review, 'Application Review', 'PreInterviewScreen', LEGACY_PLAN, 0),
    stage(LEGACY.portfolio, 'Portfolio Review', 'Active', LEGACY_PLAN, 1),
    stage(LEGACY.techLead, 'Tech Lead Interview', 'Active', LEGACY_PLAN, 2),
    stage(LEGACY.hmReview, 'Hiring Manager Review', 'Active', LEGACY_PLAN, 3),
    stage(LEGACY.archived, 'Archived', 'Archived', LEGACY_PLAN, 4),
  ],
  [RETIRED_PLAN]: [stage(LEGACY.retiredArchived, 'Not moving forward', 'Archived', RETIRED_PLAN, 0)],
};
const currentStage = (planId: string, id: string) => {
  const s = planStages[planId].find((x) => x.id === id)!;
  return { id: s.id, title: s.title, type: s.type, orderInInterviewPlan: s.orderInInterviewPlan, interviewStageGroupId: s.interviewStageGroupId, interviewPlanId: planId };
};

const departments = [
  { id: 'cd261df6-a77e-42ac-a246-67b871e26f64', name: 'Engineering', externalName: null, isArchived: false, parentId: null, createdAt: '2024-02-01T18:00:00.000Z', updatedAt: '2025-11-12T10:04:31.559Z', extraData: null },
  { id: 'ff0a4aed-0925-4fe5-99c1-f30f295fc976', name: 'Platform Engineering', externalName: 'Engineering', isArchived: false, parentId: 'cd261df6-a77e-42ac-a246-67b871e26f64', createdAt: '2024-02-01T18:05:12.000Z', updatedAt: '2025-11-12T10:04:31.559Z', extraData: null },
  { id: 'e7121f28-d097-435d-afd9-9ef32cce616e', name: 'Sales', externalName: null, isArchived: true, parentId: null, createdAt: '2024-02-01T18:00:00.000Z', updatedAt: '2026-05-02T08:11:09.300Z', extraData: { partner_external_object_id: '12345' } },
];

const SBE = 'ab48f7b4-8f56-4bc6-93a5-500404a52d09';
const AE = '810e00b7-b8bb-41e7-80ed-f6bf9a7a7e70';
const POSTING = '6de67cd9-b521-4856-b3dc-7d1ad1e313f6';
const INTERNAL_BOARD = '9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const jobs = [
  {
    id: SBE,
    title: 'Senior Backend Engineer',
    confidential: false,
    status: 'Open',
    employmentType: 'FullTime',
    locationId: '0514b0d4-fa3c-41a2-8a6f-b4c83bd317ca',
    departmentId: 'ff0a4aed-0925-4fe5-99c1-f30f295fc976',
    defaultInterviewPlanId: ENG_PLAN,
    interviewPlanIds: [ENG_PLAN],
    jobPostingIds: [POSTING],
    customRequisitionId: 'ENG-042',
    brandId: 'e88c20af-8732-426e-84a2-3f41045f1603',
    hiringTeam: [
      { userId: maya.id, firstName: 'Maya', lastName: 'Patel', email: maya.email, role: 'Recruiter' },
      { userId: jane.id, firstName: 'Jane', lastName: 'Smith', email: jane.email, role: 'Hiring Manager' },
    ],
    customFields: [{ id: '5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e', isPrivate: false, title: 'Hiring priority', value: 'p1', valueLabel: 'P1' }],
    createdAt: '2026-05-18T20:11:05.000Z',
    updatedAt: '2026-09-01T10:30:00.000Z',
    openedAt: '2026-05-20T16:00:00.000Z',
    closedAt: null,
  },
  {
    id: AE,
    title: 'Account Executive',
    confidential: false,
    status: 'Closed',
    employmentType: 'FullTime',
    locationId: '06cf5d1a-6cf6-4003-8b6b-d522445f3fe3',
    departmentId: 'e7121f28-d097-435d-afd9-9ef32cce616e',
    defaultInterviewPlanId: SALES_PLAN,
    interviewPlanIds: [SALES_PLAN],
    jobPostingIds: [],
    customRequisitionId: null,
    brandId: 'e88c20af-8732-426e-84a2-3f41045f1603',
    hiringTeam: [],
    customFields: [],
    createdAt: '2026-01-10T17:00:00.000Z',
    updatedAt: '2026-04-01T09:00:00.000Z',
    openedAt: '2026-01-12T17:00:00.000Z',
    closedAt: '2026-04-01T09:00:00.000Z',
  },
];
// job.info {expand: ['compensation']}: the Account Executive role has no posting, so its pay lives only here.
const jobCompensation: Record<string, unknown> = {
  [AE]: {
    compensationTiers: [
      {
        id: 'd1e2f3a4-b5c6-4d7e-8f9a-0b1c2d3e4f5a',
        title: null,
        additionalInformation: null,
        components: [
          { id: 'e2f3a4b5-c6d7-4e8f-9a0b-1c2d3e4f5a6b', summary: '$90K – $110K', compensationType: 'Salary', interval: '1 YEAR', label: null, currencyCode: 'USD', minValue: 90000, maxValue: 110000 },
          { id: 'f3a4b5c6-d7e8-4f9a-8b1c-2d3e4f5a6b7c', summary: '$70K', compensationType: 'Commission', interval: '1 YEAR', label: 'Target commission', currencyCode: 'USD', minValue: 70000, maxValue: 70000 },
        ],
        tierSummary: '$90K – $110K • $70K commission',
      },
    ],
    displaySettings: { shouldShowOnJobBoard: false, shouldShowOnJobPostings: false, compensationTierGuideUrl: null, compensationPhilosophy: null, compensationPhilosophyHtml: null },
  },
};

const openingVersion = (id: string, identifier: string, isBackfill: boolean, createdAt: string) => ({
  id,
  identifier,
  description: isBackfill ? 'Backfill for platform team' : null,
  authorId: jane.id,
  createdAt,
  targetHireDate: null,
  targetStartDate: null,
  isBackfill,
  employmentType: 'FullTime',
  teamId: 'ff0a4aed-0925-4fe5-99c1-f30f295fc976',
  jobIds: [SBE],
  locationIds: ['0514b0d4-fa3c-41a2-8a6f-b4c83bd317ca'],
  hiringTeam: [],
  customFields: [],
});
const jobOpenings: Record<string, unknown[]> = {
  [SBE]: [
    { id: '7d36a903-948e-401c-98cf-3efd4486c1ab', openedAt: '2026-05-20T16:00:00.000Z', closedAt: '2026-08-14T17:05:12.440Z', isArchived: false, closeReasonId: 'd52655a9-6e7c-42ed-aa58-ac2e183a0ba1', archivedAt: null, openingState: 'Filled', latestVersion: openingVersion('8f2a1bfb-f0e8-4253-9684-7e0bdfb89132', 'ENG-042-1', true, '2026-05-20T15:58:12.800Z') },
    { id: '4e888bb5-ffc1-41f5-985f-1e22f7079925', openedAt: '2026-08-20T16:00:00.000Z', closedAt: null, isArchived: false, closeReasonId: null, archivedAt: null, openingState: 'Open', latestVersion: openingVersion('6ad750b8-15ce-4d30-b491-8fbf0ffd71b0', 'ENG-042-2', false, '2026-08-20T15:59:40.120Z') },
  ],
  [AE]: [],
};
const jobLocations: Record<string, unknown> = {
  [SBE]: { id: '0514b0d4-fa3c-41a2-8a6f-b4c83bd317ca', name: 'San Francisco HQ', externalName: 'San Francisco', isArchived: false, isRemote: false, address: { postalAddress: { addressCountry: 'United States', addressRegion: 'California', addressLocality: 'San Francisco' } }, parentLocationId: null, type: 'Location', workplaceType: 'Hybrid', extraData: null },
  [AE]: { id: '06cf5d1a-6cf6-4003-8b6b-d522445f3fe3', name: 'Remote (US)', externalName: null, isArchived: false, isRemote: true, address: { postalAddress: { addressCountry: 'United States' } }, parentLocationId: null, type: 'Location', workplaceType: 'Remote', extraData: null },
};

const descriptionHtml =
  "<h3>About the role</h3><p>You will own the services that power our fleet telemetry.</p><h3>What you'll do</h3><ul><li><p>Design APIs</p></li><li><p>Mentor engineers</p></li></ul>";
const salaryComponent = { summary: '$170K – $210K', compensationType: 'Salary', interval: '1 YEAR', currencyCode: 'USD', minValue: 170000, maxValue: 210000 };
const posting = {
  id: POSTING,
  title: 'Senior Backend Engineer',
  status: 'Published',
  descriptionPlain: "About the role\nYou will own the services that power our fleet telemetry.\nWhat you'll do\n- Design APIs\n- Mentor engineers",
  descriptionHtml,
  descriptionSocial: null,
  descriptionParts: { descriptionOpening: { html: '<p>Acme Robotics builds warehouse robots.</p>', plain: 'Acme Robotics builds warehouse robots.' }, descriptionBody: { html: descriptionHtml, plain: 'About the role' }, descriptionClosing: null },
  departmentName: 'Engineering',
  teamName: 'Platform Engineering',
  teamNameHierarchy: ['Engineering', 'Platform Engineering'],
  jobId: SBE,
  locationName: 'San Francisco',
  locationAddress: 'San Francisco, California, United States',
  locationIds: { primaryLocationId: '0514b0d4-fa3c-41a2-8a6f-b4c83bd317ca', secondaryLocationIds: ['06cf5d1a-6cf6-4003-8b6b-d522445f3fe3'] },
  linkedData: {},
  publishedDate: '2026-05-21',
  applicationDeadline: null,
  address: { postalAddress: { addressRegion: 'California', addressCountry: 'United States', addressLocality: 'San Francisco' } },
  isRemote: false,
  workplaceType: 'Hybrid',
  employmentType: 'FullTime',
  applicationFormDefinition: { sections: [] },
  applicationFormDefinitionId: null,
  surveyFormDefinitions: [],
  isListed: true,
  jobBoardAssociations: [{ jobBoardId: '446adc6a-73b0-4439-97a6-ac8e7994ab46', isListed: true }],
  suppressDescriptionOpening: false,
  suppressDescriptionClosing: false,
  externalLink: `https://jobs.ashbyhq.com/acme-robotics/${POSTING}`,
  applyLink: `https://jobs.ashbyhq.com/acme-robotics/${POSTING}/application`,
  compensation: {
    compensationTierSummary: '$170K – $210K • Offers Equity',
    summaryComponents: [salaryComponent],
    compensationTiers: [{ id: 'ccac69d5-6381-41a9-91ae-0ecc63cb41e3', tierSummary: '$170K – $210K • Offers Equity', title: null, additionalInformation: null, components: [{ id: 'cbd63252-665c-426e-879b-e7fe92b1c8d1', ...salaryComponent }] }],
    shouldDisplayCompensation: true,
    displaySettings: { shouldShowOnJobBoard: true, shouldShowOnJobPostings: true, compensationTierGuideUrl: null, compensationPhilosophy: null, compensationPhilosophyHtml: null },
  },
  updatedAt: '2026-06-02T14:20:11.301Z',
  applicationLimitCalloutHtml: null,
  applicationConfirmationEmailTemplateId: null,
};

const archiveReasons = [
  { id: '14e6965c-38c1-4c03-9a52-4e0313af8c56', text: 'Too inexperienced', reasonType: 'RejectedByOrg', isArchived: false },
  { id: 'f0433449-8915-49f9-9821-6084de6e5fdf', text: 'Compensation mismatch', reasonType: 'RejectedByCandidate', isArchived: false },
  { id: 'd1bb8471-da23-4a8c-afe0-ab40093ec388', text: 'Duplicate application', reasonType: 'Other', isArchived: true },
];

const sources = {
  applied: { id: '9dbc9c80-9e57-43c8-856b-5ee4e9c898f3', title: 'Applied', isArchived: false, sourceType: { id: 'cb1d219e-f3aa-48c8-b4c6-a7df6e65ff0c', title: 'Inbound', isArchived: false } },
  referral: { id: '92a6f9e8-efb5-41ed-8c45-9d190aef6471', title: 'Employee Referral', isArchived: false, sourceType: { id: 'b0b31d04-ff44-4fd2-888e-befde557cc42', title: 'Referral', isArchived: false } },
  linkedin: { id: 'a6bedaa8-ef8f-4923-b6a1-e748d0ec69df', title: 'LinkedIn (Sourced)', isArchived: false, sourceType: { id: 'a1bb544a-7302-4c59-8912-5c4b407706a4', title: 'Outbound', isArchived: false } },
};

const ADA = 'eba85616-765c-4a4d-bc20-80ceb15c0ff8';
const GRACE = '28be18bd-fbc5-4294-aa96-897623175e96';
const ALAN = '98e6e150-60c7-4990-ae6e-1493f8c2dbbb';
const handle = (fileId: string, ownerId: string) =>
  Buffer.from(JSON.stringify({ handle: { type: 'CandidateFile', fileId, ownerId }, signature: 'OpHNne7Kkz+ALV2sWJURhHwfFZpZk7T5nrzTdO2YvqI=', version: '1' })).toString('base64url');
const files = {
  adaResume: { id: 'df42bbe5-cccb-4847-9702-0e38dae3f638', name: 'Ada_Lovelace_Resume.pdf', handle: handle('df42bbe5-cccb-4847-9702-0e38dae3f638', ADA) },
  adaCover: { id: '0f9e96bf-faa5-481a-bba9-e76be614718a', name: 'Cover_Letter.docx', handle: handle('0f9e96bf-faa5-481a-bba9-e76be614718a', ADA) },
  graceResume: { id: '1ae3e252-1445-4f3a-893f-df302f1b33aa', name: 'grace-hopper-cv.pdf', handle: handle('1ae3e252-1445-4f3a-893f-df302f1b33aa', GRACE) },
  offerLetter: {
    id: '0b0bc8a0-618b-4aa0-b128-e13dc08cfbcb',
    name: 'Offer Letter - Grace Hopper.pdf',
    handle: 'eyJoYW5kbGUiOnsidHlwZSI6Ik9mZmVyRmlsZSIsImZpbGVJZCI6IjBiMGJjOGEwLTYxOGItNGFhMC1iMTI4LWUxM2RjMDhjZmJjYiJ9fQ',
  },
};
const fileMime: Record<string, string> = {
  [files.adaResume.id]: 'application/pdf',
  [files.adaCover.id]: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  [files.graceResume.id]: 'application/pdf',
  [files.offerLetter.id]: 'application/pdf',
};

const candidates = [
  {
    id: ADA,
    createdAt: '2026-08-28T09:14:03.551Z',
    updatedAt: '2026-09-19T11:02:44.019Z',
    name: 'Ada Lovelace',
    primaryEmailAddress: { value: 'ada@lovelace.dev', type: 'Personal', isPrimary: true },
    emailAddresses: [
      { value: 'ada@lovelace.dev', type: 'Personal', isPrimary: true },
      { value: 'Ada.Lovelace@AnalyticalEngines.co.uk', type: 'Work', isPrimary: false },
    ],
    primaryPhoneNumber: { value: '+44 20 7946 0958', type: 'Personal', isPrimary: true },
    phoneNumbers: [{ value: '+44 20 7946 0958', type: 'Personal', isPrimary: true }],
    socialLinks: [
      { type: 'LinkedIn', url: 'https://www.linkedin.com/in/adalovelace' },
      { type: 'GitHub', url: 'https://github.com/adalovelace' },
      { type: 'Website', url: 'https://lovelace.dev' },
    ],
    tags: [{ id: '5e6c39e3-6310-4b2f-98da-b7d332fb8a86', title: 'Strong candidate', isArchived: false }],
    position: 'Staff Software Engineer',
    company: 'Analytical Engines Ltd',
    school: 'University of London',
    applicationIds: ['315a6f9f-8bb4-40fc-9f8f-6360f535aba2'],
    resumeFileHandle: files.adaResume,
    fileHandles: [files.adaResume, files.adaCover],
    customFields: [
      { id: 'fba8c8c0-591a-4213-9a24-4045c81c2eb7', isPrivate: false, title: 'Notice period (weeks)', value: 4 },
      { id: '13c6be32-d0fc-4275-8b6c-9a6e95e3e17f', isPrivate: false, title: 'Visa status', value: 'requires_sponsorship', valueLabel: 'Requires sponsorship' },
    ],
    profileUrl: `https://app.ashbyhq.com/candidates/${ADA}`,
    source: sources.applied,
    creditedToUser: null,
    timezone: 'Europe/London',
    location: {
      id: '3f1d2c4b-5a69-4788-9a0b-1c2d3e4f5a6b',
      locationSummary: 'London, England, United Kingdom',
      locationComponents: [
        { type: 'City', name: 'London' },
        { type: 'Region', name: 'England' },
        { type: 'Country', name: 'United Kingdom' },
      ],
    },
    fraudStatus: null,
  },
  {
    id: GRACE,
    createdAt: '2026-03-02T19:47:22.310Z',
    updatedAt: '2026-08-14T17:05:13.002Z',
    name: 'Grace Hopper',
    primaryEmailAddress: { value: 'grace.hopper@example.com', type: 'Personal', isPrimary: true },
    emailAddresses: [{ value: 'grace.hopper@example.com', type: 'Personal', isPrimary: true }],
    primaryPhoneNumber: null,
    phoneNumbers: [],
    socialLinks: [{ type: 'LinkedIn', url: 'https://www.linkedin.com/in/gracehopper' }],
    tags: [{ id: 'c3502c19-3b7c-4d8d-8de8-ff9d039dde23', title: 'Boomerang', isArchived: false }],
    position: 'Principal Engineer',
    company: 'Harvard Computation Lab',
    applicationIds: ['4951d644-5a62-43f7-ab54-a19240253392', '000867a3-54a3-44d2-a60a-cd924e5818f0'],
    resumeFileHandle: files.graceResume,
    fileHandles: [files.graceResume],
    customFields: [],
    profileUrl: `https://app.ashbyhq.com/candidates/${GRACE}`,
    source: sources.referral,
    creditedToUser: priya,
    timezone: 'America/New_York',
    location: null,
    fraudStatus: 'NotFraudulent',
  },
  {
    id: ALAN,
    // Sourced long ago; his application is recent (the `since` test relies on that).
    createdAt: '2025-11-03T16:20:00.000Z',
    updatedAt: '2026-09-15T12:00:00.000Z',
    name: 'Alan Turing',
    primaryEmailAddress: { value: 'alan@turing.example', type: 'Work', isPrimary: true },
    emailAddresses: [{ value: 'alan@turing.example', type: 'Work', isPrimary: true }],
    primaryPhoneNumber: null,
    phoneNumbers: [],
    socialLinks: [{ type: 'LinkedIn', url: 'https://www.linkedin.com/in/alanturing' }],
    tags: [{ id: '7a0f3c55-2d19-4b8e-9c61-1f2e3d4c5b6a', title: 'Cryptography', isArchived: false }],
    position: 'Research Scientist',
    company: 'Bletchley Labs',
    applicationIds: ['a623bc76-804c-4efe-80d3-ede2f550f6aa'],
    resumeFileHandle: null,
    fileHandles: [],
    customFields: [],
    profileUrl: `https://app.ashbyhq.com/candidates/${ALAN}`,
    source: sources.linkedin,
    creditedToUser: maya,
    timezone: 'Europe/London',
    location: null,
    fraudStatus: 'Unreviewed',
  },
];
// Records the key may not see (confidential roles) are dropped after paging, so a page can come back empty with more to follow.
const hidden = (id: string, createdAt: string) => ({ id, createdAt, hidden: true });
const candidateRows = [
  candidates[0],
  candidates[1],
  hidden('3e4f5a6b-7c8d-4e9f-8a0b-1c2d3e4f5a60', '2026-02-11T08:00:00.000Z'),
  hidden('3e4f5a6b-7c8d-4e9f-8a0b-1c2d3e4f5a61', '2026-02-12T08:00:00.000Z'),
  candidates[2],
];
const inline = (c: (typeof candidates)[number]) => ({ id: c.id, name: c.name, primaryEmailAddress: c.primaryEmailAddress, primaryPhoneNumber: c.primaryPhoneNumber });

const APP = {
  ada: '315a6f9f-8bb4-40fc-9f8f-6360f535aba2',
  graceHired: '000867a3-54a3-44d2-a60a-cd924e5818f0',
  graceArchived: '4951d644-5a62-43f7-ab54-a19240253392',
  alan: 'a623bc76-804c-4efe-80d3-ede2f550f6aa',
};
const jobRef = (j: (typeof jobs)[number]) => ({ id: j.id, title: j.title, locationId: j.locationId, departmentId: j.departmentId });
const applications = [
  {
    id: APP.ada,
    createdAt: '2026-08-28T09:14:03.551Z',
    updatedAt: '2026-09-19T11:02:44.019Z',
    status: 'Active',
    // A date-only field, sent as a full instant (§5.20); customField.list says it's date-only.
    customFields: [{ id: '0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f', isPrivate: false, title: 'Expected start date', value: '2026-11-02T19:47:56.795Z' }],
    candidate: inline(candidates[0]),
    currentInterviewStage: currentStage(ENG_PLAN, ST.eTech),
    source: sources.applied,
    archiveReason: null,
    archivedAt: null,
    job: jobRef(jobs[0]),
    creditedToUser: null,
    hiringTeam: [
      { userId: maya.id, firstName: 'Maya', lastName: 'Patel', email: maya.email, role: 'Recruiter' },
      { userId: jane.id, firstName: 'Jane', lastName: 'Smith', email: jane.email, role: 'Hiring Manager' },
    ],
    appliedViaJobPostingId: POSTING,
    submitterClientIp: '81.2.69.160',
    submitterUserAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  },
  {
    id: APP.graceHired,
    createdAt: '2026-06-10T15:22:41.118Z',
    updatedAt: '2026-08-14T17:05:12.440Z',
    status: 'Hired',
    customFields: [],
    candidate: inline(candidates[1]),
    currentInterviewStage: currentStage(ENG_PLAN, ST.eHired),
    source: sources.referral,
    archiveReason: null,
    archivedAt: null,
    job: jobRef(jobs[0]),
    creditedToUser: priya,
    hiringTeam: [{ userId: maya.id, firstName: 'Maya', lastName: 'Patel', email: maya.email, role: 'Recruiter' }],
    appliedViaJobPostingId: null,
    submitterClientIp: null,
    submitterUserAgent: null,
  },
  {
    id: APP.graceArchived,
    createdAt: '2026-03-02T19:47:22.310Z',
    updatedAt: '2026-03-20T13:08:40.772Z',
    status: 'Archived',
    customFields: [],
    candidate: inline(candidates[1]),
    currentInterviewStage: currentStage(SALES_PLAN, ST.sArchived),
    source: sources.applied,
    archiveReason: { ...archiveReasons[1], customFields: [] },
    archivedAt: '2026-03-20T13:08:40.772Z',
    job: jobRef(jobs[1]),
    creditedToUser: null,
    hiringTeam: [],
    appliedViaJobPostingId: null,
    submitterClientIp: null,
    submitterUserAgent: null,
  },
  {
    id: APP.alan,
    createdAt: '2026-09-15T12:00:00.000Z',
    updatedAt: '2026-09-15T12:00:00.000Z',
    status: 'Lead',
    customFields: [],
    candidate: inline(candidates[2]),
    currentInterviewStage: currentStage(ENG_PLAN, ST.eLead),
    source: sources.linkedin,
    archiveReason: null,
    archivedAt: null,
    job: jobRef(jobs[0]),
    creditedToUser: maya,
    hiringTeam: [],
    appliedViaJobPostingId: null,
    submitterClientIp: null,
    submitterUserAgent: null,
  },
];

const move = (id: string, stageId: string, title: string, enteredStageAt: string, leftStageAt: string | null, stageNumber: number, actorId: string | null) => ({
  id,
  stageId,
  title,
  enteredStageAt,
  leftStageAt,
  stageNumber,
  allowedActions: stageNumber === 0 ? ['set_entered_at'] : ['delete', 'set_entered_at'],
  actorId,
});
const history: Record<string, ReturnType<typeof move>[]> = {
  [APP.ada]: [
    move('b7c1d2e3-0a1b-4c2d-8e3f-4a5b6c7d8e01', ST.eReview, 'Application Review', '2026-08-28T09:14:03.551Z', '2026-09-02T16:40:00.000Z', 0, null),
    move('b7c1d2e3-0a1b-4c2d-8e3f-4a5b6c7d8e02', ST.eScreen, 'Recruiter Screen', '2026-09-02T16:40:00.000Z', '2026-09-18T20:30:00.000Z', 1, maya.id),
    move('b7c1d2e3-0a1b-4c2d-8e3f-4a5b6c7d8e03', ST.eTech, 'Technical Interview', '2026-09-18T20:30:00.000Z', null, 2, maya.id),
  ],
  [APP.graceHired]: [
    move('7e512f89-78c7-4435-982c-2fa4ff8089bc', ST.eReview, 'Application Review', '2026-06-10T15:22:41.118Z', '2026-06-12T18:03:09.771Z', 0, null),
    move('25f909d8-fdf6-49e2-8b94-e405317f3491', ST.eScreen, 'Recruiter Screen', '2026-06-12T18:03:09.771Z', '2026-06-20T16:40:55.020Z', 1, maya.id),
    move('9d66df98-d3ab-4cae-92c0-764e7b3cbc04', ST.eTech, 'Technical Interview', '2026-06-20T16:40:55.020Z', '2026-07-08T21:11:37.905Z', 2, maya.id),
    move('f1cc1d67-14f7-4e12-9765-038d403087f9', ST.eOnsite, 'Onsite', '2026-07-08T21:11:37.905Z', '2026-07-24T19:30:02.614Z', 3, maya.id),
    move('37974cd0-9ecf-4de8-b018-fcad9db9c9d3', ST.eOffer, 'Offer', '2026-07-24T19:30:02.614Z', '2026-08-14T17:05:12.440Z', 4, jane.id),
    move('ac1619a9-eb93-4a46-b235-86fc590269c3', ST.eHired, 'Hired', '2026-08-14T17:05:12.440Z', null, 5, maya.id),
  ],
  [APP.graceArchived]: [
    move('c3d4e5f6-1a2b-4c3d-9e4f-5a6b7c8d9e01', ST.sReview, 'Application Review', '2026-03-02T19:47:22.310Z', '2026-03-05T10:00:00.000Z', 0, null),
    move('c3d4e5f6-1a2b-4c3d-9e4f-5a6b7c8d9e02', ST.sScreen, 'Recruiter Screen', '2026-03-05T10:00:00.000Z', '2026-03-20T13:08:40.772Z', 1, maya.id),
    move('c3d4e5f6-1a2b-4c3d-9e4f-5a6b7c8d9e03', ST.sArchived, 'Archived', '2026-03-20T13:08:40.772Z', null, 2, maya.id),
  ],
  [APP.alan]: [move('d4e5f6a7-2b3c-4d4e-8f5a-6b7c8d9e0f01', ST.eLead, 'Lead', '2026-09-15T12:00:00.000Z', null, 0, maya.id)],
};

const notes: Record<string, unknown[]> = {
  // Newest first, as Ashby returns them. The first is private and the key can't see it.
  [ADA]: [
    hidden('4f5a6b7c-8d9e-4f0a-9b1c-2d3e4f5a6b70', '2026-09-20T08:00:00.000Z'),
    { id: '2efc9e89-a9f8-4ab0-9eff-4d49f3252299', createdAt: '2026-09-19T11:02:44.019Z', isPrivate: true, content: 'Comp expectations above band; discuss with Jane before onsite.', author: author(jane) },
    { id: '9dd0b69e-fbb0-45be-b377-0e2c7f50a373', createdAt: '2026-09-02T16:45:10.527Z', isPrivate: false, content: 'Great phone screen. Very interested in the telemetry work.\nAvailable to start in 4 weeks.', author: author(maya) },
  ],
  // Written by a deactivated recruiter who has no Source account.
  [GRACE]: [{ id: '5c1d7a2e-8b3f-4e6a-9d0c-1b2a3c4d5e6f', createdAt: '2026-03-18T10:00:00.000Z', isPrivate: false, content: 'AE band tops out below her current package.', author: author(tom) }],
  [ALAN]: [],
};

const INTERVIEW = { backend: '03e29268-f3ac-48d9-8013-02ca0ac3a974', phone: 'd8227f75-7982-40ca-9373-c0d0c8ee8fea' };
const interviews = [
  { id: INTERVIEW.backend, title: 'Backend Technical Interview', externalTitle: 'Technical Interview', type: 'Interview', isArchived: false, isDebrief: false, isFeedbackRequired: true, isFeedbackRequested: true, instructionsHtml: '<p>Focus on API design and data modelling. Use the scorecard.</p>', instructionsPlain: 'Focus on API design and data modelling. Use the scorecard.', jobId: SBE, feedbackFormDefinitionId: 'f2ff36c1-89f8-4030-81f4-f750f154ee1b' },
  { id: INTERVIEW.phone, title: 'Recruiter Phone Screen', externalTitle: 'Intro call with Acme Robotics', type: 'Interview', isArchived: false, isDebrief: false, isFeedbackRequired: true, isFeedbackRequested: true, instructionsHtml: null, instructionsPlain: null, jobId: null, feedbackFormDefinitionId: 'f2ff36c1-89f8-4030-81f4-f750f154ee1b' },
];
const interviewer = (u: typeof priya, pool: unknown) => ({ ...u, trainingRole: null, interviewerPool: pool, isFeedbackRequired: true });
const ADA_EVENT = '03f4074d-e84c-4084-80d7-c5c4708f1767';
const GRACE_EVENT = 'bc11f653-18de-404a-8544-54d2718981a6';
const schedules = [
  {
    id: '45a32d47-dbd3-41ca-8710-abbc5481f0be',
    status: 'Scheduled',
    applicationId: APP.ada,
    interviewStageId: ST.eTech,
    scheduledBy: maya,
    createdAt: '2026-09-18T20:31:05.412Z',
    updatedAt: '2026-09-18T20:33:47.090Z',
    interviewEvents: [
      {
        id: ADA_EVENT,
        interviewId: INTERVIEW.backend,
        interviewScheduleId: '45a32d47-dbd3-41ca-8710-abbc5481f0be',
        interviewerUserIds: [priya.id],
        interviewers: [interviewer(priya, { id: '8646f388-eecc-40b4-9b05-c80183ce5601', title: 'Backend interviewers', isArchived: false })],
        createdAt: '2026-09-18T20:31:05.412Z',
        updatedAt: '2026-09-18T20:33:47.090Z',
        startTime: '2026-09-25T17:00:00.000Z',
        endTime: '2026-09-25T18:00:00.000Z',
        feedbackLink: `https://app.ashbyhq.com/interview-briefings/${ADA_EVENT}/feedback`,
        location: 'Zoom',
        meetingLink: 'https://acmerobotics.zoom.us/j/81234567890',
        interviewerCalendarEventId: null,
        hasSubmittedFeedback: false,
        extraData: null,
        notetakerTranscriptId: null,
      },
    ],
  },
  {
    id: '49b55bf2-123b-4e08-ac40-0d106dc84f73',
    status: 'Complete',
    applicationId: APP.graceHired,
    interviewStageId: ST.eOnsite,
    scheduledBy: null,
    createdAt: '2026-07-09T15:02:19.000Z',
    updatedAt: '2026-07-23T01:12:09.338Z',
    interviewEvents: [
      {
        id: GRACE_EVENT,
        interviewId: INTERVIEW.backend,
        interviewScheduleId: '49b55bf2-123b-4e08-ac40-0d106dc84f73',
        interviewerUserIds: [priya.id],
        interviewers: [interviewer(priya, null)],
        createdAt: '2026-07-09T15:02:19.000Z',
        updatedAt: '2026-07-23T01:12:09.338Z',
        startTime: '2026-07-22T18:00:00.000Z',
        endTime: '2026-07-22T19:30:00.000Z',
        feedbackLink: `https://app.ashbyhq.com/interview-briefings/${GRACE_EVENT}/feedback`,
        location: 'SF HQ – Room Babbage',
        meetingLink: null,
        interviewerCalendarEventId: null,
        hasSubmittedFeedback: true,
        extraData: null,
        notetakerTranscriptId: null,
      },
    ],
  },
];

const field = (id: string, type: string, path: string, title: string, selectableValues?: { label: string; value: string }[]) => ({
  isRequired: false,
  field: { id, type, path, humanReadablePath: title, title, isNullable: true, ...(selectableValues ? { selectableValues } : {}) },
});
const feedback = [
  {
    // Default form: overall_recommendation "4" = Strong Yes. Priya has no Source account.
    id: 'dbe50cf6-33aa-4055-868b-92dfd2be8f1e',
    applicationId: APP.graceHired,
    feedbackFormDefinitionId: 'f2ff36c1-89f8-4030-81f4-f750f154ee1b',
    interviewId: INTERVIEW.backend,
    interviewEventId: GRACE_EVENT,
    applicationHistoryId: 'f1cc1d67-14f7-4e12-9765-038d403087f9',
    submittedAt: '2026-07-23T01:12:09.338Z',
    submittedByUser: priya,
    creditedToUser: priya,
    formDefinition: {
      sections: [
        {
          title: 'Overall',
          fields: [
            field('12bde86d-3dd2-40ed-9fc5-7261cbb41a59', 'ValueSelect', 'overall_recommendation', 'Overall Recommendation', [
              { label: '4 - Strong Yes', value: '4' },
              { label: '3 - Yes', value: '3' },
              { label: '2 - No', value: '2' },
              { label: '1 - Strong No', value: '1' },
            ]),
            field('78bd7d68-139e-46ed-b028-dccd0c0d1889', 'LongText', '78bd7d68-139e-46ed-b028-dccd0c0d1889', 'Notes'),
          ],
        },
        { title: 'Skills', fields: [field('ce5de027-0444-4613-acde-c985f55559f0', 'Score', 'ce5de027-0444-4613-acde-c985f55559f0', 'System design')] },
      ],
    },
    submittedValues: {
      overall_recommendation: '4',
      '78bd7d68-139e-46ed-b028-dccd0c0d1889': 'Designed a sharded ingest pipeline end to end, clear trade-off reasoning.',
      'ce5de027-0444-4613-acde-c985f55559f0': { score: 4, comments: { type: 'PlainText', value: 'Best design round this quarter.' } },
    },
  },
  {
    // A screening form with no overall decision → kept as a note.
    id: '8f14e45f-ceea-467a-9575-2c5e8b5d7c01',
    applicationId: APP.ada,
    feedbackFormDefinitionId: '3c59dc04-8e2f-4b1a-9d6c-7e8f9a0b1c2d',
    interviewId: INTERVIEW.phone,
    interviewEventId: null,
    applicationHistoryId: 'b7c1d2e3-0a1b-4c2d-8e3f-4a5b6c7d8e02',
    submittedAt: '2026-09-03T09:30:00.000Z',
    submittedByUser: maya,
    creditedToUser: maya,
    formDefinition: {
      sections: [
        {
          title: 'Screen',
          fields: [
            field('6a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', 'LongText', 'screen_notes', 'Notes'),
            field('7b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e', 'MultiValueSelect', 'teams', 'Interested teams', [
              { label: 'Platform', value: 'platform' },
              { label: 'Data', value: 'data' },
            ]),
          ],
        },
      ],
    },
    submittedValues: { screen_notes: 'Strong communicator; wants platform work. Needs the technical loop before a decision.', teams: ['platform', 'data'] },
  },
  {
    // A custom form on another scale: "no_hire" → 2.
    id: 'e4da3b7f-bbce-4345-9777-2b0674a318d5',
    applicationId: APP.graceArchived,
    feedbackFormDefinitionId: '1679091c-5a88-4faf-afb5-e6087eb1b2dc',
    interviewId: null,
    interviewEventId: null,
    applicationHistoryId: null,
    submittedAt: '2026-03-12T17:45:00.000Z',
    submittedByUser: maya,
    creditedToUser: maya,
    formDefinition: {
      sections: [
        {
          title: 'Hiring manager screen',
          fields: [
            field('8c4d5e6f-7a8b-4c9d-8e0f-2a3b4c5d6e7f', 'ValueSelect', 'decision', 'Recommendation', [
              { label: 'Strong Hire', value: 'strong_hire' },
              { label: 'Hire', value: 'hire' },
              { label: 'No Hire', value: 'no_hire' },
              { label: 'Strong No Hire', value: 'strong_no_hire' },
            ]),
            field('9d5e6f7a-8b9c-4d0e-9f1a-3b4c5d6e7f80', 'Boolean', 'would_work_with', 'Would you work with them?'),
          ],
        },
      ],
    },
    submittedValues: { decision: 'no_hire', would_work_with: true },
  },
];

const offers = [
  {
    id: '22f7fe0d-313d-4ce4-9976-3c88b78f2e60',
    decidedAt: '2026-08-14T16:58:31.007Z',
    applicationId: APP.graceHired,
    acceptanceStatus: 'Accepted',
    offerStatus: 'CandidateAccepted',
    latestVersion: {
      id: '775dd413-322c-4ba0-ab53-51aa9648c4ed',
      startDate: '2026-09-08',
      salary: { value: 195000, currencyCode: 'USD' },
      createdAt: '2026-07-28T20:15:44.102Z',
      openingId: '7d36a903-948e-401c-98cf-3efd4486c1ab',
      customFields: [
        { id: '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c80', isPrivate: false, title: 'Relocation option', value: 'full_package', valueLabel: 'Full package' },
        { id: '46d95499-58de-4c68-ab3d-a2415716949f', isPrivate: true, title: 'Equity (options)', value: 12000 },
        { id: '0e1d2c3b-4a59-4687-8a9b-0c1d2e3f4a5b', isPrivate: true, title: 'Signing bonus', value: { value: 15000, currencyCode: 'USD' } },
        // Offer-version values can be date-time strings.
        { id: '6b7c8d9e-0f1a-4b2c-9d3e-4f5a6b7c8d90', isPrivate: false, title: 'Offer expires', value: '2026-08-01T00:00:00.000Z' },
      ],
      fileHandles: [files.offerLetter],
      author: maya,
      approvalStatus: 'Approved',
    },
    formDefinition: { sections: [] },
    versions: [],
  },
];

// customField.list (§5.20), with the date-only application field.
const fieldDefs = [
  { id: '13c6be32-d0fc-4275-8b6c-9a6e95e3e17f', title: 'Visa status', description: 'Work authorization at time of application', objectType: 'Candidate', isArchived: false, isPrivate: false, isEditableOnlyViaPublicApi: false, fieldType: 'ValueSelect', isRequired: false, selectableValues: [{ label: 'Authorized', value: 'authorized', isArchived: false }, { label: 'Requires sponsorship', value: 'requires_sponsorship', isArchived: false }] },
  { id: 'fba8c8c0-591a-4213-9a24-4045c81c2eb7', title: 'Notice period (weeks)', description: null, objectType: 'Candidate', isArchived: false, isPrivate: false, isEditableOnlyViaPublicApi: false, fieldType: 'Number', isRequired: false },
  { id: '0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f', title: 'Expected start date', description: null, objectType: 'Application', isArchived: false, isPrivate: false, isEditableOnlyViaPublicApi: false, fieldType: 'Date', isRequired: false, isDateOnlyField: true },
];

// ---------- The mock API ----------

/** Request params each endpoint documents; anything else is refused, as `additionalProperties: false` would. */
const PARAMS: Record<string, string[]> = {
  'brand.list': ['limit', 'cursor', 'syncToken'],
  'jobBoard.list': [],
  'apiKey.info': [],
  'user.list': ['includeDeactivated', 'limit', 'cursor', 'syncToken'],
  'interviewPlan.list': ['includeArchived', 'limit', 'cursor', 'syncToken'],
  'interviewStage.list': ['interviewPlanId'],
  'interviewStage.info': ['interviewStageId'],
  'customField.list': ['includeArchived', 'limit', 'cursor', 'syncToken'],
  'archiveReason.list': ['includeArchived'],
  'department.list': ['includeArchived', 'limit', 'cursor', 'syncToken'],
  'job.list': ['limit', 'cursor', 'syncToken', 'status', 'openedAfter', 'openedBefore', 'closedAfter', 'closedBefore', 'includeUnpublishedJobPostingsIds', 'expand'],
  'job.info': ['id', 'expand'],
  'jobPosting.info': ['jobPostingId', 'includeUnpublishedJobPostings', 'expand', 'jobBoardId'],
  'candidate.list': ['limit', 'cursor', 'syncToken', 'createdAfter', 'createdBefore'],
  'candidate.info': ['id', 'externalMappingId'],
  'candidate.listNotes': ['candidateId', 'limit', 'cursor', 'syncToken'],
  'application.list': ['limit', 'cursor', 'syncToken', 'status', 'jobId', 'createdAfter', 'createdBefore', 'expand'],
  'application.info': ['applicationId', 'expand'],
  'application.listHistory': ['applicationId', 'limit', 'cursor'],
  'interview.list': ['includeArchived', 'includeNonSharedInterviews', 'limit', 'cursor', 'syncToken'],
  'interviewSchedule.list': ['limit', 'cursor', 'syncToken', 'applicationId', 'interviewStageId', 'createdAfter'],
  'applicationFeedback.list': ['applicationId', 'limit', 'cursor', 'syncToken', 'createdAfter'],
  'offer.list': ['limit', 'cursor', 'syncToken', 'applicationId', 'offerStatus', 'acceptanceStatus', 'approvalStatus', 'createdAfter'],
  'file.info': ['fileHandle'],
};

/**
 * Ashby-style cursor pagination; the mock serves `size` records a page to exercise the terminal condition.
 * `hidden` rows take a slot and are then dropped, as Ashby drops records the key may not see.
 */
function paginate(items: unknown[], body: Body, size = 100) {
  const per = Math.min(size, typeof body.limit === 'number' ? body.limit : 100);
  const start = typeof body.cursor === 'string' ? Number(Buffer.from(body.cursor, 'base64url').toString()) : 0;
  const end = start + per;
  const visible = (rows: unknown[]) => rows.filter((r) => !(r as { hidden?: boolean }).hidden);
  return end < items.length
    ? json({ success: true, results: visible(items.slice(start, end)), moreDataAvailable: true, nextCursor: Buffer.from(String(end)).toString('base64url') })
    : json({ success: true, results: visible(items.slice(start)), moreDataAvailable: false, syncToken: 'mqXvvQBWO' });
}

const notFound = (code: string, message: string) => json({ success: false, errorInfo: { code, message, requestId: 'req-1' } });

const after = (body: Body, iso: string) => typeof body.createdAfter !== 'number' || Date.parse(iso) > body.createdAfter;

type MockOptions = {
  /** Endpoints the key lacks permission for (Ashby answers 403 missing_endpoint_permission). */
  deny?: string[];
  overrides?: Record<string, (body: Body) => Response>;
};

function ashbyApi(opts: MockOptions = {}) {
  const violations: string[] = [];
  const signed = new Map<string, number>();

  const rpc = (endpoint: string, handler: (body: Body) => Response): [string, RouteHandler] => [
    `POST ${API}/${endpoint}`,
    ({ headers, body }) => {
      if (!headers.authorization) return json({ success: false, errors: ['Missing authentication'] }, { status: 401 });
      if (headers.authorization !== BASIC) return json({ success: false, errors: ['Invalid API key'] }, { status: 403 });
      if (headers['content-type'] !== 'application/json') violations.push(`${endpoint}: content-type ${headers['content-type']}`);
      const b = (body ?? {}) as Body;
      const unknown = Object.keys(b).filter((k) => !PARAMS[endpoint].includes(k));
      if (unknown.length) {
        violations.push(`${endpoint}: ${unknown.join(', ')}`);
        return json({ success: false, errors: [{ message: `Unknown parameter "${unknown[0]}"`, parameter: unknown[0] }] });
      }
      if (typeof b.limit === 'number' && b.limit > 100) violations.push(`${endpoint}: limit ${b.limit}`);
      if (opts.deny?.includes(endpoint)) {
        return json({ success: false, errorInfo: { code: 'missing_endpoint_permission', message: `The API key is missing permission for ${endpoint}` } }, { status: 403 });
      }
      return (opts.overrides?.[endpoint] ?? handler)(b);
    },
  ];

  const routes: Record<string, RouteHandler> = Object.fromEntries([
    rpc('brand.list', (b) => paginate([{ id: 'e88c20af-8732-426e-84a2-3f41045f1603', name: 'Acme Robotics', hostedJobsPageSlug: 'acme-robotics' }], b)),
    rpc('jobBoard.list', () =>
      json({
        success: true,
        results: [
          { id: '446adc6a-73b0-4439-97a6-ac8e7994ab46', title: 'Acme Careers', isInternal: false },
          { id: INTERNAL_BOARD, title: 'Acme Internal Mobility', isInternal: true },
        ],
      }),
    ),
    rpc('apiKey.info', () => json({ success: true, results: { title: 'Source import', createdAt: '2026-09-20T16:04:11.512Z', scopes: ['apiKeys:read', 'candidates:read'] } })),
    rpc('user.list', (b) => paginate(users.filter((u) => b.includeDeactivated === true || u.isEnabled), b)),
    rpc('interviewPlan.list', (b) =>
      paginate([{ id: ENG_PLAN, title: 'Engineering Interview Plan', isArchived: false, createdAt: '2024-02-03T19:20:44.964Z', updatedAt: '2026-03-13T21:30:57.965Z' }], b),
    ),
    rpc('interviewStage.list', (b) => {
      const list = planStages[String(b.interviewPlanId)];
      return list
        ? json({ success: true, results: list, moreDataAvailable: false })
        : json({ success: false, errorInfo: { code: 'interview_plan_not_found', message: 'Interview plan not found', requestId: 'req-1' } });
    }),
    rpc('interviewStage.info', (b) => {
      const s = Object.values(planStages).flat().find((x) => x.id === b.interviewStageId);
      return s ? json({ success: true, results: s }) : notFound('interview_stage_not_found', 'Interview stage not found');
    }),
    rpc('customField.list', (b) => paginate(fieldDefs, b)),
    rpc('archiveReason.list', (b) => json({ success: true, results: archiveReasons.filter((r) => b.includeArchived === true || !r.isArchived) })),
    rpc('department.list', (b) => paginate(departments, b)),
    rpc('job.list', (b) => {
      const expand = Array.isArray(b.expand) ? (b.expand as string[]) : [];
      const statuses = Array.isArray(b.status) ? (b.status as string[]) : ['Open'];
      const results = jobs
        .filter((j) => statuses.includes(j.status))
        .map((j) => ({
          ...j,
          ...(expand.includes('openings') ? { openings: jobOpenings[j.id] } : {}),
          ...(expand.includes('location') ? { location: jobLocations[j.id] } : {}),
        }));
      return paginate(results, b);
    }),
    rpc('job.info', (b) => {
      const j = jobs.find((x) => x.id === b.id);
      if (!j) return notFound('job_not_found', 'Job not found');
      const expand = Array.isArray(b.expand) ? (b.expand as string[]) : [];
      return json({ success: true, results: { ...j, ...(expand.includes('compensation') ? { compensation: jobCompensation[j.id] ?? null } : {}) } });
    }),
    rpc('jobPosting.info', (b) =>
      b.jobPostingId === POSTING
        ? json({ success: true, results: posting })
        : json({ success: false, errorInfo: { code: 'job_posting_not_found', message: 'Job posting not found' } }),
    ),
    rpc('candidate.list', (b) => paginate(candidateRows.filter((c) => after(b, c.createdAt)), b, 2)),
    rpc('candidate.info', (b) => {
      const c = candidates.find((x) => x.id === b.id);
      return c ? json({ success: true, results: c }) : json({ success: false, errorInfo: { code: 'candidate_not_found', message: 'Candidate not found' } });
    }),
    rpc('candidate.listNotes', (b) => paginate(notes[String(b.candidateId)] ?? [], b, 1)),
    rpc('application.list', (b) =>
      paginate(
        applications.filter((a) => (typeof b.status !== 'string' || a.status.toLowerCase() === b.status.toLowerCase()) && after(b, a.createdAt)),
        b,
        2,
      ),
    ),
    rpc('application.info', (b) => {
      const a = applications.find((x) => x.id === b.applicationId);
      return a ? json({ success: true, results: a }) : notFound('application_not_found', 'Application not found');
    }),
    rpc('application.listHistory', (b) => paginate(history[String(b.applicationId)] ?? [], b)),
    rpc('interview.list', (b) => paginate(interviews, b)),
    rpc('interviewSchedule.list', (b) => paginate(schedules.filter((s) => after(b, s.createdAt)), b)),
    rpc('applicationFeedback.list', (b) =>
      paginate(feedback.filter((f) => (!b.applicationId || f.applicationId === b.applicationId) && after(b, f.submittedAt)), b),
    ),
    rpc('offer.list', (b) => paginate(offers.filter((o) => after(b, o.latestVersion.createdAt)), b)),
    rpc('file.info', (b) => {
      const f = Object.values(files).find((x) => x.handle === b.fileHandle);
      if (!f) return json({ success: false, errorInfo: { code: 'file_not_found', message: 'File not found' } });
      const n = (signed.get(f.id) ?? 0) + 1;
      signed.set(f.id, n);
      const url = `https://${S3}/${BUCKET}/${f.id}/${encodeURIComponent(f.name)}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Date=20260923T161000Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host&X-Amz-Signature=sig${n}`;
      return json({ success: true, results: { url } });
    }),
    ...Object.values(files).map((f): [string, RouteHandler] => [
      `GET ${S3}/${BUCKET}/${f.id}/${encodeURIComponent(f.name)}`,
      ({ url }) => {
        // Grace's first link has already expired by the time it's used.
        if (f.id === files.graceResume.id && url.searchParams.get('X-Amz-Signature') === 'sig1') {
          return new Response('<Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>', { status: 403, headers: { 'content-type': 'application/xml' } });
        }
        return new Response(Buffer.from(`%PDF-1.4 ${f.name}`), { headers: { 'content-type': fileMime[f.id], 'content-length': String(9 + f.name.length) } });
      },
    ]),
  ]);

  return { ...mockFetch(routes), violations };
}

type Api = ReturnType<typeof ashbyApi>;
const paths = (api: Api) => api.calls.map((c) => `${c.url.host}${c.url.pathname}`);
const bodiesOf = (api: Api, endpoint: string) => api.calls.filter((c) => c.url.pathname === `/${endpoint}`).map((c) => c.body as Body);

type Loaded = {
  requisition: ImportedRequisition[];
  posting: ImportedPosting[];
  contact: ImportedCandidate[];
  opportunity: ImportedApplication[];
  interview: ImportedInterview[];
  feedback: ImportedFeedback[];
  note: ImportedNote[];
  offer: ImportedOffer[];
  file: ImportedFile[];
};

/**
 * Drive the adapter's phases directly with a recording loader: no database, the
 * exact records handed to the engine, and cursors round-tripped through JSON.
 * No retries, so an outage surfaces on the first answer.
 */
function adapterRun(api: Api, opts: { options?: Partial<ImportOptions>; outOfTime?: boolean } = {}) {
  const http = createHttpClient({ resolveHost: publicDns, auth: ashbyProvider.auth({ apiKey: KEY }), minIntervalMs: 0, maxRetries: 0, sleep: async () => {}, fetchImpl: api.impl });
  const adapter = ashbyProvider.create({ apiKey: KEY }, http);
  const catalog = { stages: [] as CatalogStage[], reasons: [] as CatalogReason[], users: [] as CatalogUser[] };
  const loaded: Loaded = { requisition: [], posting: [], contact: [], opportunity: [], interview: [], feedback: [], note: [], offer: [], file: [] };
  const warnings: string[] = [];
  const ids = (kind: RefKind): string[] =>
    kind === 'stage'
      ? catalog.stages.map((s) => s.externalId)
      : kind === 'reason'
        ? catalog.reasons.map((r) => r.externalId)
        : kind === 'user'
          ? catalog.users.map((u) => u.externalId)
          : (loaded[kind] as { externalId: string }[]).map((r) => r.externalId);
  const load: Loader = {
    has: async (kind, id) => ids(kind).includes(id),
    handled: async () => false,
    requisition: async (r) => void loaded.requisition.push(r),
    posting: async (r) => void loaded.posting.push(r),
    candidate: async (r) => void loaded.contact.push(r),
    application: async (r) => void loaded.opportunity.push(r),
    interview: async (r) => void loaded.interview.push(r),
    feedback: async (r) => void loaded.feedback.push(r),
    note: async (r) => void loaded.note.push(r),
    offer: async (r) => void loaded.offer.push(r),
    file: async (r) => void loaded.file.push(r),
  };
  const options: ImportOptions = { ...DEFAULT_IMPORT_OPTIONS, ...opts.options };
  const ctx: PhaseContext = {
    http,
    catalog: {
      stage: (s) => void catalog.stages.push(s),
      reason: (r) => void catalog.reasons.push(r),
      user: (u) => void catalog.users.push(u),
    },
    load,
    options,
    since: options.since ? new Date(options.since) : null,
    outOfTime: () => !!opts.outOfTime,
    warn: (m) => void warnings.push(m),
  };
  let steps = 0;
  /** Run these phases (all when none are named) to completion, in the adapter's order. */
  async function run(...phaseIds: string[]) {
    for (const phase of [...adapter.discover, ...adapter.load]) {
      if ((phaseIds.length && !phaseIds.includes(phase.id)) || (phase.enabled && !phase.enabled(options))) continue;
      let cursor: Cursor | null = null;
      do {
        const next: Cursor | null = await phase.run(ctx, cursor);
        cursor = next === null ? null : (JSON.parse(JSON.stringify(next)) as Cursor);
        steps++;
      } while (cursor !== null && steps < 1000);
    }
  }
  return { run, catalog, loaded, warnings, ids, steps: () => steps };
}

const ratingOptions = [
  { label: 'Strong Hire', value: 'strong_hire' },
  { label: 'Hire', value: 'hire' },
  { label: 'No Hire', value: 'no_hire' },
  { label: 'Strong No Hire', value: 'strong_no_hire' },
];

// ---------- Tests ----------

async function seedOrg() {
  const org = await db.organization.create({
    data: { slug: `ashby-test-${randomUUID().slice(0, 8)}`, name: 'Acme Robotics', kind: 'COMPANY', onboardedAt: new Date() },
  });
  // Jane runs the import; Maya is a teammate. Priya and Tom have no Source accounts.
  const admin = await db.user.create({ data: { orgId: org.id, email: 'jane.smith@acmerobotics.com', name: 'Jane Smith', accessRole: 'ADMIN' } });
  const teammate = await db.user.create({ data: { orgId: org.id, email: 'maya.patel@acmerobotics.com', name: 'Maya Patel', accessRole: 'TEAM_MEMBER' } });
  await db.stage.createMany({
    data: [
      { orgId: org.id, name: 'New applicant', type: 'APPLICANT', order: 0 },
      { orgId: org.id, name: 'Phone screen', type: 'SCREEN', order: 1 },
      { orgId: org.id, name: 'On-site', type: 'ONSITE', order: 2 },
      { orgId: org.id, name: 'Offer', type: 'OFFER', order: 3 },
      { orgId: org.id, name: 'Hired', type: 'HIRED', order: 4 },
    ],
  });
  return { orgId: org.id, adminId: admin.id, mayaId: teammate.id };
}

const importedId = (o: { customFields: unknown }) => (o.customFields as { imported: { id: string } }).imported.id;

describe.skipIf(!hasDb)('Ashby adapter', () => {
  let org: Awaited<ReturnType<typeof seedOrg>>;

  beforeAll(async () => {
    org = await seedOrg();
  });

  it('lists its phases without credentials and sends the key as Basic auth only to the API host', () => {
    const adapter = ashbyProvider.create({}, createHttpClient({ resolveHost: publicDns, auth: { hosts: [] }, minIntervalMs: 0 }));
    expect(adapter.discover.map((p) => p.id)).toEqual(['users', 'stages', 'reasons']);
    expect(adapter.load.map((p) => p.id)).toEqual([
      'requisitions',
      'postings',
      'candidates',
      'applications',
      'interviews',
      'feedback',
      'notes',
      'offers',
      'files',
    ]);
    expect(ashbyProvider.auth({ apiKey: KEY })).toEqual({ hosts: [API], headers: { authorization: BASIC } });
    expect(ashbyProvider.minIntervalMs).toBeGreaterThanOrEqual(60); // 1,000 req/min is the ceiling
  });

  it('verifies the key and names the account after its brand', async () => {
    const api = ashbyApi();
    await expect(verifyForTest(ashbyProvider, { apiKey: KEY }, api.impl)).resolves.toEqual({ accountName: 'Acme Robotics' });
    expect(paths(api)).toEqual([`${API}/candidate.list`, `${API}/job.list`, `${API}/brand.list`]);
    for (const c of api.calls) {
      expect(c.method).toBe('POST');
      expect(c.headers.authorization).toBe(BASIC);
      expect(c.headers['content-type']).toBe('application/json');
    }
    expect(api.unmatched).toEqual([]);
    expect(api.violations).toEqual([]);
  });

  it('tells a wrong key from one missing a permission, and falls back to the job board name without Organization read', async () => {
    // Ashby answers 403 to both. Every other module refusing the key too makes it a wrong key.
    const wrong = ashbyApi();
    const err = await verifyForTest(ashbyProvider, { apiKey: 'not-the-key' }, wrong.impl).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImportAuthError);
    expect((err as ImportAuthError).status).toBe(401);
    expect((err as Error).message).not.toContain('not-the-key');

    for (const [endpoint, module] of [
      ['candidate.list', 'Candidates'],
      ['job.list', 'Jobs'],
    ]) {
      const missing = ashbyApi({ deny: [endpoint] });
      const denied = await verifyForTest(ashbyProvider, { apiKey: KEY }, missing.impl).catch((e: unknown) => e);
      expect(denied).toBeInstanceOf(ImportAuthError);
      expect((denied as ImportAuthError).status).toBe(403);
      expect((denied as Error).message).toBe(`This key can't read ${module}. In Ashby, edit the key and tick Read for ${module}.`);
    }

    const limited = ashbyApi({ deny: ['brand.list'] });
    await expect(verifyForTest(ashbyProvider, { apiKey: KEY }, limited.impl)).resolves.toEqual({ accountName: 'Acme Careers' });
  });

  it('imports jobs, candidates, applications with history, scorecards, interviews, notes, offers and resumes', async () => {
    const api = ashbyApi();
    const res = await runImportForTest({ module: ashbyProvider, credentials: { apiKey: KEY }, fetchImpl: api.impl, orgId: org.orgId });
    expect(res.error).toBeNull();
    expect(res.status).toBe('SUCCEEDED');
    expect(api.unmatched).toEqual([]);
    expect(api.violations).toEqual([]);
    expect(res.view.issues).toEqual([]);

    // Review: stages from both plans grouped by name. The Sales plan was only reachable through job.list.
    expect(bodiesOf(api, 'interviewStage.list').map((b) => b.interviewPlanId)).toEqual([ENG_PLAN, SALES_PLAN]);
    const stages = Object.fromEntries(res.review!.stages.map((s) => [s.key, s]));
    expect(Object.keys(stages).sort()).toEqual([
      'application review',
      'hired',
      'hiring manager screen',
      'lead',
      'offer',
      'onsite',
      'recruiter screen',
      'technical interview',
    ]);
    expect(stages['recruiter screen'].count).toBe(2);
    expect(stages['technical interview'].count).toBe(1);
    expect(stages['offer'].target).toHaveProperty('stageId');
    expect(stages['hired'].target).toHaveProperty('stageId');
    expect(stages['lead'].target).toEqual({ create: { name: 'Lead', type: 'LEAD' } });
    expect(stages['application review'].target).toEqual({ create: { name: 'Application Review', type: 'APPLICANT' } });
    // Active stages: a screen by name, else the plan's first is the screen and later ones are onsite.
    expect(stages['recruiter screen'].target).toEqual({ create: { name: 'Recruiter Screen', type: 'SCREEN' } });
    expect(stages['technical interview'].target).toEqual({ create: { name: 'Technical Interview', type: 'ONSITE' } });
    expect(stages['onsite'].target).toHaveProperty('stageId'); // Matches the org's existing "On-site" (punctuation doesn't matter), rather than a near-duplicate.
    expect(stages['hiring manager screen'].target).toEqual({ create: { name: 'Hiring Manager Screen', type: 'SCREEN' } });
    // Ashby's `Other` reasons (duplicates, filled roles) aren't rejections.
    expect(res.review!.reasons.map((r) => [r.name, r.target])).toEqual([
      ['Too inexperienced', { create: { name: 'Too inexperienced', countsAsRejection: true } }],
      ['Compensation mismatch', { create: { name: 'Compensation mismatch', countsAsRejection: false } }],
      ['Duplicate application', { create: { name: 'Duplicate application', countsAsRejection: false } }],
    ]);
    expect(res.review!.users).toMatchObject({ total: 4, matched: 2 });

    expect(res.view.created).toEqual({
      requisition: 1,
      posting: 2,
      contact: 3,
      opportunity: 4,
      interview: 2,
      feedback: 3,
      note: 3,
      offer: 1,
      file: 4,
    });

    // Pagination followed nextCursor to the page where moreDataAvailable is false, through a page
    // Ashby emptied of confidential candidates (candidates, then the notes and files walks).
    const candidatePages = bodiesOf(api, 'candidate.list').filter((b) => b.limit === 100);
    expect(candidatePages.map((b) => typeof b.cursor)).toEqual(Array(3).fill(['undefined', 'string', 'string']).flat());
    // Discover reads applications for their plans, then the applications phase reads them again.
    expect(bodiesOf(api, 'application.list').map((b) => typeof b.cursor)).toEqual(['undefined', 'string', 'undefined', 'string']);
    // Ada's first note is hidden from the key, so her first notes page is empty yet promises more.
    expect(bodiesOf(api, 'candidate.listNotes').filter((b) => b.candidateId === ADA)).toHaveLength(3);

    // Jobs
    const postings = await db.posting.findMany({ where: { orgId: org.orgId }, include: { department: true, requisition: true } });
    const sbe = postings.find((p) => p.title === 'Senior Backend Engineer')!;
    expect(sbe).toMatchObject({ state: 'DRAFT', location: 'San Francisco', workplaceType: 'HYBRID', commitment: 'FULL_TIME', salaryMin: 170000, salaryMax: 210000, salaryCurrency: 'USD' });
    expect(sbe.department!.name).toBe('Platform Engineering');
    // The job page's opening, then the body (no closing here).
    expect((sbe.content as { description: string }).description).toBe(
      "Acme Robotics builds warehouse robots.\n\nAbout the role\n\nYou will own the services that power our fleet telemetry.\n\nWhat you'll do\n\n• Design APIs\n• Mentor engineers",
    );
    expect(sbe.requisition).toMatchObject({ code: 'ENG-042', title: 'Senior Backend Engineer', state: 'OPEN', openings: 2, filled: 1, backfill: true });
    // No posting: the pay comes from the job's own compensation plan.
    const ae = postings.find((p) => p.title === 'Account Executive')!;
    expect(ae).toMatchObject({ state: 'CLOSED', location: 'Remote (US)', workplaceType: 'REMOTE', requisitionId: null, content: null, salaryMin: 90000, salaryMax: 110000, salaryCurrency: 'USD' });
    expect(ae.department!.name).toBe('Sales');
    expect(bodiesOf(api, 'job.info')).toEqual([{ id: AE, expand: ['compensation'] }]);

    // Candidates
    const contacts = await db.contact.findMany({ where: { orgId: org.orgId }, orderBy: { createdAt: 'asc' } });
    expect(contacts.map((c) => c.name)).toEqual(['Alan Turing', 'Grace Hopper', 'Ada Lovelace']);
    const ada = contacts.find((c) => c.name === 'Ada Lovelace')!;
    expect(ada).toMatchObject({
      emails: ['ada@lovelace.dev', 'ada.lovelace@analyticalengines.co.uk'],
      phones: ['+44 20 7946 0958'],
      links: ['https://www.linkedin.com/in/adalovelace', 'https://github.com/adalovelace', 'https://lovelace.dev'],
      tags: ['Strong candidate'],
      headline: 'Staff Software Engineer at Analytical Engines Ltd',
      location: 'London, England, United Kingdom',
    });
    expect(ada.createdAt.toISOString()).toBe('2026-08-28T09:14:03.551Z');
    // Candidate custom fields need the full record, fetched once per candidate.
    expect([...new Set(bodiesOf(api, 'candidate.info').map((b) => b.id))].sort()).toEqual([ADA, ALAN, GRACE].sort());

    // Applications
    const opps = await db.opportunity.findMany({
      where: { orgId: org.orgId },
      include: { stage: true, archiveReason: true, posting: true, stageTransitions: { orderBy: { occurredAt: 'asc' }, include: { toStage: true } } },
    });
    const opp = (id: string) => opps.find((o) => importedId(o) === id)!;

    const adaApp = opp(APP.ada);
    expect(adaApp).toMatchObject({ status: 'ACTIVE', origin: 'APPLIED', source: 'Applied', ownerId: org.mayaId, confidential: false, archivedAt: null });
    expect(adaApp.stage.name).toBe('Technical Interview');
    expect(adaApp.posting!.title).toBe('Senior Backend Engineer');
    expect(adaApp.stageTransitions.map((t) => t.toStage.name)).toEqual(['Application Review', 'Recruiter Screen', 'Technical Interview']);
    expect(adaApp.stageTransitions.map((t) => t.actorId)).toEqual([null, org.mayaId, org.mayaId]);
    expect(adaApp.stageTransitions[0].fromStageId).toBeNull();
    expect(adaApp.stageChangedAt.toISOString()).toBe('2026-09-18T20:30:00.000Z');
    expect(adaApp.createdAt.toISOString()).toBe('2026-08-28T09:14:03.551Z');
    // Her candidate-level fields ride along; the date-only field keeps its day, not the instant Ashby sent.
    expect((adaApp.customFields as { imported: { fields: Record<string, string> } }).imported.fields).toEqual({
      'Expected start date': '2026-11-02',
      'Notice period (weeks)': '4',
      'Visa status': 'Requires sponsorship',
    });

    const hired = opp(APP.graceHired);
    expect(hired).toMatchObject({ status: 'HIRED', origin: 'REFERRED', source: 'Employee Referral', ownerId: org.mayaId, archiveReasonId: null });
    expect(hired.stage.name).toBe('Hired'); // the org's own Hired stage
    expect(hired.archivedAt).toBeNull();
    expect(hired.stageChangedAt.toISOString()).toBe('2026-08-14T17:05:12.440Z'); // entered the Hired stage
    expect(hired.stageTransitions.map((t) => t.toStage.name)).toEqual(['Application Review', 'Recruiter Screen', 'Technical Interview', 'On-site', 'Offer', 'Hired']); // Onsite → the org's On-site
    expect(hired.stageTransitions[4].actorId).toBe(org.adminId); // Jane moved her to Offer

    const archived = opp(APP.graceArchived);
    expect(archived).toMatchObject({ status: 'ARCHIVED', origin: 'APPLIED', ownerId: null });
    expect(archived.archiveReason).toMatchObject({ name: 'Compensation mismatch', countsAsRejection: false });
    expect(archived.archivedAt!.toISOString()).toBe('2026-03-20T13:08:40.772Z');
    // Ashby parks archived applications in an "Archived" stage; Orqestra keeps the last real one.
    expect(archived.stage.name).toBe('Recruiter Screen');
    expect(archived.stageTransitions.map((t) => t.toStage.name)).toEqual(['Application Review', 'Recruiter Screen']);
    expect(archived.posting!.state).toBe('CLOSED');
    expect(archived.contactId).toBe(hired.contactId);

    const lead = opp(APP.alan);
    expect(lead).toMatchObject({ status: 'ACTIVE', origin: 'SOURCED', source: 'LinkedIn (Sourced)', ownerId: org.mayaId });
    expect(lead.stage.name).toBe('Lead');

    // Interviews
    const ivs = await db.interview.findMany({ where: { orgId: org.orgId }, include: { panelists: true } });
    const graceIv = ivs.find((i) => i.opportunityId === hired.id)!;
    expect(graceIv).toMatchObject({ title: 'Backend Technical Interview', state: 'COMPLETED', durationMins: 90, location: 'SF HQ – Room Babbage' });
    expect(graceIv.startAt.toISOString()).toBe('2026-07-22T18:00:00.000Z');
    expect(graceIv.panelists).toEqual([]); // Priya has no Source account
    const adaIv = ivs.find((i) => i.opportunityId === adaApp.id)!;
    expect(adaIv).toMatchObject({
      title: 'Backend Technical Interview',
      durationMins: 60,
      location: 'https://acmerobotics.zoom.us/j/81234567890',
      state: Date.parse('2026-09-25T18:00:00.000Z') > Date.now() ? 'SCHEDULED' : 'COMPLETED',
    });

    // Scorecards: default scale is kept as is, a custom scale maps by label, no decision → note.
    const fbs = await db.feedbackSubmission.findMany({ where: { orgId: org.orgId } });
    const strongYes = fbs.find((f) => f.opportunityId === hired.id)!;
    expect(strongYes.overallRating).toBe(4);
    expect(strongYes.interviewId).toBe(graceIv.id);
    expect(strongYes.authorId).toBe(org.adminId);
    expect(strongYes.summary).toMatch(
      /^\[ashby · Priya Raman\] Backend Technical Interview\nDesigned a sharded ingest pipeline end to end, clear trade-off reasoning\.$/i,
    );
    expect(strongYes.answers).toEqual({ 'imported-0': { label: 'System design', kind: 'TEXT', value: '4/4 — Best design round this quarter.' } });
    expect(strongYes.createdAt.toISOString()).toBe('2026-07-23T01:12:09.338Z');
    const noHire = fbs.find((f) => f.opportunityId === archived.id)!;
    expect(noHire.overallRating).toBe(2);
    expect(noHire.authorId).toBe(org.mayaId);
    expect(noHire.answers).toEqual({
      'imported-0': { label: 'Recommendation', kind: 'TEXT', value: 'No Hire' },
      'imported-1': { label: 'Would you work with them?', kind: 'TEXT', value: 'Yes' },
    });

    // Notes: candidate-level notes land on the latest application; bylines only for unmatched authors.
    const dbNotes = await db.note.findMany({ where: { orgId: org.orgId }, orderBy: { createdAt: 'asc' } });
    const byBody = (re: RegExp) => dbNotes.filter((n) => re.test(n.body));
    const [tomNote] = byBody(/AE band tops out/);
    expect(tomNote.body).toMatch(/^\[ashby · Tom Nguyen\] AE band tops out below her current package\.$/i);
    expect(tomNote.authorId).toBe(org.adminId);
    expect(tomNote.opportunityId).toBe(hired.id);
    expect(tomNote.createdAt.toISOString()).toBe('2026-03-18T10:00:00.000Z');
    const [privateNote] = byBody(/Comp expectations/);
    expect(privateNote).toMatchObject({ body: '[Private] Comp expectations above band; discuss with Jane before onsite.', authorId: org.adminId, opportunityId: adaApp.id });
    const [mayaNote] = byBody(/Great phone screen/);
    expect(mayaNote).toMatchObject({ body: 'Great phone screen. Very interested in the telemetry work.\nAvailable to start in 4 weeks.', authorId: org.mayaId });
    const [noDecision] = byBody(/Strong communicator/);
    expect(noDecision).toMatchObject({
      body: 'Recruiter Phone Screen\nStrong communicator; wants platform work. Needs the technical loop before a decision.\nInterested teams: Platform, Data',
      authorId: org.mayaId,
      opportunityId: adaApp.id,
    });
    expect(byBody(/Attachment: Cover_Letter\.docx/)).toHaveLength(1);
    // The offer letter is filed on the application the offer belongs to.
    expect(byBody(/Attachment: Offer Letter - Grace Hopper\.pdf/).map((n) => n.opportunityId)).toEqual([hired.id]);
    expect(dbNotes).toHaveLength(6);

    // Offer: "Relocation option" is a note, not equity; a midnight date-time reads as a date.
    const offer = await db.offer.findFirstOrThrow({ where: { orgId: org.orgId } });
    expect(offer).toMatchObject({
      opportunityId: hired.id,
      status: 'ACCEPTED',
      jobTitle: 'Senior Backend Engineer',
      salaryAmount: 195000,
      salaryCurrency: 'USD',
      equity: 'Equity (options): 12000',
      notes: 'Relocation option: Full package\nSigning bonus: 15000 USD\nOffer expires: 2026-08-01',
      sentAt: null,
    });
    expect(offer.startDate!.toISOString()).toBe('2026-09-08T00:00:00.000Z');
    expect(offer.respondedAt!.toISOString()).toBe('2026-08-14T16:58:31.007Z');
    expect(offer.createdAt.toISOString()).toBe('2026-07-28T20:15:44.102Z');
    // The offer names only its application; one application.info finds the candidate the letter belongs to.
    expect(bodiesOf(api, 'application.info')).toEqual([{ applicationId: APP.graceHired }]);

    // Resumes come from S3 through a fresh file.info link; an expired link is re-signed once.
    const stored = await db.storedFile.findMany({ where: { orgId: org.orgId } });
    expect(stored.map((f) => [f.filename, f.mime]).sort()).toEqual([
      ['Ada_Lovelace_Resume.pdf', 'application/pdf'],
      ['Cover_Letter.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      ['Offer Letter - Grace Hopper.pdf', 'application/pdf'],
      ['grace-hopper-cv.pdf', 'application/pdf'],
    ]);
    const withResume = await db.contact.findMany({ where: { orgId: org.orgId, resumeFileId: { not: null } }, include: { resumeFile: true } });
    expect(withResume.map((c) => [c.name, c.resumeFile!.filename]).sort()).toEqual([
      ['Ada Lovelace', 'Ada_Lovelace_Resume.pdf'],
      ['Grace Hopper', 'grace-hopper-cv.pdf'],
    ]);
    expect(bodiesOf(api, 'file.info').filter((b) => b.fileHandle === files.graceResume.handle)).toHaveLength(2);

    // The key never leaves api.ashbyhq.com.
    const elsewhere = api.calls.filter((c) => c.url.host !== API);
    expect(elsewhere.map((c) => c.url.host)).toEqual([S3, S3, S3, S3, S3]);
    for (const c of elsewhere) {
      expect(c.method).toBe('GET');
      expect(c.headers.authorization).toBeUndefined();
      expect(c.url.toString()).not.toContain(KEY);
    }
    const job = await db.importJob.findUniqueOrThrow({ where: { id: res.jobId } });
    expect(JSON.stringify([job.cursor, job.issues, job.stats, job.catalog])).not.toContain(KEY);
  });

  it('re-running into the same org creates nothing and skips the per-record fan-out', async () => {
    const counts = async () => ({
      contacts: await db.contact.count({ where: { orgId: org.orgId } }),
      opportunities: await db.opportunity.count({ where: { orgId: org.orgId } }),
      transitions: await db.stageTransition.count({ where: { opportunity: { orgId: org.orgId } } }),
      notes: await db.note.count({ where: { orgId: org.orgId } }),
      feedback: await db.feedbackSubmission.count({ where: { orgId: org.orgId } }),
      interviews: await db.interview.count({ where: { orgId: org.orgId } }),
      offers: await db.offer.count({ where: { orgId: org.orgId } }),
      files: await db.storedFile.count({ where: { orgId: org.orgId } }),
      postings: await db.posting.count({ where: { orgId: org.orgId } }),
      requisitions: await db.requisition.count({ where: { orgId: org.orgId } }),
      stages: await db.stage.count({ where: { orgId: org.orgId } }),
      reasons: await db.archiveReason.count({ where: { orgId: org.orgId } }),
    });
    const before = await counts();
    const api = ashbyApi();
    const res = await runImportForTest({ module: ashbyProvider, credentials: { apiKey: KEY }, fetchImpl: api.impl, orgId: org.orgId });
    expect(res.status).toBe('SUCCEEDED');
    expect(res.review!.stages.every((s) => 'stageId' in s.target)).toBe(true); // remembers the first run's mapping
    expect(res.view.created).toEqual({});
    expect(await counts()).toEqual(before);
    expect(api.unmatched).toEqual([]);
    const called = new Set(paths(api));
    for (const skipped of [
      'application.listHistory',
      'application.info',
      'candidate.info',
      'customField.list',
      'interviewStage.info',
      'job.info',
      'jobPosting.info',
      'file.info',
      'interview.list',
      'department.list',
    ]) {
      expect(called.has(`${API}/${skipped}`)).toBe(false);
    }
    expect(api.calls.some((c) => c.url.host === S3)).toBe(false);
  });

  it('resumes mid-page from JSON cursors when every step runs out of time', async () => {
    const api = ashbyApi();
    const run = adapterRun(api, { outOfTime: true });
    await run.run();

    expect(run.warnings).toEqual([]);
    // A record replayed after a resume would show up twice.
    const kinds: RefKind[] = ['user', 'stage', 'reason', 'requisition', 'posting', 'contact', 'opportunity', 'interview', 'feedback', 'note', 'offer', 'file'];
    for (const kind of kinds) expect(new Set(run.ids(kind)).size).toBe(run.ids(kind).length);
    expect(Object.fromEntries(kinds.map((kind) => [kind, run.ids(kind).length]))).toEqual({
      user: 4,
      stage: 13,
      reason: 3,
      requisition: 1,
      posting: 2,
      contact: 3,
      opportunity: 4,
      interview: 2,
      feedback: 3,
      note: 3,
      offer: 1,
      file: 4,
    });
    expect(run.steps()).toBeGreaterThan(30); // one record per step, not one page
    expect(api.violations).toEqual([]);
    expect(api.unmatched).toEqual([]);
  });

  it('finds plans only applications still use, types Active stages by position, and drops history into Archived stages discover never saw', async () => {
    const MARIE = '5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d91';
    const marieApp = {
      ...applications[0],
      id: MARIE,
      customFields: [],
      currentInterviewStage: currentStage(LEGACY_PLAN, LEGACY.techLead),
    };
    const marieHistory = [
      move('6c7d8e9f-0a1b-4c2d-9e3f-4a5b6c7d8e01', LEGACY.portfolio, 'Portfolio Review', '2026-05-02T10:00:00.000Z', '2026-05-09T10:00:00.000Z', 0, maya.id),
      // Archived under a retired plan, then brought back: not a stage move.
      move('6c7d8e9f-0a1b-4c2d-9e3f-4a5b6c7d8e02', LEGACY.retiredArchived, 'Not moving forward', '2026-05-09T10:00:00.000Z', '2026-05-20T10:00:00.000Z', 1, maya.id),
      move('6c7d8e9f-0a1b-4c2d-9e3f-4a5b6c7d8e03', LEGACY.techLead, 'Tech Lead Interview', '2026-05-20T10:00:00.000Z', null, 2, maya.id),
    ];
    const api = ashbyApi({
      overrides: {
        'application.list': (b) => paginate([...applications, marieApp], b, 2),
        'application.listHistory': (b) => paginate(b.applicationId === MARIE ? marieHistory : (history[String(b.applicationId)] ?? []), b),
      },
    });
    const run = adapterRun(api);
    await run.run('stages', 'applications');

    expect(bodiesOf(api, 'interviewStage.list').map((b) => b.interviewPlanId)).toEqual([ENG_PLAN, SALES_PLAN, LEGACY_PLAN]);
    const hint = (name: string) => [...new Set(run.catalog.stages.filter((s) => s.name === name).map((s) => s.typeHint))];
    expect(hint('Portfolio Review')).toEqual(['SCREEN']); // the legacy plan's first Active stage
    expect(hint('Tech Lead Interview')).toEqual(['ONSITE']);
    expect(hint('Hiring Manager Review')).toEqual(['ONSITE']);
    expect(hint('Technical Interview')).toEqual(['ONSITE']);
    expect(hint('Recruiter Screen')).toEqual(['SCREEN']);
    expect(hint('Hiring Manager Screen')).toEqual(['SCREEN']); // a screen by name, though second in its plan
    expect(run.catalog.stages.some((s) => s.externalId === LEGACY.archived)).toBe(false);

    const marie = run.loaded.opportunity.find((a) => a.externalId === MARIE)!;
    expect(marie.history!.map((h) => h.stage.name)).toEqual(['Portfolio Review', 'Tech Lead Interview']);
    expect(marie.stage).toEqual({ externalId: LEGACY.techLead, name: 'Tech Lead Interview' });
    // Only the stage discover couldn't reach is looked up.
    expect(bodiesOf(api, 'interviewStage.info')).toEqual([{ interviewStageId: LEGACY.retiredArchived }]);
    expect(api.violations).toEqual([]);
  });

  it('takes a rating only from a field shaped like one, and reads "no opinion" as no decision', async () => {
    const sub = (id: string, fields: ReturnType<typeof field>[], values: Record<string, unknown>) => ({
      id,
      applicationId: APP.ada,
      feedbackFormDefinitionId: null,
      interviewId: null,
      interviewEventId: null,
      applicationHistoryId: null,
      submittedAt: '2026-09-10T10:00:00.000Z',
      submittedByUser: maya,
      creditedToUser: maya,
      formDefinition: { sections: [{ title: 'Scorecard', fields }] },
      submittedValues: values,
    });
    const ID = {
      freeTextOverall: '7d8e9f0a-1b2c-4d3e-8f4a-5b6c7d8e9f01',
      notesOverall: '7d8e9f0a-1b2c-4d3e-8f4a-5b6c7d8e9f02',
      yesNoQuestion: '7d8e9f0a-1b2c-4d3e-8f4a-5b6c7d8e9f03',
      noStrongOpinion: '7d8e9f0a-1b2c-4d3e-8f4a-5b6c7d8e9f04',
      noDecision: '7d8e9f0a-1b2c-4d3e-8f4a-5b6c7d8e9f05',
    };
    const submissions = [
      // A free-text "Overall impressions" is not the decision; the Recommendation select is.
      sub(
        ID.freeTextOverall,
        [
          field('8e9f0a1b-2c3d-4e4f-9a5b-6c7d8e9f0a01', 'LongText', 'impressions', 'Overall impressions'),
          field('8e9f0a1b-2c3d-4e4f-9a5b-6c7d8e9f0a02', 'ValueSelect', 'decision', 'Recommendation', ratingOptions),
        ],
        { impressions: 'Solid systems thinking, but not senior enough for staff yet.', decision: 'hire' },
      ),
      sub(
        ID.notesOverall,
        [
          field('8e9f0a1b-2c3d-4e4f-9a5b-6c7d8e9f0a03', 'LongText', 'notes', 'Overall notes'),
          field('8e9f0a1b-2c3d-4e4f-9a5b-6c7d8e9f0a04', 'ValueSelect', 'decision', 'Recommendation', ratingOptions),
        ],
        { notes: 'Great communicator, sharp on trade-offs.', decision: 'strong_hire' },
      ),
      // A logistics yes/no is not a hire scale: the Score answers decide.
      sub(
        ID.yesNoQuestion,
        [
          field('8e9f0a1b-2c3d-4e4f-9a5b-6c7d8e9f0a05', 'Score', 'api_design', 'API design'),
          field('8e9f0a1b-2c3d-4e4f-9a5b-6c7d8e9f0a06', 'Score', 'debugging', 'Debugging'),
          field('8e9f0a1b-2c3d-4e4f-9a5b-6c7d8e9f0a07', 'ValueSelect', 'relocate', 'Willing to relocate?', [
            { label: 'Yes', value: 'yes' },
            { label: 'No', value: 'no' },
          ]),
        ],
        { api_design: { score: 4 }, debugging: { score: 4 }, relocate: 'no' },
      ),
      sub(
        ID.noStrongOpinion,
        [field('8e9f0a1b-2c3d-4e4f-9a5b-6c7d8e9f0a08', 'ValueSelect', 'decision', 'Recommendation', [...ratingOptions, { label: 'No Strong Opinion', value: 'no_strong_opinion' }])],
        { decision: 'no_strong_opinion' },
      ),
      sub(
        ID.noDecision,
        [field('8e9f0a1b-2c3d-4e4f-9a5b-6c7d8e9f0a09', 'ValueSelect', 'decision', 'Recommendation', [...ratingOptions, { label: 'No Decision', value: 'no_decision' }])],
        { decision: 'no_decision' },
      ),
    ];
    const api = ashbyApi({ overrides: { 'applicationFeedback.list': (b) => paginate(submissions, b) } });
    const run = adapterRun(api);
    await run.run('feedback');

    const byId = Object.fromEntries(run.loaded.feedback.map((f) => [f.externalId, f]));
    expect(Object.fromEntries(Object.entries(ID).map(([k, id]) => [k, byId[id].rating]))).toEqual({
      freeTextOverall: 3,
      notesOverall: 4,
      yesNoQuestion: 4,
      noStrongOpinion: null,
      noDecision: null,
    });
    expect(byId[ID.freeTextOverall].summary).toBe('Solid systems thinking, but not senior enough for staff yet.');
    expect(api.violations).toEqual([]);
  });

  it('keeps an application whose history is gone, skips one Ashby refuses, and stops on a revoked key', async () => {
    const api = ashbyApi({
      overrides: {
        'application.listHistory': (b) =>
          b.applicationId === APP.graceHired
            ? notFound('application_not_found', 'Application not found')
            : b.applicationId === APP.alan
              ? json({ success: false, errors: [{ message: 'Invalid applicationId', parameter: 'applicationId' }] })
              : paginate(history[String(b.applicationId)] ?? [], b),
      },
    });
    const run = adapterRun(api);
    await run.run('stages', 'applications');
    const byId = Object.fromEntries(run.loaded.opportunity.map((a) => [a.externalId, a]));
    // Deleted between the list and the fan-out: kept without history, hired as of the application's last update.
    expect(byId[APP.graceHired]).toMatchObject({ status: 'hired', history: [], archivedAt: new Date('2026-08-14T17:05:12.440Z') });
    // Refused: not committed half-done, so a re-run tries it again.
    expect(byId[APP.alan]).toBeUndefined();
    expect(Object.keys(byId).sort()).toEqual([APP.ada, APP.graceArchived, APP.graceHired].sort());
    expect(run.warnings).toEqual([
      expect.stringMatching(/^Stage history: .*application_not_found/),
      expect.stringMatching(/^Skipped a record that could not be imported: .*Invalid applicationId/),
    ]);

    // A key revoked mid-import fails loudly instead of importing applications without their history.
    const revoked = adapterRun(ashbyApi({ deny: ['application.listHistory'] }));
    await expect(revoked.run('applications')).rejects.toBeInstanceOf(ImportAuthError);
    expect(revoked.loaded.opportunity).toEqual([]);

    // Throttling answered as success:false is retried, not skipped.
    const throttled = adapterRun(ashbyApi({ overrides: { 'candidate.list': () => notFound('rate_limit_exceeded', 'Too many requests') } }));
    const err = await throttled.run('candidates').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImportHttpError);
    expect((err as ImportHttpError).status).toBe(503);
  });

  it('fails the step on a job board outage instead of saving the posting without its description', async () => {
    const api = ashbyApi({
      overrides: {
        'jobPosting.info': (b) =>
          b.jobBoardId === INTERNAL_BOARD ? json({ success: true, results: posting }) : notFound('job_posting_not_found', 'Job posting not found'),
        'jobBoard.list': () => new Response('upstream connect error', { status: 503 }),
      },
    });
    const run = adapterRun(api);
    const err = await run.run('postings').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImportHttpError);
    expect((err as ImportHttpError).status).toBe(503);
    expect(run.loaded.posting).toEqual([]);
  });

  it('skips notes for candidates with no applications, and says so', async () => {
    const PROSPECT = '9f0a1b2c-3d4e-4f5a-8b6c-7d8e9f0a1b2c';
    const prospect = { ...candidates[2], id: PROSPECT, name: 'Katherine Johnson', applicationIds: [], primaryEmailAddress: { value: 'kj@example.com', type: 'Personal', isPrimary: true }, emailAddresses: [] };
    const api = ashbyApi({ overrides: { 'candidate.list': (b) => paginate([...candidates, prospect], b) } });
    const run = adapterRun(api);
    await run.run('candidates', 'notes');
    expect(run.loaded.contact.map((c) => c.externalId)).toContain(PROSPECT);
    expect(bodiesOf(api, 'candidate.listNotes').map((b) => b.candidateId)).not.toContain(PROSPECT);
    expect(run.loaded.note).toHaveLength(3);
    expect(run.warnings).toEqual(["Notes weren't imported for candidates with no applications"]);
  });

  it('filters server-side for `since` and active-only, and degrades to warnings without Offers or Hiring Process read', async () => {
    const since = '2026-06-01T00:00:00.000Z';
    const api = ashbyApi({
      deny: ['offer.list', 'archiveReason.list', 'customField.list'],
      overrides: {
        // This role was only ever posted internally: Ashby's default (external) board doesn't have it.
        'jobPosting.info': (b) =>
          b.jobBoardId === INTERNAL_BOARD
            ? json({ success: true, results: posting })
            : json({ success: false, errorInfo: { code: 'job_posting_not_found', message: 'Job posting not found' } }),
        // Some keys are refused the org-wide scorecard list; the adapter reads them per application instead.
        'applicationFeedback.list': (b) =>
          b.applicationId
            ? paginate(feedback.filter((f) => f.applicationId === b.applicationId), b)
            : json({ success: false, errors: [{ message: 'applicationId is required', parameter: 'applicationId' }] }),
      },
    });
    const res = await runImportForTest({
      module: ashbyProvider,
      credentials: { apiKey: KEY },
      fetchImpl: api.impl,
      options: { archived: false, since },
    });
    expect(res.error).toBeNull();
    expect(res.status).toBe('SUCCEEDED');
    expect(api.unmatched).toEqual([]);
    expect(api.violations).toEqual([]);

    const sinceMs = Date.parse(since);
    // Active and Lead are separate passes (Ashby's status filter takes one value), both cut at `since`.
    const appLists = bodiesOf(api, 'application.list').filter((b) => 'status' in b);
    expect(appLists.map((b) => [b.status, b.createdAfter])).toEqual([
      ['Active', sinceMs],
      ['Lead', sinceMs],
    ]);
    expect(bodiesOf(api, 'candidate.list').filter((b) => b.limit === 100 && b.createdAfter === sinceMs)).toHaveLength(1);
    expect(bodiesOf(api, 'interviewSchedule.list')[0].createdAfter).toBe(sinceMs);
    // Alan predates `since` but applied after it: his full record is fetched, not the shallow inline copy.
    // (Without custom field definitions there's no call for candidate fields.)
    expect(bodiesOf(api, 'candidate.info')).toEqual([{ id: ALAN }]);
    // Notes are only fetched for candidates that were imported.
    expect([...new Set(bodiesOf(api, 'candidate.listNotes').map((b) => b.candidateId))].sort()).toEqual([ALAN, ADA].sort());

    const contacts = await db.contact.findMany({ where: { orgId: res.orgId } });
    expect(contacts.map((c) => c.name).sort()).toEqual(['Ada Lovelace', 'Alan Turing']);
    expect(contacts.find((c) => c.name === 'Alan Turing')).toMatchObject({
      links: ['https://www.linkedin.com/in/alanturing'],
      tags: ['Cryptography'],
      headline: 'Research Scientist at Bletchley Labs',
    });
    expect(await db.opportunity.count({ where: { orgId: res.orgId } })).toBe(2);
    expect(bodiesOf(api, 'jobPosting.info').map((b) => b.jobBoardId ?? null)).toEqual([null, INTERNAL_BOARD]);
    const internalOnly = await db.posting.findFirstOrThrow({ where: { orgId: res.orgId, title: 'Senior Backend Engineer' } });
    expect((internalOnly.content as { description: string }).description).toContain('• Design APIs');
    expect(res.view.created).toMatchObject({ contact: 2, opportunity: 2, feedback: 1 });
    expect(res.view.created.offer).toBeUndefined();

    const messages = res.view.issues.map((i) => i.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/Archive reasons were not listed.*archiveReason\.list/),
        expect.stringMatching(/Offers were skipped.*offer\.list/),
        expect.stringMatching(/Candidate custom fields were not imported.*customField\.list/),
        expect.stringMatching(/org-wide scorecard list/),
      ]),
    );
    expect(messages.join('\n')).not.toContain(KEY);
  });
});
