'use client';

import { useState, useTransition } from 'react';
import { GitMerge } from 'lucide-react';
import { mergeContactsAction } from '@/app/(app)/actions';
import { btnGhost } from '@/components/form-controls';

type Duplicate = { id: string; name: string; email: string | null };

export function DuplicatesBanner({
  contactId,
  duplicates,
}: {
  contactId: string;
  duplicates: Duplicate[];
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  if (!duplicates.length) return null;

  return (
    <div className="mt-4 rounded-card bg-caution/10 p-4">
      <p className="text-xs font-medium text-caution">Possible duplicates</p>
      <div className="mt-2 flex flex-col gap-1.5">
        {duplicates.map((d) => (
          <div key={d.id} className="flex items-center justify-between gap-3">
            <p className="text-sm">
              {d.name}
              {d.email ? <span className="text-ink-2"> · {d.email}</span> : null}{' '}
              <span className="text-ink-2">shares an email, phone, or link with this profile.</span>
            </p>
            <button
              disabled={pending}
              onClick={() => {
                if (!confirm(`Merge ${d.name} into this profile? Their applications, emails, and consents move here and the duplicate is deleted. This cannot be undone.`)) return;
                startTransition(async () => {
                  const result = await mergeContactsAction(contactId, d.id);
                  setError(result.error ?? null);
                });
              }}
              className={`${btnGhost} shrink-0`}
            >
              <GitMerge /> Merge into this profile
            </button>
          </div>
        ))}
      </div>
      {error ? <p className="mt-2 text-sm text-critical">{error}</p> : null}
    </div>
  );
}
