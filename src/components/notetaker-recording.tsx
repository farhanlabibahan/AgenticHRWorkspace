'use client';

import { useEffect, useState } from 'react';
import { notetakerProvider } from '@/lib/notetaker-providers';
import { LocalTime } from '@/components/local-time';
import { SiteIcon } from '@/components/site-icon';
import { cn } from '@/lib/utils';

/**
 * Pieces the two ways of binding a recording to a person share: the review
 * card on the Interviews page (notetaker-suggestions.tsx) and "Attach a
 * recording" on a candidate's interview (attach-recording.tsx).
 */

/** Participants shown before "+N". */
export const PARTICIPANTS_SHOWN = 6;

export function participantsText(list: string[], max = PARTICIPANTS_SHOWN): string | null {
  if (!list.length) return null;
  const shown = list.slice(0, max).join(', ');
  return list.length > max ? `${shown} +${list.length - max}` : shown;
}

export function durationText(mins: number | null): string | null {
  if (!mins || mins < 1) return null;
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export function ProviderIcon({ provider, size = 16 }: { provider: string; size?: number }) {
  const meta = notetakerProvider(provider);
  return (
    <span className="flex size-5 shrink-0 items-center justify-center">{meta ? <SiteIcon url={meta.domain} size={size} /> : null}</span>
  );
}

/** A recording: favicon, title, when and how long, and who was there. */
export function RecordingSummary({
  provider,
  title,
  startAt,
  durationMins,
  participants,
  showIcon = true,
  showProvider = true,
  after,
}: {
  provider: string;
  title: string;
  startAt: string;
  durationMins: number | null;
  participants: string[];
  showIcon?: boolean;
  showProvider?: boolean;
  /** Beside the title (a chip). */
  after?: React.ReactNode;
}) {
  const meta = notetakerProvider(provider);
  const duration = durationText(durationMins);
  const people = participantsText(participants);
  return (
    <div className="flex min-w-0 items-start gap-3">
      {showIcon ? <ProviderIcon provider={provider} /> : null}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <p className="truncate text-sm font-medium text-ink">{title || 'Untitled meeting'}</p>
          {after}
        </div>
        <p className="mt-0.5 text-xs text-ink-2">
          {showProvider ? `${meta?.name ?? provider} · ` : ''}
          <span className="tabular-nums">
            <LocalTime date={startAt} />
          </span>
          {duration ? ` · ${duration}` : ''}
        </p>
        {people ? <p className="mt-0.5 text-xs text-ink-2">{people}</p> : null}
      </div>
    </div>
  );
}

/**
 * One choice in a list of them: a radio row. Unselected rows sit on muted
 * so the selected one (white, with the 1px stroke) reads inside a white
 * surface (docs/09 §8). The real radio input stays underneath for keyboard
 * and screen readers.
 */
export function ChoiceRow({
  name,
  value,
  checked,
  onSelect,
  disabled = false,
  children,
  className,
}: {
  name: string;
  value: string;
  checked: boolean;
  onSelect: () => void;
  disabled?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label
      className={cn(
        'selectable flex items-start gap-3 rounded-field px-3 py-2.5',
        disabled ? 'cursor-default bg-muted/60' : checked ? 'cursor-pointer is-selected' : 'cursor-pointer bg-muted hover:bg-recessed',
        className,
      )}
    >
      <input type="radio" name={name} value={value} checked={checked} onChange={onSelect} disabled={disabled} className="peer sr-only" />
      <span
        aria-hidden
        className={cn(
          'mt-0.5 size-4 shrink-0 rounded-full bg-surface shadow-[inset_0_0_0_1px_var(--color-line-strong)] transition-shadow duration-[var(--duration-quick)] ease-[var(--ease-smooth)] peer-checked:shadow-[inset_0_0_0_5px_var(--color-ink)] peer-focus-visible:ring-2 peer-focus-visible:ring-line-strong peer-focus-visible:ring-offset-2',
          disabled && 'opacity-40',
        )}
      />
      <div className="min-w-0 flex-1">{children}</div>
    </label>
  );
}

/** Formats a time in the viewer's zone once mounted (UTC before, so server and client HTML agree), for option labels. */
export function useLocalFormat(options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return (iso: string) =>
    mounted ? new Date(iso).toLocaleString(undefined, options) : new Date(iso).toLocaleString('en-US', { ...options, timeZone: 'UTC' });
}
