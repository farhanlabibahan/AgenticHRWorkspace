import { describe, expect, it } from 'vitest';
import { brandColorWarning, brandVars, contrast, EMPTY_BRAND, palette, readBrand, textOn } from '@/lib/brand';

describe('readBrand', () => {
  it('keeps only known fonts, sizes and #rrggbb colors', () => {
    expect(readBrand({ font: 'inter', textSize: 'lg', color: '#FF5500', background: ' #101010 ' })).toEqual({
      font: 'inter',
      textSize: 'lg',
      color: '#ff5500',
      background: '#101010',
    });
    expect(readBrand({ font: 'comic-sans', textSize: 'huge', color: 'red', background: '#fff' })).toEqual(EMPTY_BRAND);
    expect(readBrand(null)).toEqual(EMPTY_BRAND);
  });
});

describe('colors', () => {
  it('puts near-black on light colors and white on dark ones', () => {
    expect(textOn('#ffd400')).toBe('#0a0a0a');
    expect(textOn('#1d4ed8')).toBe('#ffffff');
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 0);
  });

  it('derives readable text from any background', () => {
    for (const bg of ['#ffffff', '#fdf6e3', '#0b1220', '#2d1b69', '#777777']) {
      const p = palette(bg);
      expect(contrast(p.ink, p.canvas), bg).toBeGreaterThanOrEqual(4.5);
      expect(contrast(p.ink2, p.canvas), bg).toBeGreaterThanOrEqual(3);
    }
  });

  it('warns only when buttons would nearly vanish into the page', () => {
    expect(brandColorWarning({ ...EMPTY_BRAND, color: '#f2f1ef' })).toMatch(/hard to see/);
    expect(brandColorWarning({ ...EMPTY_BRAND, color: '#1d4ed8' })).toBeNull();
    expect(brandColorWarning({ ...EMPTY_BRAND, color: '#1d4ed8', background: '#1e40af' })).toMatch(/hard to see/);
  });
});

describe('brandVars', () => {
  it('is empty for the default brand', () => {
    expect(brandVars(EMPTY_BRAND)).toEqual({});
  });

  it('sets the brand color, the text on it, the font and the scale', () => {
    const vars = brandVars({ font: 'lora', textSize: 'lg', color: '#1d4ed8', background: null }, '--font-brand-lora');
    expect(vars['--color-brand']).toBe('#1d4ed8');
    expect(vars['--color-on-brand']).toBe('#ffffff');
    expect(vars['--font-sans']).toBe('var(--font-brand-lora), Georgia, "Times New Roman", serif');
    expect(vars['--text-md']).toBe('18px');
    expect(vars['--text-md--line-height']).toBe('28px');
    expect(vars['--color-canvas']).toBeUndefined();
  });

  it('keeps buttons ink on a custom background without a brand color', () => {
    const vars = brandVars({ ...EMPTY_BRAND, background: '#0b1220' });
    expect(vars['--color-ink']).toBe('#f5f4f2');
    expect(vars['--color-brand']).toBe('#f5f4f2');
    expect(vars['--color-on-brand']).toBe('#0b1220');
  });
});
