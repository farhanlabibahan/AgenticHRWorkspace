/**
 * The sign-in page's `?error=` codes, in words. Ours come from the Google
 * sign-in (server/google-auth.ts); anything else is next-auth's own
 * (a cancelled consent screen, a failed state or PKCE check…). The code
 * itself is never echoed back to the page, and where Google sign-in isn't
 * set up nothing mentions it.
 */
const GOOGLE_MESSAGES: Record<string, string> = {
  'google-unverified':
    'Google hasn’t verified that email address, so it can’t be used to sign in. Use an account with a verified address.',
  'google-unverified-domain':
    'Sign in with your password for this account. Google sign-in works with Gmail and Google Workspace addresses.',
  'google-account-mismatch':
    'That email is already linked to a different Google account. Continue with that account, or sign in with your password.',
  'google-deactivated': 'Your account has been deactivated. Ask a workspace admin to restore it.',
  'google-expired': 'Your Google sign-in timed out. Please try again.',
};

export function signInErrorMessage(code: unknown, { google }: { google: boolean }): string | null {
  if (typeof code !== 'string' || !code) return null;
  if (!google) return 'Sign-in didn’t finish. Please try again.';
  return GOOGLE_MESSAGES[code] ?? 'Google sign-in didn’t finish. Please try again.';
}
