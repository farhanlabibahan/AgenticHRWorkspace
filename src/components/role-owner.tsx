'use client';

import { useOptimistic, useTransition } from 'react';
import { setPostingOwnerAction } from '@/app/(app)/actions';
import { Dropdown } from '@/components/dropdown';
import { Avatar } from '@/components/ui/orb';
import { runOptimistic } from '@/lib/optimistic';
import { cn } from '@/lib/utils';

type Person = { id: string; name: string; email: string };

const NOBODY = '__none';

/**
 * The recruiter who owns a role (Posting.owner), with a picker to hand it
 * to a teammate. The same card sits on the posting and on every candidate
 * for it; the change shows at once and the server confirms behind it.
 */
export function RoleOwner({
  postingId,
  owner,
  teammates,
  inline = false,
}: {
  postingId: string;
  owner: Person | null;
  teammates: Person[];
  /** A single row for the posting header, instead of the sidebar card body. */
  inline?: boolean;
}) {
  const [, startTransition] = useTransition();
  const [current, setCurrent] = useOptimistic(owner);

  const picker = (
    <Dropdown
      compact
      onSurface
      label={current ? 'Change' : 'Assign'}
      showSelectedInTrigger={false}
      value={current?.id ?? ''}
      options={[
        ...teammates.map((t) => ({ value: t.id, label: t.name })),
        ...(current ? [{ value: NOBODY, label: 'No recruiter' }] : []),
      ]}
      onSelect={(value) => {
        const next = value === NOBODY ? null : (teammates.find((t) => t.id === value) ?? null);
        if ((next?.id ?? null) === (current?.id ?? null)) return;
        runOptimistic(
          startTransition,
          () => setCurrent(next),
          () => setPostingOwnerAction(postingId, next?.id ?? null),
          'Changing the recruiter',
        );
      }}
    />
  );

  return (
    <div className={cn('flex min-w-0 items-center gap-3', !inline && 'px-3 py-2.5')}>
      {current ? (
        <>
          <Avatar name={current.name} size={24} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-ink">{current.name}</p>
            {inline ? null : (
              <a
                href={`mailto:${current.email}`}
                className="block truncate text-xs text-ink-2 transition-colors duration-[120ms] hover:text-ink"
              >
                {current.email}
              </a>
            )}
          </div>
        </>
      ) : (
        <p className="flex-1 text-sm text-ink-2">No recruiter yet</p>
      )}
      {picker}
    </div>
  );
}
