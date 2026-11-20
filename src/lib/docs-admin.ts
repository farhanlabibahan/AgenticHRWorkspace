import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';

const COOKIE = 'orqestra-docs-admin';
const SESSION_MS = 4 * 60 * 60 * 1000;

function configuredSecret(): string | null {
  const password = process.env.DOCS_ADMIN_PASSWORD;
  const authSecret = process.env.AUTH_SECRET;
  return password && authSecret ? `${authSecret}:docs:${password}` : null;
}

function signature(expires: number, secret: string) {
  return createHmac('sha256', secret).update(`docs-admin:${expires}`).digest('base64url');
}

export function issueDocsSession(secret: string, now = Date.now()) {
  const expires = now + SESSION_MS;
  return `${expires}.${signature(expires, secret)}`;
}

export function verifyDocsSession(token: string | undefined, secret: string, now = Date.now()) {
  if (!token) return false;
  const match = /^(\d{13})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match) return false;
  const expires = Number(match[1]);
  if (expires <= now || expires > now + SESSION_MS) return false;
  const expected = Buffer.from(signature(expires, secret));
  const actual = Buffer.from(match[2]);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function docsPasswordConfigured() {
  return configuredSecret() !== null;
}

export function matchesDocsPassword(input: string) {
  const expected = process.env.DOCS_ADMIN_PASSWORD;
  if (!expected || !process.env.AUTH_SECRET) return false;
  const actualHash = createHash('sha256').update(input).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  return timingSafeEqual(actualHash, expectedHash);
}

export async function hasDocsAdminAccess() {
  const secret = configuredSecret();
  if (!secret) return false;
  const token = (await cookies()).get(COOKIE)?.value;
  return verifyDocsSession(token, secret);
}

export async function grantDocsAdminAccess() {
  const secret = configuredSecret();
  if (!secret) throw new Error('Documentation password is not configured');
  (await cookies()).set(COOKIE, issueDocsSession(secret), {
    httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict',
    path: '/settings/docs', maxAge: SESSION_MS / 1000,
  });
}

export async function clearDocsAdminAccess() {
  (await cookies()).set(COOKIE, '', {
    httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict',
    path: '/settings/docs', maxAge: 0,
  });
}
