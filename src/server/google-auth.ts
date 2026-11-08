import { cookies } from 'next/headers';
import { decode, encode } from 'next-auth/jwt';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { authConfig } from '@/lib/auth.config';
import { safeRedirectPath } from '@/lib/safe-redirect';
import {
  googleIdentityFrom,
  googleIsAuthoritative,
  normalizeEmail,
  pickResolvedUser,
  resolveGoogleAccount,
  type AccountCandidate,
  type GoogleIdentity,
  type GoogleResolution,
  type RefusalReason,
  type WorkspaceOption,
} from '@/server/google-account';
import { requestOrigin } from '@/server/request-origin';
import { activeSessionUser, type SessionUser } from '@/server/session-user';

/**
 * "Continue with Google". next-auth runs the OAuth dance (state and PKCE
 * checks, the id token's signature, issuer and audience); this module decides
 * who the verified Google account is in Orqestra (see google-account.ts).
 *
 * One match signs in straight from Google's callback. Several workspaces, or
 * none, need one more step: the verified identity waits in a short-lived,
 * encrypted, httpOnly cookie while the person picks a workspace
 * (/login/workspace) or names a new one (/signup/finish), and that step signs
 * in through the `google-continue` credentials provider, which trusts only
 * the cookie, never the form.
 *
 * Optional per deployment: without AUTH_GOOGLE_ID and AUTH_GOOGLE_SECRET the
 * provider isn't registered and no page mentions Google.
 */

export function googleAuthEnabled(): boolean {
  return Boolean(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET);
}

export const GOOGLE_CONTINUE_PROVIDER = 'google-continue';

/** The verified identity waiting for its workspace step. */
export type PendingGoogle = {
  sub: string;
  email: string;
  /** The Google Workspace domain, or null (see googleIsAuthoritative). */
  hd: string | null;
  name: string;
  /** Where to land after signing in (a path on this site). */
  returnTo: string;
};

/** The pending identity as Google verified it (it was sealed only once verified). */
export function pendingIdentity(pending: PendingGoogle): GoogleIdentity {
  return { sub: pending.sub, email: pending.email, emailVerified: true, hd: pending.hd };
}

const PENDING_COOKIE = 'source.google-pending';
const PENDING_SALT = 'source.google-pending'; // never the session cookie's salt
const PENDING_MAX_AGE = 10 * 60;

/** Everyone this Google account could be: same address, or already bound to it. */
export async function loadAccountCandidates(identity: Pick<GoogleIdentity, 'sub' | 'email'>): Promise<AccountCandidate[]> {
  // lower() =, not Prisma's `mode: 'insensitive'`: that's an unescaped
  // ILIKE, where "_" in the Google address would match any character.
  return db.$queryRaw<AccountCandidate[]>`
    SELECT u.id AS "userId", u."orgId", o.name AS "orgName", u.email, u."googleSub",
           (u."deactivatedAt" IS NOT NULL) AS deactivated
    FROM "User" u
    JOIN "Organization" o ON o.id = u."orgId"
    WHERE lower(u.email) = ${normalizeEmail(identity.email)} OR u."googleSub" = ${identity.sub}
    ORDER BY u."createdAt"
    LIMIT 200`;
}

export async function resolveGoogle(identity: GoogleIdentity): Promise<{
  resolution: GoogleResolution;
  candidates: AccountCandidate[];
}> {
  const candidates = await loadAccountCandidates(identity);
  return { resolution: resolveGoogleAccount(identity, candidates), candidates };
}

/**
 * Bind the Google account to the user on their first Google sign-in, then
 * return their session. Null when the user is bound to a different Google
 * account (or became so in a race), was deactivated meanwhile, or isn't
 * bound and Google isn't authoritative for the address (resolveGoogleAccount
 * already refuses that; this is the backstop at the write).
 */
export async function completeGoogleSignIn(identity: GoogleIdentity, userId: string): Promise<SessionUser | null> {
  try {
    const bound = googleIsAuthoritative(identity)
      ? await db.user.updateMany({
          where: { id: userId, googleSub: null, deactivatedAt: null },
          data: { googleSub: identity.sub },
        })
      : { count: 0 };
    if (bound.count === 0) {
      const user = await db.user.findUnique({ where: { id: userId }, select: { googleSub: true } });
      if (user?.googleSub !== identity.sub) return null;
    }
  } catch (error) {
    // The same Google account is already bound to another user in that workspace.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return null;
    throw error;
  }
  return activeSessionUser(userId);
}

