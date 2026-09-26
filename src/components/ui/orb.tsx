'use client';

import { useSyncExternalStore } from 'react';
import { cn } from '@/lib/utils';
import { Shdr14 } from '@/components/ui/shdr-14';

/**
 * The orb — Orbkit's SHDR-14 (a lit plasma dome dithered to two tones
 * through an 8×8 ordered Bayer matrix), the one place color lives in the
 * interface (docs/09 §2). Seeded from an entity id so a posting or
 * candidate always wears the same ink/paper pair.
 *
 * Two renderers, one look:
 * - animate and ≥ 64px — the live WebGL shader (hero, focal moments).
 * - everything else — a still dithered sphere on a 2D canvas, rendered once
 *   per look and shared. Lists and avatars can hold dozens of orbs, and
 *   browsers cap live WebGL contexts at ~16 per page, so only orbs that
 *   actually move take one.
 */

import { ORB_PALETTES, orbFor, type OrbPalette } from '@/components/ui/orb-palettes';
import { ditherCellPx, ditherLevel } from '@/components/ui/ordered-dither';

export { ORB_PALETTES, orbFor, type OrbPalette };

/** Size at and above which the orb is the live shader. */
const LIVE_MIN = 64;

/**
 * The orb's dither, tunable (the Storybook playground drives this). Only
 * `cellPx` reaches the still orb; the rest are SHDR-14 shader params and
 * apply to the live orb.
 */
export type OrbDither = {
  /** Dither cell size in CSS px (default ~1.5, 2 on big focal orbs). */
  cellPx?: number;
  /** Tone steps between ink and paper; 2 is pure 1-bit. */
  levels?: number;
  contrast?: number;
  /** Brightness. */
  gain?: number;
  /** Key light strength. */
  light?: number;
  /** Rim light strength. */
  rim?: number;
  /** Plasma wave amount. */
  plasma?: number;
  /** Plasma wave speed. */
  speed?: number;
};

/** Rendered small orbs as image URLs, shared by every instance with the same look. */
const stillCache = new Map<string, string>();
const subscribeNoop = () => () => {};

/**
 * Draw one still orb into an offscreen canvas: a lambert-lit sphere with a
 * faint plasma ripple and a rim, quantized to ink/paper per cell — SHDR-14
 * as a still frame. Cells are collected into two paths and filled twice,
 * rather than one fillRect per cell.
 */
function renderStill(
  ink: string,
  paper: string,
  size: number,
  angle: number,
  soft: boolean,
  dpr: number,
  cellOverride?: number,
) {
  const canvas = document.createElement('canvas');
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  ctx.scale(dpr, dpr);

  const cellPx = cellOverride ?? ditherCellPx(size);
  const n = Math.max(8, Math.round(size / cellPx));
  const c = size / n;
  const w = Math.ceil(c);
  const a = (angle * Math.PI) / 180;
  // light from the upper-left quadrant, nudged by the seed
  const L = [Math.cos(a) * 0.35 - 0.45, -0.55 + Math.sin(a) * 0.2, 0.7];
  const len = Math.hypot(L[0], L[1], L[2]);
  const inkCells = new Path2D();
  const paperCells = new Path2D();
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = ((i + 0.5) / n) * 2 - 1;
      const y = ((j + 0.5) / n) * 2 - 1;
      const r2 = x * x + y * y;
      if (r2 > 1) continue;
      const z = Math.sqrt(1 - r2);
      const lambert = Math.max(0, (x * L[0] + y * L[1] + z * L[2]) / len);
      const plasma = 0.5 + 0.5 * Math.sin(x * 3.1 + a) * Math.sin(y * 2.7 - a * 0.7 + z * 2.0);
      const rim = Math.pow(1 - z, 3);
      let lum = 0.15 + 0.7 * lambert + 0.18 * (plasma - 0.5) + 0.35 * rim;
      // soft (avatars): mostly paper, ink only in the deepest shadow, so initials read;
      // small avatars at 1x have few cells, so they lean harder toward paper
      if (soft) lum = size <= 32 ? 0.86 + lum * 0.2 : 0.8 + lum * 0.3;
      (ditherLevel(lum, i, j) ? paperCells : inkCells).rect(i * c, j * c, w, w);
    }
  }
  ctx.fillStyle = ink;
  ctx.fill(inkCells);
  ctx.fillStyle = paper;
  ctx.fill(paperCells);
  return canvas;
}

