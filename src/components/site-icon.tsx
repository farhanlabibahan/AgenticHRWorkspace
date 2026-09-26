'use client';

import { useState } from 'react';
import { Link2 } from 'lucide-react';

/**
 * Favicon for an external profile link (LinkedIn, GitHub, portfolio…),
 * fetched from Google's favicon service by domain. Falls back to the
 * generic link glyph when the URL is unparseable or the icon 404s.
 */
export function SiteIcon({ url, size = 14 }: { url: string; size?: number }) {
  const [failed, setFailed] = useState(false);

  let domain: string | null = null;
  try {
    domain = new URL(url.startsWith('http') ? url : `https://${url}`).hostname;
  } catch {
    domain = null;
  }

  if (!domain || failed) {
    return <Link2 size={size} className="shrink-0 text-ink-2" />;
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- external favicon service
    <img
      src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32`}
      alt=""
      aria-hidden
      width={size}
      height={size}
      loading="lazy"
      referrerPolicy="no-referrer"
      className="shrink-0 rounded-[3px]"
      onError={() => setFailed(true)}
    />
  );
}
