'use client';

import { useFormStatus } from 'react-dom';
import { chooseWorkspace, googleSignIn } from '@/app/(auth)/actions';
import { buttonClass } from '@/components/ui/button';
import { TextSwap } from '@/components/ui/motion';
import { Avatar } from '@/components/ui/orb';

/**
 * "Continue with Google" and its follow-up step. Only rendered where the
 * deployment has Google sign-in set up (server/google-auth.ts).
 */

/**
 * Google's "G", in its own colors: Google's branding rules for sign-in
 * buttons keep the mark unaltered, so it's the one colored thing here.
 */
export function GoogleMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true" focusable="false" className={className}>
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

function GoogleSubmit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className={buttonClass({ variant: 'tonal', size: 'lg', className: 'w-full [&_svg]:size-[18px]' })}
    >
      <GoogleMark />
      <TextSwap>{pending ? 'Working…' : 'Continue with Google'}</TextSwap>
    </button>
  );
}

/** The button, and the "or" rule that separates it from the email form. */
export function GoogleSignIn({ callbackUrl, kind }: { callbackUrl?: string; kind?: 'agency' }) {
  return (
    <>
      <form action={googleSignIn}>
        {callbackUrl ? <input type="hidden" name="callbackUrl" value={callbackUrl} /> : null}
        {kind ? <input type="hidden" name="kind" value={kind} /> : null}
        <GoogleSubmit />
      </form>
      <div role="separator" className="my-5 flex items-center gap-3">
        <span className="h-px flex-1 bg-line" />
        <span className="text-xs text-ink-2">or</span>
        <span className="h-px flex-1 bg-line" />
      </div>
    </>
  );
}

function WorkspaceSubmit({ orgName }: { orgName: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className={buttonClass({ variant: 'tonal', size: 'lg', className: 'w-full justify-start pl-2' })}
    >
      {/* The same mark the sidebar gives a workspace without a logo */}
      <Avatar name={orgName} size={28} />
      <span className="min-w-0 flex-1 truncate text-left">{orgName}</span>
      {pending ? (
        <span className="text-sm text-ink-2">Working…</span>
      ) : (
        <span className="t-learn-arrow" aria-hidden="true">
          →
        </span>
      )}
    </button>
  );
}

export function WorkspaceChoice({ userId, orgName }: { userId: string; orgName: string }) {
  return (
    <form action={chooseWorkspace}>
      <input type="hidden" name="userId" value={userId} />
      <WorkspaceSubmit orgName={orgName} />
    </form>
  );
}
