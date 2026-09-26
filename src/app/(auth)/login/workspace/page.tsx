import Link from 'next/link';
import { redirect } from 'next/navigation';
import { WorkspaceChoice } from '@/components/google-auth';
import {
  googleAuthEnabled,
  loginErrorPath,
  pendingIdentity,
  readPendingGoogle,
  resolveGoogle,
  workspaceOptions,
} from '@/server/google-auth';

export const metadata = { title: 'Choose a workspace · Source' };

export const dynamic = 'force-dynamic';

/**
 * After Google, for an address that belongs to more than one workspace:
 * pick which one to sign in to. The list is worked out again here from the
 * sealed Google identity, never from the URL.
 */
export default async function ChooseWorkspacePage() {
  if (!googleAuthEnabled()) redirect('/login');
  const pending = await readPendingGoogle();
  if (!pending) redirect(loginErrorPath('expired'));

  const { resolution, candidates } = await resolveGoogle(pendingIdentity(pending));
  if (resolution.kind === 'create-workspace') redirect('/signup/finish');
  if (resolution.kind === 'refused') redirect(loginErrorPath(resolution.reason));
  const options = workspaceOptions(resolution, candidates);

  return (
    <div>
      <h1 className="text-xl font-medium">Choose a workspace</h1>
      <p className="mb-6 mt-1 text-sm text-ink-2">
        {options.length > 1 ? (
          <>
            <span className="text-ink">{pending.email}</span> belongs to more than one workspace.
            Which one do you want to open?
          </>
        ) : (
          <>
            Continue as <span className="text-ink">{pending.email}</span>.
          </>
        )}
      </p>
      <div className="flex flex-col gap-2">
        {options.map((o) => (
          <WorkspaceChoice key={o.userId} userId={o.userId} orgName={o.orgName} />
        ))}
      </div>
      <p className="mt-6 text-sm text-ink-2">
        Not you?{' '}
        <Link href="/login" className="font-medium text-ink hover:underline">
          Use a different account
        </Link>
      </p>
    </div>
  );
}
