'use client';

import { useRef } from 'react';
import { cn } from '@/lib/utils';

/**
 * Switch: a recessed pill track that fills with ink when on, white thumb.
 * The thumb overshoots by a pixel and settles (transitions.dev "toggle"),
 * but only after a real change, so a page load never plays it.
 * Pair with a quiet status label where the state needs naming.
 */
export function Switch({
  checked,
  onChange,
  disabled = false,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Accessible name for the switch. */
  label: string;
}) {
  const interacted = useRef(false);
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => {
        interacted.current = true;
        onChange(!checked);
      }}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors duration-[var(--duration-quick)] ease-[var(--ease-smooth)] outline-none focus-visible:ring-2 focus-visible:ring-line-strong focus-visible:ring-offset-2 disabled:cursor-default disabled:opacity-40',
        checked ? 'bg-brand' : 'bg-recessed',
      )}
      style={{ '--toggle-travel': '16px' } as React.CSSProperties}
    >
      <span
        className="absolute left-[2px] size-4 rounded-full bg-white shadow-[0_1px_2px_rgb(0_0_0/0.15)]"
        style={{
          translate: checked ? 'var(--toggle-travel) 0' : '0 0',
          animation: interacted.current
            ? `${checked ? 't-toggle-on' : 't-toggle-off'} 350ms cubic-bezier(0.34, 1.35, 0.64, 1) both`
            : undefined,
        }}
      />
    </button>
  );
}
