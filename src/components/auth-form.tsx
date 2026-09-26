'use client';

import { useActionState, useEffect } from 'react';
import type { AuthFormState } from '@/app/(auth)/actions';
import { inputLgClass } from '@/components/form-controls';
import { buttonClass } from '@/components/ui/button';
import { TextSwap, useShake } from '@/components/ui/motion';

type Field = {
  name: string;
  label: string;
  type: string;
  placeholder?: string;
  autoComplete?: string;
  defaultValue?: string;
};

export function AuthForm({
  action,
  fields,
  submitLabel,
  hidden,
}: {
  action: (prev: AuthFormState, formData: FormData) => Promise<AuthFormState>;
  fields: Field[];
  submitLabel: string;
  /** Carried along with the fields (e.g. where to go after signing in). */
  hidden?: Record<string, string>;
}) {
  const [state, formAction, pending] = useActionState(action, undefined);
  const [fieldsRef, shake] = useShake();

  // Each rejected submit returns a fresh state object, so a repeat failure shakes again.
  // (shake only touches a ref, so it's safe to leave out of the deps.)
  useEffect(() => {
    if (state?.error) shake();
  }, [state]);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {Object.entries(hidden ?? {}).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <div ref={fieldsRef} className="flex flex-col gap-4">
        {fields.map((f) => (
          <label key={f.name} className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-ink">{f.label}</span>
            <input
              name={f.name}
              type={f.type}
              required
              placeholder={f.placeholder}
              autoComplete={f.autoComplete}
              defaultValue={f.defaultValue}
              className={inputLgClass}
            />
          </label>
        ))}
      </div>

      {state?.error ? (
        <p
          role="alert"
          className="animate-fade-rise rounded-field bg-critical/10 px-3 py-2 text-sm text-critical"
        >
          {state.error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className={buttonClass({ variant: 'primary', size: 'lg', className: 'mt-2 w-full' })}
      >
        <TextSwap>{pending ? 'Working…' : submitLabel}</TextSwap>
      </button>
    </form>
  );
}