/**
 * The small orb. Its light angle snaps to one of eight directions, so a
 * 100-row table of distinct people resolves to a few dozen shared renders
 * (6 palettes × 8 angles per size). Each render becomes an image URL once,
 * and every orb after that is a plain <img> of it: mounting a row costs no
 * canvas, context or draw (a canvas per row was the largest cost of
 * mounting and scrolling a long list).
 */
function StaticDitherOrb({
  ink,
  paper,
  size,
  angle,
  soft,
  cellPx,
}: {
  ink: string;
  paper: string;
  size: number;
  angle: number;
  soft: boolean;
  cellPx?: number;
}) {
  // Drawn in the browser only: the server's HTML (and hydrating it) has no
  // orb yet, as the canvas it replaces had none.
  const client = useSyncExternalStore(subscribeNoop, () => true, () => false);
  if (!client) return null;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const snapped = (Math.round(angle / 45) % 8) * 45;
  const key = `${ink}|${paper}|${size}|${snapped}|${soft ? 1 : 0}|${dpr}|${cellPx ?? ''}`;
  let src = stillCache.get(key);
  if (!src) {
    src = renderStill(ink, paper, size, snapped, soft, dpr, cellPx).toDataURL();
    stillCache.set(key, src);
  }
  // eslint-disable-next-line @next/next/no-img-element -- a generated data URL, not an asset
  return <img src={src} alt="" aria-hidden draggable={false} className="absolute inset-0 size-full" />;
}

export function Orb({
  seed = '',
  palette,
  size = 64,
  soft = false,
  animate = false,
  dither,
  className,
  children,
}: {
  /** Entity id or name — picks palette and light angle deterministically. */
  seed?: string;
  /** Force a palette instead of deriving it from the seed. */
  palette?: OrbPalette;
  size?: number;
  /** Paper-heavy variant for avatars, so initials stay legible. */
  soft?: boolean;
  /** Animate (≥64px only). Without it the orb is a still frame and takes no WebGL context. */
  animate?: boolean;
  /** Override the dither's look; see OrbDither. */
  dither?: OrbDither;
  className?: string;
  children?: React.ReactNode;
}) {
  const derived = orbFor(seed);
  const { cellPx, ...shader } = dither ?? {};
  const shaderParams = Object.fromEntries(
    Object.entries(shader).filter(([, v]) => v !== undefined),
  ) as Record<string, number>;
  const colors = ORB_PALETTES[palette ?? derived.palette];
  // WebGL only when it moves: a still orb of any size takes the 2D path
  const live = animate && size >= LIVE_MIN && !soft;

  return (
    <span
      aria-hidden={children ? undefined : true}
      className={cn(
        'relative isolate inline-flex shrink-0 items-center justify-center rounded-full',
        className,
      )}
      style={{ width: size, height: size }}
    >
      {live ? (
        <Shdr14
          size={size}
          colors={colors}
          // Tight dither: ~1.5px cells. Big focal orbs render at 1x with 2px cells —
          // the dither is chunkier than a device pixel anyway, so retina resolution
          // would only quadruple the fill cost for no visible gain.
          params={{
            cells: Math.round(Math.min(600, Math.max(48, size / (cellPx ?? (size >= 300 ? 2 : 1.5))))),
            ...shaderParams,
          }}
          maxDpr={size >= 300 ? 1 : 2}
          paused={!animate}
          className="absolute! inset-0"
        />
      ) : (
        <StaticDitherOrb {...colors} size={size} angle={derived.angle} soft={soft} cellPx={cellPx} />
      )}
      {children ? <span className="relative z-[1]">{children}</span> : null}
    </span>
  );
}

/** Person avatar: a soft dithered orb carrying initials (docs/09 §8). */
export function Avatar({
  name,
  seed,
  size = 32,
  className,
}: {
  name: string;
  seed?: string;
  size?: number;
  className?: string;
}) {
  const initials =
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase() ?? '')
      .join('') || '?';
  return (
    <Orb seed={seed ?? name} size={size} soft className={className}>
      <span
        className="font-medium text-ink"
        style={{ fontSize: Math.max(10, Math.round(size * 0.36)), lineHeight: 1 }}
      >
        {initials}
      </span>
    </Orb>
  );
}
