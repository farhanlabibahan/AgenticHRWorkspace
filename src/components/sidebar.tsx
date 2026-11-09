'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { SourceLockup } from '@/components/powered-by';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Bot,
  CircleHelp,
  BarChart3,
  CalendarRange,
  Clock,
  Briefcase,
  CalendarDays,
  Inbox,
  Kanban,
  ListTodo,
  LogOut,
  MoreHorizontal,
  Search,
  Newspaper,
  Settings,
  Home,
  UserPlus,
  Users,
} from 'lucide-react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { cn } from '@/lib/utils';
import { Avatar } from '@/components/ui/orb';
import { AskBox } from '@/components/ask-box';

/** Items the mobile floating nav shows directly; the rest live under More. */
const MOBILE_PRIMARY = ['/dashboard', '/pipeline', '/postings', '/interviews'];

const nav = [
  { href: '/dashboard', label: 'Dashboard', icon: Home },
  { href: '/search', label: 'Search', icon: Search },
  { href: '/review', label: 'Review', icon: Inbox },
  { href: '/pipeline', label: 'Pipeline', icon: Kanban },
  { href: '/contacts', label: 'Contacts', icon: Users },
  { href: '/referrals', label: 'Referrals', icon: UserPlus },
  { href: '/postings', label: 'Postings', icon: Briefcase },
  { href: '/interviews', label: 'Interviews', icon: CalendarDays },
  { href: '/tasks', label: 'Tasks', icon: ListTodo },
  { href: '/newsletters', label: 'Newsletters', icon: Newspaper },
  { href: '/attendance', label: 'Attendance', icon: Clock },
  { href: '/leave', label: 'Leave', icon: CalendarRange },
  { href: '/agents', label: 'AI agents', icon: Bot },
  { href: '/reports', label: 'Reports', icon: BarChart3 },
  { href: '/settings', label: 'Settings', icon: Settings },
  { href: '/help', label: 'Help', icon: CircleHelp },
];

