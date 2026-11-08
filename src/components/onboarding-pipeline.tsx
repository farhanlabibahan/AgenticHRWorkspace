'use client';

import { useState } from 'react';
import { completeOnboardingAction } from '@/app/org-actions';
import { btnPrimary, surface } from '@/components/form-controls';
import { SiteIcon } from '@/components/site-icon';
import { StageManager } from '@/components/stage-manager';
import { Segmented } from '@/components/ui/primitives';
import { IMPORT_PROVIDERS } from '@/lib/import-providers';
import { cn } from '@/lib/utils';

type From = 'here' | 'import';

/**
 * Onboarding step 3 and the finish button. A team starting fresh shapes the
 * starter pipeline here; a team coming from another ATS picks it, and
 * finishing lands on that provider's import form. Its stages come across
 * there, mapped one by one, before any candidates do.
 */
export function OnboardingPipeline({ stages }: { stages: React.ComponentProps<typeof StageManager>['stages'] }) {
  const [from, setFrom] = useState<From>('here');
  const [provider, setProvider] = useState(IMPORT_PROVIDERS[0].id);
  const meta = IMPORT_PROVIDERS.find((p) => p.id === provider) ?? IMPORT_PROVIDERS[0];
  const importing = from === 'import';

  return (
    <>
      <section className={`${surface} p-5`}>
        <h2 className="mb-1 text-md font-medium">3 · Your hiring pipeline</h2>
        <p className="mb-4 text-sm text-ink-2">Start from Orqestra&apos;s stages, or bring the ones you use today.</p>
        <Segmented<From>
          value={from}
          onChange={setFrom}
          items={[
            { value: 'here', label: 'Set it up here' },
            { value: 'import', label: 'Import from another ATS' },
          ]}
        />

        {importing ? (
          <div className="mt-5">
            <div role="radiogroup" aria-label="Your current ATS" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {IMPORT_PROVIDERS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  aria-checked={p.id === provider}
                  onClick={() => setProvider(p.id)}
                  className={cn(
                    'flex items-center gap-2 rounded-card bg-surface px-3 py-2.5 text-left text-sm text-ink outline-none transition-shadow duration-150 focus-visible:ring-2 focus-visible:ring-line-strong',
                    p.id === provider ? 'ring-2 ring-ink' : 'ring-1 ring-line hover:shadow-lift',
                  )}
                >
                  <SiteIcon url={p.domain} size={16} />
                  {p.name}
                </button>
              ))}
            </div>
            <p className="mt-4 text-sm text-ink-2">
              Your stages will come from {meta.name}. You&apos;ll choose where each one lands, and whether it
              replaces Orqestra&apos;s starter stages, before any candidates come over.
            </p>
          </div>
        ) : (
          <div className="mt-5">
            <p className="mb-4 text-sm text-ink-2">
              Rename, reorder, add, or remove stages to match how you actually interview.
            </p>
            <StageManager stages={stages} />
          </div>
        )}
      </section>

      <form action={completeOnboardingAction} className="flex justify-end pb-10 pt-4">
        {importing ? <input type="hidden" name="provider" value={meta.id} /> : null}
        <button type="submit" className={btnPrimary}>
          {importing ? `Finish setup and connect ${meta.name}` : 'Finish setup'}{' '}
          <span className="t-learn-arrow">→</span>
        </button>
      </form>
    </>
  );
}
