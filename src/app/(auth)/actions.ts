'use server';

import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { AuthError } from 'next-auth';
import bcrypt from 'bcryptjs';
import { db } from '@/lib/db';
import { signIn } from '@/lib/auth';
import { safeRedirectPath } from '@/lib/safe-redirect';
import {
  GOOGLE_CONTINUE_PROVIDER,
  googleAuthEnabled,
  loginErrorPath,
  readPendingGoogle,
} from '@/server/google-auth';
import { companyExists, createWorkspace, EmailTakenError, SINGLE_COMPANY_MESSAGE } from '@/server/workspace';
import { SIGNUP_KIND_COOKIE } from '@/lib/signup-kind';

export type AuthFormState = { error?: string } | undefined;

export async function signup(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const name = String(formData.get('name') ?? '').trim();
  const orgName = String(formData.get('orgName') ?? '').trim();
  const email = String(formData.get('email') ?? '')
    .toLowerCase()
    .trim();
  const password = String(formData.get('password') ?? '');

  if (!name || !orgName || !email || !password) return { error: 'All fields are required.' };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: 'Enter a valid email address.' };
  if (password.length < 8) return { error: 'Password must be at least 8 characters.' };

  const existing = await db.user.findFirst({ where: { email } });
  if (existing) return { error: 'An account with this email already exists.' };

  if (await companyExists()) return { error: SINGLE_COMPANY_MESSAGE };

  const passwordHash = await bcrypt.hash(password, 12);
  try {
    await createWorkspace({ orgName, name, email, passwordHash, kind: signupKind(formData.get('kind')) });
  } catch (error) {
    if (error instanceof EmailTakenError) return { error: error.message };
    throw error;
  }

  await signIn('credentials', { email, password, redirectTo: '/onboarding' });
}

export async function login(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const email = String(formData.get('email') ?? '');
  try {
    await signIn('credentials', {
      email,
      password: String(formData.get('password') ?? ''),
      redirectTo: safeRedirectPath(formData.get('callbackUrl')),
    });
  } catch (error) {
    if (error instanceof AuthError) {
      if (googleAuthEnabled() && (await signsInWithGoogleOnly(email))) {
        return { error: 'This account signs in with Google. Use Continue with Google above.' };
      }
      return { error: 'Invalid email or password.' };
    }
    throw error; // successful signIn throws a redirect — let it through
  }
}

/** Every active account at this address is password-less (made by Google sign-up). */
async function signsInWithGoogleOnly(rawEmail: string): Promise<boolean> {
  const email = rawEmail.toLowerCase().trim();
  if (!email) return false;
  const [row] = await db.$queryRaw<{ googleOnly: boolean | null }[]>`
    SELECT bool_and("passwordHash" IS NULL) AS "googleOnly"
    FROM "User" WHERE lower(email) = ${email} AND "deactivatedAt" IS NULL`;
  return row?.googleOnly === true;
}

// ---------- Continue with Google ----------

/** Off to Google. Where they land afterwards is checked here and by next-auth. */
export async function googleSignIn(formData: FormData): Promise<void> {
  if (!googleAuthEnabled()) redirect('/login');
  // A sign-up from /agencies: remember it across Google's round trip, for /signup/finish.
  const jar = await cookies();
  if (signupKind(formData.get('kind')) === 'AGENCY') {
    jar.set(SIGNUP_KIND_COOKIE, 'agency', { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 30 * 60 });
  } else {
    jar.delete(SIGNUP_KIND_COOKIE);
  }
  await signIn('google', { redirectTo: safeRedirectPath(formData.get('callbackUrl')) });
}

/** A new workspace's kind from a sign-up form: AGENCY only when asked for. */
function signupKind(value: FormDataEntryValue | null): 'COMPANY' | 'AGENCY' {
  return value === 'agency' ? 'AGENCY' : 'COMPANY';
}

/** /login/workspace: sign in to the workspace they picked. */
export async function chooseWorkspace(formData: FormData): Promise<void> {
  const pending = await readPendingGoogle();
  if (!pending) redirect(loginErrorPath('expired'));
  try {
    await signIn(GOOGLE_CONTINUE_PROVIDER, {
      userId: String(formData.get('userId') ?? ''),
      redirectTo: pending.returnTo,
    });
  } catch (error) {
    // The workspace went away between the list and the click; start over.
    if (error instanceof AuthError) redirect('/login/workspace');
    throw error;
  }
}

/**
 * /signup/finish: create the workspace for a verified Google account that
 * has none, through the same code as the password sign-up, then sign in.
 */
export async function finishGoogleSignup(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const pending = await readPendingGoogle();
  if (!pending) redirect(loginErrorPath('expired'));

  const orgName = String(formData.get('orgName') ?? '').trim();
  const name = String(formData.get('name') ?? '').trim();
  if (!orgName || !name) return { error: 'All fields are required.' };

  if (await companyExists()) return { error: SINGLE_COMPANY_MESSAGE };

  try {
    await createWorkspace({
      orgName,
      name,
      email: pending.email,
      passwordHash: null,
      googleSub: pending.sub,
      kind: signupKind(formData.get('kind')),
    });
    (await cookies()).delete(SIGNUP_KIND_COOKIE);
  } catch (error) {
    // The address has an account now (a second submit, or an invite that
    // just landed): sign in to that instead of making another workspace.
    if (error instanceof EmailTakenError) redirect('/login/workspace');
    throw error;
  }

  try {
    await signIn(GOOGLE_CONTINUE_PROVIDER, { redirectTo: '/onboarding' });
  } catch (error) {
    if (error instanceof AuthError) {
      return { error: 'Your workspace is ready, but sign-in didn’t finish. Continue with Google to sign in.' };
    }
    throw error;
  }
}
