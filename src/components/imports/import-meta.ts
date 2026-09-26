import type { ImportStatus, StageType } from '@prisma/client';
import type { Tone } from '@/components/ui/primitives';

/**
 * Shared vocabulary for the ATS import screens (settings list, new-import
 * flow, job page): status labels and tones, the record kinds we count, and
 * a relative-time formatter. Plain module — safe on server and client.
 */

export const IMPORT_STATUS: Record<ImportStatus, { label: string; tone: Tone }> = {
  DISCOVERING: { label: 'Reading setup', tone: 'info' },
  REVIEW: { label: 'Needs review', tone: 'caution' },
  RUNNING: { label: 'Importing', tone: 'info' },
  SUCCEEDED: { label: 'Done', tone: 'positive' },
  FAILED: { label: 'Failed', tone: 'critical' },
  CANCELED: { label: 'Canceled', tone: 'neutral' },
};

/** Statuses the pump advances. REVIEW waits on the admin instead. */
export function isRunning(status: ImportStatus): boolean {
  return status === 'DISCOVERING' || status === 'RUNNING';
}

/** Statuses that block starting another import. */
export function isOpen(status: ImportStatus): boolean {
  return isRunning(status) || status === 'REVIEW';
}

/** Record kinds shown in the counts grid, in reading order. `always` shows even at zero. */
export const COUNT_KINDS: { kind: string; label: string; always?: boolean }[] = [
  { kind: 'contact', label: 'Candidates', always: true },
  { kind: 'opportunity', label: 'Applications', always: true },
  { kind: 'posting', label: 'Postings' },
  { kind: 'requisition', label: 'Requisitions' },
  { kind: 'note', label: 'Notes' },
  { kind: 'feedback', label: 'Scorecards' },
  { kind: 'interview', label: 'Interviews' },
  { kind: 'offer', label: 'Offers' },
  { kind: 'file', label: 'Files' },
];

/** Same names the stage manager uses (ONSITE reads as "Interview" in the app). */
export const STAGE_TYPE_LABELS: Record<StageType, string> = {
  LEAD: 'Lead',
  APPLICANT: 'Applicant',
  SCREEN: 'Screen',
  ONSITE: 'Interview',
  OFFER: 'Offer',
  HIRED: 'Hired',
};

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
];

/** "5 minutes ago", "yesterday", "just now". */
export function timeAgo(iso: string, now = Date.now()): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  }
  return 'just now';
}

export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}
