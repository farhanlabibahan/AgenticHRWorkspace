/**
 * Orb identity data, kept out of the 'use client' orb module so server
 * components can read it (a value imported from a client module arrives as
 * a client reference, not the object).
 */

/** Ink (shadow tone) and paper (lit tone) per identity, sampled from the reference hues. */
export const ORB_PALETTES = {
  ember: { ink: '#3a1a12', paper: '#f2a58f' },
  lavender: { ink: '#1f1850', paper: '#d9d3fb' },
  iris: { ink: '#141848', paper: '#a9c8f4' },
  prism: { ink: '#3a2410', paper: '#f6d68e' },
  glacier: { ink: '#101426', paper: '#cfe6ff' },
  sage: { ink: '#122418', paper: '#c9ddc2' },
} as const;

export type OrbPalette = keyof typeof ORB_PALETTES;
const PALETTE_KEYS = Object.keys(ORB_PALETTES) as OrbPalette[];

function hash(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic palette + light angle for a seed. */
export function orbFor(seed: string): { palette: OrbPalette; angle: number } {
  const h = hash(seed || 'source');
  return { palette: PALETTE_KEYS[h % PALETTE_KEYS.length], angle: (h >>> 8) % 360 };
}
