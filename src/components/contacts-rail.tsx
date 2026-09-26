'use client';

import Link from 'next/link';
import { X } from 'lucide-react';
import { deleteTalentPoolAction } from '@/app/(app)/actions';
import { contactRowCache } from '@/lib/list-client/caches';
import type { BoundedCount } from '@/lib/list-types';
import { useContactsNav, useLanded } from '@/components/contacts-nav';
import { buttonClass } from '@/components/ui/button';
import { StatusDot } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';

const fmt = (n: number) => n.toLocaleString('en-US');

/**
 * Pools and saved segments. Names render with the page; their counts
 * arrive on their own (a dynamic segment's count is a text search over
 * every contact) and fill in when they land.
 */
export function ContactsRail({
  pools,
  counts,
}: {
  pools: { id: string; name: string; kind: 'STATIC' | 'DYNAMIC' }[];
  counts: Promise<Record<string, BoundedCount> | null>;
}) {
  const nav = useContactsNav();
  const landed = useLanded(counts);
  const current = nav.input.pool ?? '';
  const warm = (pool: string) => {
    const key = nav.keyFor({ pool });
    if (key !== nav.committedKey && !contactRowCache.get(key)) void contactRowCache.prefetch(key);
  };

  return (
    <>
      <Link
        href={nav.hrefFor({ pool: '' })}
        prefetch={false}
        onClick={(e) => nav.go({ pool: '' }, e)}
        onPointerEnter={() => warm('')}
        onFocus={() => warm('')}
        aria-current={!current ? 'true' : undefined}
        className={cn(
          'flex h-8 items-center justify-between rounded-full px-3 text-sm transition-colors duration-[120ms]',
          !current ? 'bg-surface text-ink' : 'text-ink-2 hover:bg-ink/[0.04] hover:text-ink',
        )}
      >
        All contacts
      </Link>

      {pools.length ? (
        <div className="mt-4">
          <p className="mb-1 px-3 text-xs font-medium text-ink-2">Pools &amp; segments</p>
          {pools.map((p) => {
            const c = landed?.[p.id];
            return (
              <span key={p.id} className="group flex items-center">
                <Link
                  href={nav.hrefFor({ pool: p.id })}
                  prefetch={false}
                  onClick={(e) => nav.go({ pool: p.id }, e)}
                  onPointerEnter={() => warm(p.id)}
                  onFocus={() => warm(p.id)}
                  aria-current={current === p.id ? 'true' : undefined}
                  className={cn(
                    'flex h-8 min-w-0 flex-1 items-center gap-2 rounded-full px-3 text-sm transition-colors duration-[120ms]',
                    current === p.id ? 'bg-surface text-ink' : 'text-ink-2 hover:bg-ink/[0.04] hover:text-ink',
                  )}
                >
                  <span className="flex" title={p.kind === 'DYNAMIC' ? 'Saved segment (live filter)' : 'Static pool'}>
                    <StatusDot tone={p.kind === 'DYNAMIC' ? 'info' : 'neutral'} />
                  </span>
                  <span className="truncate">{p.name}</span>
                  <span className="ml-auto min-w-6 text-right text-xs tabular-nums text-ink-2" data-pool-count={p.id}>
                    {c ? `${fmt(c.count)}${c.capped ? '+' : ''}` : ''}
                  </span>
                </Link>
                <form action={deleteTalentPoolAction.bind(null, p.id)}>
                  <button
                    type="submit"
                    aria-label={`Delete ${p.name}`}
                    className={buttonClass({
                      variant: 'ghost',
                      size: 'xs',
                      icon: true,
                      className: 'opacity-0 transition-opacity hover:text-critical group-hover:opacity-100',
                    })}
                  >
                    <X />
                  </button>
                </form>
              </span>
            );
          })}
        </div>
      ) : null}
    </>
  );
}
