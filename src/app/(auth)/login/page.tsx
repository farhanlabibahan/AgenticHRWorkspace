import Link from 'next/link';
import { buttonClass } from '@/components/ui/button';
import { AuthForm } from '@/components/auth-form';
import { GoogleSignIn } from '@/components/google-auth';
import { signInErrorMessage } from '@/lib/auth-errors';
import { safeRedirectPath } from '@/lib/safe-redirect';
import { demoEnabled } from '@/server/demo-accounts';
import { googleAuthEnabled } from '@/server/google-auth';
import { requestOrigin } from '@/server/request-origin';
import { login } from '../actions';

export const metadata = { title: 'Sign in · Source' };

// Rendered per-request so the DEMO_MODE flag and the Google keys are read
// at runtime, not baked in at build time.
export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string | string[]; error?: string | string[] }>;
}) {
  const params = await searchParams;
  const google = googleAuthEnabled();
  const error = signInErrorMessage(first(params.error), { google });
  // The middleware sends people here with the page they wanted; keep it,
  // as a path on this site, for after they sign in.
  const { origin } = await requestOrigin();
  const callbackUrl = safeRedirectPath(first(params.callbackUrl), { origin });

  return (
    <div>
      <h1 className="text-xl font-medium">Sign in</h1>
      <p className="mb-6 mt-1 text-sm text-ink-2">Welcome back.</p>
      {error ? (
        <p role="alert" className="mb-4 rounded-field bg-critical/10 px-3 py-2 text-sm text-critical">
          {error}
        </p>
      ) : null}
      {google ? <GoogleSignIn callbackUrl={callbackUrl} /> : null}
      <AuthForm
        action={login}
        submitLabel="Sign in"
        hidden={{ callbackUrl }}
        fields={[
          { name: 'email', label: 'Email', type: 'email', autoComplete: 'email' },
          { name: 'password', label: 'Password', type: 'password', autoComplete: 'current-password' },
        ]}
      />
      {demoEnabled() ? (
        <div className="mt-6 flex flex-col gap-2">
          <p className="text-xs text-ink-2">Try a sample workspace, no account needed:</p>
          <a href="/demo/manager" className={buttonClass({ variant: 'tonal', size: 'lg', className: 'w-full' })}>
            Demo: manager / recruiter <span aria-hidden>→</span>
          </a>
          <a href="/demo/employee" className={buttonClass({ variant: 'tonal', size: 'lg', className: 'w-full' })}>
            Demo: employee <span aria-hidden>→</span>
          </a>
        </div>
      ) : null}
      <p className="mt-6 text-sm text-ink-2">
        New here?{' '}
        <Link href="/signup" className="font-medium text-ink hover:underline">
          Create an organization
        </Link>
      </p>
    </div>
  );
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
