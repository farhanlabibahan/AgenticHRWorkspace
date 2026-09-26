'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
  type Ref,
} from 'react';
import { useRouter } from 'next/navigation';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { buttonClass } from '@/components/ui/button';
import { ProfileSkeleton } from '@/components/profile-skeleton';

/**
 * The candidate drawer.
 *
 * It used to arrive with its route, so nothing showed until the server
 * answered (half a second or more on a first open), exits other than X /
 * Escape / backdrop removed it without animating, and a refresh showed the
 * bare profile page. Now:
 *
 * - A click on a CandidateLink opens a placeholder drawer at once with the
 *   skeleton (DrawerHost, in the app layout). When the profile's route
 *   arrives, its own drawer (DrawerContent) takes over from exactly where
 *   the placeholder's slide had got to, so the handoff can't be seen.
 * - The full /candidates/[id] page renders the same DrawerContent over the
 *   pipeline, so a refresh or a shared link opens the drawer too.
 * - Every exit plays the entrance backwards. X, Escape, the backdrop and
 *   links out of the drawer animate first, then navigate; browser Back
 *   navigates first, so a copy of the drawer as it stood slides out.
 *
 * DrawerContent renders its drawer inline and never reads the host's state:
 * a portal into the host made its rendering depend on host state, and a
 * streaming profile suspending mid-mount looped React between registering
 * and unregistering it.
 */

/** Same length both ways: the exit is the entrance played backwards. --duration-slow. */
export const DRAWER_MS = 480;
/** The entrance's curve (--ease-smooth), and that curve reversed for the exit (--ease-smooth-out). */
const EASE_IN = 'cubic-bezier(0.33, 1, 0.68, 1)';
const EASE_OUT = 'cubic-bezier(0.32, 0, 0.67, 0)';

/** Fired by CandidateLink on a plain click, before the route starts loading. */
export const OPEN_CANDIDATE_EVENT = 'source:open-candidate';
/** Fired by DrawerContent when it takes over from the placeholder. */
const TAKEOVER_EVENT = 'source:drawer-takeover';

/** How long a click waits for its profile before the placeholder gives up. */
const PENDING_LIMIT_MS = 15_000;

/** What the placeholder hands to the drawer that replaces it. Outside React on purpose. */
const handoff = {
  openedAt: null as number | null,
  /** The page it was clicked on, so "← Pipeline" there can just go back. */
  origin: null as string | null,
  sheet: null as HTMLElement | null,
  backdrop: null as HTMLElement | null,
  /** The placeholder was closed before its profile arrived: don't open it. */
  cancelled: false,
};

/**
 * Browser Back / Forward. Registered when this module loads, which is before
 * Next's router adds its own popstate listener: the router unmounts the
 * drawer synchronously when it handles the event, and a listener the drawer
 * added itself would be removed before its turn came.
 */
