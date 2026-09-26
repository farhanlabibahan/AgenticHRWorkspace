import localFont from 'next/font/local';

/**
 * Geist + Fragment Mono, shared by the app layout and Storybook's preview so
 * every story renders in the real type. Variables feed --font-sans / --font-mono
 * in globals.css.
 */
export const geist = localFont({
  src: [
    { path: '../../public/fonts/Geist-Regular.woff2', weight: '400', style: 'normal' },
    { path: '../../public/fonts/Geist-Medium.woff2', weight: '500', style: 'normal' },
    { path: '../../public/fonts/Geist-Bold.woff2', weight: '700', style: 'normal' },
  ],
  variable: '--font-geist',
  display: 'swap',
});

export const fragmentMono = localFont({
  src: [{ path: '../../public/fonts/FragmentMono-Regular.woff2', weight: '400', style: 'normal' }],
  variable: '--font-fragment-mono',
  display: 'swap',
});
