import Link from 'next/link';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { AuthForm } from '@/components/auth-form';
import { SIGNUP_KIND_COOKIE } from '@/lib/signup-kind';
import { finishGoogleSignup } from '../../actions';
import {
  googleAuthEnabled,
  loginErrorPath,
  pendingIdentity,
  readPendingGoogle,
  resolveGoogle,
} from '@/server/google-auth';

export const metadata = { title: 'Finish creating your workspace · Orqestra' };

export const dynamic = 'force-dynamic';

/**
 * After Google, for a verified address with no account yet: the password
 * sign-up's questions minus the email and password, which Google answered.
 */
export default async function FinishSignupPage() {
  if (!googleAuthEnabled()) redirect('/signup');
  const pending = await readPendingGoogle();
  if (!pending) redirect(loginErrorPath('expired'));

  // An account may have appeared since (an invite, another tab): sign in to it instead.
  const { resolution } = await resolveGoogle(pendingIdentity(pending));
  if (resolution.kind === 'refused') redirect(loginErrorPath(resolution.reason));
  if (resolution.kind !== 'create-workspace') redirect('/login/workspace');
  const agency = (await cookies()).get(SIGNUP_KIND_COOKIE)?.value === 'agency';

  return (
    <div>
      <h1 className="text-xl font-medium">Finish creating your workspace</h1>
      <p className="mb-6 mt-1 text-sm text-ink-2">
        Signed in with Google as <span className="text-ink">{pending.email}</span>. Name your
        organization and you&apos;re in. You&apos;ll be the super admin.
      </p>
      <AuthForm
        action={finishGoogleSignup}
        hidden={agency ? { kind: 'agency' } : undefined}
        submitLabel="Create workspace"
        fields={[
          { name: 'orgName', label: agency ? 'Agency name' : 'Organization name', type: 'text', placeholder: agency ? 'Harbor Talent' : 'Acme Inc.' },
          {
            name: 'name',
            label: 'Your name',
            type: 'text',
            autoComplete: 'name',
            defaultValue: pending.name,
          },
        ]}
      />
      <p className="mt-6 text-sm text-ink-2">
        Not you?{' '}
        <Link href="/signup" className="font-medium text-ink hover:underline">
          Start over
        </Link>
      </p>
    </div>
  );
}
