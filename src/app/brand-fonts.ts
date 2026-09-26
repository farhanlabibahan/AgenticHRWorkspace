import { DM_Sans, Fraunces, IBM_Plex_Sans, Inter, Lora, Manrope, Source_Serif_4, Space_Grotesk, Work_Sans } from 'next/font/google';
import type { BrandFontId } from '@/lib/brand';
import { geist } from './fonts';

/**
 * The fonts an organization can pick for its brand kit (lib/brand.ts).
 * next/font downloads them at build time and serves them from this app, so
 * a candidate's browser never contacts Google. None is preloaded: a page
 * downloads only the font it uses. Loader options must be literals.
 */
const inter = Inter({ subsets: ['latin'], display: 'swap', preload: false, variable: '--font-brand-inter' });
const dmSans = DM_Sans({ subsets: ['latin'], display: 'swap', preload: false, variable: '--font-brand-dm-sans' });
const plex = IBM_Plex_Sans({ subsets: ['latin'], weight: ['400', '500', '700'], display: 'swap', preload: false, variable: '--font-brand-plex' });
const manrope = Manrope({ subsets: ['latin'], display: 'swap', preload: false, variable: '--font-brand-manrope' });
const workSans = Work_Sans({ subsets: ['latin'], display: 'swap', preload: false, variable: '--font-brand-work-sans' });
const spaceGrotesk = Space_Grotesk({ subsets: ['latin'], display: 'swap', preload: false, variable: '--font-brand-space-grotesk' });
const sourceSerif = Source_Serif_4({ subsets: ['latin'], display: 'swap', preload: false, variable: '--font-brand-source-serif' });
const lora = Lora({ subsets: ['latin'], display: 'swap', preload: false, variable: '--font-brand-lora' });
const fraunces = Fraunces({ subsets: ['latin'], display: 'swap', preload: false, variable: '--font-brand-fraunces' });

/** Each font's class (defines its CSS variable) and that variable's name. */
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

/** Every brand font's class, for a page that shows them all (the brand kit's font picker). */
export const ALL_BRAND_FONT_CLASSES = Object.values(BRAND_FONT_FACES)
  .map((f) => f.className)
  .join(' ');
