'use client';

import { useEffect, useOptimistic, useRef, useState, useTransition } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { AlarmClock, X } from 'lucide-react';
import { snoozeOpportunityAction } from '@/app/(app)/actions';
import { badge, inputClass, noAutofill } from '@/components/form-controls';
import { buttonClass } from '@/components/ui/button';
import { StatusDot } from '@/components/ui/primitives';
import { runOptimistic } from '@/lib/optimistic';
import { cn } from '@/lib/utils';
import { LocalTime } from '@/components/local-time';

/**
 * Snooze hides a candidate from the pipeline until a date; they come back
 * on their own that morning and wait under Tasks → Snoozed meanwhile.
 * Presets cover the usual waits; "Pick a date…" opens a date field that
 * saves only on Snooze or Enter (typing a year in a date input passes
 * through 0002, 0020… and must not save each one), with ✕ and Escape to
 * back out.
 */

const PRESETS = [
  { label: 'Tomorrow', days: 1 },
  { label: 'In 3 days', days: 3 },
  { label: 'In a week', days: 7 },
  { label: 'In 2 weeks', days: 14 },
  { label: 'In a month', days: 30 },
];

/**
 * Local midnight `days` from today. Sent as a full timestamp: a bare
 * YYYY-MM-DD parses as UTC midnight, which is the evening before in the
 * Americas, so "until Sep 28" showed as Sep 27 there.
 */
function startOfDay(days: number): Date {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);
}

/** A date input's YYYY-MM-DD, as local midnight. */
function fromInput(value: string): Date | null {
  const [y, m, d] = value.split('-').map(Number);
  if (!y || !m || !d || y < 1000) return null;
  return new Date(y, m - 1, d);
}

const toInput = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const shortDate = (d: Date) => d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

const itemClass =
  'flex cursor-pointer items-center justify-between gap-3 rounded-field px-3 py-2 text-sm text-ink outline-none data-[highlighted]:bg-muted';

export function SnoozeControl({
  opportunityId,
  snoozedUntil,
}: {
  opportunityId: string;
  snoozedUntil: string | null;
}) {
  const [, startTransition] = useTransition();
  const [until, setUntil] = useOptimistic(snoozedUntil);
  const [picking, setPicking] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const snooze = (next: Date | null) =>
    runOptimistic(
      startTransition,
      () => {
        setUntil(next?.toISOString() ?? null);
        setPicking(false);
      },
      () => snoozeOpportunityAction(opportunityId, next?.toISOString() ?? null),
      next ? 'Snoozing' : 'Unsnoozing',
    );

  // The menu hands focus back to its trigger as it closes, after the date
  // field has mounted; take it back a frame later and open the calendar.
  useEffect(() => {
    if (!picking) return;
    const raf = requestAnimationFrame(() => {
      inputRef.current?.focus();
      try {
        inputRef.current?.showPicker();
      } catch {
        // showPicker needs a recent click; without one the field is still focused
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [picking]);

  if (until) {
    return (
      <span className={badge}>
        <StatusDot tone="caution" />
        Snoozed until{' '}
        <LocalTime date={until} options={{ month: 'short', day: 'numeric' }} />
        <button
          type="button"
          title="Unsnooze"
          aria-label="Unsnooze"
          onClick={() => snooze(null)}
          className="-mr-1 flex size-4 cursor-pointer items-center justify-center rounded-full text-ink-3 hover:text-ink"
        >
          <X size={12} />
        </button>
      </span>
    );
  }

  if (picking) {
    const picked = fromInput(draft);
    const valid = !!picked && picked >= startOfDay(1);
    return (
      <form
        className="inline-flex items-center gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) snooze(picked);
        }}
      >
        <input {...noAutofill}
          ref={inputRef}
          type="date"
          aria-label="Snooze until"
          min={toInput(startOfDay(1))}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Handled here, so the drawer underneath doesn't close too.
            if (e.key === 'Escape') {
              e.preventDefault();
              setPicking(false);
            }
          }}
          className={cn(inputClass, 'h-6 w-auto px-2 text-xs tabular-nums')}
        />
        <button type="submit" disabled={!valid} className={buttonClass({ variant: 'tonal', size: 'xs' })}>
          Snooze
        </button>
        <button
          type="button"
          aria-label="Cancel"
          title="Cancel"
          onClick={() => setPicking(false)}
          className={buttonClass({ variant: 'ghost', size: 'xs', icon: true })}
        >
          <X />
        </button>
      </form>
    );
  }

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className={buttonClass({ variant: 'ghost', size: 'xs', className: 'data-[state=open]:bg-ink/[0.05]' })}
        >
          <AlarmClock /> Snooze
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={5}
          className="menu-animate z-[350] w-[248px] rounded-card bg-surface p-1 shadow-float"
        >
          <DropdownMenu.Label className="px-3 pb-1 pt-2 text-xs text-ink-2">
            Hide from the pipeline until…
          </DropdownMenu.Label>
          {PRESETS.map((p) => {
            const date = startOfDay(p.days);
            return (
              <DropdownMenu.Item key={p.days} onSelect={() => snooze(date)} className={itemClass}>
                <span>{p.label}</span>
                <span className="text-xs tabular-nums text-ink-3">{shortDate(date)}</span>
              </DropdownMenu.Item>
            );
          })}
          <DropdownMenu.Separator className="mx-2 my-1 h-px bg-line" />
          <DropdownMenu.Item
            onSelect={() => {
              setDraft('');
              setPicking(true);
            }}
            className={itemClass}
          >
            Pick a date…
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