let onBrowserNavigation: (() => void) | null = null;
if (typeof window !== 'undefined') {
  window.addEventListener('popstate', () => onBrowserNavigation?.());
}

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The drawer's frame: backdrop, sheet, close button. Shared by the placeholder and the real one. */
function Frame({
  open,
  onClose,
  overlayRef,
  sheetRef,
  backdropRef,
  closeRef,
  onClickCapture,
  skeleton = false,
  children,
  ...data
}: {
  open: boolean;
  onClose: () => void;
  overlayRef?: Ref<HTMLDivElement>;
  sheetRef?: Ref<HTMLDivElement>;
  backdropRef?: Ref<HTMLDivElement>;
  closeRef?: Ref<HTMLButtonElement>;
  onClickCapture?: (e: MouseEvent) => void;
  /** Keep the skeleton behind the content and crossfade to the profile when it lands (globals.css). */
  skeleton?: boolean;
  children: ReactNode;
  [dataAttr: `data-${string}`]: string | boolean | undefined;
}) {
  const ease = { transitionTimingFunction: open ? EASE_IN : EASE_OUT };
  return (
    <div ref={overlayRef} className="fixed inset-0 z-[300]" role="dialog" aria-modal="true" aria-label="Candidate profile" {...data}>
      <div
        ref={backdropRef}
        data-drawer-backdrop
        onClick={onClose}
        style={ease}
        className={cn(
          'absolute inset-0 bg-ink/20 transition-opacity duration-[var(--duration-slow)] motion-reduce:transition-none',
          open ? 'opacity-100' : 'opacity-0',
        )}
      />
      {/* A floating sheet: canvas-toned so the profile's white cards still read as raised.
          Panel reveal (transitions.dev); the exit mirrors it. Only `translate` and
          `opacity` move, on their own layer, so the GPU animates them without
          repainting the sheet. It used to cross-blur too, which re-blurred the whole
          screen-sized sheet every frame and made the slide lag on Retina displays.
          Tailwind v4's translate-x-* sets the CSS `translate` property, so that's
          what transitions. */}
      <div
        ref={sheetRef}
        data-drawer-sheet
        onClickCapture={onClickCapture}
        style={ease}
        className={cn(
          'sheet-scroll absolute inset-y-2 right-2 w-[calc(90vw-8px)] overflow-y-auto overscroll-contain [scrollbar-gutter:stable] rounded-dialog bg-canvas shadow-float transition-[translate,opacity] duration-[var(--duration-slow)] will-change-[translate,opacity] motion-reduce:transition-none',
          open ? 'translate-x-0 opacity-100' : 'translate-x-[calc(100%+8px)] opacity-0',
        )}
      >
        {/* Close sits top-right so it never covers the profile's back link */}
        <div className="pointer-events-none sticky top-4 z-10 flex justify-end px-4">
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close profile"
            className={buttonClass({ variant: 'secondary', size: 'sm', icon: true, className: 'pointer-events-auto' })}
          >
            <X />
          </button>
        </div>
        {/* The scrollbar's space is always kept, so content doesn't shift 7px when
            a profile tall enough to scroll replaces the skeleton. */}
        <div data-drawer-body className="relative -mt-8">
          {skeleton ? (
            <div data-drawer-skeleton aria-hidden className="pointer-events-none absolute inset-x-0 top-0">
              <ProfileSkeleton />
            </div>
          ) : null}
          <div className="relative">{children}</div>
        </div>
      </div>
    </div>
  );
}

/** How many drawers hold the page still: the placeholder hands over to the real one mid-lock. */
let scrollLocks = 0;

/** Escape closes (a menu inside handles its own Escape first and marks it handled); the page behind doesn't scroll. */
function useDrawerChrome(active: boolean, close: () => void) {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) close();
    };
    document.addEventListener('keydown', onKey);
    if (scrollLocks++ === 0) document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      if (--scrollLocks === 0) document.body.style.overflow = '';
    };
  }, [active, close]);
}

/**
 * The placeholder: opens on a click, before the profile's route exists, and
 * steps aside the moment DrawerContent mounts.
 */
export function DrawerHost({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState(false);
  const [open, setOpen] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const closing = useRef(false);

  useEffect(() => {
    const onOpen = () => {
      handoff.cancelled = false;
      handoff.openedAt = performance.now();
      handoff.origin = window.location.pathname + window.location.search;
      closing.current = false;
      setShown(true);
    };
    const onTakeover = () => {
      handoff.openedAt = null;
      setOpen(false);
      setShown(false);
    };
    window.addEventListener(OPEN_CANDIDATE_EVENT, onOpen);
    window.addEventListener(TAKEOVER_EVENT, onTakeover);
    return () => {
      window.removeEventListener(OPEN_CANDIDATE_EVENT, onOpen);
      window.removeEventListener(TAKEOVER_EVENT, onTakeover);
    };
  }, []);

  // Shown → slide in. Reading layout commits the closed position first.
  useLayoutEffect(() => {
    if (!shown) return;
    handoff.sheet = sheetRef.current;
    handoff.backdrop = backdropRef.current;
    sheetRef.current?.getBoundingClientRect();
    const raf = requestAnimationFrame(() => setOpen(true));
    return () => {
      cancelAnimationFrame(raf);
      handoff.sheet = null;
      handoff.backdrop = null;
    };
  }, [shown]);

  const close = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    handoff.cancelled = true;
    handoff.openedAt = null;
    setOpen(false);
    setTimeout(() => setShown(false), reducedMotion() ? 0 : DRAWER_MS);
  }, []);

  // A click whose profile never arrives doesn't hold the placeholder open.
  useEffect(() => {
    if (!shown) return;
    const t = setTimeout(close, PENDING_LIMIT_MS);
    return () => clearTimeout(t);
  }, [shown, close]);

  useDrawerChrome(shown, close);

  return (
    <>
      {children}
      {shown ? (
        <Frame open={open} onClose={close} sheetRef={sheetRef} backdropRef={backdropRef} data-drawer-placeholder>
          <ProfileSkeleton />
        </Frame>
      ) : null}
    </>
  );
}

