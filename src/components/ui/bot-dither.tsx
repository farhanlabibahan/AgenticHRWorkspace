'use client';

import { useCallback, useLayoutEffect, useRef } from 'react';
import {
  BotAvatar,
  BOT_AVATAR_OVERSCAN,
  BOT_AVATAR_RISE,
  parseColor,
  type BotAvatarProps,
} from 'bot-avatars';
import { ORB_PALETTES } from '@/components/ui/orb-palettes';
import { ditherCellPx, ditherLevel } from '@/components/ui/ordered-dither';

/**
 * The bot, dithered like the orb. bot-avatars renders the live 3D form
 * (pose, plastic shading, face, pointer play) into its own canvas, which
 * stays in the page at opacity 0 so it keeps the layout, the accessible
 * name and the pointer events. Each frame it draws is read back and drawn
 * again in a canvas over it: an ordered dither through the orb's 8×8 Bayer
 * matrix, one dot per orb-sized cell, with a crisp cell-edged silhouette.
 *
 * The tones: the lavender orb's ink for the shadow side and the face, its
 * paper for the lit side, and the bot's own colour as a middle step between
 * them (SHDR-14's three-step ladder). Two tones alone flattened the form
 * and lost the face in the dots at 16–32px, where most bots live.
 *
 * When to dither: exactly when the library draws. Each of its frames begins
 * with one `clearRect` on its canvas, so the context is wrapped to queue a
 * microtask per frame; the microtask runs once the frame is drawn and
 * before the browser paints. So the dither never lags a frame, adds no
 * loop of its own, and an idle (paused) bot, which draws only when it
 * re-renders, costs nothing between renders. This leans on how
 * bot-avatars 0.1.1 draws; the version is pinned.
 */

type Rgb = readonly [number, number, number];

const hex = (c: string): Rgb => parseColor(c) ?? [0, 0, 0];
const INK = hex(ORB_PALETTES.lavender.ink);
const PAPER = hex(ORB_PALETTES.lavender.paper);

/**
 * The face is drawn in pure green. Nothing on a lavender body is green, so
 * a pixel's lead of green over red and blue says how much of it is face,
 * however dark the shading around it gets.
 */
const FACE_KEY = '#00ff00';
/** The key's own luma, taken back out of face-edged cells. */
const KEY_LUMA = 0.7152;
/** A cell that is at least this much face (by covered area) is face. */
const FACE_MIN = 0.3;

/**
 * Body tone: the plastic's luma (sRGB, 0–1) onto the ladder. Lit as below,
 * it runs from about 0.16 at the far rim to 0.9 at the hot spot, with most
 * of the front at 0.45–0.65. So the rim and the far side fall to ink dots
 * (solid past TONE_LO), the front sits on the body colour with a scatter of
 * paper, and the lit shoulder dithers up to paper.
 */
const TONE_LO = 0.25;
const TONE_HI = 0.85;
/** Lit from the upper left, as the orb is, with a deeper shadow side than
 * the library's default so the ladder has a form to follow. */
const LIGHT = { light: 315, shadow: 1 } as const;

type Dither = {
  ladder: Rgb[];
  out: HTMLCanvasElement | null;
  img: ImageData | null;
};

