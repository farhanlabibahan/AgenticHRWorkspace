import { describe, expect, it } from 'vitest';
import {
  googleIdentityFrom,
  googleIsAuthoritative,
  pickResolvedUser,
  resolveGoogleAccount,
  type AccountCandidate,
  type GoogleIdentity,
} from '@/server/google-account';

/** Which Source user a verified Google account is: every branch. */

const SUB = 'google-sub-1';
const OTHER_SUB = 'google-sub-2';
// A Google Workspace account on the address's own domain: Google speaks for it.
const me: GoogleIdentity = { sub: SUB, email: 'ada@example.com', emailVerified: true, hd: 'example.com' };
// A consumer Google account made with that work address: Google checked the
// mailbox once, and doesn't speak for it now.
const consumer: GoogleIdentity = { ...me, hd: null };

let n = 0;
function user(over: Partial<AccountCandidate> = {}): AccountCandidate {
  n += 1;
  return {
    userId: `user-${n}`,
    orgId: `org-${n}`,
    orgName: `Org ${n}`,
    email: 'ada@example.com',
    googleSub: null,
    deactivated: false,
    ...over,
  };
}

describe('resolveGoogleAccount', () => {
  it('refuses an address Google has not verified, even with an account behind it', () => {
    expect(resolveGoogleAccount({ ...me, emailVerified: false }, [user()])).toEqual({
      kind: 'refused',
      reason: 'unverified',
    });
    expect(resolveGoogleAccount({ ...me, email: '' }, [])).toEqual({ kind: 'refused', reason: 'unverified' });
    expect(resolveGoogleAccount({ ...me, sub: '' }, [user()])).toEqual({ kind: 'refused', reason: 'unverified' });
  });

  it('offers to create a workspace when nobody has the address', () => {
    expect(resolveGoogleAccount(me, [])).toEqual({ kind: 'create-workspace' });
  });

  it('signs in the one match, with or without a password (first Google sign-in links it)', () => {
    const invited = user(); // a password user who has never used Google
    expect(resolveGoogleAccount(me, [invited])).toEqual({ kind: 'sign-in', userId: invited.userId });
  });

  it('signs in a user already bound to this Google account', () => {
    const bound = user({ googleSub: SUB });
    expect(resolveGoogleAccount(me, [bound])).toEqual({ kind: 'sign-in', userId: bound.userId });
  });

  it('matches the address case-insensitively, and never loosely', () => {
    const upper = user({ email: '  Ada@Example.COM ' });
    expect(resolveGoogleAccount({ ...me, email: 'ADA@example.com' }, [upper])).toEqual({
      kind: 'sign-in',
      userId: upper.userId,
    });
    // A candidate the query shouldn't have returned (a LIKE wildcard, say) is ignored.
    expect(resolveGoogleAccount({ ...me, email: 'a_a@example.com' }, [user({ email: 'aba@example.com' })])).toEqual({
      kind: 'create-workspace',
    });
  });

  it('follows the Google account, not the address, once bound (Google addresses can change)', () => {
    const bound = user({ email: 'ada@old-domain.com', googleSub: SUB });
    expect(resolveGoogleAccount(me, [bound])).toEqual({ kind: 'sign-in', userId: bound.userId });
  });

  it('refuses a user bound to a different Google account with the same address', () => {
    expect(resolveGoogleAccount(me, [user({ googleSub: OTHER_SUB })])).toEqual({
      kind: 'refused',
      reason: 'account-mismatch',
    });
  });

  it('refuses deactivated users', () => {
    expect(resolveGoogleAccount(me, [user({ deactivated: true })])).toEqual({
      kind: 'refused',
      reason: 'deactivated',
    });
    expect(resolveGoogleAccount(me, [user({ deactivated: true, googleSub: SUB })])).toEqual({
      kind: 'refused',
      reason: 'deactivated',
    });
  });

  it('offers the workspaces, by name, when the address has several', () => {
    const zeta = user({ orgName: 'Zeta' });
    const acme = user({ orgName: 'Acme', googleSub: SUB });
    expect(resolveGoogleAccount(me, [zeta, acme])).toEqual({
      kind: 'choose-workspace',
      options: [
        { userId: acme.userId, orgId: acme.orgId, orgName: 'Acme' },
        { userId: zeta.userId, orgId: zeta.orgId, orgName: 'Zeta' },
      ],
    });
  });

  it('leaves out the workspaces it would refuse, and signs in when one is left', () => {
    const ok = user();
    const gone = user({ deactivated: true });
    const other = user({ googleSub: OTHER_SUB });
    expect(resolveGoogleAccount(me, [gone, other, ok])).toEqual({ kind: 'sign-in', userId: ok.userId });

    const ok2 = user();
    const result = resolveGoogleAccount(me, [gone, other, ok, ok2]);
    expect(result.kind).toBe('choose-workspace');
    expect(result.kind === 'choose-workspace' && result.options.map((o) => o.userId).sort()).toEqual(
      [ok.userId, ok2.userId].sort(),
    );
  });

  it('refuses as a mismatch when every active match is bound elsewhere, even beside deactivated ones', () => {
    expect(resolveGoogleAccount(me, [user({ googleSub: OTHER_SUB }), user({ deactivated: true })])).toEqual({
      kind: 'refused',
      reason: 'account-mismatch',
    });
  });

  it('in one workspace, prefers the user bound to this Google account over one with the address', () => {
    const bound = user({ orgId: 'org-x', email: 'ada@old-domain.com', googleSub: SUB });
    const sameOrg = user({ orgId: 'org-x' });
    expect(resolveGoogleAccount(me, [sameOrg, bound])).toEqual({ kind: 'sign-in', userId: bound.userId });
  });
});

