import Link from 'next/link';
import { AuthForm } from '@/components/auth-form';
import { GoogleSignIn } from '@/components/google-auth';
import { googleAuthEnabled } from '@/server/google-auth';
import { signup } from '../actions';

export const metadata = { title: 'Sign up · Source' };

// Per request, so the Google keys are read at runtime, not at build time.
export const dynamic = 'force-dynamic';

export default async function SignupPage({ searchParams }: { searchParams: Promise<{ kind?: string }> }) {
  // From /agencies' Get started: the workspace is set up as a staffing agency.
  const agency = (await searchParams).kind === 'agency';
  return (
    <div>
      <h1 className="text-xl font-medium">{agency ? 'Create your agency workspace' : 'Create your organization'}</h1>
      <p className="mb-6 mt-1 text-sm text-ink-2">
        {agency
          ? 'Sets up your agency with a default hiring pipeline, ready for your client companies. You’ll be the super admin.'
          : 'Sets up your org with a default hiring pipeline. You’ll be the super admin.'}
      </p>
      {googleAuthEnabled() ? <GoogleSignIn kind={agency ? 'agency' : undefined} /> : null}
      <AuthForm
        action={signup}
        hidden={agency ? { kind: 'agency' } : undefined}
        submitLabel="Create organization"
        fields={[
          { name: 'orgName', label: agency ? 'Agency name' : 'Organization name', type: 'text', placeholder: agency ? 'Harbor Talent' : 'Acme Inc.' },
          { name: 'name', label: 'Your name', type: 'text', autoComplete: 'name' },
          { name: 'email', label: 'Work email', type: 'email', autoComplete: 'email' },
          {
            name: 'password',
            label: 'Password',
            type: 'password',
            placeholder: 'At least 8 characters',
            autoComplete: 'new-password',
          },
        ]}
      />
      <p className="mt-6 text-sm text-ink-2">
        Already have an account?{' '}
        <Link href="/login" className="font-medium text-ink hover:underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}
