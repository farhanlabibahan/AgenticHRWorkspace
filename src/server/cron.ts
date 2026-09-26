import { randomUUID } from 'node:crypto';
import { db } from '@/lib/db';

/**
 * Shared plumbing for the /api/cron/* routes: the CRON_SECRET check, the
 * self-chaining that lets a cron with work left start its next run right
 * away instead of waiting for the schedule, and the one-run-at-a-time lease.
 */

/** CRON_SECRET bearer auth. When the secret is unset (local dev), the endpoint is open. */
export function cronAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  return !secret || request.headers.get('authorization') === `Bearer ${secret}`;
}

/** Where this deployment can reach itself: the production domain, not the protected per-deploy URL. */
export function selfOrigin(): string | null {
  if (process.env.AUTH_URL) return process.env.AUTH_URL.replace(/\/$/, '');
  if (process.env.VERCEL_ENV === 'production' && process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  if (process.env.VERCEL) return null; // previews share prod's database; let prod's cron do the work
  return `http://127.0.0.1:${process.env.PORT ?? 3000}`;
}

/** Start the next run of a cron route (e.g. '/api/cron/imports'). */
export async function chainCron(path: string) {
  const secret = process.env.CRON_SECRET;
  const origin = selfOrigin();
  // Without a secret the endpoint is open, and an open self-invoking loop is
  // not something to leave running; the schedule still covers it.
  if (!secret || !origin) return;
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  // Fire and forget: the next run doesn't need this one to wait for it.
  await fetch(`${origin}${path}`, {
    headers: {
      authorization: `Bearer ${secret}`,
      ...(bypass ? { 'x-vercel-protection-bypass': bypass } : {}),
    },
    signal: AbortSignal.timeout(5_000),
  }).catch(() => undefined);
}

/**
 * Takes the named lease until `until`, or returns null while another run holds
 * it. A run that dies leaves it to expire. Returns the release.
 */
export async function takeCronLease(name: string, until: Date): Promise<(() => Promise<void>) | null> {
  const token = randomUUID();
  await db.cronLease.createMany({ data: [{ name, leaseUntil: new Date(0), token }], skipDuplicates: true });
  const taken = await db.cronLease.updateMany({ where: { name, leaseUntil: { lte: new Date() } }, data: { leaseUntil: until, token } });
  if (!taken.count) return null;
  return async () => {
    await db.cronLease.updateMany({ where: { name, token }, data: { leaseUntil: new Date(0) } }).catch(() => undefined);
  };
}
