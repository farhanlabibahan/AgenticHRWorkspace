import type { ParseStatus } from '@prisma/client';
import { db } from '@/lib/db';
import type { ResumeParseErrorCode } from './client';
import { pauseName, startOfUtcDay } from './run';

/** What Settings shows about an organization's resume parsing. Codes only, never provider text. */
export type ResumeParseSummary = {
  /** Files queued in the last 30 days, by status. */
  last30: Partial<Record<ParseStatus, number>>;
  /** Attempts claimed today (UTC), against the daily limit. */
  usedToday: number;
  /** Still waiting now. */
  waiting: number;
  /** Why the queue is paused, when a provider or setup failure paused it in the last day and nothing has parsed since. */
  pauseCode: ResumeParseErrorCode | null;
  /** The latest per-file failure in the last day. */
  lastFileError: ResumeParseErrorCode | null;
};

const FILE_ERRORS = new Set<string>(['provider_timeout', 'provider_too_large', 'provider_bad_json', 'provider_truncated', 'provider_empty', 'provider_bad_request']);
const PAUSE_ERRORS = new Set<string>([
  'provider_auth',
  'provider_not_found',
  'provider_model_retired',
  'provider_quota',
  'provider_rate_limited',
  'provider_unavailable',
  'provider_timeout',
  'provider_bad_request',
  'provider_redirect',
]);

/** `lease` names the run whose pause to report: the one run of a deployment, unless a test scoped its own. */
export async function resumeParseSummary(orgId: string, { at = new Date(), lease }: { at?: Date; lease?: string } = {}): Promise<ResumeParseSummary> {
  const since30 = new Date(at.getTime() - 30 * 24 * 3_600_000);
  const since24 = new Date(at.getTime() - 24 * 3_600_000);
  const [groups, usedToday, waiting, pause, failed] = await Promise.all([
    db.storedFile.groupBy({
      by: ['parseStatus'],
      where: { orgId, parseStatus: { not: null }, parseQueuedAt: { gte: since30 } },
      _count: { _all: true },
    }),
    db.storedFile.aggregate({ where: { orgId, parseCheckedAt: { gte: startOfUtcDay(at) } }, _sum: { parseAttempts: true } }),
    db.storedFile.count({ where: { orgId, parseStatus: 'QUEUED' } }),
    db.cronLease.findUnique({ where: { name: pauseName(lease) } }),
    db.storedFile.findFirst({
      where: { orgId, parseStatus: 'FAILED', parseCheckedAt: { gte: since24 } },
      orderBy: { parseCheckedAt: 'desc' },
      select: { parseError: true },
    }),
  ]);
  const last30: Partial<Record<ParseStatus, number>> = {};
  for (const g of groups) if (g.parseStatus) last30[g.parseStatus] = g._count._all;
  return {
    last30,
    usedToday: usedToday._sum.parseAttempts ?? 0,
    waiting,
    pauseCode: pause && pause.leaseUntil > since24 && PAUSE_ERRORS.has(pause.token) ? (pause.token as ResumeParseErrorCode) : null,
    lastFileError: failed?.parseError && FILE_ERRORS.has(failed.parseError) ? (failed.parseError as ResumeParseErrorCode) : null,
  };
}
