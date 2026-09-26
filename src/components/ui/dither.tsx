'use client';

import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';

/**
 * Dithered charts (after amicro.vercel.app/dither-charts): values drawn as a
 * tight grid of ink dots (1.5px pitch with a half-pixel gap in bars, 3px in
 * columns and rings), filled or not by an 8×8 ordered Bayer threshold, so a
 * tone ramp reads as texture instead of a flat bar. Still ink-only — the
 * charts stay inside the achromatic UI (docs/09 §2).
 *
 * Each chart draws once per size/value change (no idle rAF loop), eases in
 * when it scrolls into view, tweens from its previous values on change, and
 * draws its final frame immediately under prefers-reduced-motion.
 */

/**
 * Ordered Bayer thresholds for an n×n matrix (n = 2, 4, 8), built by the
 * usual recursion: each step tiles 4·M + [0 2; 3 1]. n = 8 is the default.
 */
function bayer(n: 2 | 4 | 8) {
  let m = [[0]];
  while (m.length < n) {
    const k = m.length;
    const next: number[][] = Array.from({ length: k * 2 }, () => []);
    for (let y = 0; y < k; y++)
      for (let x = 0; x < k; x++) {
        const v = m[y][x] * 4;
        next[y][x] = v;
        next[y][x + k] = v + 2;
        next[y + k][x] = v + 3;
        next[y + k][x + k] = v + 1;
      }
    m = next;
  }
  const flat = m.flat().map((v) => (v + 0.5) / (n * n));
  return (cx: number, cy: number) => flat[(cy % n) * n + (cx % n)];
}
const MATRICES = { 2: bayer(2), 4: bayer(4), 8: bayer(8) };

// transitions.dev smooth-out, cubic-bezier(0.22, 1, 0.36, 1), close enough for a fill
const easeOut = (t: number) => 1 - Math.pow(1 - t, 4);
const ENTER_MS = 550; // tuned in the dither playground

/**
 * The dither's look, tunable per chart (the Storybook playground drives
 * these). Every field is optional; each chart keeps its own defaults.
 */
export type DitherOptions = {
  /** Grid spacing in px (1.5 in bars, 3 in columns and rings), snapped to whole device pixels. */
  pitch?: number;
  /** Space between dots in px; the dot is pitch − gap. */
  gap?: number;
  /** Bayer matrix size: 2 is coarse and patterned, 8 is smooth. */
  matrix?: 2 | 4 | 8;
  shape?: 'square' | 'round';
  /** Draw the empty dots of the track, or leave it blank. */
  track?: boolean;
  /** Dot density where the fill is lightest, 0–1 (default 0.55). */
  floor?: number;
  /** Dot density at the fill's leading edge, 0–1 (default 1). */
  peak?: number;
  /** Entrance tween length in ms. */
  enterMs?: number;
};

type Resolved = Required<DitherOptions>;

const BASE: Omit<Resolved, 'pitch' | 'floor' | 'peak'> = {
  gap: 1,
  matrix: 8,
  shape: 'square',
  track: true,
  enterMs: ENTER_MS,
};

type Surface = Resolved & {
  w: number;
  h: number;
  dot: number;
  ink: string;
  trackInk: string;
  threshold: (cx: number, cy: number) => number;
};

type Painter = (ctx: CanvasRenderingContext2D, s: Surface, progress: number, from: number[]) => void;

function readInk(el: Element) {
  const cs = getComputedStyle(el);
  return {
    ink: cs.getPropertyValue('--color-ink').trim() || '#0a0a0a',
    trackInk: cs.getPropertyValue('--color-line').trim() || 'rgb(10 10 10 / 0.07)',
  };
}

/**
 * Shared canvas plumbing: DPR scaling, resize, in-view entrance, and a tween
 * from the last values drawn. `values` is what the painter animates between.
 */
