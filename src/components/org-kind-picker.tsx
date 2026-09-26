'use client';

import { useTransition } from 'react';
import { Building2, Users2 } from 'lucide-react';
import { setOrgKindAction } from '@/app/org-actions';
import { cn } from '@/lib/utils';

const options = [
  {
    kind: 'COMPANY' as const,
    icon: Building2,
    title: 'Company',
    description: 'We hire for our own teams and departments.',
  },
  {
    kind: 'AGENCY' as const,
    icon: Users2,
    title: 'Staffing agency',
    description: 'We hire on behalf of multiple client companies.',
  },
];

export function OrgKindPicker({ current }: { current: 'COMPANY' | 'AGENCY' }) {
  const [pending, startTransition] = useTransition();

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {options.map(({ kind, icon: Icon, title, description }) => {
        const active = current === kind;
        return (
          <button
            key={kind}
            type="button"
            aria-pressed={active}
            disabled={pending}
            onClick={() => startTransition(() => setOrgKindAction(kind))}
            className={cn(
              'selectable cursor-pointer rounded-card p-4 text-left disabled:opacity-40',
              active ? 'is-selected' : 'bg-muted hover:bg-recessed',
            )}
          >
            <Icon size={18} className={active ? 'text-ink' : 'text-ink-2'} />
            <p className="mt-2 text-sm font-medium">{title}</p>
            <p className="mt-0.5 text-xs text-ink-2">{description}</p>
          </button>
        );
      })}
    </div>
  );
}
