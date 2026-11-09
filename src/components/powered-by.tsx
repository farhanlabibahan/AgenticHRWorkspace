import Link from 'next/link';
import { cn } from '@/lib/utils';

/**
 * The Orqestra logo: the orb mark from public/brand beside the name.
 */
export function SourceLockup({ href, className }: { href?: string; className?: string }) {
  // The orb (public/brand/source-mark.svg, no lettering) with the name set as
  // live text beside it, so the wordmark can change without redrawing the art.
  const art = (
    <span className="inline-flex items-center gap-2">
      {/* eslint-disable-next-line @next/next/no-img-element -- a static SVG, drawn cell for cell */}
      <img src="/brand/source-mark.svg" alt="" width={32} height={32} className="size-8 shrink-0" />
      <span className="text-[18px] font-semibold tracking-[-0.02em] text-ink">Orqestra</span>
    </span>
  );
  return href ? (
    <Link href={href} aria-label="Orqestra home" className={cn('inline-flex shrink-0', className)}>
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
