/**
 * An organization's brand kit (Organization.brand): a font, a text size, a
 * brand color and a background, applied to what candidates see (the job
 * board, the application form and emails to candidates). The logo is the
 * organization's logo. Everything is optional; unset means Source's own
 * look. Read defensively: the column is JSON.
 *
 * Only the brand color and the background are chosen. Every other shade
 * (text, cards, fields, lines) is derived from the background, so a dark
 * background can't leave dark text on it, and the text on a button is
 * whichever of near-black or white reads better on the brand color.
 */

export const BRAND_FONTS = [
  { id: 'geist', label: 'Geist', stack: 'Geist, Helvetica, Arial, sans-serif' },
  { id: 'inter', label: 'Inter', stack: 'Inter, Helvetica, Arial, sans-serif' },
  { id: 'dm-sans', label: 'DM Sans', stack: '"DM Sans", Helvetica, Arial, sans-serif' },
  { id: 'ibm-plex-sans', label: 'IBM Plex Sans', stack: '"IBM Plex Sans", Helvetica, Arial, sans-serif' },
  { id: 'manrope', label: 'Manrope', stack: 'Manrope, Helvetica, Arial, sans-serif' },
  { id: 'work-sans', label: 'Work Sans', stack: '"Work Sans", Helvetica, Arial, sans-serif' },
  { id: 'space-grotesk', label: 'Space Grotesk', stack: '"Space Grotesk", Helvetica, Arial, sans-serif' },
  { id: 'source-serif', label: 'Source Serif', stack: '"Source Serif 4", Georgia, "Times New Roman", serif' },
  { id: 'lora', label: 'Lora', stack: 'Lora, Georgia, "Times New Roman", serif' },
  { id: 'fraunces', label: 'Fraunces', stack: 'Fraunces, Georgia, "Times New Roman", serif' },
] as const;

export type BrandFontId = (typeof BRAND_FONTS)[number]['id'];

export const TEXT_SIZES = [
  { id: 'sm', label: 'Small', scale: 0.9375 },
  { id: 'md', label: 'Default', scale: 1 },
  { id: 'lg', label: 'Large', scale: 1.125 },
] as const;

export type TextSizeId = (typeof TEXT_SIZES)[number]['id'];

export type Brand = {
  font: BrandFontId | null;
  textSize: TextSizeId;
  /** Buttons and highlights, as #rrggbb. */
  color: string | null;
  /** The page, as #rrggbb. */
  background: string | null;
};

export const EMPTY_BRAND: Brand = { font: null, textSize: 'md', color: null, background: null };

const HEX = /^#[0-9a-f]{6}$/i;

export function readBrand(raw: unknown): Brand {
  if (!raw || typeof raw !== 'object') return EMPTY_BRAND;
  const r = raw as Record<string, unknown>;
  const font = BRAND_FONTS.find((f) => f.id === r.font)?.id ?? null;
  const textSize = TEXT_SIZES.find((t) => t.id === r.textSize)?.id ?? 'md';
  const hex = (v: unknown) => (typeof v === 'string' && HEX.test(v.trim()) ? v.trim().toLowerCase() : null);
  return { font, textSize, color: hex(r.color), background: hex(r.background) };
}

export const isDefaultBrand = (b: Brand) => !b.font && b.textSize === 'md' && !b.color && !b.background;

// ---------- color ----------

type Rgb = [number, number, number];

