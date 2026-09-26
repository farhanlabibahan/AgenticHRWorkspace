/**
 * Which Source user a Google sign-in belongs to. Pure: the caller loads the
 * candidates (every user whose email matches the Google address, or who is
 * already bound to this Google account) and acts on the answer.
 *
 * Linking a Google account to an existing user needs Google to be
 * authoritative for the address: @gmail.com / @googlemail.com, or a Google
 * Workspace account whose `hd` claim is the address's domain. Any other
 * verified address is a consumer Google account made with someone else's
 * mailbox (a work email, say): Google checked the mailbox once, when the
 * account was made, and whoever holds that Google account may no longer
 * hold the mailbox. So:
 *  - an existing user not yet bound links on their first Google sign-in,
 *    password or not, only when Google is authoritative for the address;
 *    otherwise they're refused and sign in with their password;
 *  - a user already bound to this Google account signs in, whatever the
 *    address (the binding was made under these rules, and Google addresses
 *    can change; the account id doesn't);
 *  - an address with no account can create a workspace, whoever verifies it:
 *    there's nothing to take over.
 * Also refused: an address Google hasn't verified, a user bound to a
 * different Google account, and deactivated users.
 */

export type GoogleIdentity = {
  /** Google's stable account id (the OIDC `sub`). */
  sub: string;
  email: string;
  emailVerified: boolean;
  /** The Google Workspace domain (`hd` claim); null for consumer accounts. */
  hd: string | null;
};

export type AccountCandidate = {
  userId: string;
  orgId: string;
  orgName: string;
  email: string;
  googleSub: string | null;
  deactivated: boolean;
};

export type WorkspaceOption = { userId: string; orgId: string; orgName: string };

export type RefusalReason = 'unverified' | 'unverified-domain' | 'account-mismatch' | 'deactivated';

export type GoogleResolution =
  | { kind: 'sign-in'; userId: string }
  | { kind: 'choose-workspace'; options: WorkspaceOption[] }
  | { kind: 'create-workspace' }
  | { kind: 'refused'; reason: RefusalReason };

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

const GOOGLE_MAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

/**
 * Google speaks for this mailbox: a Gmail address, or a Google Workspace
 * account (`hd`) on the address's own domain.
 */
export function googleIsAuthoritative(identity: Pick<GoogleIdentity, 'email' | 'hd'>): boolean {
  const email = normalizeEmail(identity.email);
  const at = email.lastIndexOf('@');
  if (at < 1 || at === email.length - 1) return false;
  const domain = email.slice(at + 1);
  if (GOOGLE_MAIL_DOMAINS.has(domain)) return true;
  return !!identity.hd && identity.hd.trim().toLowerCase() === domain;
}

/**
 * The claims we rely on from Google's id token (next-auth has already
 * checked its issuer, audience and expiry), or null when Google hasn't
 * verified the address.
 */
export function googleIdentityFrom(profile: unknown): GoogleIdentity | null {
  if (!profile || typeof profile !== 'object') return null;
  const p = profile as Record<string, unknown>;
  const sub = typeof p.sub === 'string' ? p.sub : '';
  const email = typeof p.email === 'string' ? normalizeEmail(p.email) : '';
  // Google sends a boolean; some older responses carried the string "true".
  const emailVerified = p.email_verified === true || p.email_verified === 'true';
  const hd = typeof p.hd === 'string' && p.hd.trim() ? p.hd.trim().toLowerCase() : null;
  if (!sub || !email || !emailVerified) return null;
  return { sub, email, emailVerified, hd };
}

export function resolveGoogleAccount(
  identity: GoogleIdentity,
  candidates: AccountCandidate[],
): GoogleResolution {
  const email = normalizeEmail(identity.email);
  if (!identity.emailVerified || !email || !identity.sub) return { kind: 'refused', reason: 'unverified' };
  const mayLink = googleIsAuthoritative({ email, hd: identity.hd });

  const relevant = candidates.filter(
    (c) => normalizeEmail(c.email) === email || c.googleSub === identity.sub,
  );
  const active = relevant.filter((c) => !c.deactivated);
  const allowed = active.filter(
    (c) => c.googleSub === identity.sub || (c.googleSub === null && mayLink),
  );

  // In a workspace where this Google account is already bound, that user is
  // the one, even if another user there now has the Google address (Google
  // addresses can change; the account id doesn't).
  const boundOrgs = new Set(allowed.filter((c) => c.googleSub === identity.sub).map((c) => c.orgId));
  const eligible = allowed.filter((c) => c.googleSub === identity.sub || !boundOrgs.has(c.orgId));

  if (eligible.length === 1) return { kind: 'sign-in', userId: eligible[0].userId };
  if (eligible.length > 1) {
    const options = eligible
      .map(({ userId, orgId, orgName }) => ({ userId, orgId, orgName }))
      .sort((a, b) => a.orgName.localeCompare(b.orgName) || a.orgId.localeCompare(b.orgId));
    return { kind: 'choose-workspace', options };
  }
  if (active.some((c) => c.googleSub !== null)) return { kind: 'refused', reason: 'account-mismatch' };
  if (active.length > 0) return { kind: 'refused', reason: 'unverified-domain' };
  if (relevant.length > 0) return { kind: 'refused', reason: 'deactivated' };
  return { kind: 'create-workspace' };
}

/**
 * The user a finishing step may sign in as, given a fresh resolution: the
 * only match, or the workspace the person picked from the list.
 */
export function pickResolvedUser(resolution: GoogleResolution, chosenUserId?: string | null): string | null {
  if (resolution.kind === 'sign-in') {
    return !chosenUserId || chosenUserId === resolution.userId ? resolution.userId : null;
  }
  if (resolution.kind === 'choose-workspace' && chosenUserId) {
    return resolution.options.some((o) => o.userId === chosenUserId) ? chosenUserId : null;
  }
  return null;
}
