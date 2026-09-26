import { cn } from '@/lib/utils';

/**
 * Specimen chrome for the design-system docs: frames and labels drawn in the
 * system itself, and `sb-unstyled` so Storybook's docs typography never
 * restyles what's being documented.
 */

export function Specimen({
  children,
  className,
  ground = 'canvas',
}: {
  children: React.ReactNode;
  className?: string;
  ground?: 'canvas' | 'surface' | 'sheet';
}) {
  const bg = ground === 'surface' ? 'bg-surface' : ground === 'sheet' ? 'bg-sheet' : 'bg-canvas';
  return (
    <div className={cn('sb-unstyled my-6 rounded-card p-6 font-sans text-ink', bg, className)}>
      {children}
    </div>
  );
}

/** A labeled row: the spec on the left, the thing on the right. */
export function Row({ label, spec, children }: { label: string; spec?: string; children: React.ReactNode }) {
  return (
    <div className="grid items-center gap-4 border-b border-line py-4 last:border-0 md:grid-cols-[180px_1fr]">
      <div>
        <p className="text-sm font-medium text-ink">{label}</p>
        {spec ? <p className="font-mono text-xs text-ink-2">{spec}</p> : null}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}

/** A color token: swatch, name, value, and what it's for. */
export function Swatch({ token, value, use }: { token: string; value: string; use: string }) {
  return (
    <div>
      <div
        className="h-20 rounded-card shadow-[inset_0_0_0_1px_var(--color-line)]"
        style={{ background: `var(--color-${token})` }}
      />
      <p className="mt-2 text-sm font-medium text-ink">{token}</p>
      <p className="font-mono text-xs text-ink-2">{value}</p>
      <p className="mt-1 text-xs text-ink-2">{use}</p>
    </div>
  );
}

export function Grid({ children, min = 160 }: { children: React.ReactNode; min?: number }) {
  return (
    <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${min}px, 1fr))` }}>
      {children}
    </div>
  );
}
