import { forwardRef } from 'react';
import { cn } from '@/lib/utils';

/**
 * Checkbox with a drawn check (transitions.dev "checkbox check"). A real
 * <input type="checkbox"> stays underneath — forms, labels, keyboard and
 * screen readers work unchanged — and the visual box reads its :checked
 * state through `peer`. Pass any input props straight through. Without a
 * `label` it renders a span, so it can sit inside an existing <label>.
 */
export const Checkbox = forwardRef<
  HTMLInputElement,
  Omit<React.ComponentProps<'input'>, 'type'> & { label?: React.ReactNode }
>(function Checkbox({ className, label, ...props }, ref) {
  const Wrapper = label ? 'label' : 'span';
  return (
    <Wrapper
      className={cn(
        'relative inline-flex shrink-0 cursor-pointer items-center gap-2 has-[:disabled]:cursor-default has-[:disabled]:opacity-40',
        className,
      )}
    >
      <input ref={ref} type="checkbox" className="peer absolute size-4 opacity-0" {...props} />
      <span
        aria-hidden
        className="flex size-4 items-center justify-center rounded-box bg-surface text-canvas shadow-[inset_0_0_0_1px_var(--color-line-strong)] transition-[background-color,box-shadow] duration-[var(--duration-quick)] ease-[var(--ease-smooth)] peer-checked:bg-ink peer-checked:shadow-none peer-focus-visible:ring-2 peer-focus-visible:ring-line-strong peer-focus-visible:ring-offset-2"
      >
        <svg viewBox="0 0 16 16" className="size-3" fill="none">
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
      {label ? <span className="text-sm text-ink">{label}</span> : null}
    </Wrapper>
  );
});
