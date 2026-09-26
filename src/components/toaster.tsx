'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { StatusDot } from '@/components/ui/primitives';
import { buttonClass } from '@/components/ui/button';

type Tone = 'error' | 'info';
type Toast = { id: number; message: string; tone: Tone };

const EVENT = 'source:toast';
const INFO_MS = 6000;
let seq = 0;

/** Show a short message from any client component. */
export function toast(message: string, tone: Tone = 'info') {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<Toast>(EVENT, { detail: { id: ++seq, message, tone } }));
}

/**
 * Bottom-center stack of short messages. Mounted once in the app layout;
 * anything calls toast().
 *
 * Both live regions are always in the DOM, so screen readers are already
 * watching them when a message is added: errors go to the assertive one,
 * everything else to the polite one. Errors stay until dismissed; info
 * messages leave after a few seconds, but not while hovered or focused.
 * The stack sits above every overlay (menus z-200, the candidate drawer
 * z-300), so a failed edit made in the drawer still shows its message.
 */
export function Toaster() {
  const [items, setItems] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setItems((prev) => prev.filter((t) => t.id !== id)), []);

  useEffect(() => {
    const onToast = (event: Event) => {
      const next = (event as CustomEvent<Toast>).detail;
      setItems((prev) => [...prev.slice(-2), next]);
    };
    window.addEventListener(EVENT, onToast);
    return () => window.removeEventListener(EVENT, onToast);
  }, []);

  const errors = items.filter((t) => t.tone === 'error');
  const infos = items.filter((t) => t.tone !== 'error');

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-24 z-[400] flex flex-col items-center gap-2 px-4 md:bottom-6">
      <div role="alert" aria-live="assertive" aria-atomic="false" className="flex flex-col items-center gap-2">
        {errors.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={dismiss} />
        ))}
      </div>
      <div role="status" aria-live="polite" aria-atomic="false" className="flex flex-col items-center gap-2">
        {infos.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={dismiss} />
        ))}
      </div>
    </div>
  );
}

function ToastItem({ toast: t, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  const [paused, setPaused] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const remaining = useRef(INFO_MS);

  // Play the exit (150ms) before the item leaves the list.
  const close = useCallback(() => {
    setLeaving(true);
    window.setTimeout(() => onDismiss(t.id), 150);
  }, [onDismiss, t.id]);

  // Info messages time out; the clock stops while the pointer or focus is on them.
  useEffect(() => {
    if (t.tone === 'error' || paused) return;
    const started = Date.now();
    const id = window.setTimeout(close, remaining.current);
    return () => {
      window.clearTimeout(id);
      remaining.current = Math.max(1000, remaining.current - (Date.now() - started));
    };
  }, [t, paused, close]);

  return (
    <div
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setPaused(false);
      }}
      data-leaving={leaving || undefined}
      className="t-toast pointer-events-auto flex max-w-md items-center gap-2 rounded-card bg-surface py-1.5 pl-4 pr-1.5 text-sm text-ink shadow-float"
    >
      <StatusDot tone={t.tone === 'error' ? 'critical' : 'neutral'} />
      <span className="py-1">{t.message}</span>
      <button
        type="button"
        onClick={close}
        aria-label="Dismiss"
        className={buttonClass({ variant: 'ghost', size: 'sm', icon: true, className: 'shrink-0' })}
      >
        <X />
      </button>
    </div>
  );
}
