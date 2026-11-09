'use client';

import { useEffect, useState } from 'react';
import { Check, EyeOff } from 'lucide-react';
import { surface } from '@/components/form-controls';
import { buttonClass } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { DitherBar } from '@/components/ui/dither';
import { NumberPop } from '@/components/ui/motion';

export type OnboardingStep = { label: string; detail: string; done: boolean; href: string };

/**
 * Dashboard onboarding checklist (Recruiting-Assistant layout): progress %
 * as a dithered bar, check-circle steps, and a Hide link (persisted locally).
 */
export function OnboardingCard({ steps }: { steps: OnboardingStep[] }) {
  const [hidden, setHidden] = useState(true); // avoid flash before localStorage read
  useEffect(() => {
    setHidden(localStorage.getItem('src-hide-onboarding') === '1');
  }, []);

  const done = steps.filter((s) => s.done).length;
  const pct = Math.round((done / steps.length) * 100);
  if (hidden || pct === 100) return null;

  return (
    <div className={`${surface} p-5`}>
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-md font-medium text-ink">Onboarding</h2>
        <span className="text-lg font-medium">
          <NumberPop value={pct} format={(n) => `${n}%`} />
        </span>
      </div>
      <div
        role="progressbar"
        aria-label="Onboarding progress"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        className="mt-3"
      >
        <DitherBar value={pct} max={100} height={9} label={`${pct}% complete`} />
      </div>
      <p className="mt-3 text-sm text-ink-2">
        A few steps to get your workspace humming.
      </p>
      <div className="mt-4 flex flex-col gap-1">
        {steps.map((s) => (
          <a
            key={s.label}
            href={s.href}
            className={cn(
              'flex items-start gap-3 rounded-field px-3 py-2.5 transition-colors duration-[120ms]',
              s.done ? 'opacity-60' : 'bg-muted hover:bg-recessed',
            )}
          >
            <span
              className={cn(
                'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full',
                s.done ? 'bg-brand text-on-brand' : 'bg-surface',
              )}
            >
              {s.done ? <Check size={12} /> : null}
            </span>
            <span className="min-w-0">
              <span className={cn('block text-sm font-medium', s.done && 'line-through')}>
                {s.label}
              </span>
              <span className="block text-xs text-ink-2">{s.detail}</span>
            </span>
          </a>
        ))}
      </div>
      <button
        type="button"
        onClick={() => {
          localStorage.setItem('src-hide-onboarding', '1');
          setHidden(true);
        }}
        className={buttonClass({ variant: 'ghost', size: 'xs', className: '-ml-2.5 mt-3' })}
      >
        <EyeOff size={12} /> Hide onboarding
      </button>
    </div>
  );
}
