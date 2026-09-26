'use client';

import { useActionState } from 'react';
import { declineOfferAction, signOfferAction, type OfferSignState } from '@/app/offer/actions';
import { inputLgClass, surface } from '@/components/form-controls';
import { buttonClass } from '@/components/ui/button';
import { TextSwap } from '@/components/ui/motion';
import { Checkbox } from '@/components/ui/checkbox';

/** Typed-name e-signature block on the public offer page. */
export function OfferSignForm({ token, candidateName }: { token: string; candidateName: string }) {
  const [state, formAction, pending] = useActionState<OfferSignState, FormData>(
    signOfferAction,
    undefined,
  );
  const [declineState, declineFormAction, declinePending] = useActionState<
    OfferSignState,
    FormData
  >(declineOfferAction, undefined);

  if (state?.signed) {
    return (
      <div className={`${surface} animate-fade-rise p-8`}>
        <h2 className="text-md font-medium text-ink">Signed — congratulations! 🎉</h2>
        <p className="mt-2 text-sm text-ink-2">
          Your acceptance is recorded and the team has been notified. A copy of this letter stays
          available at this link.
        </p>
      </div>
    );
  }
  if (declineState?.declined) {
    return (
      <div className={`${surface} p-8`}>
        <h2 className="text-md font-medium text-ink">Response recorded</h2>
        <p className="mt-2 text-sm text-ink-2">
          You&rsquo;ve declined this offer. The team has been notified — thank you for letting
          them know.
        </p>
      </div>
    );
  }

  return (
    <div className={`${surface} p-8`}>
      <h2 className="text-md font-medium text-ink">Sign electronically</h2>
      <form action={formAction} className="mt-4 flex flex-col gap-4">
        <input type="hidden" name="token" value={token} />
        <label className="flex flex-col gap-1.5">
          <span className="text-sm text-ink-2">
            Type your full legal name to sign as {candidateName}
          </span>
          <input
            name="signedName"
            required
            placeholder={candidateName}
            className={inputLgClass}
            autoComplete="name"
          />
        </label>
        <label className="flex cursor-pointer items-start gap-2.5 text-sm text-ink-2">
          <Checkbox name="consent" required className="mt-0.5" />
          <span>
            I agree that typing my name here constitutes my electronic signature on this offer
            letter, with the same effect as a handwritten signature.
          </span>
        </label>
        {state?.error ? <p className="text-sm text-critical">{state.error}</p> : null}
        <button
          type="submit"
          disabled={pending}
          className={buttonClass({ variant: 'primary', size: 'lg', className: 'mt-2 w-full' })}
        >
          <TextSwap>{pending ? 'Signing…' : 'Accept & sign'}</TextSwap>
        </button>
      </form>
      <form action={declineFormAction} className="mt-2 text-center">
        <input type="hidden" name="token" value={token} />
        {declineState?.error ? <p className="mb-1 text-sm text-critical">{declineState.error}</p> : null}
        <button
          type="submit"
          disabled={declinePending}
          className={buttonClass({ variant: 'ghost', size: 'sm' })}
        >
          {declinePending ? 'Recording…' : 'Decline this offer'}
        </button>
      </form>
    </div>
  );
}
