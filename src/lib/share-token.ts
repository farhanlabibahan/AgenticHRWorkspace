import { createHmac, timingSafeEqual } from 'crypto';

/**
 * The first share links: the whole payload signed into the URL (~200
 * characters). New links are short codes (server/share-links.ts); this
 * only verifies the old ones, which keep working until they expire.
 */

export type ShareScope = 'posting' | 'client' | 'candidate';

export type SharePayload = {
  orgId: string;
  scope: ShareScope;
  id: string; // postingId, clientCompanyId, or opportunityId
  exp: number;
};

function secret(): string {
  const s = process.env.AUTH_SECRET;
  if (!s) throw new Error('AUTH_SECRET is required');
  return s;
}

function sign(data: string): string {
  return createHmac('sha256', secret()).update(`share:${data}`).digest('base64url');
}

export function verifyShareToken(token: string): SharePayload | null {
  const [data, signature] = token.split('.');
  if (!data || !signature) return null;
  const expected = sign(data);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString()) as SharePayload;
    if (!payload.orgId || !payload.id || payload.exp < Date.now()) return null;
    if (payload.scope !== 'posting' && payload.scope !== 'client' && payload.scope !== 'candidate')
      return null;
    return payload;
  } catch {
    return null;
  }
}