/**
 * A profile in the drawer. The intercepted route wraps its content in this;
 * the full /candidates/[id] page does too, with `standalone`, so a refresh
 * opens the same drawer (and closing it lands on the pipeline).
 */
export function DrawerContent({ children, standalone = false }: { children: ReactNode; standalone?: boolean }) {
  const router = useRouter();
  // A page load (refresh, shared link) paints the drawer already open: the
  // page itself is the arrival, and a slide starting once it had hydrated
  // read as the drawer lagging in late.
  // Taking over from the placeholder starts open too: starting closed, the one
  // frame between dropping the placeholder's values and React applying "open"
  // showed the drawer at opacity 0, a full-screen flash.
  const [open, setOpen] = useState(() => standalone || (typeof window !== 'undefined' && handoff.openedAt !== null));
  const overlayRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const closing = useRef(false);
  const origin = useRef<string | null>(null);

  // Mount: take over from the placeholder if there is one, else slide in.
  useLayoutEffect(() => {
    const sheet = sheetRef.current;
    const backdrop = backdropRef.current;
    if (!sheet || !backdrop) return;
    if (handoff.cancelled && !standalone) {
      // closed while it loaded: leave without ever showing
      handoff.cancelled = false;
      closing.current = true;
      router.back();
      return;
    }
    let raf = 0;
    if (handoff.openedAt !== null && handoff.sheet && handoff.backdrop) {
      // Start exactly where the placeholder is, then finish its slide in the time it had left.
      const from = getComputedStyle(handoff.sheet);
      const remaining = Math.max(0, DRAWER_MS - (performance.now() - handoff.openedAt));
      sheet.style.transition = 'none';
      sheet.style.translate = from.translate;
      sheet.style.opacity = from.opacity;
      backdrop.style.transition = 'none';
      backdrop.style.opacity = getComputedStyle(handoff.backdrop).opacity;
      origin.current = handoff.origin;
      window.dispatchEvent(new Event(TAKEOVER_EVENT));
      sheet.getBoundingClientRect();
      raf = requestAnimationFrame(() => {
        for (const el of [sheet, backdrop]) {
          el.style.transition = '';
          // Clearing the shorthand also dropped the curve React set, and React
          // won't set an unchanged style again: put the entrance's curve back.
          el.style.transitionTimingFunction = EASE_IN;
          el.style.transitionDuration = `${remaining}ms`;
          el.style.translate = '';
          el.style.opacity = '';
        }
        setTimeout(() => {
          sheet.style.transitionDuration = '';
          backdrop.style.transitionDuration = '';
        }, remaining + 20);
      });
    } else if (!standalone) {
      sheet.getBoundingClientRect();
      raf = requestAnimationFrame(() => setOpen(true));
    }
    closeRef.current?.focus({ preventScroll: true });
    return () => cancelAnimationFrame(raf);
    // mount only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Show the profile once it has painted: mark it data-shown two frames after
  // it lands, which starts the crossfade from the skeleton (globals.css). A
  // fade started at insertion ran out while the heavy mount kept the screen
  // from updating, so it arrived as a pop.
  useEffect(() => {
    const sheet = sheetRef.current;
    if (!sheet) return;
    let pending: HTMLElement | null = null;
    let raf = 0;
    const reveal = () => {
      const el = sheet.querySelector<HTMLElement>('[data-profile]:not([data-shown])');
      if (!el || el === pending) return;
      pending = el;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        raf = requestAnimationFrame(() => {
          el.dataset.shown = '';
          pending = null;
        });
      });
    };
    reveal();
    const observer = new MutationObserver(reveal);
    observer.observe(sheet, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(raf);
    };
  }, []);

  /** Slide out, then leave: `then` if given, else back to the page underneath. */
  const close = useCallback(
    (then?: () => void) => {
      if (closing.current) return;
      closing.current = true;
      setOpen(false);
      setTimeout(
        () => {
          if (then) then();
          else if (standalone) router.replace('/pipeline');
          else router.back();
        },
        reducedMotion() ? 0 : DRAWER_MS,
      );
    },
    [router, standalone],
  );

  // Browser Back / Forward swaps the page before any close could run, so a
  // copy of the drawer as it stood slides out instead.
  useEffect(() => {
    const onPop = () => {
      if (closing.current || window.location.pathname.startsWith('/candidates/')) return;
      const overlay = overlayRef.current;
      const sheet = sheetRef.current;
      if (!overlay || !sheet) return;
      closing.current = true;
      const ghost = overlay.cloneNode(true) as HTMLDivElement;
      ghost.removeAttribute('role');
      ghost.setAttribute('aria-hidden', 'true');
      ghost.style.pointerEvents = 'none';
      // canvases (orbs, avatars) don't copy their pixels
      const from = overlay.querySelectorAll('canvas');
      ghost.querySelectorAll('canvas').forEach((c, i) => {
        try {
          c.getContext('2d')?.drawImage(from[i], 0, 0);
        } catch {
          // a WebGL orb may not copy; it goes out blank
        }
      });
      document.body.appendChild(ghost);
      const ghostSheet = ghost.querySelector<HTMLElement>('[data-drawer-sheet]');
      const ghostBackdrop = ghost.querySelector<HTMLElement>('[data-drawer-backdrop]');
      if (ghostSheet) ghostSheet.scrollTop = sheet.scrollTop;
      requestAnimationFrame(() => {
        if (ghostSheet) {
          ghostSheet.style.transitionTimingFunction = EASE_OUT;
          ghostSheet.style.translate = 'calc(100% + 8px) 0';
          ghostSheet.style.opacity = '0';
        }
        if (ghostBackdrop) {
          ghostBackdrop.style.transitionTimingFunction = EASE_OUT;
          ghostBackdrop.style.opacity = '0';
        }
      });
      setTimeout(() => ghost.remove(), (reducedMotion() ? 0 : DRAWER_MS) + 50);
    };
    onBrowserNavigation = onPop;
    return () => {
      if (onBrowserNavigation === onPop) onBrowserNavigation = null;
    };
  }, []);

  const closeBack = useCallback(() => close(), [close]);
  useDrawerChrome(true, closeBack);

  // Links out of the drawer ("← Pipeline", "Open posting") animate out first.
  // Links to another candidate (switching applications) stay in the drawer.
  const onClickCapture = (e: MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = (e.target as HTMLElement).closest<HTMLAnchorElement>('a[href]');
    if (!a || (a.target && a.target !== '_self') || a.hasAttribute('download')) return;
    const url = new URL(a.href, window.location.href);
    if (url.origin !== window.location.origin || url.pathname.startsWith('/candidates/')) return;
    e.preventDefault();
    e.stopPropagation();
    const dest = url.pathname + url.search + url.hash;
    // a link back to the page it opened over ("← Pipeline"): just go back
    if (!standalone && origin.current && dest === origin.current) close();
    else close(() => (standalone ? router.replace(dest) : router.push(dest)));
  };

  return (
    <Frame
      open={open}
      onClose={closeBack}
      overlayRef={overlayRef}
      sheetRef={sheetRef}
      backdropRef={backdropRef}
      closeRef={closeRef}
      onClickCapture={onClickCapture}
      skeleton
      data-drawer-standalone={standalone || undefined}
      data-drawer-intercepted={!standalone || undefined}
    >
      {children}
    </Frame>
  );
}
