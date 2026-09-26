'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { cn } from '@/lib/utils';

/**
 * Small layout primitives (docs/09-design-system.md §8). These are thin on
 * purpose — most of the system lives in tokens and the class vocabulary in
 * form-controls.tsx; these exist where markup structure repeats.
 */

export type Tone = 'neutral' | 'positive' | 'caution' | 'critical' | 'info';

const dotTone: Record<Tone, string> = {
  neutral: 'bg-ink-3',
  positive: 'bg-positive',
  caution: 'bg-caution',
  critical: 'bg-critical',
  info: 'bg-info',
};

/** 6px status dot — the only way status color enters a row. */
export function StatusDot({ tone = 'neutral', className }: { tone?: Tone; className?: string }) {
  return <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', dotTone[tone], className)} />;
}

/**
 * xs pill badge. `muted` fill on a surface, `surface` fill on the canvas
 * (pass onCanvas). A tone adds a status dot; the text stays ink.
 */
export function Badge({
  children,
  tone,
  onCanvas = false,
  wrap = false,
  className,
}: {
  children: React.ReactNode;
  tone?: Tone;
  onCanvas?: boolean;
  /** Let long text wrap (AI strengths, notes); the pill grows to fit instead of truncating. */
  wrap?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs text-ink-2',
        wrap ? 'min-h-6 whitespace-normal rounded-[12px] py-1' : 'h-6 whitespace-nowrap',
        onCanvas ? 'bg-surface' : 'bg-muted',
        className,
      )}
    >
      {tone ? <StatusDot tone={tone} /> : null}
      {children}
    </span>
  );
}

/** Raised surface. Interactive cards lift on hover instead of darkening. */
export function Card({
  children,
  className,
  interactive = false,
  as: Tag = 'div',
}: {
  children: React.ReactNode;
  className?: string;
  interactive?: boolean;
  as?: 'div' | 'section' | 'article' | 'li';
}) {
  return (
    <Tag
      className={cn(
        'rounded-card bg-surface',
        interactive &&
          'transition-shadow duration-200 ease-[var(--ease-standard)] hover:shadow-lift',
        className,
      )}
    >
      {children}
    </Tag>
  );
}

/** Sentence-case section label with an optional trailing action. */
export function SectionHeader({
  title,
  action,
  className,
}: {
  title: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    // min-h-5 fits an icon in the title (Candidate match's bot) without
    // pushing that column's content lower than its neighbour's
    <div className={cn('mb-3 flex min-h-5 items-center justify-between gap-3', className)}>
      <h2 className="text-xs font-medium text-ink-2">{title}</h2>
      {action}
    </div>
  );
}

/**
 * Filter chip: white pill; selected adds the 1px gray stroke and full ink
 * (docs/09 §8). Link when href is given.
 */
export function Chip({
  children,
  selected = false,
  href,
  onClick,
  onSurface = false,
  className,
}: {
  children: React.ReactNode;
  selected?: boolean;
  href?: string;
  onClick?: () => void;
  /** Inside a white surface: muted fill instead of white. */
  onSurface?: boolean;
  className?: string;
}) {
  const cls = cn(
    'inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-sm active:scale-[0.98]',
    'selectable',
    selected
      ? 'is-selected'
      : onSurface
        ? 'bg-muted text-ink-2 hover:text-ink'
        : 'bg-surface text-ink-2 hover:text-ink',
    className,
  );
  if (href)
    return (
      <Link href={href} className={cls} aria-current={selected ? 'true' : undefined}>
        {children}
      </Link>
    );
  return (
    <button type="button" onClick={onClick} className={cls} aria-pressed={selected}>
      {children}
    </button>
  );
}

/**
 * Segmented control — recessed pill track with a white thumb that slides
 * to the active option (transitions.dev "tabs sliding": 250ms smooth-out on
 * transform + width). Until the first measure, the active option paints
 * its own fill so server HTML never flashes an empty track.
 */
export function Segmented<T extends string>({
  items,
  value,
  onChange,
  size = 'md',
  className,
}: {
  items: {
    value: T;
    label: React.ReactNode;
    href?: string;
    /** For link items: take over the click (e.g. an optimistic navigation). */
    onClick?: (e: React.MouseEvent<HTMLAnchorElement>) => void;
    /** For link items: warm what the link points at. */
    onIntent?: () => void;
  }[];
  value: T;
  onChange?: (value: T) => void;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const refs = useRef(new Map<T, HTMLElement>());
  const [thumb, setThumb] = useState<{ x: number; w: number } | null>(null);

  useLayoutEffect(() => {
    const measure = () => {
      const el = refs.current.get(value);
      if (el) setThumb({ x: el.offsetLeft, w: el.offsetWidth });
    };
    measure();
    const ro = new ResizeObserver(measure);
    refs.current.forEach((el) => ro.observe(el));
    return () => ro.disconnect();
  }, [value, items.length]);

  return (
    <div
      role="tablist"
      className={cn(
        'relative inline-flex w-fit items-center rounded-full bg-recessed p-[3px]',
        size === 'sm' ? 'h-8' : 'h-9',
        className,
      )}
    >
      {thumb ? (
        <span
          aria-hidden
          className="absolute inset-y-[3px] left-0 rounded-full bg-surface shadow-[0_1px_2px_rgb(0_0_0/0.06)] transition-[transform,width] duration-[var(--duration-fast)] ease-[var(--ease-smooth)]"
          style={{ width: thumb.w, transform: `translateX(${thumb.x}px)` }}
        />
      ) : null}
      {items.map((item) => {
        const active = item.value === value;
        const cls = cn(
          'relative z-[1] inline-flex h-full flex-1 items-center justify-center whitespace-nowrap rounded-full px-3 text-sm transition-colors duration-[var(--duration-fast)] ease-[var(--ease-smooth)]',
          active ? 'text-ink' : 'text-ink-2 hover:text-ink',
          active && !thumb && 'bg-surface shadow-[0_1px_2px_rgb(0_0_0/0.06)]',
        );
        const setRef = (el: HTMLElement | null) => {
          if (el) refs.current.set(item.value, el);
          else refs.current.delete(item.value);
        };
        return item.href ? (
          <Link
            key={item.value}
            ref={setRef}
            href={item.href}
            role="tab"
            aria-selected={active}
            className={cls}
            {...(item.onClick ? { prefetch: false, onClick: item.onClick } : {})}
            {...(item.onIntent ? { onPointerEnter: item.onIntent, onFocus: item.onIntent } : {})}
          >
            {item.label}
          </Link>
        ) : (
          <button
            key={item.value}
            ref={setRef}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange?.(item.value)}
            className={cls}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
