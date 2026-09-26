import { describe, expect, it } from 'vitest';
import { ditherCellPx, ditherLevel } from '@/components/ui/ordered-dither';

/** Mean ladder step over one 8×8 tile at a flat tone. */
function tileMean(t: number, levels: number) {
  let sum = 0;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) sum += ditherLevel(t, x, y, levels);
  return sum / 64;
}

describe('ditherLevel', () => {
  it('holds the ends: ink stays ink and paper stays paper', () => {
    for (const levels of [2, 3]) {
      expect(tileMean(0, levels)).toBe(0);
      expect(tileMean(1, levels)).toBe(levels - 1);
      expect(tileMean(-0.5, levels)).toBe(0);
      expect(tileMean(1.5, levels)).toBe(levels - 1);
    }
  });

  it('lays down as much paper as the tone asks for, in 1/64 steps', () => {
    for (const levels of [2, 3]) {
      for (const t of [0.1, 0.25, 0.5, 0.8]) {
        expect(Math.abs(tileMean(t, levels) / (levels - 1) - t)).toBeLessThanOrEqual(1 / 64);
      }
    }
  });

  it('uses one threshold per cell, repeating every 8 cells', () => {
    const tile = (ox: number, oy: number) =>
      Array.from({ length: 64 }, (_, i) => ditherLevel(0.4, ox + (i % 8), oy + Math.floor(i / 8)));
    expect(tile(8, 16)).toEqual(tile(0, 0));
    // every threshold in the matrix is distinct: 64 tones, 64 patterns
    const fills = new Set(Array.from({ length: 65 }, (_, k) => tileMean(k / 64, 2)));
    expect(fills.size).toBe(65);
  });
});

describe('ditherCellPx', () => {
  it('dots 1px on small things and 1.5px on bigger ones', () => {
    expect(ditherCellPx(16)).toBe(1);
    expect(ditherCellPx(40)).toBe(1);
    expect(ditherCellPx(48)).toBe(1.5);
    expect(ditherCellPx(96)).toBe(1.5);
  });
});
