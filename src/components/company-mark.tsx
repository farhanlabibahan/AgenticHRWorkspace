'use client';

import { useState } from 'react';
import { Orb } from '@/components/ui/orb';
import { cn } from '@/lib/utils';

/**
 * A company's or school's logo, from the best source we have:
 *
 *   1. Logo.dev, by domain when we know it, else by name (its "I'm feeling
 *      lucky" brand search). Asked for a 404 when it has no logo, so we
 *      never show its generated monogram.
 *   2. Google's favicon service, only when we know the domain. Guessing a
 *      domain from a name shows the wrong company's icon, so we don't.
 *   3. The orb seeded by the name, as postings and clients have.
 *
 * The orb is painted first and the logo fades in over it once it loads, so
 * a slow or missing logo never leaves a hole. NEXT_PUBLIC_LOGO_DEV_TOKEN is
 * Logo.dev's publishable key, meant for the browser; without it step 1 is
 * skipped.
 */

const LOGO_DEV_TOKEN = process.env.NEXT_PUBLIC_LOGO_DEV_TOKEN;

function sources(name: string, domain: string | null, px: number): string[] {
  const out: string[] = [];
  if (LOGO_DEV_TOKEN) {
    const params = `token=${encodeURIComponent(LOGO_DEV_TOKEN)}&size=${px}&format=webp&retina=true&fallback=404`;
    out.push(
      domain
        ? `https://img.logo.dev/${encodeURIComponent(domain)}?${params}`
        : `https://img.logo.dev/name/${encodeURIComponent(name)}?${params}`,
    );
  }
  if (domain) out.push(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=${Math.min(256, px * 2)}`);
  return out;
}

export function CompanyMark({
  name,
  domain = null,
  size = 28,
  className,
}: {
  name: string;
  domain?: string | null;
  size?: number;
  className?: string;
}) {
  const candidates = name.trim() ? sources(name.trim(), domain, size) : [];
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const src = candidates[attempt];

  return (
    <span className={cn('relative inline-flex shrink-0', className)} style={{ width: size, height: size }}>
      <Orb seed={name} size={size} />
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element -- external logo services
        <img
          key={src}
          src={src}
          alt=""
          aria-hidden
          width={size}
          height={size}
          loading="lazy"
          referrerPolicy="no-referrer"
          onLoad={(e) => {
            // Google answers an unknown domain with a 16px globe: treat it as missing.
            if (src.includes('google.com/s2') && e.currentTarget.naturalWidth <= 16 && size > 16) {
              setAttempt((a) => a + 1);
              return;
            }
            setLoaded(true);
          }}
          onError={() => {
            setLoaded(false);
            setAttempt((a) => a + 1);
          }}
          className={cn(
            'absolute inset-0 size-full rounded-full bg-surface object-cover ring-1 ring-line transition-opacity duration-200',
            loaded ? 'opacity-100' : 'opacity-0',
          )}
        />
      ) : null}
    </span>
  );
}

/** Logo.dev's free plan asks for a visible link wherever its logos show in a commercial product. */
export function LogoAttribution({ className }: { className?: string }) {
  if (!LOGO_DEV_TOKEN) return null;
  return (
    <a
      href="https://logo.dev"
      target="_blank"
      rel="noopener"
      className={cn('text-xs text-ink-3 underline-offset-2 hover:text-ink-2 hover:underline', className)}
    >
      Logos provided by Logo.dev
    </a>
  );
}
