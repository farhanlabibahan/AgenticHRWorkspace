'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Activity, ArrowUp, Braces, Layers, Presentation, Sparkles, Users } from 'lucide-react';
import { SourceLockup } from '@/components/powered-by';
import { cn } from '@/lib/utils';

export const DOC_SECTIONS = [
  { id: 'overview', label: 'Overview', icon: Sparkles },
  { id: 'pitch', label: 'Pitch', icon: Presentation },
  { id: 'live', label: 'Live view', icon: Activity },
  { id: 'team', label: 'Team', icon: Users },
  { id: 'technical', label: 'Technical', icon: Layers },
  { id: 'api', label: 'API', icon: Braces },
] as const;

type Indicator = { left: number; width: number };

/** Sticky docs header: section nav that follows the scroll, a sliding underline, reading progress. */
export function DocsNav() {
  const [active, setActive] = useState<string>('overview');
  const [progress, setProgress] = useState(0);
  const [scrolled, setScrolled] = useState(false);
  const [indicator, setIndicator] = useState<Indicator | null>(null);
  const links = useRef(new Map<string, HTMLAnchorElement>());

  useEffect(() => {
    const onScroll = () => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      setProgress(max > 0 ? Math.min(1, window.scrollY / max) : 0);
      setScrolled(window.scrollY > 8);
      // The active section is the last one whose top has passed under the header.
      let current: string = DOC_SECTIONS[0].id;
      for (const s of DOC_SECTIONS) {
        const el = document.getElementById(s.id);
        if (el && el.getBoundingClientRect().top <= 140) current = s.id;
      }
      // At the very bottom, the last section is active even if it is short.
      if (max > 0 && window.scrollY >= max - 4) current = DOC_SECTIONS[DOC_SECTIONS.length - 1].id;
      setActive(current);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, []);

  useEffect(() => {
    const measure = () => {
      const el = links.current.get(active);
      if (el) setIndicator({ left: el.offsetLeft, width: el.offsetWidth });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [active]);

  return (
    <>
      <header
        className={cn(
          'dx-header sticky top-0 z-40 bg-canvas/80 backdrop-blur-xl transition-shadow duration-300',
          scrolled && 'shadow-[0_1px_0_var(--color-line),0_12px_32px_-24px_rgb(15_61_52/0.35)]',
        )}
      >
        <div className="mx-auto flex h-[68px] max-w-6xl items-center justify-between gap-6 px-6">
          <div className="flex items-center gap-3">
            <SourceLockup href="/" />
            <span className="hidden rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-brand sm:inline-block">Docs</span>
          </div>

          <nav aria-label="Documentation sections" className="relative hidden items-center lg:flex">
            {DOC_SECTIONS.map(({ id, label, icon: Icon }) => (
              <a
                key={id}
                href={`#${id}`}
                ref={(el) => {
                  if (el) links.current.set(id, el);
                  else links.current.delete(id);
                }}
                aria-current={active === id ? 'true' : undefined}
                className={cn(
                  'flex items-center gap-1.5 rounded-full px-3 py-2 text-sm transition-colors duration-150',
                  active === id ? 'font-medium text-brand' : 'text-ink/70 hover:text-ink',
                )}
              >
                <Icon size={15} strokeWidth={1.9} />
                {label}
              </a>
            ))}
            {indicator ? (
              <span
                aria-hidden
                className="dx-underline pointer-events-none absolute -bottom-[13px] h-[2.5px] rounded-full bg-brand"
                style={{ transform: `translateX(${indicator.left + 12}px)`, width: Math.max(0, indicator.width - 24) }}
              />
            ) : null}
          </nav>

          <div className="flex items-center gap-1 text-sm">
            <Link href="/help" className="hidden rounded-full px-3 py-2 text-ink/70 hover:text-ink md:inline-block">
              Guide
            </Link>
            <Link href="/login" className="rounded-full bg-brand px-4 py-2 font-medium text-on-brand transition-transform active:scale-[0.97]">
              Open Orqestra
            </Link>
          </div>
        </div>
        <div aria-hidden className="h-[2px] bg-transparent">
          <div className="h-full origin-left bg-brand" style={{ transform: `scaleX(${progress})` }} />
        </div>
      </header>

      {/* Phones and tablets: a floating icon bar instead of the top section nav. */}
      <nav
        aria-label="Documentation sections"
        className="fixed inset-x-3 bottom-3 z-40 mx-auto flex max-w-md justify-between rounded-full bg-canvas/90 p-1.5 shadow-[0_16px_40px_-16px_rgb(15_61_52/0.45),0_0_0_1px_var(--color-line)] backdrop-blur-xl lg:hidden"
      >
        {DOC_SECTIONS.map(({ id, label, icon: Icon }) => (
          <a
            key={id}
            href={`#${id}`}
            aria-label={label}
            className={cn(
              'flex flex-1 flex-col items-center gap-0.5 rounded-full py-1.5 text-[10.5px] transition-colors duration-150',
              active === id ? 'bg-brand text-on-brand' : 'text-ink/70',
            )}
          >
            <Icon size={17} strokeWidth={1.9} />
            <span className="leading-none">{label.split(' ')[0]}</span>
          </a>
        ))}
      </nav>

      <a
        href="#overview"
        aria-label="Back to top"
        className={cn(
          'fixed bottom-6 right-6 z-40 hidden size-11 place-items-center rounded-full bg-brand text-on-brand shadow-[0_12px_28px_-12px_rgb(15_61_52/0.6)] transition-all duration-300 lg:grid',
          progress > 0.08 ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-3 opacity-0',
        )}
      >
        <ArrowUp size={18} />
      </a>
    </>
  );
}
