'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Activity, ArrowUp, Braces, ChevronsLeft, ChevronsRight, Layers, Presentation, Sparkles, Users } from 'lucide-react';
import { cn } from '@/lib/utils';

export const DOC_SECTIONS = [
  { id: 'overview', label: 'Overview', icon: Sparkles },
  { id: 'pitch', label: 'Pitch', icon: Presentation },
  { id: 'live', label: 'Live view', icon: Activity },
  { id: 'team', label: 'Team', icon: Users },
  { id: 'technical', label: 'Technical', icon: Layers },
  { id: 'api', label: 'API', icon: Braces },
] as const;

/** Row height of a sidebar item; the active indicator moves in steps of this. */
const ROW = 38; // 36px row + 2px gap, like the app sidebar
const STORAGE_KEY = 'orqestra-docs-sidebar-collapsed';

/** Runs before first paint (inlined in the page) so a collapsed sidebar never flashes open. */
export const SIDEBAR_BOOT = `try{if(localStorage.getItem('${STORAGE_KEY}')==='1')document.documentElement.dataset.dxCollapsed='1'}catch(e){}`;

/** Docs navigation: a left sidebar on desktop, a floating icon bar on phones. */
export function DocsNav() {
  const [active, setActive] = useState(0);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const onScroll = () => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      setProgress(max > 0 ? Math.min(1, window.scrollY / max) : 0);
      // The active section is the last one whose top has reached the upper part of the screen.
      let current = 0;
      DOC_SECTIONS.forEach((s, i) => {
        const el = document.getElementById(s.id);
        if (el && el.getBoundingClientRect().top <= 140) current = i;
      });
      // At the very bottom, the last section is active even if it is short.
      if (max > 0 && window.scrollY >= max - 4) current = DOC_SECTIONS.length - 1;
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

  const toggle = () => {
    const root = document.documentElement;
    const next = root.dataset.dxCollapsed !== '1';
    if (next) root.dataset.dxCollapsed = '1';
    else delete root.dataset.dxCollapsed;
    try {
      localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
    } catch {
      /* private mode: the choice just isn't remembered */
    }
  };

  return (
    <>
      <aside className="dx-side fixed inset-y-0 left-0 z-40 hidden flex-col bg-surface shadow-[1px_0_0_var(--color-line)] lg:flex">
        <div className="flex h-[72px] shrink-0 items-center gap-2 overflow-hidden px-4">
          <Link href="/" aria-label="Orqestra home" className="flex shrink-0 items-center gap-2.5">
            {/* eslint-disable-next-line @next/next/no-img-element -- a static PNG logo */}
            <img src="/brand/orqestra/logo-128.png" alt="" width={36} height={36} className="size-9 shrink-0 object-contain" />
            <span className="dx-label text-[16px] font-semibold tracking-[-0.02em]">Orqestra</span>
          </Link>
          <span className="dx-label rounded-full bg-recessed px-2 py-0.5 text-2xs font-medium text-brand">Docs</span>
        </div>

        <nav aria-label="Documentation sections" className="relative mx-3 mt-1">
          <span
            aria-hidden
            className="dx-indicator absolute inset-x-0 top-0 rounded-full bg-brand"
            style={{ height: ROW - 2, transform: `translateY(${active * ROW}px)` }}
          />
          {DOC_SECTIONS.map(({ id, label, icon: Icon }, i) => (
            <a
              key={id}
              href={`#${id}`}
              title={label}
              aria-current={active === i ? 'true' : undefined}
              className={cn(
                'dx-item relative z-10 mb-[2px] flex items-center gap-3 overflow-hidden whitespace-nowrap rounded-full px-3.5 text-sm transition-colors duration-150',
                active === i ? 'font-medium text-on-brand' : 'text-ink',
              )}
              style={{ height: ROW - 2 }}
            >
              <Icon size={16} strokeWidth={1.75} className="shrink-0" />
              <span className="dx-label">{label}</span>
            </a>
          ))}
        </nav>

        <div className="dx-label mx-6 mt-6">
          <div className="flex items-center justify-between text-xs">
            <span>Read</span>
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>{Math.round(progress * 100)}%</span>
          </div>
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-recessed">
            <div className="h-full origin-left rounded-full bg-brand" style={{ transform: `scaleX(${progress})` }} />
          </div>
        </div>

        <div className="mt-auto flex flex-col gap-1.5 p-3">
          <Link href="/help" className="dx-label rounded-full px-3.5 py-2 text-sm hover:bg-muted">
            User guide
          </Link>
          <Link
            href="/login"
            className="dx-label rounded-full bg-brand px-4 py-2 text-center text-sm font-medium text-on-brand transition-transform active:scale-[0.97]"
          >
            Open Orqestra
          </Link>
          <button
            type="button"
            onClick={toggle}
            aria-label="Collapse or expand the sidebar"
            title="Collapse or expand"
            className="grid size-9 place-items-center self-start text-ink/60 transition-colors hover:text-brand"
          >
            <ChevronsLeft size={18} className="dx-when-open" />
            <ChevronsRight size={18} className="dx-when-closed" />
          </button>
        </div>
      </aside>

      {/* Phones and tablets: a floating icon bar. */}
      <nav
        aria-label="Documentation sections"
        className="fixed inset-x-3 bottom-3 z-40 mx-auto flex max-w-md justify-between rounded-full bg-canvas/90 p-1.5 shadow-[0_16px_40px_-16px_rgb(15_61_52/0.45),0_0_0_1px_var(--color-line)] backdrop-blur-xl lg:hidden"
      >
        {DOC_SECTIONS.map(({ id, label, icon: Icon }, i) => (
          <a
            key={id}
            href={`#${id}`}
            aria-label={label}
            className={cn(
              'flex flex-1 flex-col items-center gap-0.5 rounded-full py-1.5 text-[10.5px] transition-colors duration-150',
              active === i ? 'bg-brand text-on-brand' : 'text-ink/70',
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
