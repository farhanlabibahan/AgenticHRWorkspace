'use client';

import { useState, useTransition } from 'react';
import { ArrowUpRight, Plus, X } from 'lucide-react';
import { addCaseStudyAction, removeCaseStudyAction } from '@/app/(app)/actions';
import { inputClass, noAutofill } from '@/components/form-controls';
import { buttonClass } from '@/components/ui/button';
import { SectionHeader } from '@/components/ui/primitives';
import { ThinkingStates } from '@/components/ui/motion';
import { WorkThumb } from '@/components/work-thumb';
import { cn } from '@/lib/utils';

export type CaseStudyItem = { id: string; url: string; title: string; imageUrl: string | null };

const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

/**
 * Links to the candidate's work (portfolio case studies, repositories,
 * write-ups), shown as thumbnails on their presentation. Paste a link and
 * the page's own title and image fill in.
 */
export function CaseStudiesSection({
  opportunityId,
  contactId,
  studies,
}: {
  opportunityId: string;
  contactId: string;
  studies: CaseStudyItem[];
}) {
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <section>
      <SectionHeader
        title="Case studies"
        action={
          !adding ? (
            <button type="button" onClick={() => setAdding(true)} className={buttonClass({ variant: 'ghost', size: 'sm', className: '-my-1.5' })}>
              <Plus /> Add
            </button>
          ) : null
        }
      />
      {adding ? (
        pending ? (
          <p className="mb-3 rounded-card bg-surface px-4 py-3 text-sm">
            <ThinkingStates lines={['Opening the page…', 'Reading its title…', 'Finding its image…']} />
          </p>
        ) : (
          <form
            className="mb-3 flex flex-col gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              const url = String(new FormData(e.currentTarget).get('url') ?? '');
              start(async () => {
                const result = await addCaseStudyAction(opportunityId, contactId, url);
                if (result.error) setError(result.error);
                else {
                  setError(null);
                  setAdding(false);
                }
              });
            }}
          >
            <div className="flex gap-1.5">
              <input
                {...noAutofill}
                name="url"
                autoFocus
                required
                inputMode="url"
                placeholder="Link to a case study"
                aria-label="Case study link"
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setAdding(false);
                    setError(null);
                  }
                }}
                className={cn(inputClass, 'h-9 min-w-0 flex-1 text-sm')}
              />
              <button type="submit" className={buttonClass({ variant: 'tonal', size: 'md' })}>
                Add
              </button>
            </div>
            {error ? <p className="px-1 text-xs text-critical">{error}</p> : null}
          </form>
        )
      ) : null}
      {studies.length ? (
        <ul className="grid grid-cols-2 gap-2">
          {studies.map((s) => (
            <li key={s.id} className="group relative">
              <a href={s.url} target="_blank" rel="noopener noreferrer" className="block rounded-card bg-surface p-1.5 transition-colors duration-[120ms] hover:bg-muted/60">
                <WorkThumb imageUrl={s.imageUrl} seed={s.id} orb={112} />
                <p className="mt-2 line-clamp-2 px-1 text-xs font-medium text-ink">{s.title}</p>
                <p className="flex items-center gap-1 px-1 pb-1 text-2xs text-ink-3">
                  {host(s.url)} <ArrowUpRight className="size-3" />
                </p>
              </a>
              <button
                type="button"
                aria-label={`Remove ${s.title}`}
                onClick={() => start(() => removeCaseStudyAction(opportunityId, s.id).then(() => undefined))}
                className={buttonClass({
                  variant: 'secondary',
                  size: 'xs',
                  icon: true,
                  className: 'absolute right-3 top-3 shadow-float [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 focus-visible:opacity-100',
                })}
              >
                <X />
              </button>
            </li>
          ))}
        </ul>
      ) : !adding ? (
        <p className="text-sm text-ink-2">Links to their work, shown as thumbnails on their presentation.</p>
      ) : null}
    </section>
  );
}
