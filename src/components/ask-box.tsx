'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import * as Dialog from '@radix-ui/react-dialog';
import { ArrowRight, ArrowUp, Search } from 'lucide-react';
import { askCorpusAction } from '@/app/(app)/actions';
import type { CorpusAnswer } from '@/server/ai';
import { CorpusAnswerView } from '@/components/ask-corpus';
import { noAutofill } from '@/components/form-controls';
import { buttonClass } from '@/components/ui/button';
import { ThinkingStates } from '@/components/ui/motion';
import { Bot } from '@/components/ui/bot';
import { cn } from '@/lib/utils';

/**
 * The sidebar's Search, as a prompt box: opens over any page (⌘K too).
 * With AI on, a question is answered from every transcript, resume and note,
 * with the candidates it came from; a "Search for …" row runs the keyword
 * search on /search. With AI off it's the keyword search alone.
 */

const SUGGESTIONS = [
  'Who has led a design system migration?',
  'Which candidates mentioned remote work in interviews?',
  'Who has hiring-manager experience at a startup?',
];

const THINKING = [
  'Reading interview transcripts…',
  'Searching resumes and notes…',
  'Weighing the evidence…',
  'Citing candidates…',
];

export function AskBox({
  open,
  onOpenChange,
  aiEnabled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  aiEnabled: boolean;
}) {
  const router = useRouter();
  const [question, setQuestion] = useState('');
  const [result, setResult] = useState<CorpusAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const field = useRef<HTMLTextAreaElement>(null);
  const q = question.trim();

  // The prompt grows with what's typed, up to a few lines.
  useEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [question, open]);

  const close = () => onOpenChange(false);

  const search = (text = q) => {
    if (!text) return;
    close();
    router.push(`/search?q=${encodeURIComponent(text)}`);
  };

  const ask = (text = q) => {
    if (!text) return;
    if (!aiEnabled) return search(text);
    setQuestion(text);
    startTransition(async () => {
      const res = await askCorpusAction(text);
      if ('error' in res) {
        setError(res.error);
        setResult(null);
      } else {
        setResult(res);
        setError(null);
      }
    });
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay fixed inset-0 z-[310] bg-ink/15" />
        <Dialog.Content
          aria-describedby={undefined}
          className="dialog-animate fixed inset-x-0 top-[12vh] z-[311] mx-auto flex max-h-[76vh] w-[min(44rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-dialog bg-surface shadow-float"
        >
          <Dialog.Title className="sr-only">{aiEnabled ? 'Ask' : 'Search'}</Dialog.Title>

          <form
            className="flex items-start gap-3 p-4"
            onSubmit={(e) => {
              e.preventDefault();
              ask();
            }}
          >
            <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center">
              {aiEnabled ? (
                <Bot state={pending ? 'working' : 'idle'} size={28} />
              ) : (
                <Search size={18} className="text-ink-3" />
              )}
            </span>
            <textarea
              {...noAutofill}
              ref={field}
              autoFocus
              rows={1}
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  ask();
                }
              }}
              placeholder={
                aiEnabled
                  ? 'Ask about your candidates, or search for anyone…'
                  : 'Search candidates, resumes, notes and postings…'
              }
              aria-label={aiEnabled ? 'Ask a question' : 'Search'}
              className="min-h-8 flex-1 resize-none bg-transparent py-1 text-md leading-6 text-ink outline-none placeholder:text-ink-3"
            />
            <button
              type="submit"
              disabled={!q || pending}
              aria-label={aiEnabled ? 'Ask' : 'Search'}
              className={buttonClass({ variant: 'primary', size: 'md', icon: true, className: 'shrink-0' })}
            >
              <ArrowUp />
            </button>
          </form>

          <div className="min-h-0 flex-1 overflow-y-auto border-t border-line">
            {/* keyword search is always one row away */}
            {q ? (
              <button
                type="button"
                onClick={() => search()}
                className="flex w-full items-center gap-3 px-5 py-3 text-left text-sm text-ink transition-colors duration-[120ms] hover:bg-muted"
              >
                <Search size={16} className="shrink-0 text-ink-3" />
                <span className="min-w-0 flex-1 truncate">
                  Search for <span className="font-medium">“{q}”</span>
                </span>
                <span className="text-xs text-ink-3">Names, resumes, notes, postings</span>
                <ArrowRight size={14} className="shrink-0 text-ink-3" />
              </button>
            ) : null}

            {error ? <p className="px-5 py-3 text-sm text-critical">{error}</p> : null}

            {pending ? (
              <div className="animate-fade-rise px-5 py-4 text-sm">
                <ThinkingStates lines={THINKING} />
              </div>
            ) : result ? (
              <div className="animate-fade-rise px-5 py-4">
                <CorpusAnswerView result={result} onOpenSource={close} />
              </div>
            ) : aiEnabled && !q ? (
              <div className="px-5 py-4">
                <p className="mb-2 text-xs text-ink-2">Try asking</p>
                <div className="flex flex-col items-start gap-1">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => ask(s)}
                      className="rounded-field px-2 py-1.5 -mx-2 text-left text-sm text-ink-2 transition-colors duration-[120ms] hover:bg-muted hover:text-ink"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>

          <p
            className={cn(
              'border-t border-line px-5 py-2.5 text-2xs text-ink-3',
              !aiEnabled && !q && 'border-t-0',
            )}
          >
            {aiEnabled ? 'Enter to ask · Shift+Enter for a new line · Esc to close' : 'Enter to search · Esc to close'}
          </p>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
