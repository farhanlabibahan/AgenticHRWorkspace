'use client';

import { useTransition } from 'react';
import { setNetworkConsentAction } from '@/app/portal/actions';
import { surface } from '@/components/form-controls';
import { buttonClass } from '@/components/ui/button';
import { TextSwap } from '@/components/ui/motion';

export function NetworkConsentToggle({ token, optedIn }: { token: string; optedIn: boolean }) {
  const [pending, startTransition] = useTransition();

  return (
    <div className={`${surface} flex flex-wrap items-center justify-between gap-3 p-4`}>
      <div className="min-w-0 max-w-md">
        <p className="text-sm font-medium">Discoverable by other employers</p>
        <p className="mt-0.5 text-xs text-ink-2">
          {optedIn
            ? 'Your profile can be found by other companies hiring on Source. Only details you submitted are shared — never interview notes or feedback.'
            : 'Your profile is private to the companies you applied to.'}
        </p>
      </div>
      <button
        disabled={pending}
        onClick={() => startTransition(() => setNetworkConsentAction(token, !optedIn))}
        className={buttonClass({ variant: 'tonal', size: 'sm' })}
      >
        <TextSwap>{pending ? 'Saving…' : optedIn ? 'Withdraw' : 'Opt in'}</TextSwap>
      </button>
    </div>
  );
}
