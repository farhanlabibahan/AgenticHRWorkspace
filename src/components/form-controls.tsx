import { buttonClass } from '@/components/ui/button';

/**
 * Shared UI class vocabulary — the calm system (docs/09-design-system.md).
 * Shape encodes behavior: pills are pressed, soft rectangles are typed into,
 * rounded rectangles contain. Depth is value, not lines: fields sit recessed
 * below the canvas, surfaces sit raised above it, neither has a border.
 * Controls share height tiers (sm 32 · md 36 · lg 44) so toolbars align.
 */

const field =
  'w-full rounded-field bg-recessed text-sm text-ink outline-none transition-[background-color,box-shadow] duration-[120ms] placeholder:text-ink-3 hover:bg-[color-mix(in_oklab,var(--color-recessed),var(--color-ink)_3%)] focus:is-focused disabled:opacity-40';

export const inputClass = `${field} h-9 px-3`;

/**
 * The field look on a wrapper, for an input with controls inside it (a
 * delete button, a status): the input inside is `fieldBareInput`.
 */
export const fieldShellClass =
  'flex h-9 w-full items-center gap-1 rounded-field bg-recessed text-sm text-ink transition-[background-color,box-shadow] duration-[120ms] hover:bg-[color-mix(in_oklab,var(--color-recessed),var(--color-ink)_3%)] focus-within:is-focused';

export const fieldBareInput = 'h-full min-w-0 flex-1 bg-transparent px-3 outline-none placeholder:text-ink-3';

export const inputLgClass = `${field} h-11 px-4 text-base`;

export const textareaClass = `${field} px-3 py-2`;

export const selectClass = `${field} h-9 cursor-pointer px-3`;

/**
 * Spread onto every in-app field (`<input {...noAutofill} …>`) to keep
 * password managers (1Password, LastPass, Bitwarden, Dashlane) and the
 * browser's own autofill from dressing it up: a pool name or a search box
 * isn't a login. Spread it first so an explicit autoComplete still wins.
 * Not for sign-in or the candidate-facing pages, where autofill helps.
 */
export const noAutofill = {
  autoComplete: 'off',
  'data-1p-ignore': 'true',
  'data-lpignore': 'true',
  'data-bwignore': 'true',
  'data-form-type': 'other',
} as const;

// The one filled-ink action in a view
export const btnPrimary = buttonClass({ variant: 'primary' });

// Every other action on the canvas — white pill
export const btnSecondary = buttonClass({ variant: 'secondary' });

// Secondary actions sitting inside a white surface
export const btnTonal = buttonClass({ variant: 'tonal' });

// Text-only; fill appears on hover
export const btnGhost = buttonClass({ variant: 'ghost', size: 'sm' });

// xs pill badge — muted fill, sentence case (never mono, never outlined)
export const badge =
  'inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-muted px-2.5 text-xs text-ink-2';

// Raised surface card
export const surface = 'rounded-card bg-surface';

// Interactive card — lifts on hover
export const surfaceHover =
  'rounded-card bg-surface transition-shadow duration-200 hover:shadow-lift';

// Section label — sentence case, quiet
export const sectionLabel = 'text-xs font-medium text-ink-2';

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={`flex flex-col gap-1.5 ${className ?? ''}`}>
      <span className="text-sm font-medium text-ink">{label}</span>
      {children}
      {hint ? <span className="text-xs text-ink-2">{hint}</span> : null}
    </label>
  );
}
