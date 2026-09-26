'use client';

import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { unstable_rethrow } from 'next/navigation';
import { ArrowUpRight, Link2, Presentation, RotateCcw, X } from 'lucide-react';
import { createShareLinkAction } from '@/app/(app)/actions';
import { btnGhost, inputClass, noAutofill } from '@/components/form-controls';
import { buttonClass } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { Rise, SuccessCheck, ThinkingStates } from '@/components/ui/motion';
import { Avatar, Orb } from '@/components/ui/orb';
import { cn } from '@/lib/utils';

type Scope = 'posting' | 'client' | 'candidate';

type State =
  | { kind: 'idle' }
  | { kind: 'working' }
  | { kind: 'ready'; url: string; expiresAt: string | null }
  | { kind: 'error' };

/**
 * The shortest the build-up plays. Making the link takes a few hundred ms,
 * and a preview that flashes past reads as a glitch rather than a step.
 * Skipped under reduced motion, where the build-up doesn't animate anyway.
 */
const MIN_WORKING_MS = 1200;

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

const COPY: Record<
  Scope,
  { working: (name: string) => string[]; ready: string; open: string; note: (name: string) => string }
> = {
  candidate: {
    working: (name) => [
      `Gathering ${firstName(name)}'s profile…`,
      'Leaving out notes and scorecards…',
      'Making the link…',
    ],
    ready: 'Presentation ready',
    open: 'Open presentation',
    note: (name) =>
      `A one-pager on ${firstName(name)}: background, links, and contact details. Notes, scorecards, and pay stay private.`,
  },
  posting: {
    working: () => ['Counting candidates by stage…', 'Leaving out notes and scorecards…', 'Making the link…'],
    ready: 'Share link ready',
    open: 'Open share page',
    note: () =>
      'Hiring progress for this role: each candidate and their stage. Notes, scorecards, and pay stay private.',
  },
  client: {
    working: () => ['Counting candidates by stage…', 'Leaving out notes and scorecards…', 'Making the link…'],
    ready: 'Share link ready',
    open: 'Open share page',
    note: (name) =>
      `Hiring progress across ${name}'s roles: each candidate and their stage. Notes, scorecards, and pay stay private.`,
  },
};

/**
 * Makes a read-only public link: a candidate presentation, or hiring
 * progress for a posting or client company. The dialog shows a miniature
 * of the page building while the link is made, then the short link with
 * Open and Copy. The link is made once per mount; reopening shows it again.
 */
