'use client';

import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** One sweep of the band across the layout; matches t-skel-sweep in globals.css. */
const SWEEP_MS = 1800;
/** How much later the band reaches a shape per pixel down: a slight diagonal. */
const SLANT = 0.35;

/** A gray shape the skeleton's light band sweeps across (`.skel` in globals.css). */
export function Skel({ className }: { className?: string }) {
  return <div className={cn('skel', className)} />;
}

/**
 * Wraps a skeleton. The sweep runs in step with the clock, not from the
 * skeleton's own mount, so two copies show the same frame (the drawer's
 * placeholder and the drawer that replaces it), and it is one band crossing
 * the whole layout at a constant speed, slightly diagonal: each shape lights
 * up only while the band passes over it. The skeleton fades off toward the
 * bottom instead of stopping partway down the page.
 */
export function SkeletonWave({ className, children }: { className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    root.style.setProperty('--skel-delay', `-${Math.round(performance.now() % SWEEP_MS)}ms`);
    const origin = root.getBoundingClientRect();
    root.style.setProperty('--skel-span', String(Math.round(origin.width + SLANT * origin.height)));
    root.querySelectorAll<HTMLElement>('.skel').forEach((el) => {
      const r = el.getBoundingClientRect();
      el.style.setProperty('--skel-x', String(Math.round(r.left - origin.left + SLANT * (r.top - origin.top))));
    });
  }, []);
  return (
    <div ref={ref} aria-hidden data-skel className={cn('skel-fade', className)}>
      {children}
    </div>
  );
}
