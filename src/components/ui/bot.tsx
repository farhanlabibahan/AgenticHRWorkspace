'use client';

import { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';

// Loaded only where a bot actually renders (bot-avatars ~45KB plus the
// dither) — never on pages without one. Until it arrives, a lavender disc
// holds the exact footprint.
const DitheredBotAvatar = dynamic(
  () => import('@/components/ui/bot-dither').then((m) => m.DitheredBotAvatar),
  { ssr: false, loading: () => null },
);
import { cn } from '@/lib/utils';

/**
 * The Orqestra assistant's face (bot-avatars, libraries.dev/bots). One bot,
 * one identity: a lavender form, drawn as an ordered dither on the lavender
 * orb's ink and paper so it reads as the orb's kin (see bot-dither.tsx).
 *
 * State carries meaning, so every AI surface maps to one of three:
 * - idle      — ready: every few seconds it glances around, and when the
 *               pointer comes close its eyes and head follow it
 * - working   — a request is in flight (hops; pair with ThinkingStates)
 * - sleeping  — AI isn't on for this server: a still frame, until the
 *               pointer is on it
 *
 * Idle, about one glance in three is a flip (a hop and a full turn), so a
 * bot flips every 20–30 seconds or so; a click hops it any time.
 *
 * Cost: an animating bot shades its canvas per pixel and dithers it every
 * frame, about 2% of the main thread for one 20px bot. So a bot is awake
 * (its loop running) only when there's something to show: working,
 * settling into a new state, a glance, or a pointer near enough to follow.
 * Otherwise it holds a still frame and costs nothing. The library's clock
 * only runs while a bot is awake, so each glance picks up where the last
 * one stopped. Off-screen bots are paused by the library, and with reduced
 * motion it draws no loop at all.
 */

export type BotState = 'idle' | 'working' | 'sleeping';

const BOT = { type: 'circle', color: '#9f93f3', saturation: 1 } as const;

/**
 * How long a bot keeps moving after its state changes: the library eases
 * into a new state's pose over up to 1.4s, and a hop under way finishes
 * first. Paused sooner, it would hold a frame from the old state (a bot
 * frozen mid-hop, or awake after it was put to sleep).
 */
const SETTLE_MS = 1600;

/** A glance: awake this long, then still for a random spell between REST_MS. */
const GLANCE_MS = 2400;
const REST_MS = [3000, 9000] as const;
/** The share of glances that are a flip. */
const FLIP_ODDS = 1 / 3;
/**
 * A flip is cued by setting the library's idle-jump interval very short (it
 * reschedules the next jump whenever the interval changes: this one is due
 * 0.13–0.28s of awake time later), then back off before a second can come.
 * The flip itself takes about 1.5s, so it lands well inside the glance and
 * the bot is never paused mid-air.
 */
const FLIP_CUE_S = 0.2;
const FLIP_CUE_MS = 450;

/**
 * How near the pointer wakes a bot, in body widths from its centre. The
 * library starts following at 3 and faces the pointer fully inside 1.
 */
const NEAR = 3;
/** Awake this long after the pointer leaves, so the head eases back to centre. */
const NEAR_GRACE_MS = 1200;

// One pointer listener for every bot on the page, read once per frame.
const watchers = new Set<(x: number, y: number) => void>();
let pointer = { x: 0, y: 0 };
let queued = 0;
function onPointerMove(e: PointerEvent) {
  pointer = { x: e.clientX, y: e.clientY };
  queued ||= requestAnimationFrame(() => {
    queued = 0;
    watchers.forEach((fn) => fn(pointer.x, pointer.y));
  });
}
function watchPointer(fn: (x: number, y: number) => void) {
  if (!watchers.size) document.addEventListener('pointermove', onPointerMove, { passive: true });
  watchers.add(fn);
  return () => {
    watchers.delete(fn);
    if (!watchers.size) document.removeEventListener('pointermove', onPointerMove);
  };
}

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const LABELS: Record<BotState, string> = {
  idle: 'Orqestra assistant',
  working: 'Orqestra assistant, working',
  sleeping: 'Orqestra assistant, not set up',
};

export function Bot({
  state = 'idle',
  size = 32,
  interactive = true,
  className,
}: {
  state?: BotState;
  size?: number;
  /** Pointer following and hop-on-click. */
  interactive?: boolean;
  className?: string;
}) {
  const [hovered, setHovered] = useState(false);
  const settle = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(settle.current), []);

  // a state change keeps the bot moving until it has settled into the new pose
  const [shown, setShown] = useState(state);
  const [settling, setSettling] = useState(false);
  if (shown !== state) {
    setShown(state);
    setSettling(true);
  }
  useEffect(() => {
    if (!settling) return;
    const t = setTimeout(() => setSettling(false), SETTLE_MS);
    return () => clearTimeout(t);
  }, [settling, shown]);

  // a glance now and then while idle, and now and then a flip
  const [glancing, setGlancing] = useState(false);
  const [flipping, setFlipping] = useState(false);
  useEffect(() => {
    if (state !== 'idle' || reducedMotion()) return;
    let t: ReturnType<typeof setTimeout>;
    let cue: ReturnType<typeof setTimeout> | undefined;
    const rest = () => {
      t = setTimeout(glance, REST_MS[0] + Math.random() * (REST_MS[1] - REST_MS[0]));
    };
    const glance = () => {
      setGlancing(true);
      if (Math.random() < FLIP_ODDS) {
        setFlipping(true);
        cue = setTimeout(() => setFlipping(false), FLIP_CUE_MS);
      }
      t = setTimeout(() => {
        setGlancing(false);
        rest();
      }, GLANCE_MS);
    };
    rest();
    return () => {
      clearTimeout(t);
      clearTimeout(cue);
      setGlancing(false);
      setFlipping(false);
    };
  }, [state]);

  // awake while the pointer is near enough for the library to follow it
  const box = useRef<HTMLSpanElement>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    if (state === 'sleeping' || !interactive || reducedMotion()) return;
    let isNear = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const stop = watchPointer((x, y) => {
      const r = box.current?.getBoundingClientRect();
      if (!r?.width) return;
      const d = Math.hypot(x - (r.left + r.width / 2), y - (r.top + r.height / 2)) / r.width;
      if (d < NEAR) {
        clearTimeout(grace);
        if (!isNear) {
          isNear = true;
          setNear(true);
        }
      } else if (isNear) {
        isNear = false;
        grace = setTimeout(() => setNear(false), NEAR_GRACE_MS);
      }
    });
    return () => {
      stop();
      clearTimeout(grace);
      setNear(false);
    };
  }, [state, interactive]);

  const live = state === 'working' || hovered || settling || glancing || near;

  return (
    <span
      ref={box}
      className="relative inline-flex shrink-0 [&:has(canvas)>span]:hidden"
      style={{ width: size, height: size }}
    >
      {/* placeholder until the canvas arrives: same size, so nothing shifts */}
      <span
        aria-hidden
        className="absolute inset-[12%] rounded-full"
        style={{ background: BOT.color, opacity: 0.35 }}
      />
      <DitheredBotAvatar
        paused={!live}
        onPointerEnter={() => {
          clearTimeout(settle.current);
          setHovered(true);
        }}
        // a beat of grace so the glance it started can finish
        onPointerLeave={() => {
          settle.current = setTimeout(() => setHovered(false), 1500);
        }}
        type={BOT.type}
        color={BOT.color}
        saturation={BOT.saturation}
        state={state === 'idle' ? 'default' : state}
        size={size}
        theme="light"
        interactive={interactive}
        jumpEvery={flipping ? FLIP_CUE_S : 0}
        aria-label={LABELS[state]}
        className={cn('relative shrink-0', className)}
      />
    </span>
  );
}
