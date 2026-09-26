/**
 * The ordered dither the brand's dithered surfaces share: the still orb
 * (orb.tsx) and the assistant bot (bot-dither.tsx). SHDR-14, the live orb,
 * builds the same 8×8 matrix procedurally in its shader, so every dot field
 * in the interface sits on one pattern.
 */

/**
 * Dither cell size in CSS px for something `size` px wide: tight, to match
 * the live shader's ~1.5px cells. The still orb and the bot both use it, so
 * an orb and a bot of one size show one dot.
 */
export function ditherCellPx(size: number) {
  return size <= 40 ? 1 : 1.5;
}

/** 8×8 ordered Bayer thresholds, row-major, each in (0, 1). */
const BAYER8: readonly number[] = (() => {
  const m: number[] = [];
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) {
      let v = 0;
      for (let bit = 0, xx = x, yy = y; bit < 3; bit++, xx >>= 1, yy >>= 1)
        v |= (((xx ^ yy) & 1) << (2 * (2 - bit) + 1)) | ((yy & 1) << (2 * (2 - bit)));
      m.push((v + 0.5) / 64);
    }
  return m;
})();

/**
 * One cell's step on the tone ladder. `t` runs from ink (0) to paper (1);
 * the result is 0 … levels − 1. Two levels is the pure 1-bit look (paper
 * where `t` clears the cell's threshold); more add mid tones between, the
 * way SHDR-14's `levels` does, and keep the grain.
 */
export function ditherLevel(t: number, x: number, y: number, levels = 2): number {
  const steps = levels - 1;
  const q = Math.floor(t * steps + 1 - BAYER8[(y & 7) * 8 + (x & 7)]);
  return q < 0 ? 0 : q > steps ? steps : q;
}
