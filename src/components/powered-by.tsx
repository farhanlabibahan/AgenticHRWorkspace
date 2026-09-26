import Link from 'next/link';
import { cn } from '@/lib/utils';

/**
 * The Source logo: the orb-and-wordmark lockup from public/brand, at 32px
 * tall (its minimum, and a whole multiple of the orb's dither grid), in the
 * light or dark file to match the theme. Never a text stand-in: "SRC" is
 * only for favicons (public/brand/README.md).
 */
export function SourceLockup({ href, className }: { href?: string; className?: string }) {
  const art = (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element -- a static SVG, drawn cell for cell */}
      <img src="/brand/source-lockup-light.svg" alt="Source" width={105} height={32} className="h-8 w-auto dark:hidden" />
      {/* eslint-disable-next-line @next/next/no-img-element -- a static SVG, drawn cell for cell */}
      <img src="/brand/source-lockup-dark.svg" alt="Source" width={105} height={32} className="hidden h-8 w-auto dark:block" />
    </>
  );
  return href ? (
    <Link href={href} className={cn('inline-flex shrink-0', className)}>
      {art}
    </Link>
  ) : (
    <span className={cn('inline-flex shrink-0', className)}>{art}</span>
  );
}

/**
 * "Powered by" and the logo, for pages candidates and clients see: careers
 * pages, the candidate portal, offers, scheduling and share links. Opens our
 * site in a new tab so nobody loses their place.
 */
export function PoweredBySource({ className }: { className?: string }) {
  return (
    <a
      href="/"
      target="_blank"
      rel="noopener"
      className={cn('inline-flex items-center gap-2.5 text-xs text-ink-2 transition-colors hover:text-ink', className)}
    >
      Powered by
      <SourceLockup />
    </a>
  );
}
