import { createHmac, timingSafeEqual } from 'crypto';
import { cookies } from 'next/headers';
import bcrypt from 'bcryptjs';
import { db } from '@/lib/db';
import { capName } from '@/lib/utils';

/**
 * Candidate accounts: one email + password that works across every company.
 * A separate cookie from company sign-in, so a candidate never gets a company
 * session and nothing from company users leaks into it.
 *
 * The cookie is an HMAC-signed, expiring account id (same signing as the
 * portal links). Passwords are bcrypt cost 12.
 */

export const CANDIDATE_COOKIE = 'orqestra_candidate';
const TTL_DAYS = 30;

function secret(): string {
  const s = process.env.AUTH_SECRET;
  if (!s) throw new Error('AUTH_SECRET is required');
  return s;
}

function sign(data: string): string {
  return createHmac('sha256', secret()).update(`candidate:${data}`).digest('base64url');
}

export function encodeCandidateToken(accountId: string, now = Date.now()): string {
  const data = Buffer.from(JSON.stringify({ a: accountId, exp: now + TTL_DAYS * 86_400_000 })).toString('base64url');
  return `${data}.${sign(data)}`;
}

export function decodeCandidateToken(token: string, now = Date.now()): string | null {
  const [data, signature] = token.split('.');
  if (!data || !signature) return null;
  const a = Buffer.from(signature);
  const b = Buffer.from(sign(data));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString()) as { a?: string; exp?: number };
    if (!payload.a || !payload.exp || payload.exp < now) return null;
    return payload.a;
  } catch {
    return null;
  }
}

/** The signed-in candidate account, or null. Reads the cookie; never trusts a client id. */
export async function currentCandidate(): Promise<{ id: string; email: string; name: string } | null> {
  const jar = await cookies();
  const token = jar.get(CANDIDATE_COOKIE)?.value;
  if (!token) return null;
  const id = decodeCandidateToken(token);
  if (!id) return null;
  const account = await db.candidateAccount.findUnique({ where: { id }, select: { id: true, email: true, name: true } });
  return account;
}

export async function setCandidateCookie(accountId: string) {
  const jar = await cookies();
  jar.set(CANDIDATE_COOKIE, encodeCandidateToken(accountId), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: TTL_DAYS * 86_400,
  });
}

export async function clearCandidateCookie() {
  const jar = await cookies();
  jar.delete(CANDIDATE_COOKIE);
}

export class CandidateAuthError extends Error {}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Create an account, and attach any contacts already using this email in any company. */
export async function signUpCandidate(input: { name: string; email: string; password: string }) {
  const email = normalizeEmail(input.email);
  const name = capName(input.name.trim());
  if (!name) throw new CandidateAuthError('Enter your name.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new CandidateAuthError('Enter a valid email address.');
  if (input.password.length < 8) throw new CandidateAuthError('Password must be at least 8 characters.');

  const existing = await db.candidateAccount.findUnique({ where: { email } });
  if (existing) throw new CandidateAuthError('An account with this email already exists. Sign in instead.');

  const passwordHash = await bcrypt.hash(input.password, 12);
  return db.$transaction(async (tx) => {
    const account = await tx.candidateAccount.create({ data: { email, name, passwordHash } });
    // Applications made before signing up with this email.
    await tx.contact.updateMany({
      where: { emails: { has: email }, candidateAccountId: null, isAnonymized: false },
      data: { candidateAccountId: account.id },
    });
    return account;
  });
}

export async function signInCandidate(input: { email: string; password: string }) {
  const email = normalizeEmail(input.email);
  const account = await db.candidateAccount.findUnique({ where: { email } });
  // Same message for an unknown email and a wrong password: no account enumeration.
  const ok = account ? await bcrypt.compare(input.password, account.passwordHash) : false;
  if (!account || !ok) {
    if (!account) await bcrypt.compare(input.password, '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalid');
    throw new CandidateAuthError('Email or password is not right.');
  }
  return account;
}

/**
 * Link a contact to an account by email (called when a candidate applies
 * while signed in, or when an account is created later).
 */
export async function linkContactToAccountByEmail(tx: Pick<typeof db, 'candidateAccount' | 'contact'>, contactId: string, email: string) {
  const account = await tx.candidateAccount.findUnique({ where: { email: normalizeEmail(email) }, select: { id: true } });
  if (account) await tx.contact.update({ where: { id: contactId }, data: { candidateAccountId: account.id } });
}
