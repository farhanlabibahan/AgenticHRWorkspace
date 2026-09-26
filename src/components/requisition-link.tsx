'use client';

import { useTransition } from 'react';
import { linkPostingRequisitionAction } from '@/app/(app)/actions';
import { Dropdown } from '@/components/dropdown';

/** Per-posting requisition selector for the postings table. */
export function RequisitionLink({
  postingId,
  requisitionId,
  requisitions,
}: {
  postingId: string;
  requisitionId: string | null;
  requisitions: { id: string; code: string }[];
}) {
  const [pending, startTransition] = useTransition();
  if (!requisitions.length) return <span className="text-ink-2">—</span>;
  const current = requisitions.find((r) => r.id === requisitionId);

  return (
    <Dropdown
      compact
      onSurface
      disabled={pending}
      label={current?.code ?? 'no req'}
      showSelectedInTrigger={false}
      value={requisitionId ?? ''}
      allLabel="No requisition"
      options={requisitions.map((r) => ({ value: r.id, label: r.code }))}
      onSelect={(value) => startTransition(() => linkPostingRequisitionAction(postingId, value))}
    />
  );
}
