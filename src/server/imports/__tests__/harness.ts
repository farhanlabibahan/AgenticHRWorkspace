import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { sealCredentials } from '@/server/imports/crypto';
import { confirmImportMapping, getImportJob, type ImportJobView } from '@/server/imports/jobs';
import { registerProviderForTests } from '@/server/imports/providers';
import { runSlice } from '@/server/imports/runner';
import type { Credentials, ImportOptions, ProviderModule } from '@/server/imports/types';
import { DEFAULT_IMPORT_OPTIONS } from '@/server/imports/types';

/**
 * Adapter test harness: runs a real provider module end-to-end through the
 * real engine (runner, loader, mapping) against the test database, with the
 * vendor's HTTP API replaced by a route table. Each call gets a fresh org.
 *
 * Adapter tests must mock `@/lib/session` (next-auth can't load in vitest)
 * and skip without a test database, like the repo's other DB suites:
 *   vi.mock('@/lib/session', () => ({ isAdmin: () => true }));
 *   describe.skipIf(!hasDb)('…', () => { … });
 */

export { hasDb } from '../../../../tests/setup';

export type RouteHandler = (req: { url: URL; method: string; headers: Record<string, string>; body: unknown }) =>
  | Response
  | Promise<Response>;

export type RecordedCall = { method: string; url: URL; headers: Record<string, string>; body: unknown };

export const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...((init.headers as Record<string, string>) ?? {}) },
  });

/**
 * Build a fetch impl from routes keyed "METHOD host/path" (no query), e.g.
 * "GET api.lever.co/v1/opportunities". Unmatched requests return 404 and are
 * recorded in `unmatched` so tests can assert nothing unexpected was called.
 */
export function mockFetch(routes: Record<string, RouteHandler>) {
  const calls: RecordedCall[] = [];
  const unmatched: string[] = [];
  const impl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(
      Object.entries((init.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    let body: unknown = init.body ?? null;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        /* keep raw */
      }
    }
    calls.push({ method, url, headers, body });
    const key = `${method} ${url.host}${url.pathname}`;
    const handler = routes[key];
    if (!handler) {
      unmatched.push(key);
      return new Response(JSON.stringify({ error: 'no mock for ' + key }), { status: 404 });
    }
    return handler({ url, method, headers, body });
  }) as typeof fetch;
  return { impl, calls, unmatched };
}

export type HarnessResult = {
  orgId: string;
  adminId: string;
  jobId: string;
  status: string;
  error: string | null;
  view: ImportJobView;
  review: ImportJobView['review'];
};

/** Mock vendors use made-up hosts; resolve them all to a public address so the SSRF guard lets them through. */
export const publicDns = async () => ['93.184.216.34'];

async function freshOrg(kind: 'COMPANY' | 'AGENCY') {
  const org = await db.organization.create({
    data: { slug: `adapter-test-${randomUUID().slice(0, 8)}`, name: 'Adapter Test', kind, onboardedAt: new Date() },
  });
  const admin = await db.user.create({
    data: { orgId: org.id, email: 'admin@example.test', name: 'Test Admin', accessRole: 'ADMIN' },
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
  return { orgId: org.id, adminId: admin.id };
}

/**
 * Drive a job the way production does, minus the waiting: after a vendor
 * back-off ('waiting') or a transient failure ('failed') the runner holds the
 * job with a future lease; tests release it straight away so retries play out
 * immediately. A job that keeps failing ends FAILED, with its error on the row.
 */
async function drive(jobId: string, fetchImpl: typeof fetch) {
  for (let i = 0; i < 1000; i++) {
    const job = await db.importJob.findUniqueOrThrow({ where: { id: jobId } });
    if (job.status !== 'DISCOVERING' && job.status !== 'RUNNING') return job;
    const r = await runSlice(jobId, 30_000, { fetchImpl, resolveHost: publicDns });
    if (r === 'waiting' || r === 'failed' || r === 'busy') {
      await db.importJob.updateMany({ where: { id: jobId, leaseToken: null }, data: { leaseUntil: null } });
    }
  }
  throw new Error('Import did not settle after 1000 slices');
}

/**
 * Verify the adapter's credentials check, then run a full import: discover →
 * accept the default mapping → load. Throws if a slice fails (so tests see
 * the adapter's real error). Pass `orgId` to re-run into the same org.
 */
export async function runImportForTest(opts: {
  module: ProviderModule;
  credentials: Credentials;
  fetchImpl: typeof fetch;
  options?: Partial<ImportOptions>;
  orgKind?: 'COMPANY' | 'AGENCY';
  orgId?: string;
}): Promise<HarnessResult> {
  process.env.AUTH_SECRET ||= 'test-secret';
  registerProviderForTests({ ...opts.module, minIntervalMs: 0 }); // throttling is covered by http.test.ts
  const { orgId, adminId } = opts.orgId
    ? {
        orgId: opts.orgId,
        adminId: (await db.user.findFirstOrThrow({ where: { orgId: opts.orgId }, orderBy: { createdAt: 'asc' } })).id,
      }
    : await freshOrg(opts.orgKind ?? 'COMPANY');
  const ctx = { userId: adminId, orgId, accessRole: 'ADMIN' };

  const job = await db.importJob.create({
    data: {
      orgId,
      provider: opts.module.id,
      credentials: sealCredentials(opts.credentials),
      options: { ...DEFAULT_IMPORT_OPTIONS, ...opts.options } as Prisma.InputJsonValue,
      createdById: adminId,
    },
  });

  let settled = await drive(job.id, opts.fetchImpl);
  let review: ImportJobView['review'] = null;
  if (settled.status === 'REVIEW') {
    const view = await getImportJob(ctx, job.id);
    review = view!.review;
    await confirmImportMapping(ctx, job.id, {
      stages: Object.fromEntries(review!.stages.map((s) => [s.key, s.target])),
      reasons: Object.fromEntries(review!.reasons.map((r) => [r.key, r.target])),
    });
    settled = await drive(job.id, opts.fetchImpl);
  }
  const view = (await getImportJob(ctx, job.id))!;
  return { orgId, adminId, jobId: job.id, status: settled.status, error: settled.error, view, review };
}

/** Run the adapter's verify() against the mock (what "Test connection" does). */
export async function verifyForTest(module: ProviderModule, credentials: Credentials, fetchImpl: typeof fetch) {
  const { createHttpClient } = await import('@/server/imports/http');
  const http = createHttpClient({ auth: module.auth(credentials), minIntervalMs: 0, fetchImpl, resolveHost: publicDns });
  return module.create(credentials, http).verify();
}

export { db };
