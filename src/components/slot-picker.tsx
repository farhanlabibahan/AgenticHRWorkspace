'use client';

import { useMemo, useState, useActionState } from 'react';
import { bookSlotAction, type BookSlotState } from '@/app/schedule/actions';
import { surface } from '@/components/form-controls';
import { buttonClass } from '@/components/ui/button';
import { Chip } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';
import { TextSwap } from '@/components/ui/motion';

/**
 * Candidate-facing slot grid: days across, times within. All times render in
 * the visitor's local timezone (the server already did the availability math
 * in the org's zone).
 */
export function SlotPicker({ token, slots }: { token: string; slots: string[] }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [state, formAction, pending] = useActionState<BookSlotState, FormData>(
    bookSlotAction,
    undefined,
  );

  const days = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const iso of slots) {
      const d = new Date(iso);
      const key = d.toLocaleDateString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      });
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(iso);
    }
    return [...map.entries()];
  }, [slots]);

  const [dayIdx, setDayIdx] = useState(0);
  const times = days[Math.min(dayIdx, days.length - 1)]?.[1] ?? [];

  if (state?.bookedAt) {
    return (
      <div className={`${surface} animate-fade-rise p-6`}>
        <h2 className="text-md font-medium text-ink">You&rsquo;re booked</h2>
        <p className="mt-2 text-sm text-ink-2">
          Confirmed for{' '}
          {new Date(state.bookedAt).toLocaleString(undefined, {
            weekday: 'long',
            month: 'long',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
          })}
          . A confirmation email with a calendar invite is on its way.
        </p>
      </div>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-5">
      <input type="hidden" name="token" value={token} />
      <input type="hidden" name="startAt" value={selected ?? ''} />

      <div className="no-scrollbar flex gap-2 overflow-x-auto pb-1">
        {days.map(([label], i) => (
          <Chip
            key={label}
            selected={i === dayIdx}
            onClick={() => {
              setDayIdx(i);
              setSelected(null);
            }}
          >
            {label}
          </Chip>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
        {times.map((iso) => (
          <button
            key={iso}
            type="button"
            onClick={() => setSelected(iso)}
            className={cn(
              'selectable h-9 rounded-full px-2 text-sm tabular-nums active:scale-[0.98]',
              selected === iso ? 'is-selected' : 'bg-muted text-ink hover:bg-recessed',
            )}
          >
            {new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
          </button>
        ))}
      </div>

      {state?.error ? <p className="text-sm text-critical">{state.error}</p> : null}

      <div>
        <button type="submit" disabled={!selected || pending} className={buttonClass({ variant: 'primary', size: 'lg' })}>
          <TextSwap>{pending ? 'Booking…' : selected ? 'Confirm this time' : 'Pick a time'}</TextSwap>
        </button>
      </div>
    </form>
  );
}
