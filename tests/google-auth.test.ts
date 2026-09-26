import { createHash, generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasDb } from './setup';

/**
 * "Continue with Google" end to end, through next-auth's real OAuth
 * callback: the state and PKCE checks, our account resolution, binding the
 * Google account, the workspace-choice and finish-sign-up steps, and the
 * session each one leaves. Google itself is a local fake (discovery and the
 * token endpoint); the browser is a cookie jar.
 */

const CLIENT_ID = 'test-client.apps.googleusercontent.com';
const ORIGIN = 'http://localhost:3000';
const SESSION_COOKIE = 'authjs.session-token';
const PENDING_COOKIE = 'source.google-pending';

const hoisted = vi.hoisted(() => {
  const saved = {
    AUTH_GOOGLE_ID: process.env.AUTH_GOOGLE_ID,
    AUTH_GOOGLE_SECRET: process.env.AUTH_GOOGLE_SECRET,
    AUTH_URL: process.env.AUTH_URL,
  };
  // Before lib/auth loads: it registers Google only when these are set.
  process.env.AUTH_GOOGLE_ID = 'test-client.apps.googleusercontent.com';
  process.env.AUTH_GOOGLE_SECRET = 'test-client-secret';
  delete process.env.AUTH_URL;
  return { saved, jar: new Map<string, string>() };
});
const jar = hoisted.jar;

function cookieHeader(): string {
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}

vi.mock('next/headers', () => {
  const store = {
    get: (name: string) => (hoisted.jar.has(name) ? { name, value: hoisted.jar.get(name)! } : undefined),
    getAll: () => [...hoisted.jar].map(([name, value]) => ({ name, value })),
    has: (name: string) => hoisted.jar.has(name),
    set: (...args: unknown[]) => {
      const [name, value, options] = (
        typeof args[0] === 'object' ? [(args[0] as { name: string }).name, (args[0] as { value: string }).value, args[0]] : args
      ) as [string, string, { maxAge?: number; expires?: Date | number | string } | undefined];
      const expired =
        options?.maxAge === 0 || (options?.expires !== undefined && new Date(options.expires).getTime() <= Date.now());
      if (expired || value === '') hoisted.jar.delete(name);
      else hoisted.jar.set(name, value);
    },
    delete: (name: string) => {
      hoisted.jar.delete(name);
    },
  };
  return {
    cookies: async () => store,
    headers: async () =>
      new Headers({
        host: 'localhost:3000',
        'x-forwarded-proto': 'http',
        cookie: [...hoisted.jar].map(([n, v]) => `${n}=${v}`).join('; '),
      }),
  };
});

const { NextRequest } = await import('next/server');
const { decode } = await import('next-auth/jwt');
const { db } = await import('@/lib/db');
const { authConfig } = await import('@/lib/auth.config');
const { handlers, signIn } = await import('@/lib/auth');
const { chooseWorkspace, finishGoogleSignup, googleSignIn, login, signup } = await import('@/app/(auth)/actions');
const { readPendingGoogle, writePendingGoogle } = await import('@/server/google-auth');
const { createWorkspace } = await import('@/server/workspace');
const { DEFAULT_STAGES, DEFAULT_ARCHIVE_REASONS } = await import('@/server/org-defaults');
const { DEFAULT_TEMPLATES } = await import('@/server/email');

// ---------- A fake Google ----------

const google = { claims: {} as Record<string, unknown>, tokenRequests: [] as URLSearchParams[] };
let privateKey: KeyObject;
const realFetch = globalThis.fetch;

function idToken(claims: Record<string, unknown>): string {
  const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const input = `${part({ alg: 'RS256', kid: 'test', typ: 'JWT' })}.${part(claims)}`;
  return `${input}.${sign('sha256', Buffer.from(input), privateKey).toString('base64url')}`;
}

