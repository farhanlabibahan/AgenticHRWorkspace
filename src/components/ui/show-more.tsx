'use client';

import { Children, useState, type ReactNode } from 'react';
import { buttonClass } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * The first `limit` children, and a button to show the rest in place. The
 * children render on the server; only the toggle is client-side.
 */
export function ShowMore({
  limit,
  children,
  noun = 'more',
  className,
  buttonClassName,
}: {
  limit: number;
  children: ReactNode;
  /** "Show 3 more roles" */
  noun?: string;
  className?: string;
  buttonClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const items = Children.toArray(children);
  const hidden = items.length - limit;
  return (
    <>
      <div className={className}>{open || hidden <= 0 ? items : items.slice(0, limit)}</div>
      {hidden > 0 ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className={cn(buttonClass({ variant: 'ghost', size: 'xs' }), buttonClassName)}
        >
          {open ? 'Show less' : `Show ${hidden} ${noun}`}
        </button>
      ) : null}
    </>
  );
}
