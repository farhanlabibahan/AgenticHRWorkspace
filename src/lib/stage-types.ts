import type { StageType } from '@prisma/client';

/**
 * Stage types, and the three groups a pipeline is edited in. The type is what
 * a stage means to Source whatever it's called: careers-page applications
 * land in the first Applicant stage, sourced candidates and referrals in the
 * first Lead stage, scheduling is offered in Screen and Interview stages, a
 * move into Hired marks the hire, and reports compare pipelines by type.
 *
 * Plain module (no server imports) so the stage editor can guess a type as
 * someone types a name.
 */

export type StageGroup = 'lead' | 'applicant' | 'interview';

export const STAGE_GROUPS: { id: StageGroup; title: string; description: string }[] = [
  { id: 'lead', title: 'Leads', description: 'People your team sources and reaches out to.' },
  { id: 'applicant', title: 'Applicants', description: 'People who apply on your careers page or are referred in.' },
  { id: 'interview', title: 'Interview', description: 'Everything from the first screen to the hire. Make it match how you interview.' },
];

export function stageGroup(type: StageType): StageGroup {
  return type === 'LEAD' ? 'lead' : type === 'APPLICANT' ? 'applicant' : 'interview';
}

/** Leads come first, then applicants, then the interview process: the groups never interleave. */
export const GROUP_RANK: Record<StageGroup, number> = { lead: 0, applicant: 1, interview: 2 };

/** What a stage in the Interview group can count as. */
export const INTERVIEW_TYPES: { value: StageType; label: string }[] = [
  { value: 'SCREEN', label: 'Screen' },
  { value: 'ONSITE', label: 'Interview' },
  { value: 'OFFER', label: 'Offer' },
  { value: 'HIRED', label: 'Hired' },
];

export const TYPE_RANK: Record<StageType, number> = {
  LEAD: 0,
  APPLICANT: 1,
  SCREEN: 2,
  ONSITE: 3,
  OFFER: 4,
  HIRED: 5,
};

/**
 * Guess a StageType from a stage name. Checked most-specific first:
 * "Offer Extended" is OFFER even though it contains no "hired", and
 * "Hiring Manager Screen" is SCREEN — "hiring" is not "hired".
 */
export function inferStageType(name: string): StageType {
  const n = name.toLowerCase();
  if (/\bhired?\b|\bplaced\b|\bstarted\b|\bonboard/.test(n)) return 'HIRED';
  if (/\boffer\b|\breference/.test(n)) return 'OFFER';
  if (/on-?site|face[ -]to[ -]face|\bfinal\b|\bpanel\b|\bloop\b|\bsuper ?day\b|in[ -]person/.test(n)) return 'ONSITE';
  if (/\blead\b|\bprospect|\bsourced\b|reached out|\bcontacted\b|\bresponded\b|\boutreach\b|\bnurture/.test(n)) return 'LEAD';
  if (/\bnew\b|\bapplicant|\bapplication|\bapplied\b|\binbox\b|\breview\b|\bunscreened\b|\bnew candidate/.test(n)) return 'APPLICANT';
  return 'SCREEN';
}

/** The type a new Interview-group stage most likely has: "Client interview" → Interview, "Offer" → Offer. */
export function guessInterviewType(name: string): StageType {
  const n = name.toLowerCase();
  const t = inferStageType(name);
  if (t === 'LEAD' || t === 'APPLICANT') return 'SCREEN';
  // Within the interview process, a plain "interview" is past the screen.
  if (t === 'SCREEN' && /\binterview|\bpresent|\bassessment|\bcase\b|\btake[ -]?home/.test(n)) return 'ONSITE';
  return t;
}