/** Dither the library's current frame into `s.out`. */
function ditherFrame(src: CanvasRenderingContext2D, s: Dither) {
  const out = s.out;
  const D = src.canvas.width;
  if (!out || !D) return;
  // the library sizes its canvas box × OVERSCAN × dpr, with dpr capped at 2
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const box = D / (BOT_AVATAR_OVERSCAN * dpr);
  // whole device pixels per cell, so every dot is the same crisp square;
  // the canvas is one pixel per cell, scaled up pixelated
  const k = Math.max(1, Math.round(ditherCellPx(box) * dpr));
  const n = Math.floor(D / k);
  const W = n * k;
  if (out.width !== n) {
    out.width = out.height = n;
    out.style.width = out.style.height = `${W / dpr}px`;
    s.img = null;
  }
  const octx = out.getContext('2d');
  if (!octx) return;
  const img = (s.img ??= octx.createImageData(n, n));
  const o = img.data;
  const px = src.getImageData(0, 0, W, W).data;
  const half = (255 * k * k) / 2;
  const { ladder } = s;

  for (let cy = 0; cy < n; cy++) {
    for (let cx = 0; cx < n; cx++) {
      // box-filter the cell: coverage, how much of it is face, body luma
      let a = 0;
      let face = 0;
      let luma = 0;
      for (let y = cy * k, y1 = y + k; y < y1; y++) {
        for (let p = (y * W + cx * k) * 4, p1 = p + k * 4; p < p1; p += 4) {
          const al = px[p + 3];
          if (!al) continue;
          const r = px[p];
          const g = px[p + 1];
          const b = px[p + 2];
          const lead = g - (r > b ? r : b);
          const m = lead > 0 ? lead / 255 : 0;
          a += al;
          face += al * m;
          // take the key's share out of the luma, leaving the body's
          luma += al * ((0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 - m * KEY_LUMA);
        }
      }
      const q = (cy * n + cx) * 4;
      // the silhouette is cut on the cell grid: a cell is in or out
      if (a < half) {
        o[q + 3] = 0;
        continue;
      }
      let c = INK;
      if (face < FACE_MIN * a) {
        let t = (luma / (a - face) - TONE_LO) / (TONE_HI - TONE_LO);
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        c = ladder[ditherLevel(t, cx, cy, ladder.length)];
      }
      o[q] = c[0];
      o[q + 1] = c[1];
      o[q + 2] = c[2];
      o[q + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
}

type Props = Omit<BotAvatarProps, 'size' | 'color' | 'ink' | 'style'> & {
  size: number;
  /** The body colour, and the dither's middle step. */
  color: string;
};

export function DitheredBotAvatar({ size, color, ...props }: Props) {
  const dither = useRef<Dither>({ ladder: [INK, hex(color), PAPER], out: null, img: null });
  // Frames are dithered in a microtask after the commit, so a new colour is
  // in place before the frame the library drew with it is dithered.
  useLayoutEffect(() => {
    dither.current.ladder = [INK, hex(color), PAPER];
  }, [color]);

  // Handed the canvas in the library's layout phase, ahead of its first
  // draw: the context is made here (CPU-backed, as it's read back every
  // frame) and its clearRect wrapped. Called again on every render.
  const hooked = useRef<HTMLCanvasElement | null>(null);
  const attach = useCallback((canvas: HTMLCanvasElement | null) => {
    if (!canvas || hooked.current === canvas) return;
    hooked.current = canvas;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    const clearRect = ctx.clearRect;
    let queued = false;
    const flush = () => {
      queued = false;
      if (hooked.current === canvas) ditherFrame(ctx, dither.current);
    };
    ctx.clearRect = (x, y, w, h) => {
      if (!queued) {
        queued = true;
        queueMicrotask(flush);
      }
      clearRect.call(ctx, x, y, w, h);
    };
  }, []);

  const bleed = (BOT_AVATAR_OVERSCAN - 1) / 2;
  return (
    <>
      <BotAvatar
        ref={attach}
        {...LIGHT}
        {...props}
        size={size}
        color={color}
        ink={FACE_KEY}
        style={{ opacity: 0 }}
      />
      <canvas
        ref={(el) => {
          dither.current.out = el;
        }}
        // sized by the first frame
        width={0}
        height={0}
        aria-hidden
        className="pointer-events-none absolute [image-rendering:pixelated]"
        // over the library's canvas, which pulls itself back by its bleed
        style={{ left: -size * bleed, top: -size * (bleed + BOT_AVATAR_RISE) }}
      />
    </>
  );
}
