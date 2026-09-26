'use client';

import { ChevronDown } from 'lucide-react';
import { selectClass } from '@/components/form-controls';
import { cn } from '@/lib/utils';

/** A loading label that keeps the button's width (docs/09 §6). */
export function BusyLabel({ busy, children }: { busy: boolean; children: React.ReactNode }) {
  return (
    <span className="grid">
      <span className={cn('col-start-1 row-start-1', busy && 'invisible')}>{children}</span>
      <span aria-hidden={!busy} className={cn('col-start-1 row-start-1', !busy && 'invisible')}>
        Working…
      </span>
    </span>
  );
}

/**
 * Native select in the field style, with the app's chevron instead of the
 * platform arrow. Native because the stage mapping needs <optgroup>s.
 */
export function NativeSelect({
  value,
  onChange,
  children,
  className,
  ...rest
}: Omit<React.ComponentProps<'select'>, 'onChange' | 'value'> & { value: string; onChange: (value: string) => void }) {
  return (
    <div className={cn('relative', className)}>
      <select
        {...rest}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(selectClass, 'appearance-none truncate pr-8 dark:[color-scheme:dark]')}
      >
        {children}
      </select>
      <ChevronDown
        size={14}
        aria-hidden
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-2"
      />
    </div>
  );
}