const rgb = (hex: string): Rgb => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
const toHex = (c: Rgb) => `#${c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;

/** `a` with `amount` (0–1) of `b` mixed in, in sRGB. */
export function mix(a: string, b: string, amount: number): string {
  const [x, y] = [rgb(a), rgb(b)];
  return toHex(x.map((v, i) => v + (y[i] - v) * amount) as Rgb);
}

/** WCAG relative luminance, 0–1. */
export function luminance(hex: string): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = rgb(hex).map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two colors, 1–21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const INK = '#0a0a0a';
const PAPER = '#ffffff';

/** Near-black or white, whichever reads better on `hex`. */
export const textOn = (hex: string) => (contrast(hex, INK) >= contrast(hex, PAPER) ? INK : PAPER);

/**
 * The whole palette, derived from the background. Text is Source's usual
 * near-black or off-white; on a mid-tone background where that falls short
 * of 4.5:1, it's pure black or white, and one of them always reaches it.
 */
export function palette(background: string) {
  const preferred = textOn(background) === INK ? INK : '#f5f4f2';
  const ink =
    contrast(preferred, background) >= 4.5
      ? preferred
      : contrast('#000000', background) >= contrast('#ffffff', background)
        ? '#000000'
        : '#ffffff';
  const light = luminance(ink) < 0.5;
  return {
    canvas: background,
    surface: light ? mix(background, '#ffffff', 0.7) : mix(background, '#ffffff', 0.07),
    muted: light ? mix(background, '#000000', 0.03) : mix(background, '#ffffff', 0.11),
    recessed: light ? mix(background, '#000000', 0.06) : mix(background, '#ffffff', 0.14),
    ink,
    ink2: mix(ink, background, 0.38),
    ink3: mix(ink, background, 0.55),
    line: light ? 'rgb(10 10 10 / 0.07)' : 'rgb(255 255 255 / 0.08)',
    lineStrong: light ? 'rgb(10 10 10 / 0.14)' : 'rgb(255 255 255 / 0.14)',
  };
}

// ---------- CSS ----------

/** The type scale's steps (globals.css): size and line height in px. */
const TYPE_STEPS: [name: string, size: number, lineHeight: number][] = [
  ['2xs', 11, 16],
  ['xs', 12, 16],
  ['sm', 13, 20],
  ['base', 14, 20],
  ['md', 16, 24],
  ['lg', 18, 24],
  ['xl', 20, 28],
  ['2xl', 24, 32],
  ['3xl', 32, 36],
  ['4xl', 44, 48],
];

/**
 * The CSS variables that put a brand on a subtree: set them on its root
 * element. `fontVariable` is the CSS variable next/font gave the chosen font.
 */
export function brandVars(brand: Brand, fontVariable?: string): Record<string, string> {
  const vars: Record<string, string> = {};
  if (brand.background) {
    const p = palette(brand.background);
    Object.assign(vars, {
      '--color-canvas': p.canvas,
      '--color-surface': p.surface,
      '--color-muted': p.muted,
      '--color-recessed': p.recessed,
      '--color-ink': p.ink,
      '--color-ink-2': p.ink2,
      '--color-ink-3': p.ink3,
      '--color-line': p.line,
      '--color-line-strong': p.lineStrong,
    });
  }
  if (brand.color) {
    vars['--color-brand'] = brand.color;
    vars['--color-on-brand'] = textOn(brand.color);
  } else if (brand.background) {
    // no brand color: buttons stay ink, which the background just changed
    vars['--color-brand'] = vars['--color-ink'];
    vars['--color-on-brand'] = vars['--color-canvas'];
  }
  if (brand.font && fontVariable) {
    const stack = BRAND_FONTS.find((f) => f.id === brand.font)!.stack.split(', ').slice(1).join(', ');
    vars['--font-sans'] = `var(${fontVariable}), ${stack}`;
  }
  const scale = TEXT_SIZES.find((t) => t.id === brand.textSize)!.scale;
  if (scale !== 1) {
    for (const [name, size, lh] of TYPE_STEPS) {
      vars[`--text-${name}`] = `${+(size * scale).toFixed(2)}px`;
      vars[`--text-${name}--line-height`] = `${Math.round((lh * scale) / 2) * 2}px`;
    }
  }
  return vars;
}

/** Why the brand color may be hard to see on the page, or null when it reads fine. */
export function brandColorWarning(brand: Brand): string | null {
  if (!brand.color) return null;
  const page = brand.background ?? '#f5f4f2';
  return contrast(brand.color, page) < 1.6 ? 'Buttons in this color will be hard to see on the background.' : null;
}
