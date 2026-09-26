import { NextResponse } from 'next/server';
import { authenticateApiKey, type ApiContext } from '@/server/api-keys';
import type { SessionContext } from '@/lib/session';

/** Domain-service context for API-key callers (events attribute to the key). */
export function apiSessionContext(api: ApiContext): SessionContext {
  return { userId: null, orgId: api.orgId, accessRole: 'API', apiKeyId: api.apiKeyId };
}

/** Shared helpers for /api/v1 route handlers (docs/05-api-design.md). */

export function apiError(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

/**
 * Fixed-window rate limit per API key: RATE_LIMIT_PER_MINUTE requests/min
 * (default 120, env-overridable). In-memory, so serverless instances each
 * enforce it independently — a basic abuse guard, not a billing meter;
 * front with a real limiter at the edge if you need hard guarantees.
 */
const rateWindows = new Map<string, { windowStart: number; count: number }>();
const RATE_LIMIT = Math.max(1, Number.parseInt(process.env.RATE_LIMIT_PER_MINUTE ?? '120', 10) || 120);

function rateLimited(apiKeyId: string): boolean {
  const now = Date.now();
  const window = rateWindows.get(apiKeyId);
  if (!window || now - window.windowStart >= 60_000) {
    rateWindows.set(apiKeyId, { windowStart: now, count: 1 });
    return false;
  }
  window.count++;
  return window.count > RATE_LIMIT;
}

export async function withApiAuth(
  request: Request,
  handler: (ctx: ApiContext) => Promise<NextResponse>,
): Promise<NextResponse> {
  const ctx = await authenticateApiKey(request);
  if (!ctx) return apiError(401, 'unauthorized', 'Provide a valid API key: Authorization: Bearer src_…');
  if (rateLimited(ctx.apiKeyId)) {
    return apiError(429, 'rate_limited', `Limit is ${RATE_LIMIT} requests per minute per key.`);
  }
  try {
    return await handler(ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal error';
    return apiError(400, 'bad_request', message);
  }
}

/** Cursor pagination: ?limit=50&cursor=<id> over createdAt-descending ids. */
export function parsePagination(url: string): { limit: number; cursor: string | null } {
  const u = new URL(url);
  const limit = Math.min(Math.max(Number.parseInt(u.searchParams.get('limit') ?? '50', 10) || 50, 1), 100);
  return { limit, cursor: u.searchParams.get('cursor') };
}

export function paginated<T extends { id: string }>(items: T[], limit: number) {
  const hasMore = items.length > limit;
  const data = hasMore ? items.slice(0, limit) : items;
  return NextResponse.json({
    data,
    has_more: hasMore,
    next_cursor: hasMore ? data[data.length - 1]!.id : null,
  });
}