async function fakeGoogle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url === 'https://accounts.google.com/.well-known/openid-configuration') {
    return Response.json({
      issuer: 'https://accounts.google.com',
      authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      token_endpoint: 'https://oauth2.googleapis.com/token',
      userinfo_endpoint: 'https://openidconnect.googleapis.com/v1/userinfo',
      jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs',
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      code_challenge_methods_supported: ['plain', 'S256'],
    });
  }
  if (url === 'https://oauth2.googleapis.com/token') {
    google.tokenRequests.push(new URLSearchParams(String(init?.body ?? '')));
    const now = Math.floor(Date.now() / 1000);
    return Response.json({
      access_token: `ya29.${randomUUID()}`,
      expires_in: 3599,
      scope: 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile',
      token_type: 'Bearer',
      id_token: idToken({
        iss: 'https://accounts.google.com',
        azp: CLIENT_ID,
        aud: CLIENT_ID,
        iat: now,
        exp: now + 3600,
        ...google.claims,
      }),
    });
  }
  return realFetch(input, init);
}

// ---------- The browser ----------

function applySetCookies(res: Response) {
  for (const line of res.headers.getSetCookie()) {
    const [pair, ...attrs] = line.split(';').map((s) => s.trim());
    const eq = pair.indexOf('=');
    const name = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    const expired = attrs.some((a) => {
      const [k, v] = a.split('=');
      if (k.toLowerCase() === 'max-age') return Number(v) <= 0;
      if (k.toLowerCase() === 'expires') return new Date(a.slice(8)).getTime() <= Date.now();
      return false;
    });
    if (expired || !value) jar.delete(name);
    else jar.set(name, value);
  }
}

/** Click "Continue with Google": the URL we're sent to at Google. */
async function startGoogle(redirectTo = '/dashboard'): Promise<URL> {
  return new URL(String(await signIn('google', { redirect: false, redirectTo })));
}

/** Google sends them back with a code for an account with these claims. */
async function returnFromGoogle(authUrl: URL, claims: Record<string, unknown>, state?: string) {
  google.claims = claims;
  const callback = new URL(`${ORIGIN}/api/auth/callback/google`);
  callback.searchParams.set('code', `4/${randomUUID()}`);
  callback.searchParams.set('state', state ?? authUrl.searchParams.get('state') ?? '');
  callback.searchParams.set('scope', 'email profile openid');
  const res = await handlers.GET(new NextRequest(callback, { headers: { cookie: cookieHeader() } }));
  applySetCookies(res);
  return { status: res.status, location: res.headers.get('location') };
}

async function continueWithGoogle(claims: Record<string, unknown>, redirectTo?: string) {
  return returnFromGoogle(await startGoogle(redirectTo), claims);
}

async function session(): Promise<Record<string, unknown> | null> {
  const token = jar.get(SESSION_COOKIE);
  if (!token) return null;
  return decode({ token, secret: authConfig.secret, salt: SESSION_COOKIE });
}

/** The session without what differs per issue (issued-at, expiry, token id). */
function fields(token: Record<string, unknown> | null) {
  if (!token) return null;
  const { iat: _iat, exp: _exp, jti: _jti, ...rest } = token;
  return rest;
}

/** Where a server action redirected (Next throws the redirect). */
async function redirectOf(action: Promise<unknown>): Promise<string> {
  try {
    await action;
  } catch (error) {
    const digest = (error as { digest?: string }).digest ?? '';
    if (digest.startsWith('NEXT_REDIRECT;')) return digest.split(';')[2];
    throw error;
  }
  throw new Error('expected a redirect');
}

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(values)) data.set(k, v);
  return data;
}

const unique = () => randomUUID().slice(0, 8);
const address = () => `ada-${unique()}@example.test`;
const googleSub = () => String(100000000000000000000n + BigInt(Math.floor(Math.random() * 1e15)));
/** A Google Workspace account on the address's domain, unless `extra` says otherwise. */
const claims = (sub: string, email: string, extra: Record<string, unknown> = {}) => ({
  sub,
  email,
  email_verified: true,
  hd: email.split('@')[1],
  name: 'Ada Lovelace',
  given_name: 'Ada',
  picture: 'https://lh3.googleusercontent.com/a/photo',
  ...extra,
});

async function passwordWorkspace(email: string, orgName = 'Acme', password = 'correct-horse') {
  return createWorkspace({ orgName, name: 'Ada Lovelace', email, passwordHash: await bcrypt.hash(password, 4) });
}

async function extraWorkspaceUser(
  email: string,
  orgName: string,
  over: { googleSub?: string; deactivatedAt?: Date; passwordHash?: string } = {},
) {
  const org = await db.organization.create({ data: { name: orgName, slug: `t-${unique()}` } });
  return db.user.create({
    data: { orgId: org.id, email, name: 'Ada Lovelace', accessRole: 'TEAM_MEMBER', passwordHash: null, ...over },
  });
}

