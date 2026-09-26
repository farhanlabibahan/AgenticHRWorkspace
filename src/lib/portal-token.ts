import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Signed, expiring tokens for the candidate portal — no session, no schema.
 * Payload: contactId + orgId + expiry, HMAC'd with AUTH_SECRET.
 */

type PortalPayload = { contactId: string; orgId: string; exp: number };

function secret(): string {
  const s = process.env.AUTH_SECRET;
  if (!s) throw new Error('AUTH_SECRET is required');
  return s;
}

function sign(data: string): string {
  return createHmac('sha256', secret()).update(data).digest('base64url');
}

export function createPortalToken(contactId: string, orgId: string, ttlDays = 14): string {
  const payload: PortalPayload = {
    contactId,
    orgId,
    exp: Date.now() + ttlDays * 86_400_000,
  };
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${data}.${sign(data)}`;
}

export function verifyPortalToken(token: string): PortalPayload | null {
  const [data, signature] = token.split('.');
  if (!data || !signature) return null;
  const expected = sign(data);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString()) as PortalPayload;
    if (!payload.contactId || !payload.orgId || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}
