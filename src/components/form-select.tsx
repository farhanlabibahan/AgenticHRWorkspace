'use client';

import { useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

export type FormSelectOption = { value: string; label: string };

/**
 * Form-field select with the same open menu as Dropdown (dropdown.tsx), so
 * every menu in the app opens identically. The trigger keeps the
 * rectangular h-9 form look (selectClass); the selection travels with the
 * form via a hidden input, so it drops into any server-action form.
 */
export function FormSelect({
  name,
  options,
  defaultValue = '',
  placeholder = 'Select…',
  className,
  disabled = false,
  value: controlledValue,
  onChange,
}: {
  name?: string;
  options: FormSelectOption[];
  defaultValue?: string;
  /** Shown while nothing is selected (value ''). */
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  /** Controlled mode — pair with onChange. */
  value?: string;
  onChange?: (value: string) => void;
}) {
  const [internal, setInternal] = useState(defaultValue);
  const value = controlledValue ?? internal;
  const selected = options.find((o) => o.value === value);

  const pick = (v: string) => {
    if (controlledValue === undefined) setInternal(v);
    onChange?.(v);
  };

  return (
    <DropdownMenu.Root>
      {name !== undefined ? <input type="hidden" name={name} value={value} /> : null}
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            'flex h-9 w-full cursor-pointer items-center justify-between gap-2 rounded-field bg-recessed px-3 text-sm text-ink outline-none transition-[background-color,box-shadow] duration-[120ms] focus-visible:is-focused data-[state=open]:is-focused disabled:cursor-default disabled:opacity-40',
            className,
          )}
        >
          <span className={cn('truncate', !selected && 'text-ink-3')}>
            {selected ? selected.label : placeholder}
          </span>
          <ChevronDown size={14} className="shrink-0 text-ink-2" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={5}
          className="menu-animate z-[350] max-h-[300px] min-w-[var(--radix-dropdown-menu-trigger-width)] overflow-y-auto rounded-card bg-surface p-1 shadow-float"
        >
          {options.map((opt) => (
            <DropdownMenu.Item
              key={opt.value}
              onSelect={() => pick(opt.value)}
              className={cn(
                'flex cursor-pointer items-center justify-between gap-3 rounded-field px-3 py-2 text-sm outline-none',
                value === opt.value ? 'bg-muted text-ink' : 'text-ink hover:bg-muted data-[highlighted]:bg-muted',
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