function useDither(values: number[], paint: Painter, opts: Resolved) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const shown = useRef<number[]>(values.map(() => 0));
  const frame = useRef(0);
  const seen = useRef(false);
  const key = values.join(',');
  const optsKey = JSON.stringify(opts);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const from = values.map((_, i) => shown.current[i] ?? 0);

    const draw = (progress: number) => {
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      // Whole device pixels per step and per dot, so every dot is the same
      // crisp square: a 1.5px pitch is 3 pixels on a 2× screen, and becomes
      // 2 (with a 1px dot) on a 1× one rather than a blur.
      const pitch = Math.max(2, Math.round(opts.pitch * dpr)) / dpr;
      const surface: Surface = {
        ...opts,
        pitch,
        w,
        h,
        dot: Math.max(1, Math.floor((opts.pitch - opts.gap) * dpr)) / dpr,
        threshold: MATRICES[opts.matrix],
        ...readInk(canvas),
      };
      paint(ctx, surface, progress, from);
      shown.current = values.map((v, i) => from[i] + (v - from[i]) * progress);
    };

    const run = () => {
      cancelAnimationFrame(frame.current);
      if (reduced) return draw(1);
      const start = performance.now();
      const tick = (now: number) => {
        const t = opts.enterMs > 0 ? Math.min(1, (now - start) / opts.enterMs) : 1;
        draw(easeOut(t));
        if (t < 1) frame.current = requestAnimationFrame(tick);
      };
      frame.current = requestAnimationFrame(tick);
    };

    // First reveal waits until the chart is on screen; later changes tween immediately.
    let io: IntersectionObserver | undefined;
    if (seen.current) run();
    else {
      draw(0);
      io = new IntersectionObserver(
        ([entry]) => {
          if (!entry?.isIntersecting) return;
          seen.current = true;
          io?.disconnect();
          run();
        },
        { threshold: 0.2 },
      );
      io.observe(canvas);
    }

    const ro = new ResizeObserver(() => draw(seen.current ? 1 : 0));
    ro.observe(canvas);
    return () => {
      io?.disconnect();
      ro.disconnect();
      cancelAnimationFrame(frame.current);
    };
    // `key`/`optsKey` stand in for `values`/`opts`; the painter only closes over those
  }, [key, optsKey]);

  return canvasRef;
}

/** Fill one cell of the grid; `tone` 0–1 is dot density at that cell. */
function cell(ctx: CanvasRenderingContext2D, x: number, y: number, s: Surface, tone: number) {
  const cx = Math.round(x / s.pitch);
  const cy = Math.round(y / s.pitch);
  const on = tone > s.threshold(cx, cy);
  if (!on && !s.track) return;
  ctx.fillStyle = on ? s.ink : s.trackInk;
  if (s.shape === 'round') {
    ctx.beginPath();
    ctx.arc(x + s.dot / 2, y + s.dot / 2, s.dot / 2, 0, Math.PI * 2);
    ctx.fill();
  } else ctx.fillRect(x, y, s.dot, s.dot);
}

/** A tone between the chart's floor and peak, t 0–1. */
const ramp = (s: Surface, t: number) => s.floor + (s.peak - s.floor) * t;

/**
 * Horizontal bar: a dotted track with a dithered fill that densifies toward
 * the value's leading edge.
 */
export function DitherBar({
  value,
  max,
  height = 8,
  label,
  dither,
  className,
}: {
  value: number;
  max: number;
  height?: number;
  dither?: DitherOptions;
  /** Accessible description; defaults to "value of max". */
  label?: string;
  className?: string;
}) {
  const ratio = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  const ref = useDither(
    [ratio],
    (ctx, s, p, from) => {
      const r = from[0] + (ratio - from[0]) * p;
      const end = s.w * r;
      for (let x = 0; x < s.w; x += s.pitch) {
        const inFill = x < end;
        // floor at the start → peak at the leading edge
        const tone = inFill ? ramp(s, end > 0 ? x / end : 0) : 0;
        for (let y = 0; y < s.h; y += s.pitch) cell(ctx, x, y, s, tone);
      }
    },
    // A finer grid and a lighter ramp than columns and rings: bars stack in
    // lists (stage pass-through, match scores), where solid ink at every
    // leading edge read as a wall of black.
    { ...BASE, pitch: 1.5, gap: 0.5, floor: 0.25, peak: 0.7, ...dither },
  );
  return (
    <canvas
      ref={ref}
      role="img"
      aria-label={label ?? `${value} of ${max}`}
      className={cn('block w-full', className)}
      style={{ height }}
    />
  );
}