export function loginErrorPath(reason: RefusalReason | 'expired'): string {
  return `/login?error=google-${reason}`;
}

/**
 * next-auth's signIn callback for Google. Returns true to sign in (after
 * turning next-auth's provider user into the Source user, in place: next-auth
 * hands this same object to the jwt callback, so the session carries exactly
 * what a password sign-in does), or a path on this site to send them to.
 */
export async function googleSignInCallback(user: Record<string, unknown>, profile: unknown): Promise<true | string> {
  const identity = googleIdentityFrom(profile);
  if (!identity) return loginErrorPath('unverified');
  const { resolution } = await resolveGoogle(identity);

  switch (resolution.kind) {
    case 'refused':
      return loginErrorPath(resolution.reason);
    case 'sign-in': {
      const signedIn = await completeGoogleSignIn(identity, resolution.userId);
      if (!signedIn) return loginErrorPath('account-mismatch');
      for (const key of Object.keys(user)) delete user[key];
      Object.assign(user, signedIn);
      return true;
    }
    case 'choose-workspace':
    case 'create-workspace': {
      const p = profile as Record<string, unknown>;
      await writePendingGoogle({
        sub: identity.sub,
        email: identity.email,
        hd: identity.hd,
        name: typeof p.name === 'string' ? p.name.trim().slice(0, 200) : '',
        returnTo: await nextAuthReturnTo(),
      });
      return resolution.kind === 'choose-workspace' ? '/login/workspace' : '/signup/finish';
    }
  }
}

/**
 * The google-continue provider's authorize: sign in as the only match, or as
 * the workspace the person picked, re-checked against the database now.
 */
export async function authorizeGoogleContinue(chosenUserId: unknown): Promise<SessionUser | null> {
  const pending = await readPendingGoogle();
  if (!pending) return null;
  const identity = pendingIdentity(pending);
  const { resolution } = await resolveGoogle(identity);
  const userId = pickResolvedUser(resolution, typeof chosenUserId === 'string' && chosenUserId ? chosenUserId : null);
  if (!userId) return null;
  const user = await completeGoogleSignIn(identity, userId);
  if (user) await clearPendingGoogle();
  return user;
}

/** The workspaces to offer on /login/workspace (one, if the others went away). */
export function workspaceOptions(resolution: GoogleResolution, candidates: AccountCandidate[]): WorkspaceOption[] {
  if (resolution.kind === 'choose-workspace') return resolution.options;
  if (resolution.kind === 'sign-in') {
    const c = candidates.find((x) => x.userId === resolution.userId);
    return c ? [{ userId: c.userId, orgId: c.orgId, orgName: c.orgName }] : [];
  }
  return [];
}

// ---------- The pending cookie ----------

function secret(): string {
  return authConfig.secret;
}

export async function writePendingGoogle(pending: PendingGoogle): Promise<void> {
  const token = await encode({ token: pending, secret: secret(), salt: PENDING_SALT, maxAge: PENDING_MAX_AGE });
  const { https } = await requestOrigin();
  (await cookies()).set(PENDING_COOKIE, token, {
    httpOnly: true,
    secure: https,
    sameSite: 'lax',
    path: '/',
    maxAge: PENDING_MAX_AGE,
  });
}

export async function readPendingGoogle(): Promise<PendingGoogle | null> {
  const token = (await cookies()).get(PENDING_COOKIE)?.value;
  if (!token) return null;
  try {
    const payload = await decode({ token, secret: secret(), salt: PENDING_SALT });
    if (!payload || typeof payload.sub !== 'string' || typeof payload.email !== 'string') return null;
    return {
      sub: payload.sub,
      email: normalizeEmail(payload.email),
      hd: typeof payload.hd === 'string' && payload.hd ? payload.hd : null,
      name: typeof payload.name === 'string' ? payload.name : '',
      returnTo: safeRedirectPath(payload.returnTo),
    };
  } catch {
    return null; // expired, tampered with, or sealed with another secret
  }
}

export async function clearPendingGoogle(): Promise<void> {
  (await cookies()).delete(PENDING_COOKIE);
}

/**
 * Where next-auth was going to send them after Google (the page's
 * callbackUrl, already checked by next-auth's redirect callback), as a path.
 */
async function nextAuthReturnTo(): Promise<string> {
  const jar = await cookies();
  const raw = jar.get('__Secure-authjs.callback-url')?.value ?? jar.get('authjs.callback-url')?.value;
  const { origin } = await requestOrigin();
  return safeRedirectPath(raw, { origin });
}
