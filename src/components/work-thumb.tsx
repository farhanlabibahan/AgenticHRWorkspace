'use client';

import { useState } from 'react';
import { Orb } from '@/components/ui/orb';
import { cn } from '@/lib/utils';

/**
 * A case study's thumbnail: the page's own preview image, or, when it has
 * none (or it won't load), a dithered orb seeded by the case study, so a
 * grid of work never shows a broken image or a gray box.
 */
export function WorkThumb({
  imageUrl,
  seed,
  orb = 200,
  className,
}: {
  imageUrl: string | null;
  seed: string;
  /** The generated art's orb size: smaller for small thumbnails. */
  orb?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <div className={cn('relative aspect-[16/10] overflow-hidden rounded-field bg-recessed', className)}>
      {imageUrl && !failed ? (
        // eslint-disable-next-line @next/next/no-img-element -- the page's own preview image, from its site
        <img
          src={imageUrl}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
          className="absolute inset-0 size-full object-cover"
        />
      ) : (
        <div aria-hidden className="absolute" style={{ right: -orb * 0.24, bottom: -orb * 0.28 }}>
          <Orb seed={seed} size={orb} />
        </div>
      )}
    </div>
  );
}