/**
 * Vertical columns: one dithered column per datum, darkest at the top of
 * each column. Labels render as HTML under the canvas for crisp type.
 */
export function DitherColumns({
  data,
  height = 120,
  unit = '',
  dither,
  className,
}: {
  data: { label: string; value: number | null }[];
  dither?: DitherOptions;
  height?: number;
  /** Suffix for each value ("d", "%"). A string, not a formatter, so server pages can pass it. */
  unit?: string;
  className?: string;
}) {
  const max = Math.max(1, ...data.map((d) => d.value ?? 0));
  const ratios = data.map((d) => (d.value ?? 0) / max);
  const ref = useDither(
    ratios,
    (ctx, s, p, from) => {
      const n = ratios.length || 1;
      const gap = 12;
      const colW = (s.w - gap * (n - 1)) / n;
      ratios.forEach((ratio, i) => {
        const r = from[i] + (ratio - from[i]) * p;
        const x0 = i * (colW + gap);
        const top = s.h - s.h * r;
        for (let x = x0; x < x0 + colW - s.dot; x += s.pitch) {
          for (let y = 0; y < s.h; y += s.pitch) {
            const inFill = y >= top;
            // peak at the column's top edge, thinning to floor at the base
            const tone = inFill ? ramp(s, 1 - (y - top) / Math.max(1, s.h - top)) : 0;
            cell(ctx, x, y, s, tone);
          }
        }
      });
    },
    { ...BASE, pitch: 3, floor: 0.55, peak: 1, ...dither },
  );
  return (
    <div className={className}>
      <canvas
        ref={ref}
        role="img"
        aria-label={data.map((d) => `${d.label}: ${d.value ?? 'no data'}`).join(', ')}
        className="block w-full"
        style={{ height }}
      />
      <div
        className="mt-2 grid gap-3"
        style={{ gridTemplateColumns: `repeat(${data.length || 1}, minmax(0, 1fr))` }}
      >
        {data.map((d) => (
          <div key={d.label} className="min-w-0">
            <p className="text-sm text-ink tabular-nums">{d.value !== null ? `${d.value}${unit}` : '—'}</p>
            <p className="truncate text-xs text-ink-2">{d.label}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Ring: completion drawn as a dithered arc, for progress and rates. */
export function DitherRing({
  value,
  max = 100,
  size = 64,
  thickness = 10,
  label,
  dither,
  children,
  className,
}: {
  value: number;
  max?: number;
  size?: number;
  thickness?: number;
  dither?: DitherOptions;
  label?: string;
  children?: React.ReactNode;
  className?: string;
}) {
  const ratio = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  const ref = useDither(
    [ratio],
    (ctx, s, p, from) => {
      const r = from[0] + (ratio - from[0]) * p;
      const cx = s.w / 2;
      const cy = s.h / 2;
      const outer = Math.min(s.w, s.h) / 2;
      const inner = outer - thickness;
      for (let x = 0; x < s.w; x += s.pitch) {
        for (let y = 0; y < s.h; y += s.pitch) {
          const dx = x + s.dot / 2 - cx;
          const dy = y + s.dot / 2 - cy;
          const d = Math.hypot(dx, dy);
          if (d > outer || d < inner) continue;
          // angle from 12 o'clock, clockwise, 0–1
          const a = (Math.atan2(dx, -dy) / (2 * Math.PI) + 1) % 1;
          const tone = a <= r ? ramp(s, r > 0 ? a / r : 0) : 0;
          cell(ctx, x, y, s, tone);
        }
      }
    },
    { ...BASE, pitch: 3, floor: 0.5, peak: 1, ...dither },
  );
  return (
    <span className={cn('relative inline-flex items-center justify-center', className)} style={{ width: size, height: size }}>
      <canvas
        ref={ref}
        role="img"
        aria-label={label ?? `${Math.round(ratio * 100)}%`}
        className="absolute inset-0 size-full"
      />
      {children ? <span className="relative">{children}</span> : null}
    </span>
  );
}