export function ShareLinkButton({
  scope,
  id,
  label = 'Client share link',
  subject,
}: {
  scope: Scope;
  id: string;
  label?: string;
  /** What's being shared, for the preview: a candidate, a role, or a client. */
  subject: { name: string; detail?: string | null; seed?: string };
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<State>({ kind: 'idle' });
  const copy = COPY[scope];

  async function generate() {
    setState({ kind: 'working' });
    const started = performance.now();
    let result: Awaited<ReturnType<typeof createShareLinkAction>> | null = null;
    try {
      result = await createShareLinkAction(scope, id);
    } catch (error) {
      unstable_rethrow(error);
      console.error(error);
    }
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const hold = reduced ? 0 : MIN_WORKING_MS - (performance.now() - started);
    if (hold > 0) await new Promise((resolve) => setTimeout(resolve, hold));
    setState(
      result?.url
        ? { kind: 'ready', url: result.url, expiresAt: result.expiresAt ?? null }
        : { kind: 'error' },
    );
  }

  const working = state.kind === 'idle' || state.kind === 'working';

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next && (state.kind === 'idle' || state.kind === 'error')) void generate();
      }}
    >
      <Dialog.Trigger asChild>
        <button type="button" className={btnGhost}>
          {scope === 'candidate' ? <Presentation /> : <Link2 />} {label}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay fixed inset-0 z-[300] bg-ink/10" />
        <Dialog.Content className="dialog-animate fixed left-1/2 top-[max(16px,16vh)] z-[300] w-[min(420px,calc(100vw-32px))] -translate-x-1/2 rounded-dialog bg-surface p-6 shadow-float outline-none">
          <Dialog.Close
            aria-label="Close"
            className={buttonClass({ variant: 'ghost', size: 'sm', icon: true, className: 'absolute right-3 top-3' })}
          >
            <X />
          </Dialog.Close>

          {/* A miniature of the page being shared: it builds while the link is
              made and settles with a check once it's ready. */}
          <div aria-hidden className="relative mx-auto mt-2 w-[232px] rounded-card bg-canvas p-4">
            <div className="flex items-center gap-3">
              <Rise i={0}>
                {scope === 'candidate' ? (
                  <Avatar name={subject.name} seed={subject.seed} size={36} />
                ) : (
                  <Orb seed={subject.seed ?? id} size={36} />
                )}
              </Rise>
              <div className="min-w-0">
                <Rise i={1} as="p" className="truncate text-sm font-medium text-ink">
                  {subject.name}
                </Rise>
                {subject.detail ? (
                  <Rise i={2} as="p" className="truncate text-xs text-ink-2">
                    {subject.detail}
                  </Rise>
                ) : null}
              </div>
            </div>
            <div className="mt-4 flex flex-col gap-2">
              {[100, 86, 94, 58].map((width, i) => (
                <span
                  key={i}
                  data-working={working || undefined}
                  className="share-bar h-1.5 rounded-full bg-recessed"
                  style={{ width: `${width}%`, '--i': i + 3 } as React.CSSProperties}
                />
              ))}
            </div>
            {state.kind === 'ready' ? (
              <SuccessCheck size={24} className="absolute -right-2.5 -top-2.5 ring-4 ring-surface" />
            ) : null}
          </div>

          <div className="mt-6">
            {working ? (
              <>
                <Dialog.Title className="sr-only">Making the link</Dialog.Title>
                <Dialog.Description className="sr-only">{copy.note(subject.name)}</Dialog.Description>
                <ThinkingStates
                  lines={copy.working(subject.name)}
                  interval={650}
                  className="block text-center text-sm text-ink-2"
                />
              </>
            ) : state.kind === 'ready' ? (
              <>
                <Rise>
                  <Dialog.Title className="text-md font-medium text-ink">{copy.ready}</Dialog.Title>
                </Rise>
                <Rise i={1}>
                  <Dialog.Description className="mt-1 text-sm text-ink-2">
                    {copy.note(subject.name)}
                  </Dialog.Description>
                </Rise>
                <Rise i={2} className="mt-4">
                  <input {...noAutofill}
                    readOnly
                    aria-label="Link"
                    value={state.url.replace(/^https?:\/\//, '')}
                    onFocus={(e) => e.currentTarget.select()}
                    className={cn(inputClass, 'w-full text-ink-2')}
                  />
                  {state.expiresAt ? (
                    <p className="mt-1.5 text-xs text-ink-3">
                      Anyone with the link can view it until{' '}
                      {new Date(state.expiresAt).toLocaleDateString(undefined, {
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric',
                      })}
                      .
                    </p>
                  ) : null}
                </Rise>
                <Rise i={3} className="mt-5 flex flex-wrap justify-end gap-2">
                  <CopyButton text={state.url} label="Copy link" variant="tonal" size="md" />
                  <a
                    href={state.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={buttonClass({ variant: 'primary', size: 'md' })}
                  >
                    {copy.open} <ArrowUpRight />
                  </a>
                </Rise>
              </>
            ) : (
              <>
                <Dialog.Title className="text-md font-medium text-ink">Couldn&apos;t make the link</Dialog.Title>
                <Dialog.Description className="mt-1 text-sm text-ink-2">
                  Nothing was shared. Try again in a moment.
                </Dialog.Description>
                <div className="mt-5 flex justify-end">
                  <button type="button" onClick={generate} className={buttonClass({ variant: 'tonal' })}>
                    <RotateCcw /> Try again
                  </button>
                </div>
              </>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
