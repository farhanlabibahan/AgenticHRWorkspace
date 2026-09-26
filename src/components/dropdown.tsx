'use client';

import { useEffect, useRef } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * The filter dropdown: a white pill trigger (sentence case, like a chip) over a
 * floating surface menu. Use it for every filter and quick-action dropdown;
 * rectangular FormSelect stays inside creation forms (type = soft rect).
 */

export type DropdownOption = { value: string; label: string };

/** The pill trigger's classes, shared with StageSelect's menu-less stand-in. */
export function dropdownTriggerClass({
  compact = false,
  size = 'md',
  onSurface = false,
}: {
  compact?: boolean;
  size?: 'sm' | 'md';
  onSurface?: boolean;
}) {
  return cn(
    'inline-flex min-w-0 cursor-pointer items-center gap-1.5 rounded-full text-ink transition-colors duration-[120ms] disabled:cursor-default disabled:opacity-40',
    onSurface
      ? 'bg-muted hover:bg-recessed data-[state=open]:bg-recessed'
      : 'bg-surface hover:bg-muted data-[state=open]:bg-muted',
    compact ? 'h-6 px-2.5 text-xs' : size === 'sm' ? 'h-8 px-3 text-sm' : 'h-9 px-4 text-sm',
  );
}

export function Dropdown({
  label,
  value,
  options,
  onSelect,
  allLabel,
  compact = false,
  size = 'md',
  onSurface = false,
  disabled = false,
  showSelectedInTrigger = true,
  defaultOpen = false,
  autoFocus = false,
  triggerLabel,
}: {
  /** Trigger text, e.g. "Posting" → renders "Posting: Selected". */
  label: string;
  /** Currently selected value ('' = none/all). Omit for pure action menus. */
  value?: string;
  options: DropdownOption[];
  onSelect: (value: string) => void;
  /** Adds a leading "All …" item that selects ''. */
  allLabel?: string;
  /** h-6 trigger for dense spots (kanban cards, table rows). Wins over `size`. */
  compact?: boolean;
  /** Control tier (docs/09 §5): md matches inputs and buttons in a toolbar; sm matches chips. */
  size?: 'sm' | 'md';
  /** Inside a white surface a white pill disappears — use the muted fill instead. */
  onSurface?: boolean;
  disabled?: boolean;
  showSelectedInTrigger?: boolean;
  /** Mount with the menu open (a stand-in trigger was clicked before the menu existed). */
  defaultOpen?: boolean;
  /** Focus the trigger on mount (it replaced a stand-in that had focus). */
  autoFocus?: boolean;
  /** Accessible name for the trigger when its text alone is ambiguous. */
  triggerLabel?: string;
}) {
  const selected = options.find((o) => o.value === value);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (autoFocus) trigger.current?.focus();
  }, [autoFocus]);

  return (
    <DropdownMenu.Root defaultOpen={defaultOpen}>
      <DropdownMenu.Trigger asChild>
        <button
          ref={trigger}
          disabled={disabled}
          aria-label={triggerLabel}
          className={dropdownTriggerClass({ compact, size, onSurface })}
        >
          <span className="truncate">
            {label}
            {showSelectedInTrigger && selected && value ? `: ${selected.label}` : ''}
          </span>
          <ChevronDown size={14} className="shrink-0 text-ink-2" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={5}
          className="menu-animate z-[350] max-h-[300px] min-w-[160px] overflow-y-auto rounded-card bg-surface p-1 shadow-float"
        >
          {allLabel ? (
            <DropdownMenu.Item
              onSelect={() => onSelect('')}
              className={cn(
                'flex cursor-pointer items-center justify-between rounded-field px-3 py-2 text-sm outline-none data-[highlighted]:bg-muted',
                !value ? 'bg-muted text-ink' : 'text-ink hover:bg-muted',
              )}
            >
              <span>{allLabel}</span>
              {!value ? <Check size={14} /> : null}
            </DropdownMenu.Item>
          ) : null}
          {options.map((opt) => (
            <DropdownMenu.Item
              key={opt.value}
              onSelect={() => onSelect(opt.value)}
              className={cn(
                'flex cursor-pointer items-center justify-between gap-3 rounded-field px-3 py-2 text-sm outline-none data-[highlighted]:bg-muted',
                value === opt.value
                  ? 'bg-muted text-ink'
                  : 'text-ink hover:bg-muted',
              )}
            >
              <span className="truncate">{opt.label}</span>
              {value === opt.value ? <Check size={14} className="shrink-0" /> : null}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
