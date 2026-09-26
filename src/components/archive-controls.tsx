'use client';

import { useOptimistic, useTransition } from 'react';
import type { OpportunityStatus } from '@prisma/client';
import { archiveOpportunityAction, unarchiveOpportunityAction } from '@/app/(app)/actions';
import { Dropdown } from '@/components/dropdown';
import { SnoozeControl } from '@/components/snooze-control';
import { StageSelect } from '@/components/stage-select';
import { buttonClass } from '@/components/ui/button';
import { Badge } from '@/components/ui/primitives';
import { runOptimistic } from '@/lib/optimistic';

type Status = { status: OpportunityStatus; reason: string | null };

/**
 * The candidate header's status controls: the stage picker (or the
 * Archived badge), snooze, and archive/unarchive. They share one optimistic
 * status, so archiving swaps all of them at once instead of leaving a live
 * stage picker next to "Unarchive" until the server answers.
 *
 * Nothing here is disabled while a change saves: the new state is already
 * on screen, and Next runs server actions one at a time.
 */
export function CandidateStatusControls({
  opportunityId,
  status: serverStatus,
  archiveReason,
  stageId,
  stages,
  snoozedUntil,
  reasons,
}: {
  opportunityId: string;
  status: OpportunityStatus;
  archiveReason: string | null;
  stageId: string;
  stages: { id: string; name: string }[];
  snoozedUntil: string | null;
  reasons: { id: string; name: string }[];
}) {
  const [, startTransition] = useTransition();
  const [{ status, reason }, setStatus] = useOptimistic<Status>({
    status: serverStatus,
    reason: archiveReason,
  });
  const archived = status === 'ARCHIVED';

  const archive = (reasonId: string) =>
    runOptimistic(
      startTransition,
      () => setStatus({ status: 'ARCHIVED', reason: reasons.find((r) => r.id === reasonId)?.name ?? null }),
      () => archiveOpportunityAction(opportunityId, reasonId),
      'Archiving',
    );
  const unarchive = () =>
    runOptimistic(
      startTransition,
      () => setStatus({ status: 'ACTIVE', reason: null }),
      () => unarchiveOpportunityAction(opportunityId),
      'Unarchiving',
    );

  return (
    <>
      {archived ? (
        <Badge tone="critical">Archived{reason ? ` · ${reason}` : ''}</Badge>
      ) : (
        <StageSelect onSurface opportunityId={opportunityId} currentStageId={stageId} stages={stages} />
      )}
      {status === 'ACTIVE' ? (
        <SnoozeControl opportunityId={opportunityId} snoozedUntil={snoozedUntil} />
      ) : null}
      {archived ? (
        <button onClick={unarchive} className={buttonClass({ variant: 'ghost', size: 'xs' })}>
          Unarchive
        </button>
      ) : (
        <Dropdown
          compact
          onSurface
          label="Archive"
          options={reasons.map((r) => ({ value: r.id, label: r.name }))}
          onSelect={(reasonId) => {
            if (reasonId) archive(reasonId);
          }}
        />
      )}
    </>
  );
}
