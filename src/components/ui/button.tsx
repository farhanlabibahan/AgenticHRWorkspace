import { forwardRef } from 'react';
import { cn } from '@/lib/utils';

/**
 * Pill buttons (docs/09-design-system.md §5–6). Height tiers are shared with
 * fields and chips so toolbars line up: xs 24 · sm 32 · md 36 · lg 44.
 * One `primary` (ink, or the brand color on branded pages) per view;
 * everything else is secondary/tonal/ghost.
 */

export type ButtonVariant = 'primary' | 'secondary' | 'tonal' | 'ghost' | 'critical';
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg';

const base =
  'inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-full font-medium transition-[background-color,color,box-shadow,transform,scale] duration-[120ms] ease-[var(--ease-standard)] active:scale-[0.98] outline-none focus-visible:ring-2 focus-visible:ring-line-strong focus-visible:ring-offset-2 focus-visible:ring-offset-canvas disabled:pointer-events-none disabled:opacity-40 [&_svg]:shrink-0';

const variants: Record<ButtonVariant, string> = {
  primary: 'bg-brand text-on-brand hover:bg-brand/85',
  secondary: 'bg-surface text-ink hover:bg-muted',
  tonal: 'bg-muted text-ink hover:bg-recessed',
  ghost: 'text-ink-2 hover:bg-ink/[0.05] hover:text-ink',
  critical: 'bg-critical text-white hover:bg-critical/90',
};

const sizes: Record<ButtonSize, string> = {
  xs: 'h-6 px-2.5 text-xs [&_svg]:size-3',
  sm: 'h-8 px-3 text-sm [&_svg]:size-3.5',
  md: 'h-9 px-4 text-sm [&_svg]:size-4',
  lg: 'h-11 px-5 text-base [&_svg]:size-4',
};

const iconSizes: Record<ButtonSize, string> = {
  xs: 'size-6 [&_svg]:size-3',
  sm: 'size-8 [&_svg]:size-3.5',
  md: 'size-9 [&_svg]:size-4',
  lg: 'size-11 [&_svg]:size-4',
};

/** Class string for anything that should look like a button (Links, labels). */
export function buttonClass({
  variant = 'secondary',
  size = 'md',
  icon = false,
  className,
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Icon-only circle, same height as the text tier. */
  icon?: boolean;
  className?: string;
} = {}) {
  return cn(base, variants[variant], icon ? iconSizes[size] : sizes[size], className);
}

export const Button = forwardRef<
  HTMLButtonElement,
  React.ComponentProps<'button'> & { variant?: ButtonVariant; size?: ButtonSize; icon?: boolean }
>(function Button({ variant, size, icon, className, type = 'button', ...props }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      className={buttonClass({ variant, size, icon, className })}
      {...props}
    />
  );
});
