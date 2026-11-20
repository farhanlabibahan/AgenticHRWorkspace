import localFont from 'next/font/local';
import type { BrandFontId } from '@/lib/brand';
import { geist } from './fonts';

/** Brand font files live in the repository, so builds never fetch Google. */
const inter = localFont({ src: '../../public/fonts/brand/inter-latin-wght-normal.woff2', weight: '100 900', display: 'swap', preload: false, variable: '--font-brand-inter' });
const dmSans = localFont({ src: '../../public/fonts/brand/dm-sans-latin-wght-normal.woff2', weight: '100 900', display: 'swap', preload: false, variable: '--font-brand-dm-sans' });
const plex = localFont({
  src: [
    { path: '../../public/fonts/brand/ibm-plex-sans-latin-400-normal.woff2', weight: '400' },
    { path: '../../public/fonts/brand/ibm-plex-sans-latin-500-normal.woff2', weight: '500' },
    { path: '../../public/fonts/brand/ibm-plex-sans-latin-700-normal.woff2', weight: '700' },
  ],
  display: 'swap', preload: false, variable: '--font-brand-plex',
});
const manrope = localFont({ src: '../../public/fonts/brand/manrope-latin-wght-normal.woff2', weight: '100 900', display: 'swap', preload: false, variable: '--font-brand-manrope' });
const workSans = localFont({ src: '../../public/fonts/brand/work-sans-latin-wght-normal.woff2', weight: '100 900', display: 'swap', preload: false, variable: '--font-brand-work-sans' });
const spaceGrotesk = localFont({ src: '../../public/fonts/brand/space-grotesk-latin-wght-normal.woff2', weight: '100 900', display: 'swap', preload: false, variable: '--font-brand-space-grotesk' });
const sourceSerif = localFont({ src: '../../public/fonts/brand/source-serif-4-latin-wght-normal.woff2', weight: '200 900', display: 'swap', preload: false, variable: '--font-brand-source-serif' });
const lora = localFont({ src: '../../public/fonts/brand/lora-latin-wght-normal.woff2', weight: '400 700', display: 'swap', preload: false, variable: '--font-brand-lora' });
const fraunces = localFont({ src: '../../public/fonts/brand/fraunces-latin-wght-normal.woff2', weight: '100 900', display: 'swap', preload: false, variable: '--font-brand-fraunces' });

export const BRAND_FONT_FACES: Record<BrandFontId, { className: string; cssVar: string }> = {
  geist: { className: geist.variable, cssVar: '--font-geist' },
  inter: { className: inter.variable, cssVar: '--font-brand-inter' },
  'dm-sans': { className: dmSans.variable, cssVar: '--font-brand-dm-sans' },
  'ibm-plex-sans': { className: plex.variable, cssVar: '--font-brand-plex' },
  manrope: { className: manrope.variable, cssVar: '--font-brand-manrope' },
  'work-sans': { className: workSans.variable, cssVar: '--font-brand-work-sans' },
  'space-grotesk': { className: spaceGrotesk.variable, cssVar: '--font-brand-space-grotesk' },
  'source-serif': { className: sourceSerif.variable, cssVar: '--font-brand-source-serif' },
  lora: { className: lora.variable, cssVar: '--font-brand-lora' },
  fraunces: { className: fraunces.variable, cssVar: '--font-brand-fraunces' },
};

export const ALL_BRAND_FONT_CLASSES = Object.values(BRAND_FONT_FACES)
  .map((face) => face.className)
  .join(' ');
