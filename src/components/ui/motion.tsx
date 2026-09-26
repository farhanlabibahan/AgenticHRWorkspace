'use client';

import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

/**
 * Micro-interactions from the transitions.dev set (docs/09 §9), as small
 * React wrappers over the `t-*` rules in globals.css. Every one is a CSS
 * animation, so `prefers-reduced-motion` collapses them globally.
 */

type Vars = React.CSSProperties & Record<`--${string}`, string | number>;

/** True after the first commit — lets a wrapper skip its entrance on page load. */
function useMounted() {
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
  }, []);
  return mounted;
}

/**
 * Number pop-in: when the value changes, only the digits that changed
 * re-enter with a rise, staggered right to left like an odometer.
 */
export function NumberPop({
  value,
  format = (n) => n.toLocaleString('en-US'),
  animateOnMount = false,
  className,
}: {
  value: number;
  format?: (n: number) => string;
  animateOnMount?: boolean;
  className?: string;
}) {
  const text = format(value);
  const state = useRef<{ chars: string[]; keys: string[]; anim: boolean[]; gen: number } | null>(
    null,
  );
  const chars = [...text];

  if (!state.current) {
    state.current = {
      chars,
      keys: chars.map((c, i) => `${i}:${c}`),
      anim: chars.map(() => animateOnMount),
      gen: 0,
    };
  } else if (state.current.chars.join('') !== text) {
    // Compare right-aligned so 99 → 100 only re-enters the digits that moved.
    const prev = state.current;
    const gen = prev.gen + 1;
    const keys: string[] = [];
    const anim: boolean[] = [];
    chars.forEach((c, i) => {
      const j = prev.chars.length - (chars.length - i);
      if (j >= 0 && prev.chars[j] === c) {
        keys.push(prev.keys[j]);
        anim.push(prev.anim[j]);
      } else {
        keys.push(`${i}:${c}:${gen}`);
        anim.push(true);
      }
    });
    state.current = { chars, keys, anim, gen };
  }

  const { keys, anim } = state.current;
  let changed = 0;
  return (
    <span className={cn('inline-flex tabular-nums', className)} aria-label={text}>
      {chars.map((c, i) => {
        const stagger = anim[i] ? changed++ : 0;
        return (
          <span
            key={keys[i]}
            aria-hidden
            className={anim[i] ? 't-digit' : undefined}
            style={{ '--i': stagger } as Vars}
          >
            {c}
          </span>
        );
      })}
    </span>
  );
}

/** Text swap: a label changing in place (Save → Saving… → Saved) fades through. */
export function TextSwap({ children, className }: { children: string; className?: string }) {
  const mounted = useMounted();
  return (
    <span key={children} className={cn(mounted.current && 't-swap', className)}>
      {children}
    </span>
  );
}

/** Icon swap: two icons share one slot; `on` shows the second. */
export function IconSwap({ on, from, to }: { on: boolean; from: React.ReactNode; to: React.ReactNode }) {
  return (
    <span className="t-icon-swap" aria-hidden>
      <span data-hidden={on}>{from}</span>
      <span data-hidden={!on}>{to}</span>
    </span>
  );
}

/** Shimmer: a highlight band sweeps in-progress text. */
export function Shimmer({ children, className }: { children: string; className?: string }) {
  return (
    <span className={cn('t-shimmer', className)} data-text={children}>
      {children}
    </span>
  );
}

/**
 * Thinking states: a shimmering status line that cycles through what the
 * agent is doing, each swap fading the old line out and the new one in.
 */
export function ThinkingStates({
  lines,
  interval = 2000,
  className,
}: {
  lines: string[];
  interval?: number;
  className?: string;
}) {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (lines.length < 2) return;
    const id = setInterval(() => setI((n) => (n + 1) % lines.length), interval);
    return () => clearInterval(id);
  }, [lines.length, interval]);
  const line = lines[i] ?? '';
  return (
    <span role="status" aria-live="polite" className={className}>
      <span key={line} className="t-swap">
        <Shimmer>{line}</Shimmer>
      </span>
    </span>
  );
}

/**
 * Streaming text: words fade in, left to right. The
 * stagger is capped so a long answer finishes arriving in under two seconds.
 */
export function StreamingText({ text, className }: { text: string; className?: string }) {
  const words = text.split(/(\s+)/);
  let w = 0;
  return (
    <p key={text} className={className}>
      {words.map((part, i) =>
        /^\s+$/.test(part) ? (
          part
        ) : (
          <span key={i} className="t-stream-w" style={{ '--i': Math.min(w++, 60) * 0.4 } as Vars}>
            {part}
          </span>
        ),
      )}
    </p>
  );
}

/** Texts reveal: stacked lines rise in with a 40ms stagger; pass each line's index. */
export function Rise({
  i = 0,
  as: Tag = 'div',
  className,
  children,
}: {
  i?: number;
  as?: 'div' | 'p' | 'h1' | 'h2' | 'h3' | 'span';
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Tag className={cn('t-rise', className)} style={{ '--i': i } as Vars}>
      {children}
    </Tag>
  );
}

/** Success check: rotates up into place, then the stroke draws on. */
export function SuccessCheck({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <span
      className={cn('t-success inline-flex items-center justify-center rounded-full bg-ink text-canvas', className)}
      style={{ width: size, height: size }}
      aria-hidden
    >
      <svg viewBox="0 0 16 16" width={size * 0.6} height={size * 0.6} fill="none">
        <path
          className="t-check-path"
          d="M3.5 8.5l3 3 6-7"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

/**
 * Error shake: call `shake()` when a submit is rejected. Returns a ref for
 * the element to shake (usually the form's field group).
 */
export function useShake<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T>(null);
  const shake = () => {
    const el = ref.current;
    if (!el) return;
    el.classList.remove('t-shake');
    void el.offsetWidth; // restart the animation if it's mid-flight
    el.classList.add('t-shake');
  };
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const done = () => el.classList.remove('t-shake');
    el.addEventListener('animationend', done);
    return () => el.removeEventListener('animationend', done);
  }, []);
  return [ref, shake] as const;
}

/** Accordion body: height grows from 0 while it fades in. Parent sets data-open. */
export function Collapse({ open, children }: { open: boolean; children: React.ReactNode }) {
  return (
    <div data-open={open}>
      <div className="t-acc-panel" inert={!open}>
        <div>{children}</div>
      </div>
    </div>
  );
}