describe('linking needs Google to speak for the address', () => {
  it('links a Gmail address, a googlemail.com one, and a Workspace account on its own domain', () => {
    for (const identity of [
      { ...consumer, email: 'ada@gmail.com' },
      { ...consumer, email: 'Ada@GoogleMail.com' },
      { ...consumer, hd: 'example.com' },
      { ...consumer, hd: 'EXAMPLE.com' },
    ]) {
      const invited = user({ email: identity.email });
      expect(resolveGoogleAccount(identity, [invited]), identity.email).toEqual({
        kind: 'sign-in',
        userId: invited.userId,
      });
    }
  });

  it('refuses to link an existing password user to a consumer account on a work address', () => {
    const passwordUser = user();
    expect(resolveGoogleAccount(consumer, [passwordUser])).toEqual({ kind: 'refused', reason: 'unverified-domain' });
  });

  it('refuses to link an invited user with no password the same way', () => {
    // The candidate carries no password either way: having one doesn't change who Google speaks for.
    expect(resolveGoogleAccount(consumer, [user()])).toEqual({ kind: 'refused', reason: 'unverified-domain' });
  });

  it('refuses a Workspace account whose domain is not the address’s', () => {
    const other = { ...me, hd: 'other-company.com' };
    expect(resolveGoogleAccount(other, [user()])).toEqual({ kind: 'refused', reason: 'unverified-domain' });
    // A Gmail address can't be vouched for by some other domain's hd either way: still Gmail.
    const gmail = user({ email: 'ada@gmail.com' });
    expect(resolveGoogleAccount({ ...other, email: 'ada@gmail.com' }, [gmail])).toEqual({
      kind: 'sign-in',
      userId: gmail.userId,
    });
  });

  it('still signs in a user already bound to this Google account, whatever the address', () => {
    const bound = user({ googleSub: SUB });
    expect(resolveGoogleAccount(consumer, [bound])).toEqual({ kind: 'sign-in', userId: bound.userId });
  });

  it('still lets a consumer account create a workspace for an address nobody has', () => {
    expect(resolveGoogleAccount(consumer, [])).toEqual({ kind: 'create-workspace' });
  });

  it('offers only the workspaces already bound, leaving out the ones it may not link', () => {
    const bound = user({ googleSub: SUB });
    const unbound = user();
    expect(resolveGoogleAccount(consumer, [unbound, bound])).toEqual({ kind: 'sign-in', userId: bound.userId });

    const bound2 = user({ googleSub: SUB });
    const result = resolveGoogleAccount(consumer, [unbound, bound, bound2]);
    expect(result.kind === 'choose-workspace' && result.options.map((o) => o.userId).sort()).toEqual(
      [bound.userId, bound2.userId].sort(),
    );
  });

  it('says mismatch before domain when the address is also bound to another Google account', () => {
    expect(resolveGoogleAccount(consumer, [user(), user({ googleSub: OTHER_SUB })])).toEqual({
      kind: 'refused',
      reason: 'account-mismatch',
    });
  });

  it('says deactivated when the only accounts it could have linked are deactivated', () => {
    expect(resolveGoogleAccount(consumer, [user({ deactivated: true })])).toEqual({
      kind: 'refused',
      reason: 'deactivated',
    });
  });
});