describe.skipIf(!hasDb)('Continue with Google', () => {
  beforeAll(() => {
    privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    vi.stubGlobal('fetch', fakeGoogle);
  });
  afterAll(() => {
    vi.unstubAllGlobals();
    for (const [k, v] of Object.entries(hoisted.saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  beforeEach(() => {
    jar.clear();
    google.tokenRequests.length = 0;
  });

  it('sends people to Google with state, PKCE and the account chooser', async () => {
    const authUrl = await startGoogle();
    expect(`${authUrl.origin}${authUrl.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(authUrl.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(authUrl.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/auth/callback/google`);
    expect(authUrl.searchParams.get('response_type')).toBe('code');
    expect(authUrl.searchParams.get('scope')).toBe('openid profile email');
    expect(authUrl.searchParams.get('state')).toBeTruthy();
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authUrl.searchParams.get('code_challenge')).toBeTruthy();
    expect(authUrl.searchParams.get('prompt')).toBe('select_account');
  });

  it('signs in a password user, binds their Google account, and gives the same session a password sign-in does', async () => {
    const email = address();
    const sub = googleSub();
    const { userId, orgId } = await passwordWorkspace(email);

    await signIn('credentials', { email, password: 'correct-horse', redirect: false });
    const passwordSession = await session();
    expect(passwordSession).toMatchObject({ userId, orgId, accessRole: 'SUPER_ADMIN', orgName: 'Acme' });

    jar.clear();
    const authUrl = await startGoogle('/pipeline?stage=abc');
    // Google hands back the address in its own case.
    const back = await returnFromGoogle(authUrl, claims(sub, email.toUpperCase()));
    expect(back).toEqual({ status: 302, location: `${ORIGIN}/pipeline?stage=abc` });

    // The token exchange proved the PKCE verifier behind the challenge.
    const verifier = google.tokenRequests.at(-1)?.get('code_verifier') ?? '';
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(authUrl.searchParams.get('code_challenge'));
    expect(google.tokenRequests.at(-1)?.get('redirect_uri')).toBe(`${ORIGIN}/api/auth/callback/google`);

    expect(fields(await session())).toEqual(fields(passwordSession));
    const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.googleSub).toBe(sub);
    expect(user.passwordHash).not.toBeNull(); // they can still use it

    // Next time: straight in, same account.
    jar.clear();
    expect((await continueWithGoogle(claims(sub, email))).location).toBe(`${ORIGIN}/dashboard`);
    expect(fields(await session())).toEqual(fields(passwordSession));
  });

  it('refuses a callback whose state was not the one it sent', async () => {
    const email = address();
    await passwordWorkspace(email);
    const authUrl = await startGoogle();
    const back = await returnFromGoogle(authUrl, claims(googleSub(), email), 'forged-state');
    expect(back.location).toMatch(new RegExp(`^${ORIGIN}/login\\?error=`));
    expect(await session()).toBeNull();
    expect(google.tokenRequests).toHaveLength(0); // never even exchanged the code
  });

  it('refuses a callback without the PKCE verifier cookie', async () => {
    const email = address();
    await passwordWorkspace(email);
    const authUrl = await startGoogle();
    for (const name of [...jar.keys()]) if (name.includes('pkce')) jar.delete(name);
    const back = await returnFromGoogle(authUrl, claims(googleSub(), email));
    expect(back.location).toMatch(new RegExp(`^${ORIGIN}/login\\?error=`));
    expect(await session()).toBeNull();
  });

  it('refuses an address Google has not verified', async () => {
    const email = address();
    const { userId } = await passwordWorkspace(email);
    const back = await continueWithGoogle(claims(googleSub(), email, { email_verified: false }));
    expect(back.location).toBe(`${ORIGIN}/login?error=google-unverified`);
    expect(await session()).toBeNull();
    expect((await db.user.findUniqueOrThrow({ where: { id: userId } })).googleSub).toBeNull();
  });

  it('refuses a different Google account with the address of an account already bound', async () => {
    const email = address();
    const sub = googleSub();
    await passwordWorkspace(email);
    await continueWithGoogle(claims(sub, email));
    jar.clear();

    const back = await continueWithGoogle(claims(googleSub(), email));
    expect(back.location).toBe(`${ORIGIN}/login?error=google-account-mismatch`);
    expect(await session()).toBeNull();
  });

  it('won’t link an existing account to a consumer Google account on a work address', async () => {
    // No `hd`: a personal Google account someone made with this work address.
    // Google checked the mailbox once; it doesn't speak for it now.
    const email = address();
    const sub = googleSub();
    const { userId } = await passwordWorkspace(email);
    const invited = await extraWorkspaceUser(address(), 'Acme'); // no password yet

    const back = await continueWithGoogle(claims(sub, email, { hd: undefined }));
    expect(back.location).toBe(`${ORIGIN}/login?error=google-unverified-domain`);
    expect(await session()).toBeNull();
    expect((await db.user.findUniqueOrThrow({ where: { id: userId } })).googleSub).toBeNull();

    // Another company's Workspace can't vouch for this domain either.
    jar.clear();
    expect((await continueWithGoogle(claims(sub, email, { hd: 'other-company.test' }))).location).toBe(
      `${ORIGIN}/login?error=google-unverified-domain`,
    );

    // Nor for an invited teammate who has no password.
    jar.clear();
    expect((await continueWithGoogle(claims(googleSub(), invited.email, { hd: undefined }))).location).toBe(
      `${ORIGIN}/login?error=google-unverified-domain`,
    );
    expect((await db.user.findUniqueOrThrow({ where: { id: invited.id } })).googleSub).toBeNull();

    // Their password still works.
    jar.clear();
    expect(await redirectOf(login(undefined, form({ email, password: 'correct-horse' })))).toBe(`${ORIGIN}/dashboard`);
    expect(await session()).toMatchObject({ userId });

    // With a second workspace at the address: still refused, and no
    // workspace step is offered to go round it.
    jar.clear();
    const second = await extraWorkspaceUser(email, 'Second workspace');
    expect((await continueWithGoogle(claims(sub, email, { hd: undefined }))).location).toBe(
      `${ORIGIN}/login?error=google-unverified-domain`,
    );
    expect(jar.has(PENDING_COOKIE)).toBe(false);

    // Even holding a genuinely sealed pending identity for it, the step re-checks.
    jar.clear();
    await writePendingGoogle({ sub, email, hd: null, name: 'Ada', returnTo: '/dashboard' });
    expect(await redirectOf(chooseWorkspace(form({ userId: second.id })))).toBe('/login/workspace');
    expect(await session()).toBeNull();
    expect((await db.user.findUniqueOrThrow({ where: { id: second.id } })).googleSub).toBeNull();
  });

  it('signs in a user already bound to this Google account, whatever the address', async () => {
    const email = address();
    const sub = googleSub();
    const { userId } = await passwordWorkspace(email);
    await continueWithGoogle(claims(sub, email)); // linked as a Workspace account
    jar.clear();

    // The same Google account, now without the Workspace claim (the domain left Workspace, say).
    expect((await continueWithGoogle(claims(sub, email, { hd: undefined }))).location).toBe(`${ORIGIN}/dashboard`);
    expect(await session()).toMatchObject({ userId });
  });

  it('lets a consumer Google account create a workspace for an address nobody has', async () => {
    const email = address();
    const sub = googleSub();
    const back = await continueWithGoogle(claims(sub, email, { hd: undefined }));
    expect(back.location).toBe(`${ORIGIN}/signup/finish`);
    expect(await readPendingGoogle()).toMatchObject({ sub, email, hd: null });

    expect(await redirectOf(finishGoogleSignup(undefined, form({ orgName: 'Consumer Co', name: 'Ada' })))).toBe(
      `${ORIGIN}/onboarding`,
    );
    const user = await db.user.findFirstOrThrow({ where: { email } });
    expect(user).toMatchObject({ googleSub: sub, passwordHash: null, accessRole: 'SUPER_ADMIN' });
    expect(await session()).toMatchObject({ userId: user.id });

    // And it's theirs from then on: bound, so the next sign-in goes straight in.
    jar.clear();
    expect((await continueWithGoogle(claims(sub, email, { hd: undefined }))).location).toBe(`${ORIGIN}/dashboard`);
  });

  it('refuses deactivated users', async () => {
    const email = address();
    const { userId } = await passwordWorkspace(email);
    await db.user.update({ where: { id: userId }, data: { deactivatedAt: new Date() } });
    const back = await continueWithGoogle(claims(googleSub(), email));
    expect(back.location).toBe(`${ORIGIN}/login?error=google-deactivated`);
    expect(await session()).toBeNull();
  });

  it('asks which workspace when the address has several, and signs in to the one picked', async () => {
    const email = address();
    const sub = googleSub();
    const first = await passwordWorkspace(email, 'Zeta Talent');
    const invited = await extraWorkspaceUser(email, 'Acme');
    const stranger = await extraWorkspaceUser(address(), 'Elsewhere');

    const back = await continueWithGoogle(claims(sub, email), '/pipeline');
    expect(back.location).toBe(`${ORIGIN}/login/workspace`);
    expect(await session()).toBeNull();
    expect(await readPendingGoogle()).toMatchObject({ sub, email, returnTo: '/pipeline' });

    // Not one of theirs: back to the list, signed out.
    expect(await redirectOf(chooseWorkspace(form({ userId: stranger.id })))).toBe('/login/workspace');
    expect(await session()).toBeNull();

    expect(await redirectOf(chooseWorkspace(form({ userId: invited.id })))).toBe(`${ORIGIN}/pipeline`);
    expect(await session()).toMatchObject({
      userId: invited.id,
      orgId: invited.orgId,
      accessRole: 'TEAM_MEMBER',
      orgName: 'Acme',
      email,
    });
    expect((await db.user.findUniqueOrThrow({ where: { id: invited.id } })).googleSub).toBe(sub);
    // The other workspace binds when they first pick it.
    expect((await db.user.findUniqueOrThrow({ where: { id: first.userId } })).googleSub).toBeNull();
    // The pending identity is spent.
    expect(jar.has(PENDING_COOKIE)).toBe(false);
    expect(await redirectOf(chooseWorkspace(form({ userId: first.userId })))).toBe('/login?error=google-expired');
  });

  it('ignores a forged pending identity', async () => {
    const email = address();
    const { userId } = await passwordWorkspace(email);
    await extraWorkspaceUser(email, 'Acme');
    jar.set(PENDING_COOKIE, 'not-a-sealed-token');
    expect(await readPendingGoogle()).toBeNull();
    expect(await redirectOf(chooseWorkspace(form({ userId })))).toBe('/login?error=google-expired');
    expect(await session()).toBeNull();
  });

  it('signs up a new address: the workspace step, then the same workspace a password sign-up makes', async () => {
    const email = address();
    const sub = googleSub();
    const back = await continueWithGoogle(claims(sub, email, { name: 'Grace Hopper' }));
    expect(back.location).toBe(`${ORIGIN}/signup/finish`);
    expect(await session()).toBeNull();
    expect(await readPendingGoogle()).toMatchObject({ sub, email, name: 'Grace Hopper', returnTo: '/dashboard' });

    expect(await finishGoogleSignup(undefined, form({ orgName: '  ', name: 'Grace' }))).toEqual({
      error: 'All fields are required.',
    });
    const landed = await redirectOf(finishGoogleSignup(undefined, form({ orgName: 'Hopper & Co', name: 'Grace Hopper' })));
    expect(landed).toBe(`${ORIGIN}/onboarding`);

    const user = await db.user.findFirstOrThrow({ where: { email } });
    expect(user).toMatchObject({ googleSub: sub, passwordHash: null, accessRole: 'SUPER_ADMIN', name: 'Grace Hopper' });
    expect(await session()).toMatchObject({
      userId: user.id,
      orgId: user.orgId,
      accessRole: 'SUPER_ADMIN',
      orgName: 'Hopper & Co',
      onboardedAt: null,
      email,
    });

    // Password sign-up, through the same code: the same workspace.
    jar.clear();
    const otherEmail = address();
    const viaPassword = await redirectOf(
      signup(undefined, form({ orgName: 'Babbage Ltd', name: 'Charles', email: otherEmail, password: 'analytical-engine' })),
    );
    expect(viaPassword).toBe(`${ORIGIN}/onboarding`);
    const passwordUser = await db.user.findFirstOrThrow({ where: { email: otherEmail } });
    expect(passwordUser).toMatchObject({ googleSub: null, accessRole: 'SUPER_ADMIN' });
    expect(passwordUser.passwordHash).toBeTruthy();

    const shape = async (orgId: string) => {
      const org = await db.organization.findUniqueOrThrow({
        where: { id: orgId },
        include: { stages: { orderBy: { order: 'asc' } }, archiveReasons: true, emailTemplates: true },
      });
      const events = await db.event.findMany({ where: { orgId, verb: 'org.created' } });
      return {
        stages: org.stages.map((s) => [s.name, s.type]),
        archiveReasons: org.archiveReasons.map((r) => r.name).sort(),
        templates: org.emailTemplates.map((t) => t.name).sort(),
        autoConfirm: Boolean(org.autoConfirmTemplateId),
        autoInterview: Boolean(org.autoInterviewTemplateId),
        onboarded: org.onboardedAt,
        events: events.length,
      };
    };
    const googleShape = await shape(user.orgId);
    expect(googleShape).toEqual(await shape(passwordUser.orgId));
    expect(googleShape.stages).toHaveLength(DEFAULT_STAGES.length);
    expect(googleShape.archiveReasons).toHaveLength(DEFAULT_ARCHIVE_REASONS.length);
    expect(googleShape.templates).toHaveLength(DEFAULT_TEMPLATES.length);
    expect(googleShape).toMatchObject({ autoConfirm: true, autoInterview: true, onboarded: null, events: 1 });
  });

  it('never makes a second workspace for the same address', async () => {
    const email = address();
    const sub = googleSub();
    await continueWithGoogle(claims(sub, email));
    const pending = jar.get(PENDING_COOKIE)!;
    await redirectOf(finishGoogleSignup(undefined, form({ orgName: 'First', name: 'Ada' })));

    // The same step submitted again (another tab, a replayed cookie).
    jar.clear();
    jar.set(PENDING_COOKIE, pending);
    expect(await redirectOf(finishGoogleSignup(undefined, form({ orgName: 'Second', name: 'Ada' })))).toBe(
      '/login/workspace',
    );
    expect(await db.user.count({ where: { email } })).toBe(1);

    // And the password sign-up still refuses the address.
    expect(await signup(undefined, form({ orgName: 'Third', name: 'Ada', email, password: 'long-enough' }))).toEqual({
      error: 'An account with this email already exists.',
    });
  });

  it('tells a Google-only user on the password form to use Google', async () => {
    const email = address();
    await continueWithGoogle(claims(googleSub(), email));
    await redirectOf(finishGoogleSignup(undefined, form({ orgName: 'Only Google', name: 'Ada' })));
    jar.clear();

    expect(await login(undefined, form({ email, password: 'anything-at-all' }))).toEqual({
      error: 'This account signs in with Google. Use Continue with Google above.',
    });
    const withPassword = address();
    await passwordWorkspace(withPassword);
    expect(await login(undefined, form({ email: withPassword, password: 'wrong-password' }))).toEqual({
      error: 'Invalid email or password.',
    });
  });

  it('password sign-in skips a password-less account at the same address', async () => {
    const email = address();
    await extraWorkspaceUser(email, 'Google only'); // created first, no password
    const { id: userId } = await extraWorkspaceUser(email, 'Has a password', {
      passwordHash: await bcrypt.hash('correct-horse', 4),
    });
    expect(await redirectOf(login(undefined, form({ email, password: 'correct-horse' })))).toBe(`${ORIGIN}/dashboard`);
    expect(await session()).toMatchObject({ userId });
  });

  it('keeps where they were going, but only on this site', async () => {
    const email = address();
    await passwordWorkspace(email);

    expect(await redirectOf(login(undefined, form({ email, password: 'correct-horse', callbackUrl: '/settings' })))).toBe(
      `${ORIGIN}/settings`,
    );
    jar.clear();
    expect(
      await redirectOf(login(undefined, form({ email, password: 'correct-horse', callbackUrl: 'https://evil.example/x' }))),
    ).toBe(`${ORIGIN}/dashboard`);

    jar.clear();
    const toGoogle = await redirectOf(googleSignIn(form({ callbackUrl: '//evil.example/x' })));
    expect(toGoogle).toMatch(/^https:\/\/accounts\.google\.com\//);
    expect(decodeURIComponent(jar.get('authjs.callback-url') ?? '')).toBe(`${ORIGIN}/dashboard`);
  });
});
