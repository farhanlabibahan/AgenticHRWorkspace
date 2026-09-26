import { beforeAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { hasDb } from './setup';
import { candidate, createOrg } from './fixtures';
import { encodeCursor } from '@/lib/list-cursor';

// The routes read the session through getSessionContext; tests set it here.
const session = vi.hoisted(() => ({ orgId: '' as string | null }));
vi.mock('@/lib/session', () => ({
  getSessionContext: async () =>
    session.orgId ? { userId: null, orgId: session.orgId, accessRole: 'SUPER_ADMIN' } : null,
  requireSession: async () => ({ userId: null, orgId: session.orgId, accessRole: 'SUPER_ADMIN' }),
  getAuthSession: async () => null,
  isAdmin: () => true,
}));

// No request-scoped data cache in a unit test: run cached loaders straight through.
vi.mock('next/cache', () => ({
  unstable_cache: (fn: () => unknown) => fn,
  revalidateTag: () => {},
  revalidatePath: () => {},
}));

const pipeline = await import('@/app/api/lists/pipeline/route');
const contacts = await import('@/app/api/lists/contacts/route');
const { authConfig } = await import('@/lib/auth.config');

const get = (route: { GET: (r: NextRequest) => Promise<Response> }, qs: string) =>
  route.GET(new NextRequest(`http://localhost/api/lists/x${qs ? `?${qs}` : ''}`));

describe('list routes without a session', () => {
  it('answer 401 JSON, not a redirect', async () => {
    session.orgId = null;
    for (const route of [pipeline, contacts]) {
      const res = await get(route, '');
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthorized' });
    }
  });

  it('middleware answers 401 for /api/lists/* when signed out, and still redirects pages', () => {
    const authorized = authConfig.callbacks.authorized as unknown as (args: {
      auth: unknown;
      request: { nextUrl: URL };
    }) => unknown;
    const res = authorized({ auth: null, request: { nextUrl: new URL('http://localhost/api/lists/pipeline?stage=x') } });
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(401);
    expect(authorized({ auth: null, request: { nextUrl: new URL('http://localhost/pipeline') } })).toBe(false);
    expect(authorized({ auth: { user: { id: 'u' } }, request: { nextUrl: new URL('http://localhost/api/lists/pipeline') } })).toBe(true);
  });
});

describe.skipIf(!hasDb)('list routes', () => {
  let orgId = '';
  let screenId = '';

  beforeAll(async () => {
    const { org, stages } = await createOrg();
    orgId = org.id;
    screenId = stages[1].id;
    for (let i = 0; i < 130; i++) await candidate(orgId, stages, [[0, i % 5]], { name: `Route ${i}` });
    for (let i = 0; i < 3; i++) await candidate(orgId, stages, [[0, 0], [1, 1]], { name: `Screen ${i}` });
    const other = await createOrg();
    await candidate(other.org.id, other.stages, [[0, 0]], { name: 'Route 1 (other org)' });
  });

  it('pages the pipeline with a cursor, private and uncached', async () => {
    session.orgId = orgId;
    const res = await get(pipeline, '');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const first = await res.json();
    expect(first.rows).toHaveLength(100);
    expect(first.hasMore).toBe(true);
    expect(first.counts).toBeUndefined();
    const second = await (await get(pipeline, `after=${encodeURIComponent(first.endCursor)}`)).json();
    expect(second.rows).toHaveLength(33);
    expect(second.hasMore).toBe(false);
    expect(second.endCursor).toBeNull();
    const ids = [...first.rows, ...second.rows].map((r: { id: string }) => r.id);
    expect(new Set(ids).size).toBe(133);
  });

  it('includes counts only when asked', async () => {
    session.orgId = orgId;
    const body = await (await get(pipeline, `stage=${screenId}&counts=1`)).json();
    expect(body.rows).toHaveLength(3);
    expect(body.counts.total).toBe(133);
    expect(body.counts.counts[screenId]).toBe(3);
  });

  it('ignores unknown params, clamps limit, and keeps repeated keys to the first', async () => {
    session.orgId = orgId;
    const body = await (await get(pipeline, 'limit=5000&orgId=someone-else&q=Route%201&q=Screen')).json();
    expect(body.rows.length).toBeLessThanOrEqual(100);
    expect(body.rows.every((r: { name: string }) => r.name.startsWith('Route 1'))).toBe(true);
    expect((await (await get(pipeline, 'limit=2')).json()).rows).toHaveLength(2);
    expect((await (await get(pipeline, 'limit=0')).json()).rows).toHaveLength(1);
    expect((await (await get(pipeline, 'limit=abc')).json()).rows).toHaveLength(100);
  });

  it('rejects a bad or mismatched cursor with 400', async () => {
    session.orgId = orgId;
    expect((await get(pipeline, 'after=garbage')).status).toBe(400);
    const nameCursor = encodeCursor({ v: 1, s: 'name', n: 'A', c: 'c', id: 'o' });
    expect((await get(pipeline, `after=${nameCursor}`)).status).toBe(400);
    expect((await get(pipeline, `sort=name&after=${nameCursor}`)).status).toBe(200);
    expect((await get(contacts, 'after=garbage')).status).toBe(400);
  });

  it('pages a small ?limit through to the same rows as full pages', async () => {
    session.orgId = orgId;
    for (const sort of ['', 'name']) {
      const full = await (await get(pipeline, `sort=${sort}`)).json();
      const ids: string[] = [];
      let after = '';
      for (let i = 0; i < 5; i++) {
        const page = await (await get(pipeline, `sort=${sort}&limit=1${after ? `&after=${encodeURIComponent(after)}` : ''}`)).json();
        expect(page.rows).toHaveLength(1);
        expect(page.hasMore).toBe(true);
        ids.push(page.rows[0].id);
        after = page.endCursor;
      }
      expect(ids).toEqual(full.rows.slice(0, 5).map((r: { id: string }) => r.id));
    }
  });

  it('never answers 500 for text Postgres cannot store (NUL, year 0)', async () => {
    session.orgId = orgId;
    for (const qs of ['q=a%00b', 'stage=%00', 'posting=x%00', 'client=%00y', 'sort=name&q=%00']) {
      expect((await get(pipeline, qs)).status, qs).toBe(200);
    }
    for (const qs of ['q=a%00b', 'pool=%00', 'tag=t%00']) {
      expect((await get(contacts, qs)).status, qs).toBe(200);
    }
    const year0 = encodeCursor({ v: 1, s: 'time', t: '0000-01-01T00:00:00.000', id: 'o' });
    expect((await get(pipeline, `after=${year0}`)).status).toBe(400);
    const nul = Buffer.from(JSON.stringify({ v: 1, s: 'created', t: '2026-01-01T00:00:00.000Z', id: 'a\u0000' })).toString('base64url');
    expect((await get(contacts, `after=${nul}`)).status).toBe(400);
  });

  it('trims the contacts search, like the list key and the page do', async () => {
    session.orgId = orgId;
    const trimmed = await (await get(contacts, 'q=Screen')).json();
    expect(trimmed.rows).toHaveLength(3);
    expect(await (await get(contacts, 'q=%20Screen%20%20')).json()).toEqual(trimmed);
    expect((await (await get(contacts, 'q=%20%20')).json()).rows).toHaveLength(100);
  });

  it('pages contacts, scoped to the caller', async () => {
    session.orgId = orgId;
    const first = await (await get(contacts, 'limit=100')).json();
    expect(first.rows).toHaveLength(100);
    const rest = await (await get(contacts, `after=${encodeURIComponent(first.endCursor)}`)).json();
    expect(first.rows.length + rest.rows.length).toBe(133);
    const search = await (await get(contacts, 'q=other%20org')).json();
    expect(search.rows).toEqual([]);
  });
});