describe('googleIsAuthoritative', () => {
  it('is true for Gmail and for a Workspace account on the address’s domain only', () => {
    expect(googleIsAuthoritative({ email: 'ada@gmail.com', hd: null })).toBe(true);
    expect(googleIsAuthoritative({ email: 'ada@googlemail.com', hd: null })).toBe(true);
    expect(googleIsAuthoritative({ email: 'ada@example.com', hd: 'example.com' })).toBe(true);
    expect(googleIsAuthoritative({ email: 'ada@example.com', hd: null })).toBe(false);
    expect(googleIsAuthoritative({ email: 'ada@example.com', hd: 'mail.example.com' })).toBe(false);
    expect(googleIsAuthoritative({ email: 'ada@sub.example.com', hd: 'example.com' })).toBe(false);
    expect(googleIsAuthoritative({ email: 'ada@gmail.com.evil.test', hd: null })).toBe(false);
    expect(googleIsAuthoritative({ email: 'not-an-address', hd: 'not-an-address' })).toBe(false);
  });
});

describe('pickResolvedUser', () => {
  it('takes the only match, or a listed workspace, and nothing else', () => {
    expect(pickResolvedUser({ kind: 'sign-in', userId: 'u1' })).toBe('u1');
    expect(pickResolvedUser({ kind: 'sign-in', userId: 'u1' }, 'u1')).toBe('u1');
    expect(pickResolvedUser({ kind: 'sign-in', userId: 'u1' }, 'u2')).toBeNull();

    const choose = {
      kind: 'choose-workspace' as const,
      options: [
        { userId: 'u1', orgId: 'o1', orgName: 'A' },
        { userId: 'u2', orgId: 'o2', orgName: 'B' },
      ],
    };
    expect(pickResolvedUser(choose, 'u2')).toBe('u2');
    expect(pickResolvedUser(choose, 'someone-else')).toBeNull();
    expect(pickResolvedUser(choose)).toBeNull();

    expect(pickResolvedUser({ kind: 'create-workspace' }, 'u1')).toBeNull();
    expect(pickResolvedUser({ kind: 'refused', reason: 'deactivated' }, 'u1')).toBeNull();
  });
});

describe('googleIdentityFrom', () => {
  it('reads sub, the address (lowercased), whether Google verified it, and the Workspace domain', () => {
    expect(googleIdentityFrom({ sub: '123', email: 'Ada@Example.com', email_verified: true })).toEqual({
      sub: '123',
      email: 'ada@example.com',
      emailVerified: true,
      hd: null,
    });
    expect(
      googleIdentityFrom({ sub: '123', email: 'ada@example.com', email_verified: true, hd: 'Example.com' })?.hd,
    ).toBe('example.com');
    expect(googleIdentityFrom({ sub: '123', email: 'ada@example.com', email_verified: true, hd: 42 })?.hd).toBeNull();
    expect(googleIdentityFrom({ sub: '123', email: 'ada@example.com', email_verified: 'true' })?.emailVerified).toBe(
      true,
    );
  });

  it('is null for an unverified or missing address, or a missing account id', () => {
    expect(googleIdentityFrom({ sub: '123', email: 'ada@example.com', email_verified: false })).toBeNull();
    expect(googleIdentityFrom({ sub: '123', email: 'ada@example.com' })).toBeNull();
    expect(googleIdentityFrom({ sub: '123', email_verified: true })).toBeNull();
    expect(googleIdentityFrom({ email: 'ada@example.com', email_verified: true })).toBeNull();
    expect(googleIdentityFrom(undefined)).toBeNull();
  });
});