export function Sidebar({
  user,
  org,
  signOutAction,
  aiEnabled = false,
}: {
  user: { name: string; email: string };
  org: { name: string; logoFileId: string | null };
  signOutAction: () => Promise<void>;
  /** Whether the ask box answers questions (AI on) or only searches. */
  aiEnabled?: boolean;
}) {
  const pathname = usePathname();
  const [askOpen, setAskOpen] = useState(false);
  // ⌘K / Ctrl+K opens the ask box from anywhere in the app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        setAskOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  /** Search opens the ask box on a plain click; a modified click still opens /search. */
  const openAsk = (href: string, e: React.MouseEvent) => {
    if (href !== '/search' || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return false;
    e.preventDefault();
    setAskOpen(true);
    return true;
  };
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  const linkRefs = useRef(new Map<string, HTMLAnchorElement>());
  const [pill, setPill] = useState<{ y: number; h: number } | null>(null);

  useEffect(() => {
    setPendingHref(null);
  }, [pathname]);

  const isActive = (href: string) => pathname.startsWith(href);
  const go = (href: string) => {
    if (!pathname.startsWith(href)) setPendingHref(href);
  };
  // The active pill slides to where you're going (transitions.dev "tabs sliding",
  // vertical). It moves on click, before the route resolves, so nav feels instant.
  const target = pendingHref ?? nav.find((n) => isActive(n.href))?.href ?? null;
  useLayoutEffect(() => {
    const el = target ? linkRefs.current.get(target) : undefined;
    setPill(el ? { y: el.offsetTop, h: el.offsetHeight } : null);
  }, [target]);

  const primary = nav.filter((n) => MOBILE_PRIMARY.includes(n.href));
  const overflow = nav.filter((n) => !MOBILE_PRIMARY.includes(n.href));

  return (
    <>
      {/* Desktop: canvas-colored rail, no border — pills carry the state */}
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col md:flex">
        {/* The logo: the lockup (public/brand) at 32px, its minimum */}
        <div className="px-5 pb-4 pt-6">
          <SourceLockup />
        </div>

        {/* Workspace — the customer's logo and name on a raised surface */}
        <div className="mx-3 mb-5 flex items-center gap-3 rounded-card bg-surface p-2.5">
          {org.logoFileId ? (
            // eslint-disable-next-line @next/next/no-img-element -- org-uploaded logo via internal route
            <img
              src={`/api/logo/${org.logoFileId}`}
              alt=""
              aria-hidden
              className="size-8 shrink-0 rounded-full object-contain"
            />
          ) : (
            <Avatar name={org.name || 'Workspace'} size={32} />
          )}
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-medium text-ink">{org.name}</span>
            <span className="text-xs text-ink-2">Workspace</span>
          </span>
        </div>

        <nav className="relative flex flex-1 flex-col gap-0.5 overflow-y-auto px-3">
          {pill ? (
            <span
              aria-hidden
              className="absolute inset-x-3 top-0 rounded-full bg-brand transition-[transform,height] duration-[var(--duration-fast)] ease-[var(--ease-smooth)]"
              style={{ height: pill.h, transform: `translateY(${pill.y}px)` }}
            />
          ) : null}
          {nav.map(({ href, label, icon: Icon }) => {
            const active = isActive(href);
            const pending = pendingHref === href;
            return (
              <Link
                key={href}
                ref={(el) => {
                  if (el) linkRefs.current.set(href, el);
                  else linkRefs.current.delete(href);
                }}
                href={href}
                onClick={(e) => {
                  if (!openAsk(href, e)) go(href);
                }}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'relative flex h-9 shrink-0 items-center gap-3 rounded-full px-3.5 text-sm transition-colors duration-[var(--duration-fast)] ease-[var(--ease-smooth)]',
                  active || pending
                    ? 'font-medium text-on-brand'
                    : 'text-ink-2 hover:bg-ink/[0.04] hover:text-ink',
                  active && !pill && 'bg-brand',
                )}
              >
                <Icon
                  size={16}
                  strokeWidth={1.75}
                  className={cn('shrink-0', pending && 'animate-pulse')}
                />
                {label}
              </Link>
            );
          })}
        </nav>

        <div className="m-3 flex items-center gap-3 rounded-card p-2">
          <Avatar name={user.name || user.email} size={32} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-ink">{user.name}</p>
            <p className="truncate text-xs text-ink-2">{user.email}</p>
          </div>
          <form action={signOutAction}>
            <button
              type="submit"
              title="Sign out"
              aria-label="Sign out"
              className="flex size-8 items-center justify-center rounded-full text-ink-2 transition-colors duration-[120ms] hover:bg-ink/[0.05] hover:text-ink"
            >
              <LogOut size={14} />
            </button>
          </form>
        </div>
      </aside>

      {/* Mobile: floating white pill nav — icon over an 11px label */}
      <nav className="fixed inset-x-0 bottom-4 z-50 flex justify-center px-4 md:hidden">
        <div className="flex items-center gap-1 rounded-full bg-surface p-1.5 shadow-float">
          {primary.map(({ href, label, icon: Icon }) => {
            const active = isActive(href);
            return (
              <Link
                key={href}
                href={href}
                onClick={(e) => {
                  if (!openAsk(href, e)) go(href);
                }}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex h-12 w-16 flex-col items-center justify-center gap-0.5 rounded-full text-2xs transition-colors duration-[120ms]',
                  active ? 'bg-muted text-ink' : 'text-ink-2',
                )}
              >
                <Icon size={18} strokeWidth={1.75} className={cn(pendingHref === href && 'animate-pulse')} />
                {label}
              </Link>
            );
          })}
          <DropdownMenu.Root>
            <DropdownMenu.Trigger
              className={cn(
                'flex h-12 w-16 flex-col items-center justify-center gap-0.5 rounded-full text-2xs outline-none transition-colors duration-[120ms] data-[state=open]:bg-muted',
                overflow.some((n) => isActive(n.href)) ? 'bg-muted text-ink' : 'text-ink-2',
              )}
            >
              <MoreHorizontal size={18} strokeWidth={1.75} />
              More
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                side="top"
                align="end"
                sideOffset={10}
                className="menu-animate z-[350] min-w-[200px] rounded-card bg-surface p-1 shadow-float"
              >
                {overflow.map(({ href, label, icon: Icon }) => (
                  <DropdownMenu.Item key={href} asChild>
                    <Link
                      href={href}
                      onClick={(e) => {
                  if (!openAsk(href, e)) go(href);
                }}
                      className={cn(
                        'flex items-center gap-3 rounded-field px-3 py-2 text-sm outline-none data-[highlighted]:bg-muted',
                        isActive(href) ? 'bg-muted text-ink' : 'text-ink',
                      )}
                    >
                      <Icon size={16} strokeWidth={1.75} className="text-ink-2" />
                      {label}
                    </Link>
                  </DropdownMenu.Item>
                ))}
                <form action={signOutAction}>
                  <button
                    type="submit"
                    className="flex w-full items-center gap-3 rounded-field px-3 py-2 text-sm text-ink-2 outline-none hover:bg-muted"
                  >
                    <LogOut size={16} strokeWidth={1.75} />
                    Sign out
                  </button>
                </form>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      </nav>
      <AskBox open={askOpen} onOpenChange={setAskOpen} aiEnabled={aiEnabled} />
    </>
  );
}
