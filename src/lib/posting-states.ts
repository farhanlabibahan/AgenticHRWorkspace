import type { Tone } from '@/components/ui/primitives';

/** Badge label and tone for each posting state (server and client). */
export const POSTING_STATE_BADGES: Record<string, { label: string; tone: Tone }> = {
  DRAFT: { label: 'Draft', tone: 'neutral' },
  PENDING_APPROVAL: { label: 'Pending approval', tone: 'caution' },
  PUBLISHED: { label: 'Published', tone: 'positive' },
  INTERNAL: { label: 'Internal', tone: 'info' },
  CLOSED: { label: 'Closed', tone: 'neutral' },
};
